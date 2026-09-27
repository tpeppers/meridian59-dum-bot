// UKGOTH TROLLS — hunt trolls on MAGIC weapons, and keep the supply line behind them running.
//
// The strategy's description in strategies/catalog.mjs carries the argument; this is the table.
// In one line: a troll resists ATCK_WEAP_NONMAGIC 80 (troll.kod:64-67), so a mundane weapon
// lands a fifth, Kraanan's enchant weapon clears the flag (waench.kod:108-109), and a unit is
// sent into Ukgoth only while the weapon in its hand is READ as magic and it carries spares of
// ITS OWN FAMILY that are too. Nothing forces a weapon family: the keeper's `prefer_magic_weapon`
// is a tie-break inside whatever the unit trains, which is also why a magic axe is no spare at all
// to a hammer trainee — the tie-break will never wield it.
//
// WHAT ONE PASS MAY DO, in this order, and why the order:
//
//   1. placement   deploy the ready, stage the rest at the stage room. Cheap, and it is what keeps
//                  a mundane unit out of Ukgoth, so it is never deferred behind anything.
//   2. courier     when the depot has piled up enough REAL loot and the cooldown has run: one
//                  healthy unit carries it to a weapon buyer and back. An ERRAND, so it takes the
//                  pass; it is rare by construction (memory topic `trolls`).
//   3. supply      at the stage room: surplus loot handed UP to the depot; a family weapon handed
//                  DOWN from the depot to a unit that has nothing to dedicate; failing both, the
//                  unit conjures one (Create Weapon rolls a family at random — a mismatch is
//                  handed up next pass and waits in the depot for someone it suits).
//   4. dedicate    AT MOST ONE owner -> dedicator -> owner round (a 30-second trance blocks the
//                  fleet pass; errands.mjs: "IT BLOCKS THE PASS").
//
// PURE: no clock, no I/O. `fleetObs.at` is the time and `fleetObs.memory.trolls` is the past.

import { STRATEGY_IDS, strategyRows, strategySettings, admits } from '../../strategies/catalog.mjs';
import { activeFactionWork } from './factions.mjs';
import { takeable } from '../engine.mjs';

const DEDICATE = Object.freeze({ spell: 'enchant weapon', mana: 17,
  reagents: Object.freeze([['elderberry', 3], ['orc tooth', 1]]) });
const CREATE = Object.freeze({ spell: 'create weapon', mana: 15 });

// WHO BUYS WEAPONS, BY ROOM. Each is a smith whose ObjectDesired takes weapons
// (substrate/m59-merchants.json `buying_rule`): Quintor in Jasper is seven hops from the stage
// room through 599, the Barloque smith thirteen, Colhorr in Marion thirteen.
export const WEAPON_BUYERS = Object.freeze({ 374: 'Quintor', 113: "Fehr'loi Qan", 201: 'Colhorr' });

const norm = v => String(v ?? '').trim().toLowerCase();
// A ONE-NAME HUNT COMES BACK AS A STRING. The keeper stores `hunt: "troll"` when the order named
// one creature, and an array-only comparison called that different from ['troll'] on every pass:
// every ready troll hunter was re-sent its whole deploy every two minutes (2026-09-27, both of the
// deployed hunters), which restarts its farm posture each time. A string is a list of one.
const asList = v => v == null ? null : Array.isArray(v) ? v : [v];
const sameList = (a, b) => {
  const x = asList(a), y = asList(b);
  return !!x && !!y && x.length === y.length && x.every((v, i) => norm(v) === norm(y[i]));
};

/** How many of a named item a row carries, from the free board. */
export const carried = (row, name) => (row?.pack_items ?? [])
  .filter(i => norm(i.name) === norm(name))
  .reduce((n, i) => n + (Number(i.amount) || 0), 0);

const hasReagents = row => DEDICATE.reagents.every(([n, k]) => carried(row, n) >= k);
const knows = (row, spell) => (row?.provides ?? []).some(s => norm(s) === spell);
const weaponsOf = row => (row?.weapon_magic?.weapons ?? []).filter(w => w.id != null && w.id >= 0);

/**
 * THE UNIT'S OWN RANKING, the keeper's rule restated: the index of the first priority fragment
 * the name contains, or the list length. No priority means one family — every weapon ties — which
 * is exactly how weaponRanking treats it (the magic tie-break then decides alone).
 */
export function rankFor(row) {
  const pr = row?.policy?.weaponPriority;
  if (!Array.isArray(pr) || !pr.length) return () => 0;
  return name => {
    const i = pr.findIndex(p => norm(name).includes(norm(p)));
    return i === -1 ? pr.length : i;
  };
}

/** A weapon the keeper's tie-break would actually wield for this unit: its rank or better. */
// A BANNED WEAPON IS NEVER IN THE FAMILY, whatever its rank. The keeper refuses to wield one
// (isBannedWeapon, substring, case-insensitive), so an enchanted one in the pack is not "one equip
// from ready" and a dedication spent on one is wasted. 2026-09-27: a hunter whose ban list names
// scimitar was handed an enchanted scimitar, told to wield it every pass, wielded it once by hand,
// and was back on a conjured axe inside 599 within the quarter hour.
export const isBannedFor = (row, name) => {
  const banned = row?.policy?.bannedWeapons;
  return Array.isArray(banned) && banned.some(b => norm(b) && norm(name).includes(norm(b)));
};

const inFamily = (row, w) => {
  if (isBannedFor(row, w.name)) return false;
  const rank = rankFor(row), held = row?.weapon_magic?.wielded?.name;
  if (!held) return true;
  return rank(w.name) <= rank(held);
};

export const familyMagicSpares = row =>
  weaponsOf(row).filter(w => !w.wielded && w.bypasses_nonmagic === true && inFamily(row, w)).length;

/** Is this unit ready for the troll room, and if not, why not — in words a journal can hold. */
export function trollReadiness(row, settings) {
  const mh = Number(row?.max_health);
  if (!Number.isFinite(mh)) return { ready: false, why: 'max health unknown' };
  if (mh < settings.min_max_health)
    return { ready: false, size: false, why: `max health ${mh} is under ${settings.min_max_health}` };
  if (!settings.hunt.every(q => admits(mh, settings.room, q)))
    return { ready: false, size: false, why: `the engagement ceiling at ${mh} does not admit ${settings.hunt.join(', ')} in ${settings.room}` };
  const wm = row?.weapon_magic;
  if (!wm) return { ready: false, size: true,
    why: 'the harness reports no weapon_magic for this unit (an older broker?) — refused, not assumed' };
  const spares = familyMagicSpares(row);
  if (wm.wielded?.bypasses_nonmagic !== true || spares < settings.magic_spares)
    return { ready: false, size: true, why: `wielding ${wm.wielded?.name ?? 'nothing'} ` +
      `(${wm.wielded?.class ?? 'unread'}), ${spares}/${settings.magic_spares} magic spare(s) of its own family` +
      (wm.unknown ? `, ${wm.unknown} weapon(s) not yet read` : '') };
  return { ready: true, size: true, why: 'wielding a magic weapon with enough magic spares of its family' };
}

/**
 * The weapon a dedication should take: a SPARE of the unit's own family read as mundane, real
 * before conjured (a conjured one deletes itself after power x 2 minutes, iamade.kod, and the
 * enchantment dies with it). Never the weapon in hand: the owner would stand bare for a trance.
 */
export function dedicationTarget(row) {
  const pool = weaponsOf(row).filter(w => !w.wielded && w.bypasses_nonmagic === false && inFamily(row, w));
  return pool.find(w => w.made !== true) ?? pool[0] ?? null;
}

/**
 * What this unit carries that it will never wield for the trolls: weapons of other families, and
 * REAL same-family weapons beyond what it keeps (`keep` spares, magic first, real before
 * conjured). Conjured weapons are never handed up: nobody buys them and they vanish on their own.
 */
export function surplusWeapons(row, keep) {
  const fam = weaponsOf(row).filter(w => !w.wielded && inFamily(row, w))
    .sort((a, b) => Number(b.bypasses_nonmagic === true) - Number(a.bypasses_nonmagic === true) ||
      Number(a.made === true) - Number(b.made === true) || a.id - b.id);
  const kept = new Set(fam.slice(0, keep).map(w => w.id));
  return weaponsOf(row).filter(w => !w.wielded && !kept.has(w.id) && w.made === false);
}

// TRAINING OFF IN THE TROLL ROOM (2026-09-27). Every practice style but `normal` swaps the
// weapon in hand, and the weapon in hand is the enchanted one the whole station depends on.
// A troll hunter was deployed with training_style short_sword/hammer left over from its old shift: in
// 599 the keeper tried to take the magic long sword off for a hammer bout, then walked out of the
// room to rest up mana for Create Weapon, and the rule's recall and the keeper's training walked
// him in and out for as long as it ran. `normal` fights with whatever the tie-break wields.
// THE CEILING IS PART OF EVERY DEPLOY, NOT ONLY THE GUARDIAN ONE. A Guardian order raises it; the
// ordinary order has to put it back, or a unit that left the group keeps a band that admits a
// level-120 stone troll on its own. 150% is the keeper's default (threatCeiling).
export const DEFAULT_CEILING = Object.freeze({ mode: 'percent', value: 150 });

const deployOrders = (settings, guardian = false) => ({
  to: settings.room,
  // Guardian FIRST: the keeper's quarry choice reads the list in order, so the whole group
  // turns to the Guardian that comes for it rather than splitting between it and the trolls.
  hunt: guardian ? [...settings.guardian_hunt, ...settings.hunt] : settings.hunt,
  roam: false,
  flee_below: settings.flee_below, rest_below: settings.rest_below,
  prefer_magic_weapon: true, purpose: 'advance', goals: [{ kind: 'hp' }],
  training_style: 'normal',
  threat_ceiling: guardian ? { mode: 'percent', value: settings.guardian_ceiling } : DEFAULT_CEILING,
  ...vigorOrders(settings),
});

// THE VIGOR BAND, on deploy AND stand-down: a unit waiting at the stage room is the one about to
// set out, so it eats up there rather than on the road.
const vigorOrders = settings => ({
  fight_above_vigor: settings.vigor_floor, vigor_ceiling: settings.vigor_ceiling,
  no_food_vigor_floor: settings.no_food_vigor_floor,
});
const sameVigor = (p, o) => (p.fightAboveVigor ?? null) === o.fight_above_vigor &&
  (p.vigorCeiling ?? null) === o.vigor_ceiling && (p.noFoodVigorFloor ?? null) === o.no_food_vigor_floor;

const sameCeiling = (p, o) => {
  const have = p.threatCeiling ?? DEFAULT_CEILING;
  return (have.mode ?? 'percent') === o.mode && Number(have.value) === Number(o.value);
};

const deployed = (row, o) => {
  const p = row.policy ?? {};
  return row.mode === 'farm' && p.assignedRoom === o.to && sameList(p.hunt, o.hunt) &&
    p.roam === false && p.preferMagicWeapon === true &&
    p.fleeBelow === o.flee_below && p.restBelow === o.rest_below &&
    (p.trainingStyle ?? 'normal') === o.training_style && sameCeiling(p, o.threat_ceiling) &&
    sameVigor(p, o);
};

// ---------------------------------------------------------------- the Guardians of Zjiria
//
// Three level-120 stone trolls PLACED in Ukgoth (i9.kod), same 80% NONMAGIC resistance as a troll
// and faster. Alone they killed ~200 of this fleet's characters. The operator, 2026-09-27: "The
// guardians should be killable if they group up enough and have good armor/shields." So a
// Guardian is quarry only for a GROUP: at least `guardian_group` ready units standing in the troll
// room together, each in armour and carrying a shield, each healthy. Below that nobody hunts one.
//
// Joining needs `guardian_health`; staying needs only to be clear of the flee line by a margin, so
// one blow does not dissolve the group and re-form it on the next pass.
const ARMOUR = /\barmou?r\b|\bmail\b|\bplate\b/i;
const SHIELD = /\bshield\b/i;
export const gearedForGuardians = row => Array.isArray(row?.worn) &&
  row.worn.some(n => ARMOUR.test(n)) && row.worn.some(n => SHIELD.test(n));
const healthPct = row => {
  const h = row?.health;
  if (h && Number.isFinite(Number(h.pct))) return Number(h.pct);
  if (h && Number(h.max) > 0) return Number(h.value) / Number(h.max);
  return null;
};
// asList: the keeper reports a one-creature hunt as a STRING — `.some` on it threw and took the
// whole rule down every pass from 06:54 on 2026-09-27, stopping every deploy and dedication.
const huntsGuardians = (row, s) => (asList(row?.policy?.hunt) ?? []).some(h =>
  (s.guardian_hunt ?? []).some(g => String(g).toLowerCase() === String(h).toLowerCase()));

/** Who fights Guardians this pass, and why not when nobody does. Pure. */
export function guardianGroup(units = []) {
  const on = units.filter(u => u.s?.guardians === true);
  if (!on.length) return { members: new Set(), why: null };
  const s = on[0].s;
  const eligible = on.filter(({ row, s: us, ready, free }) => {
    if (!ready || !free || row.room !== us.room || !gearedForGuardians(row)) return false;
    const hp = healthPct(row);
    if (hp == null) return false;
    return huntsGuardians(row, us) ? hp >= us.flee_below + 0.1 : hp >= us.guardian_health;
  });
  if (eligible.length >= s.guardian_group)
    return { members: new Set(eligible.map(u => u.row.agent)),
             why: `${eligible.length} armoured, shielded and healthy in ${s.room}` };
  const inRoom = on.filter(u => u.ready && u.row.room === u.s.room);
  const geared = inRoom.filter(u => gearedForGuardians(u.row));
  return { members: new Set(),
           why: `${eligible.length}/${s.guardian_group} fit to group (${inRoom.length} ready in ` +
                `${s.room}, ${geared.length} of them in armour and a shield)` };
}
const staged = (row, room, settings = null) => {
  const p = row.policy ?? {};
  return row.mode === 'idle' && p.assignedRoom === room && p.roam === false &&
    p.preferMagicWeapon === true && (!settings || sameVigor(p, vigorOrders(settings)));
};

// A TRADE THE SERVER REFUSED IS NOT RETRIED EVERY PASS. `supply` answers `supplied: false`
// with a reason rather than throwing, so nothing upstream saw it fail, and the same refused
// hand-over was planned again every 30 seconds — using up the pass's hand-over budget
// before the lend and conjure steps below it ever got a turn. The tick records each refusal
// under memory topic `supply` (see `refusedSupplies` in act/fleet-plan.mjs), keyed
// `from>to`; this skips that pair until the cooldown has run.
export const SUPPLY_REFUSAL_MS = 15 * 60_000;
export const pairKey = (from, to) => `${from}>${to}`;

/** The giver>receiver pairs refused within the cooldown, as a Set. Pure. */
export function refusedPairs(mem = {}, now = null) {
  const out = new Set();
  for (const [key, v] of Object.entries(mem ?? {})) {
    const at = Number(v?.at);
    if (!Number.isFinite(at)) continue;
    if (now == null || now - at < SUPPLY_REFUSAL_MS) out.add(key);
  }
  return out;
}

// A DEPOT LIVES AT THE STAGE ROOM, AND HAS ROOM. On 2026-09-26 the only non-fighter in room 2
// was a castle farmer — 72 health passing through, assigned to 38, pack full — so he
// was the depot, and every pass for two hours handed him scimitars the server refused
// ("<name> can't carry all the items you have offered"). So: stationed there by its own
// policy, and a pack under DEPOT_PACK_CEILING when the board says how full it is.
const DEPOT_PACK_CEILING = 80;
const hasPackRoom = r => !Number.isFinite(Number(r?.pack?.percent)) ||
  Number(r.pack.percent) < DEPOT_PACK_CEILING;

/**
 * The stage room's depot: the non-fighter STATIONED at the stage room (its assigned room) with
 * room in its pack, holding the most elderberry.
 */
export function depotIn(rows, room, fighters = new Set()) {
  return rows.filter(r => r.in_game && r.room === room && !fighters.has(r.agent) && takeable(r) &&
      !r.piloted && r.policy?.assignedRoom === room && hasPackRoom(r))
    .sort((a, b) => carried(b, 'elderberry') - carried(a, 'elderberry') ||
      carried(b, 'orc tooth') - carried(a, 'orc tooth'))[0] ?? null;
}

export const trollFleetRules = [{
  id: 'ukgoth-trolls',
  faculty: 'movement',
  scope: 'fleet',
  why: 'units on the Ukgoth Trolls strategy hunt trolls only on weapons read as magic; the stage ' +
       'room dedicates, re-arms and collects, and a courier turns the collection into money',
  enabled: doctrine => doctrine.strategies?.enabled === true,
  offWhy: 'DUM strategies are disabled',

  decide(fleetObs, doctrine) {
    const selected = strategyRows(fleetObs, doctrine, STRATEGY_IDS.UKGOTH_TROLLS);
    if (!selected.length) return { kind: 'pass', why: 'Ukgoth Trolls is off for every live unit' };
    const rows = fleetObs.characters ?? [];

    // ---- 0. the Guardian group, decided before anybody is placed
    const settingsOf = new Map(selected.map(row =>
      [row.agent, strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.UKGOTH_TROLLS)]));
    const guardians = guardianGroup(selected.map(row => ({ row, s: settingsOf.get(row.agent),
      ready: trollReadiness(row, settingsOf.get(row.agent)).ready,
      free: takeable(row) && !row.parked && !row.piloted && !activeFactionWork(fleetObs, row) })));

    // ---- 1. placement
    // AN EQUIP NEVER HOLDS UP THE REST OF THE PASS. It used to ride in `place`, so a unit whose
    // keeper kept re-wielding its conjured twin re-queued the same equip every pass and the pass
    // returned before food, gear and the dedications: 2026-09-27, from 08:44 for an hour, every pass
    // was "0 deploy(s), 0 to the stage room" and nothing was dedicated at all.
    const place = [], notes = [], equips = [];
    let busy = 0, holding = 0, working = 0;
    const atStage = [], fighters = new Set();
    let s0 = null;
    for (const row of selected) {
      const s = settingsOf.get(row.agent);
      s0 ??= s;
      const r = trollReadiness(row, s);
      if (r.size !== false) fighters.add(row.agent);
      if (!takeable(row) || row.parked || row.piloted || activeFactionWork(fleetObs, row)) {
        busy += 1; continue;
      }
      if (r.ready) {
        const g = guardians.members.has(row.agent);
        const o = deployOrders(s, g);
        if (deployed(row, o)) working += 1;
        else place.push({ do: 'deploy', agent: row.agent, ...o,
          why: g ? `Guardian group of ${guardians.members.size} (${guardians.why}): hunt ` +
                   `${o.hunt.join(', ')} in ${o.to}, ceiling ${o.threat_ceiling.value}%`
                 : `${r.why}: hunt ${o.hunt.join(', ')} in ${o.to}, roaming off, preferring magic` +
                   (guardians.why ? ` (no Guardians: ${guardians.why})` : '') });
        // A READY UNIT PASSING THROUGH THE STAGE ROOM still hands up and may still courier.
        if (row.room === s.stage_room) atStage.push({ row, s, ready: true });
        continue;
      }
      if (r.size === false) { notes.push({ agent: row.agent, why: r.why }); continue; }
      holding += 1;
      // A MAGIC SPARE OF ITS OWN FAMILY IN THE PACK AND A MUNDANE WEAPON IN HAND is one equip from
      // ready. The keeper makes that swap only in its farm pass, which a unit idling at the stage
      // room never runs — 2026-09-27, a hunter sat at the stage room "not ready" with an enchanted
      // scimitar in its pack. Ask for the equip, once per pass; the ranking's magic tie-break does
      // the rest.
      if (row.weapon_magic?.wielded?.bypasses_nonmagic !== true && familyMagicSpares(row) > 0)
        equips.push({ do: 'equip-best', agent: row.agent,
          why: 'it carries an enchanted weapon of its own family and wields a mundane one' });
      if (!staged(row, s.stage_room, s)) {
        place.push({ do: 'stand-down', agent: row.agent, assigned_room: s.stage_room, roam: false,
          ...vigorOrders(s),
          moved: row.room !== s.stage_room,
          why: `not ready for trolls (${r.why}); wait at stage room ${s.stage_room}` });
        place.push({ do: 'magic-policy', agent: row.agent,
          why: 'prefer the enchanted twin the moment a dedication hands it back' });
      }
      if (row.room === s.stage_room) atStage.push({ row, s, ready: false });
    }
    const summary = `${working} in the troll room, ${holding} held at the stage room` +
      (busy ? `, ${busy} busy` : '');
    // A PLACEMENT NO LONGER ENDS THE PASS. It used to return here, and a crew of a dozen almost
    // always has one unit to send in or recall, so the stage room's work below — hand-downs, food,
    // and the dedications — ran on perhaps one pass in five (2026-09-27: 10:22, 10:34 and 10:45 were
    // each "1 deploy(s)" and nothing else, with Raphael at full mana). The units being placed are
    // left out of the stage room's work; everyone else standing there is served in the same pass.
    const placing = new Set(place.map(p => p.agent));
    const placeWhy = place.length
      ? `${place.filter(p => p.do === 'deploy').length} deploy(s), ` +
        `${place.filter(p => p.do === 'stand-down').length} to the stage room` : null;
    const served = atStage.filter(x => !placing.has(x.row.agent));

    // ---- 2. courier (an errand of its own, so only on a pass that places nobody)
    const courier = place.length ? { why: null }
      : planCourier(atStage, rows, fighters, s0, fleetObs.memory?.trolls ?? {}, fleetObs.at);
    if (courier.errand) return courier.errand;

    // ---- 3. supply, then 4. the dedications (one per free dedicator, up to dedications_per_pass)
    const refused = refusedPairs(fleetObs.memory?.supply, fleetObs.at);
    const gear = s0?.share_gear === false ? { plan: [], summary: null }
      : planGear(served, rows, { refused });
    const food = planFood(served, rows, { refused });
    const supply = planSupply(served, rows, fighters, { refused });
    const round = planDedication(served.filter(x => !x.ready && x.s.dedicate), rows,
      { refused, max: s0?.dedications_per_pass ?? 1 });
    const plan = [...place, ...equips, ...gear.plan, ...food.plan, ...supply.plan, ...round.plan];
    if (!plan.length)
      return { kind: 'pass', why: [summary, courier.why, supply.why, round.why].filter(Boolean).join('; ') };
    return { kind: 'act', plan, notes,
      why: [placeWhy, equips.length ? `${equips.length} to wield the enchanted twin` : null, gear.summary, food.summary, supply.plan.length ? supply.summary : null,
            round.plan.length ? `dedication (${round.summary})` : null].filter(Boolean).join('; ') };
  },
}];

/**
 * THE DEPOT'S LOOT, WALKED TO A BUYER. Pure. Returns `{errand}` when one is due, else `{why}`.
 *
 * Only REAL weapons go (a conjured one is refused by every merchant, item.kod:1110-1126), and the
 * depot keeps `depot_keep` of each name as stock for the units that need a family weapon. The
 * courier is the healthiest takeable fighter standing in the stage room; its road is through 599,
 * so it must be near full health.
 */
export function planCourier(atStage, rows, fighters, s, mem = {}, now = null) {
  if (!s?.courier) return { why: null };
  const room = s.stage_room;
  const depot = depotIn(rows, room, fighters);
  if (!depot) return { why: 'no depot in the stage room' };
  const byName = new Map();
  for (const w of weaponsOf(depot).filter(w => w.made === false && !w.wielded)) {
    if (!byName.has(w.name)) byName.set(w.name, []);
    byName.get(w.name).push(w);
  }
  const sell = [...byName.values()].flatMap(ws => ws.slice(s.depot_keep));
  if (sell.length < s.courier_min_items)
    return { why: `the depot holds ${sell.length}/${s.courier_min_items} real weapons to sell` };
  const last = Number(mem.courier_last_at ?? 0);
  const cool = s.courier_every_min * 60_000;
  if (now != null && last && now - last < cool)
    return { why: `courier cooldown: next run in ${Math.ceil((cool - (now - last)) / 60_000)} min` };
  const buyer = WEAPON_BUYERS[s.courier_room];
  if (!buyer) return { why: `room ${s.courier_room} has no known weapon buyer` };
  const courier = atStage.map(x => x.row)
    .filter(r => r.agent !== depot.agent && fighters.has(r.agent) && takeable(r) && !r.piloted &&
      (r.health?.pct ?? 0) >= s.courier_health)
    .sort((a, b) => (b.health?.pct ?? 0) - (a.health?.pct ?? 0) || String(a.agent).localeCompare(b.agent))[0];
  if (!courier) return { why: `${sell.length} weapons wait in the depot; no unit in ${room} is ` +
    `at ${Math.round(s.courier_health * 100)}% health to carry them` };
  const ids = sell.slice(0, 20).map(w => w.id);
  const agent = courier.agent;
  return { errand: {
    kind: 'errand',
    orders: {
      errand: 'troll-courier', agent,
      label: `Ukgoth loot to ${buyer} (${ids.length})`,
      context: { depot: depot.agent, buyer, room: s.courier_room, back: room, ids },
      steps: [
        { tool: 'supply', args: { from: depot.agent, to: agent, what: ids.map(id => ({ id, amount: 1 })),
            who_travels: 'neither' }, timeout_ms: 180_000, estimate_ms: 30_000,
          why: `take ${ids.length} real weapon(s) off the depot` },
        { tool: 'travel', args: { agent, to: s.courier_room, run_errands: false }, expect: 'arrived',
          timeout_ms: 900_000, estimate_ms: 400_000, why: `carry them to ${buyer}` },
        { tool: 'sell', args: { agent, to: buyer, items: ids }, optional: true,
          timeout_ms: 180_000, estimate_ms: 30_000, why: `sell them to ${buyer}` },
        { tool: 'travel', args: { agent, to: room, run_errands: false }, always: true, expect: 'arrived',
          timeout_ms: 900_000, estimate_ms: 400_000, why: 'back to the stage room, sold or not' },
      ],
    },
    why: `the depot holds ${sell.length} real weapons beyond its stock; ${agent} ` +
      `(${Math.round((courier.health?.pct ?? 0) * 100)}% health) carries ${ids.length} to ${buyer} in ${s.courier_room}`,
    evidence: { depot: depot.agent, ids, buyer },
  } };
}

// The memory writer lives in trolls-record.mjs (see there for why); re-exported here.
export { recordTrollCourier } from './trolls-record.mjs';

/**
 * THE STAGE ROOM'S HAND-OVERS, all by object id. Pure. A few per pass (each is a `supply`, a
 * verified two-sided trade), and no cast but the self-cast Create Weapon fallback.
 */
/**
 * ARMOUR AND A SHIELD FOR EVERY HUNTER, from whoever in the stage room carries a spare. Pure.
 *
 * The Guardian group admits only units in armour with a shield, and the crew farmed the orcs that
 * drop both — so the gear is mostly already in somebody's pack, unworn. A spare is a pack count
 * above what that unit wears of the same name (pack_items counts the worn one too). Handed over by
 * NAME: the harness never offers a worn item by name and refuses gear when the use list is unknown.
 * Then the receiver puts it on (wear_best). At most `max` hand-overs a pass.
 */
export function planGear(atStage, rows, { max = 4, refused = new Set() } = {}) {
  const plan = [];
  const lent = new Map();                      // donor>name -> how many promised this pass
  // Only normal-grade gear: magic loot (uncommon/rare/legendary, unidentified, cursed) is revealed
  // and kept, never worn (operator, 2026-09-27), so it is never a spare to hand out either.
  const spares = (r, re) => (r.pack_items ?? []).filter(i => re.test(String(i.name ?? '')) &&
      (i.rarity == null || Number(i.rarity) === 0))
    .map(i => ({ name: String(i.name), n: (Number(i.amount) || 0) -
      ((r.worn ?? []).filter(w => norm(w) === norm(i.name)).length) -
      (lent.get(`${r.agent}>${norm(i.name)}`) ?? 0) }))
    .filter(x => x.n > 0);
  // A SLOT A UNIT HAS EMPTY IS NOT ONE IT CAN LEND FROM. 2026-09-27, the first live pass: a unit
  // carrying its own shield unworn was listed as shieldless AND as the donor of that same shield,
  // so it gave it away and was handed somebody else's. Carrying one unworn means: put it on.
  const emptySlot = (r, re) => Array.isArray(r.worn) && !r.worn.some(n => re.test(n));
  const wearOwn = new Set();
  for (const { row, s } of atStage) {
    if (plan.length >= max * 2) break;
    if (!Array.isArray(row.worn)) continue;     // unknown gear: ask again next pass
    for (const [re, what] of [[ARMOUR, 'armour'], [SHIELD, 'shield']]) {
      if (row.worn.some(n => re.test(n))) continue;
      if (spares(row, re).length) { wearOwn.add(row.agent); continue; }
      const donor = rows.filter(r => r.in_game && r.room === s.stage_room && r.agent !== row.agent &&
          takeable(r) && !r.piloted && Array.isArray(r.worn) && !emptySlot(r, re) &&
          !refused.has(pairKey(r.agent, row.agent)))
        .map(r => ({ r, have: spares(r, re) })).find(x => x.have.length);
      if (!donor) continue;
      const item = donor.have[0].name;
      const key = `${donor.r.agent}>${norm(item)}`;
      lent.set(key, (lent.get(key) ?? 0) + 1);
      plan.push({ do: 'give-gear', from: donor.r.agent, to: row.agent, item,
        why: `${row.agent} has no ${what}; ${donor.r.agent} carries a spare ${item}` });
    }
    if (plan.some(p => p.to === row.agent) || wearOwn.has(row.agent))
      plan.push({ do: 'wear-best', agent: row.agent, why: wearOwn.has(row.agent) && !plan.some(p => p.to === row.agent)
        ? 'it carries armour or a shield it is not wearing — put it on'
        : 'put on the armour and shield just handed over' });
  }
  const gave = plan.filter(p => p.do === 'give-gear').length;
  const worn = [...wearOwn].length;
  return { plan, summary: gave || worn
    ? [gave ? `${gave} armour/shield handed out` : null, worn ? `${worn} told to wear their own` : null]
        .filter(Boolean).join(', ') : null };
}

// THE CREW'S FOOD, pooled at the stage room (operator, 2026-09-27: "troll hunters should be keeping
// 160+ vigor being fed off inky-cap mushrooms, meat pies, and bread"). The keeper eats up to the
// ceiling once under the floor, but only from its own pack, and the food sits with whoever looted or
// bought it. Nutrition is the vigor a bite returns (food.kod): inky-cap 50, meat pie 30, bread 20.
export const CREW_FOODS = Object.freeze([['Inky-cap mushroom', 50], ['meat pie', 30], ['loaf of bread', 20]]);
export const crewLarder = row => CREW_FOODS.reduce((n, [name, v]) => n + carried(row, name) * v, 0);
const vigorOf = row => Number(row?.vigor?.value ?? row?.vigor);

/**
 * Top up the hungry from the fed, inside the stage room. Pure. A unit under its vigor floor with
 * less than `low` vigor of crew food is brought to about `target`; a donor keeps `keep`.
 */
export function planFood(atStage, rows, { low = 200, target = 300, keep = 300, max = 4,
                                          refused = new Set() } = {}) {
  const plan = [];
  const vigorGiven = new Map();                    // donor -> vigor promised this pass
  const itemsGiven = new Map();                    // donor>food -> how many promised this pass
  const left = r => crewLarder(r) - keep - (vigorGiven.get(r.agent) ?? 0);
  for (const { row, s } of atStage) {
    if (plan.length >= max) break;
    const vigor = vigorOf(row);
    if (!Number.isFinite(vigor) || vigor >= (s.vigor_floor ?? 160)) continue;
    if (crewLarder(row) >= low) continue;
    let need = target - crewLarder(row);
    const donors = rows.filter(r => r.in_game && r.room === s.stage_room && r.agent !== row.agent &&
        takeable(r) && !r.piloted && !refused.has(pairKey(r.agent, row.agent)) && left(r) > 0)
      .sort((x, y) => left(y) - left(x));
    for (const d of donors) {
      for (const [name, v] of CREW_FOODS) {
        if (need <= 0 || plan.length >= max) break;
        const key = `${d.agent}>${name}`;
        const have = carried(d, name) - (itemsGiven.get(key) ?? 0);
        const n = Math.min(have, Math.ceil(need / v), Math.floor(left(d) / v));
        if (n <= 0) continue;
        plan.push({ do: 'give-reagent', from: d.agent, to: row.agent, item: name, amount: n,
          why: `${row.agent} is at ${vigor} vigor with ${crewLarder(row)} of food; ${d.agent} can spare ${n} ${name}` });
        need -= n * v;
        itemsGiven.set(key, (itemsGiven.get(key) ?? 0) + n);
        vigorGiven.set(d.agent, (vigorGiven.get(d.agent) ?? 0) + n * v);
      }
      if (need <= 0) break;
    }
  }
  const fed = new Set(plan.map(p => p.to)).size;
  return { plan, summary: fed ? `food for ${fed}` : null };
}

export function planSupply(atStage, rows, fighters, { max = 4, refused = new Set() } = {}) {
  const plan = [];
  if (!atStage.length) return { plan, why: null };
  const s = atStage[0].s;
  const depot = depotIn(rows, s.stage_room, fighters);
  const given = new Set();
  const ok = (from, to) => !refused.has(pairKey(from, to));
  // DOWN BEFORE UP. A hand-down or a conjure is what gets a unit armed; a hand-up only tidies.
  // With UP first, a crew carrying nine spare long swords spent the whole `max` every pass
  // tidying, and nobody was ever armed.
  //
  // DOWN: a family weapon for a unit with too few magic spares — from the depot, or from a CREW
  // MATE. Operator, 2026-09-26: everyone at 75+ runs this, "so they may need to coordinate
  // exchanging enchanted weapons". With the whole crew above the line there is no non-fighter to
  // be the depot, so a fighter at the stage room lends from its SURPLUS — never from what it keeps
  // for itself (magic_spares + 1 of its own family, magic first) — which is how an axe trainee's
  // looted magic hammer reaches the hammer trainee standing beside it.
  const bestFirst = (a, b) => Number(b.bypasses_nonmagic === true) - Number(a.bypasses_nonmagic === true) ||
    Number(a.made === true) - Number(b.made === true);
  for (const { row, s: st, ready } of atStage) {
    if (ready || plan.length >= max) continue;
    // AT LEAST ONE, whatever `magic_spares` says. This unit is NOT READY — a mundane weapon in hand —
    // so with no magic spare it needs one handed down or dedicated. `magic_spares: 0` (a single
    // enchanted weapon is enough to hunt) made this `0 >= 0` for every unit, and 2026-09-27 seven
    // units waited at the stage room with one weapon each while the depot held six long swords.
    if (familyMagicSpares(row) >= Math.max(1, Number(st.magic_spares) || 0)) continue;
    // A unit that already has a mundane spare to dedicate takes only a MAGIC one: that saves a
    // dedication; another mundane weapon would only queue a second one.
    const onlyMagic = !!dedicationTarget(row);
    const fits = w => !w.wielded && !given.has(w.id) && inFamily(row, w) &&
      (!onlyMagic || w.bypasses_nonmagic === true);
    const sources = [
      ...(depot ? [{ agent: depot.agent, pool: weaponsOf(depot), from: 'the depot' }] : []),
      ...atStage.filter(x => x.row.agent !== row.agent)
        .map(x => ({ agent: x.row.agent, pool: surplusWeapons(x.row, x.s.magic_spares + 1), from: x.row.agent })),
    ];
    let lent = null;
    for (const src of sources) {
      if (!ok(src.agent, row.agent)) continue;
      const w = src.pool.filter(fits).sort(bestFirst)[0];
      if (w && (!lent || bestFirst(w, lent.w) < 0)) lent = { src, w };
    }
    if (lent) {
      plan.push({ do: 'give-weapon', from: lent.src.agent, to: row.agent, what: [{ id: lent.w.id, amount: 1 }],
        weapon: lent.w.name, why: `${row.agent} is short of ${lent.w.bypasses_nonmagic ? 'magic ' : ''}` +
          `${row.weapon_magic?.wielded?.name ?? 'family'} spares; ${lent.src.from} has one to spare` });
      given.add(lent.w.id);
      continue;
    }
    if (onlyMagic) continue;             // it will be dedicated instead
    if (knows(row, CREATE.spell) && (row.mana?.value ?? 0) >= CREATE.mana && weaponsOf(row).length < 4)
      plan.push({ do: 'cast-create-weapon', agent: row.agent,
        why: `${row.agent} has no spare of its family to dedicate; conjure one (the family is a roll — ` +
          'a mismatch is handed up next pass)' });
  }
  // UP: surplus to the depot, with whatever of the budget is left.
  if (depot) for (const { row, s: st } of atStage) {
    if (!ok(row.agent, depot.agent)) continue;
    for (const w of surplusWeapons(row, st.magic_spares + 1)) {
      if (plan.length >= max) break;
      if (given.has(w.id)) continue;
      plan.push({ do: 'give-weapon', from: row.agent, to: depot.agent, what: [{ id: w.id, amount: 1 }],
        weapon: w.name, why: `${row.agent} will never wield this ${w.name} for the trolls; the depot keeps it` });
      given.add(w.id);
    }
  }
  const up = depot ? plan.filter(p => p.do === 'give-weapon' && p.to === depot.agent).length : 0;
  const down = depot ? plan.filter(p => p.do === 'give-weapon' && p.from === depot.agent).length : 0;
  const lentN = plan.filter(p => p.do === 'give-weapon' && (!depot || (p.from !== depot.agent && p.to !== depot.agent))).length;
  const cast = plan.filter(p => p.do === 'cast-create-weapon').length;
  return { plan, summary: `${up} up to the depot, ${down} down from it, ${lentN} lent between the crew, ${cast} conjured`,
    why: plan.length ? null : (depot ? 'nothing to hand over' : 'nothing to hand over, and no depot in the stage room') };
}

/**
 * The one dedication this pass, or none with the reason. Pure.
 *
 * The owner's weapon goes to a dedicator in the SAME room (a hand-over is one room — the ghost
 * raid lost four dedications to "not in the room"), the dedicator casts at the weapon by id, and
 * the weapon goes back whether or not the cast landed. A depot top-up comes first when the
 * dedicator is short of reagents.
 */
export function planDedication(needers = [], rows = [], { refused = new Set(), max = 1 } = {}) {
  if (!needers.length) return { plan: [], why: null };
  // SEVERAL ROUNDS A PASS, one per free dedicator (operator, 2026-09-27: "do any changes you
  // need"). An enchantment lapses in hours and a round lands only on the fizzle roll, so one round
  // a pass could not keep four hunters enchanted at once. Each round still has its own dedicator
  // held still for its own trance; the rounds run one after another inside the pass.
  const rounds = [], summaries = [], usedCasters = new Set();
  let reagentWhy = null;
  for (const { row, s } of needers) {
    if (summaries.length >= Math.max(1, Number(max) || 1)) break;
    const w = dedicationTarget(row);
    if (!w) continue;
    const here = rows.filter(r => r.in_game && r.room === s.stage_room && r.agent !== row.agent &&
      takeable(r) && !r.piloted && !refused.has(pairKey(row.agent, r.agent)));
    // THE BEST DEDICATOR FIRST, THEN THE ONE THAT CAN PAY. Ability is the fizzle roll: the first
    // round that ran its whole trance went to a crew dedicator (enchant weapon 5, more mana) over the stage caster
    // (20) and spent 3 elderberry and an orc tooth on nothing. A missing reading ranks as 0.
    const skill = r => Number(r?.provides_ability?.[DEDICATE.spell]) || 0;
    const casters = here.filter(r => !usedCasters.has(r.agent) &&
        knows(r, DEDICATE.spell) && (r.mana?.value ?? 0) >= DEDICATE.mana)
      .sort((a, b) => skill(b) - skill(a) || Number(hasReagents(b)) - Number(hasReagents(a)) ||
        (b.mana?.value ?? 0) - (a.mana?.value ?? 0));
    const d = casters[0];
    if (!d) continue;
    // THE DEDICATOR IS HELD FOR THE WHOLE ROUND and woken only by the hand-back. Awake between
    // steps, its keeper wielded the weapon it was handed and the hand-back was refused (the
    // first live round, 2026-09-26) — and any action inside the 30-second trance breaks it.
    const held = [d.agent];
    const plan = [{ do: 'inert-keeper', agent: d.agent,
      why: `${d.agent} dedicates: held still from the hand-over until the weapon is back` }];
    if (!hasReagents(d)) {
      const depot = here.filter(r => r.agent !== d.agent && hasReagents(r))
        .sort((a, b) => carried(b, 'orc tooth') - carried(a, 'orc tooth'))[0];
      if (!depot) {
        reagentWhy = `${d.agent} could dedicate but nobody in ${s.stage_room} ` +
          'holds 3 elderberry and 1 orc tooth to hand it';
        continue;
      }
      for (const [item, n] of DEDICATE.reagents) {
        const short = Math.max(0, n - carried(d, item));
        if (short) plan.push({ do: 'give-reagent', from: depot.agent, to: d.agent, item, amount: short,
          keep_held: held, why: `${d.agent} needs ${n} ${item} for one dedication` });
      }
    }
    plan.push(
      { do: 'give-weapon', from: row.agent, to: d.agent, what: [{ id: w.id, amount: 1 }], weapon: w.name,
        keep_held: held,
        why: `${row.agent}'s ${w.name} is read as mundane; ${d.agent} dedicates it to Kraanan` },
      { do: 'cast-enchant-weapon', agent: d.agent, target: w.id,
        why: `enchant weapon on ${row.agent}'s ${w.name}: trolls resist NONMAGIC 80` },
      { do: 'give-weapon', from: d.agent, to: row.agent, what: [{ id: w.id, amount: 1 }], weapon: w.name,
        why: 'the weapon goes back whether or not the dedication landed' },
      { do: 'equip-best', agent: row.agent, why: 'wield the dedicated weapon (prefer_magic_weapon breaks the tie)' },
    );
    usedCasters.add(d.agent);
    rounds.push(...plan);
    summaries.push(`${row.agent}'s ${w.name} by ${d.agent}`);
  }
  if (rounds.length) return { plan: rounds, summary: summaries.join(', '), why: null };
  if (reagentWhy) return { plan: [], why: reagentWhy };
  const anyTarget = needers.some(({ row }) => dedicationTarget(row));
  return { plan: [], why: anyTarget
    ? 'no dedicator in the stage room with 17 mana who knows enchant weapon'
    : 'no unit at the stage room carries a mundane spare of its own family yet (the keeper reads ' +
      'unread weapons first; the depot or Create Weapon supplies one)' };
}
