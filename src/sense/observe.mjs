// DECIDE CHEAP, CONFIRM EXPENSIVE.
//
// This is the most consequential thing in the repository and it was got wrong first
// time round. The two reads a bot lives on cost wildly different amounts, and the
// difference is not visible in their signatures:
//
//   `fleet`   sends NOTHING to the game server. It reads the client's cached world and
//             each keeper's in-memory status. One call, N characters, free.
//
//   `status`  sends FOUR requests per character — stats(1), stats(2), the spell list,
//             the skill list — through the pacer, plus a settle. For twenty-one
//             characters that is eighty-four requests every tick.
//
// The harness says the same thing in its own words: DECIDING IS FREE, ASKING IS NOT.
// Asking is not passive either — a room-contents resync counts as an action and calls
// NotifyMonstersOfPresence, which is why the keeper forbids it while playing dead. A
// bot polling every character every tick would be announcing twenty-one characters,
// repeatedly, in rooms whose entire value is that nothing attacks until you swing.
//
// So the tick is two phases:
//
//   1. decide from the board. Free. Most ticks end here, because most of what a
//      directional bot concludes is "leave this alone".
//   2. only if that produced an ORDER — something that has to be diffed against the
//      keeper's live policy, which is not on the board — pay for `status` and decide
//      again on the fuller observation.
//
// Re-deciding is free: rules are pure. And the second decision may legitimately differ
// from the first — that is the point, not a bug. A rule that could not see the keeper's
// policy may find on the second pass that the keeper already has these orders.

import { normalizeFleetRow, normalizeStatus } from './normalize.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Published by m59-proxy.mjs in the harness. Read rather than imported: the two live in
// different repositories and on different clocks, and a file is the only interface where
// either restarting loses nothing.
const LEADER_FILE = join(process.env.M59_HARNESS ?? '../m59-harness', 'substrate', 'swarm-leader.json');

/**
 * The whole-fleet observation. One call, and it costs the game server nothing.
 * @param {import('../link/broker.mjs').Broker} broker
 * @param {object} [opts]
 * @param {number} [opts.now] injected clock — see CLAUDE.md, decide/ must be pure
 */
// WHERE THE LEADER IS AND WHAT IT IS SWINGING AT — the two things a swarm needs and the
// board cannot give it.
//
// One connection per character, so the moment an operator logs in the broker loses its
// view of that character: the fleet row reads `in_game: false` with no room. Everything
// below is about getting those two facts back WITHOUT the broker's own session.
//
//   POSITION comes from any follower standing in the same room. A player is an ordinary
//   room object carrying OF_PLAYER with a row and a column, and the pilot claim records
//   the leader's OBJECT ID — so this is an id match rather than a guess by name, which
//   matters on a shared server where names are not unique.
//
//   TARGET cannot be observed at all. The client emits no attack event a bystander could
//   parse and the server tells onlookers nothing about who is hitting what. The one place
//   in the system that can see it is the proxy, because an attack is a CLIENT-TO-SERVER
//   packet — so `m59-proxy.mjs` reads REQ_ATTACK off the wire and publishes it here.
//
// The split is worth stating plainly: following works with no proxy, focus fire does not.
async function senseLeader(broker, rows, { now, leaderFile }) {
  const piloted = rows.filter(r => r.piloted);
  if (piloted.length !== 1) return { room_views: [], leader_pos: null, leader_target: null };
  const leader = piloted[0];
  const wantId = leader.piloted?.objectId ?? null;

  // Look with everyone in game — cheap, cached by the broker, and the only way to find a
  // character the broker itself cannot see.
  const views = [];
  for (const r of rows) {
    if (!r.in_game || r.agent === leader.agent) continue;
    const seen = await broker.call('look', { agent: r.agent }).catch(() => null);
    if (!seen) continue;
    views.push({ agent: r.agent, room: seen.room?.num ?? null, objects: seen.objects ?? [] });
  }
  let pos = null;
  if (wantId != null) {
    for (const v of views) {
      const hit = (v.objects ?? []).find(o => o.id === wantId);
      if (hit) { pos = { room: v.room, row: hit.row, col: hit.col, seen_by: v.agent }; break; }
    }
  }

  // The proxy's published view. STALE IS AS BAD AS ABSENT for a target: a swarm still
  // piling onto something the leader stopped hitting ten seconds ago is worse than one
  // that waits, so anything older than the window is dropped rather than reported.
  let target = null;
  try {
    const raw = JSON.parse(readFileSync(leaderFile, 'utf8'));
    if (raw?.target != null && now - (raw.at ?? 0) < 8000)
      target = { id: raw.target, how: raw.how ?? 'attack', age_ms: now - raw.at };
  } catch { /* no proxy running: following still works, focus fire does not */ }

  return { room_views: views, leader_pos: pos, leader_target: target };
}

export async function observeFleet(broker, { now = Date.now(), leaderFile = LEADER_FILE,
                                             senseSwarm = false, rooms = [] } = {}) {
  const raw = await broker.call('fleet', {});
  const rows = (raw.fleet ?? []).map(normalizeFleetRow);
  // Only when something is actually leading. `look` per character is cheap but not free,
  // and on the ordinary pass — nobody piloting — this must cost one comparison.
  const swarm = senseSwarm && rows.some(r => r.piloted)
    ? await senseLeader(broker, rows, { now, leaderFile })
    : { room_views: [], leader_pos: null, leader_target: null };
  // A scheduled room is observable only through a character standing in it. One cached
  // look per occupied target room is enough; asking all ten occupants says the same fact
  // ten times and can announce them to monsters when a resync is involved.
  const roomViews = [];
  for (const room of [...new Set(rooms)].filter(Number.isInteger)) {
    const watcher = rows.find(r => r.in_game && r.room === room);
    if (!watcher) continue;
    const seen = await broker.call('look', { agent: watcher.agent }).catch(() => null);
    if (seen) roomViews.push({ agent: watcher.agent, room,
      objects: seen.objects ?? [], where: seen.room ?? null });
  }
  return {
    at: now,
    source: 'fleet',
    characters: rows,
    ...swarm,
    // Swarm sensing and scheduled-room sensing answer the same shape. Keep both when a
    // human leader happens to share a shift room, de-duplicated by watcher+room.
    room_views: [...(swarm.room_views ?? []), ...roomViews].filter((v, i, all) =>
      all.findIndex(x => x.agent === v.agent && x.room === v.room) === i),
    in_game: rows.filter(r => r.in_game).length,
    stalled: rows.filter(r => r.stalled).length,
    // PARKING STANDS THE WHOLE TICK DOWN. A parked keeper is running and deliberately
    // doing nothing, which is exactly what a supervising loop is built to notice and
    // "fix" — and fixing it clears the parking flag and sends the character back to
    // work in the minute before the broker goes down. The harness's own supervisor
    // stands its whole round down for one parked character; so does this.
    parking: rows.filter(r => r.parked).length,
    depth: 'board',
  };
}

/**
 * Add the two paid facts a moot needs, and only to characters already at the inn.
 *
 * The fleet board intentionally carries summaries; a fair transfer needs the actual
 * stack ids as well as the loadout floors. Reading them for every character on every
 * ordinary tick would turn a free board read into forty-two server requests. A moot is
 * exceptional and bounded, so tickFleet calls this only while moot.hold is enabled and
 * only for the hands currently present.
 */
export async function enrichForMoot(broker, rows = [], { weapons = false } = {}) {
  for (const row of rows) {
    try {
      if (weapons) {
        // Unlike the fleet summary, this request populates the broker's spell cache on a
        // fresh resume. An empty `provides` before that read means "unasked", not "cannot".
        const spells = await broker.call('spells', { agent: row.agent });
        row.spells = Array.isArray(spells?.spells) ? spells.spells : [];
        row.provides = row.spells.map(s => String(s.name).toLowerCase())
          .filter(n => n === 'create weapon' || n === 'create food');
        if (spells?.your_mana) row.mana = spells.your_mana;
      }
      // loadout also refreshes inventory today, but do not depend on that incidental
      // implementation detail: inventory is the interface that supplies transferable ids.
      const inventory = await broker.call('inventory', { agent: row.agent });
      const loadout = await broker.call('loadout', { agent: row.agent });
      row.items = Array.isArray(inventory?.items) ? inventory.items : [];
      row.equipped = Array.isArray(inventory?.equipped) ? inventory.equipped : [];
      row.carry = inventory?.carry ?? null;
      // null is a real answer (use the doctrine fallback); undefined means the read failed.
      row.loadout = loadout?.loadout ?? null;
      row.moot_facts_error = null;
    } catch (e) {
      row.items = null;
      row.loadout = undefined;
      row.moot_facts_error = e.message;
    }
  }
  return rows;
}

/** Add only the live facts the independent food/weapon strategies consume. */
export async function enrichMaintenance(broker, rows = []) {
  for (const row of rows) {
    try {
      // `provides` is free on a warm fleet board. Only pay for the spell list when the
      // broker has never populated it; unlike inventory, this fact does not change every
      // time a weapon or loaf is created.
      if (!Array.isArray(row.provides) || !row.provides.length) {
        const spells = await broker.call('spells', { agent: row.agent });
        row.provides = (spells?.spells ?? []).map(s => String(s.name).toLowerCase())
          .filter(n => n === 'create weapon' || n === 'create food');
        if (spells?.your_mana) row.mana = spells.your_mana;
      }
      const inventory = await broker.call('inventory', { agent: row.agent });
      row.items = Array.isArray(inventory?.items) ? inventory.items : [];
      row.equipped = Array.isArray(inventory?.equipped) ? inventory.equipped : [];
      row.carry = inventory?.carry ?? null;
      row.maintenance_facts_error = null;
    } catch (e) {
      row.items = null;
      row.carry = null;
      row.maintenance_facts_error = e.message;
    }
  }
  return rows;
}

/** Add the server's cached use-list without refreshing inventory during a fight. */
export async function enrichEquipment(broker, rows = []) {
  for (const row of rows) {
    const equipment = await broker.call('equipment', { agent: row.agent, refresh: false })
      .catch(() => null);
    // Undefined means unread; [] is the server saying nothing is equipped.
    row.equipped = equipment && Array.isArray(equipment.equipped)
      ? equipment.equipped.map(x => x?.name ?? x).filter(Boolean) : undefined;
    row.equipment_known = equipment?.known ?? (equipment ? true : false);
  }
  return rows;
}

/** The free half: one character's observation, taken from the board row. */
export function observeFromBoard(row, { now = Date.now() } = {}) {
  return { ...row, at: now };
}

/**
 * The paid half. Four server requests, so this is called only when a decision cannot be
 * made without the keeper's policy — and the caller is expected to have a reason.
 *
 * @param {import('../link/broker.mjs').Broker} broker
 * @param {object} base   the board-derived observation to merge onto
 * @param {string[]} [extras]  further reads a rule declared it needs
 */
export async function deepen(broker, base, extras = [], { now = Date.now() } = {}) {
  const agent = base.agent;
  const status = await broker.call('status', { agent, brief: true });
  const obs = normalizeStatus(base, status, { now });

  // The declared extras, each fetched at most once. Declaring them is how the tick
  // stays one round-trip per FACT rather than one per rule.
  for (const want of new Set(extras)) {
    if (want === 'policy') continue;                 // that is what `status` was for
    if (!EXTRA_READS[want]) continue;
    obs[want] = await broker.call(EXTRA_READS[want], { agent }).catch(e => ({ error: e.message }));
  }
  return obs;
}

// Which harness call answers each declared need. Kept as data so that a rule declaring
// something nobody can fetch is visible here rather than failing silently at run time.
const EXTRA_READS = {
  progress: 'progress',
  inventory: 'inventory',
  prey: 'prey',
  bank: 'bank',
};

export { EXTRA_READS };
