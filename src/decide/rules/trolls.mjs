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
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]));

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
const inFamily = (row, w) => {
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

const deployOrders = (settings) => ({
  to: settings.room, hunt: settings.hunt, roam: false,
  flee_below: settings.flee_below, rest_below: settings.rest_below,
  prefer_magic_weapon: true, purpose: 'advance', goals: [{ kind: 'hp' }],
});

const deployed = (row, o) => {
  const p = row.policy ?? {};
  return row.mode === 'farm' && p.assignedRoom === o.to && sameList(p.hunt, o.hunt) &&
    p.roam === false && p.preferMagicWeapon === true &&
    p.fleeBelow === o.flee_below && p.restBelow === o.rest_below;
};
const staged = (row, room) => {
  const p = row.policy ?? {};
  return row.mode === 'idle' && p.assignedRoom === room && p.roam === false &&
    p.preferMagicWeapon === true;
};

/** The stage room's depot: the co-located non-fighter holding the most elderberry. */
export function depotIn(rows, room, fighters = new Set()) {
  return rows.filter(r => r.in_game && r.room === room && !fighters.has(r.agent) && takeable(r) && !r.piloted)
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

    // ---- 1. placement
    const place = [], notes = [];
    let busy = 0, holding = 0, working = 0;
    const atStage = [], fighters = new Set();
    let s0 = null;
    for (const row of selected) {
      const s = strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.UKGOTH_TROLLS);
      s0 ??= s;
      const r = trollReadiness(row, s);
      if (r.size !== false) fighters.add(row.agent);
      if (!takeable(row) || row.parked || row.piloted || activeFactionWork(fleetObs, row)) {
        busy += 1; continue;
      }
      if (r.ready) {
        const o = deployOrders(s);
        if (deployed(row, o)) working += 1;
        else place.push({ do: 'deploy', agent: row.agent, ...o,
          why: `${r.why}: hunt ${o.hunt.join(', ')} in ${o.to}, roaming off, preferring magic` });
        // A READY UNIT PASSING THROUGH THE STAGE ROOM still hands up and may still courier.
        if (row.room === s.stage_room) atStage.push({ row, s, ready: true });
        continue;
      }
      if (r.size === false) { notes.push({ agent: row.agent, why: r.why }); continue; }
      holding += 1;
      if (!staged(row, s.stage_room)) {
        place.push({ do: 'stand-down', agent: row.agent, assigned_room: s.stage_room, roam: false,
          moved: row.room !== s.stage_room,
          why: `not ready for trolls (${r.why}); wait at stage room ${s.stage_room}` });
        place.push({ do: 'magic-policy', agent: row.agent,
          why: 'prefer the enchanted twin the moment a dedication hands it back' });
      }
      if (row.room === s.stage_room) atStage.push({ row, s, ready: false });
    }
    const summary = `${working} in the troll room, ${holding} held at the stage room` +
      (busy ? `, ${busy} busy` : '');
    if (place.length)
      return { kind: 'act', plan: place, notes,
        why: `${place.filter(p => p.do === 'deploy').length} deploy(s), ` +
          `${place.filter(p => p.do === 'stand-down').length} to the stage room` };

    // ---- 2. courier
    const courier = planCourier(atStage, rows, fighters, s0, fleetObs.memory?.trolls ?? {}, fleetObs.at);
    if (courier.errand) return courier.errand;

    // ---- 3. supply, then 4. one dedication
    const supply = planSupply(atStage, rows, fighters);
    const round = planDedication(atStage.filter(x => !x.ready && x.s.dedicate), rows);
    const plan = [...supply.plan, ...round.plan];
    if (!plan.length)
      return { kind: 'pass', why: [summary, courier.why, supply.why, round.why].filter(Boolean).join('; ') };
    return { kind: 'act', plan, notes,
      why: [supply.plan.length ? supply.summary : null,
            round.plan.length ? `one dedication (${round.summary})` : null].filter(Boolean).join('; ') };
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
export function planSupply(atStage, rows, fighters, { max = 4 } = {}) {
  const plan = [];
  if (!atStage.length) return { plan, why: null };
  const s = atStage[0].s;
  const depot = depotIn(rows, s.stage_room, fighters);
  const given = new Set();
  // UP: surplus to the depot.
  if (depot) for (const { row, s: st } of atStage) {
    for (const w of surplusWeapons(row, st.magic_spares + 1)) {
      if (plan.length >= max) break;
      plan.push({ do: 'give-weapon', from: row.agent, to: depot.agent, what: [{ id: w.id, amount: 1 }],
        weapon: w.name, why: `${row.agent} will never wield this ${w.name} for the trolls; the depot keeps it` });
      given.add(w.id);
    }
  }
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
    if (familyMagicSpares(row) >= st.magic_spares) continue;
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
export function planDedication(needers = [], rows = []) {
  if (!needers.length) return { plan: [], why: null };
  for (const { row, s } of needers) {
    const w = dedicationTarget(row);
    if (!w) continue;
    const here = rows.filter(r => r.in_game && r.room === s.stage_room && r.agent !== row.agent &&
      takeable(r) && !r.piloted);
    const casters = here.filter(r => knows(r, DEDICATE.spell) && (r.mana?.value ?? 0) >= DEDICATE.mana)
      .sort((a, b) => Number(hasReagents(b)) - Number(hasReagents(a)) ||
        (b.mana?.value ?? 0) - (a.mana?.value ?? 0));
    const d = casters[0];
    if (!d) continue;
    const plan = [];
    if (!hasReagents(d)) {
      const depot = here.filter(r => r.agent !== d.agent && hasReagents(r))
        .sort((a, b) => carried(b, 'orc tooth') - carried(a, 'orc tooth'))[0];
      if (!depot) return { plan: [], why: `${d.agent} could dedicate but nobody in ${s.stage_room} ` +
        'holds 3 elderberry and 1 orc tooth to hand it' };
      for (const [item, n] of DEDICATE.reagents) {
        const short = Math.max(0, n - carried(d, item));
        if (short) plan.push({ do: 'give-reagent', from: depot.agent, to: d.agent, item, amount: short,
          why: `${d.agent} needs ${n} ${item} for one dedication` });
      }
    }
    plan.push(
      { do: 'give-weapon', from: row.agent, to: d.agent, what: [{ id: w.id, amount: 1 }], weapon: w.name,
        why: `${row.agent}'s ${w.name} is read as mundane; ${d.agent} dedicates it to Kraanan` },
      { do: 'cast-enchant-weapon', agent: d.agent, target: w.id,
        why: `enchant weapon on ${row.agent}'s ${w.name}: trolls resist NONMAGIC 80` },
      { do: 'give-weapon', from: d.agent, to: row.agent, what: [{ id: w.id, amount: 1 }], weapon: w.name,
        why: 'the weapon goes back whether or not the dedication landed' },
      { do: 'equip-best', agent: row.agent, why: 'wield the dedicated weapon (prefer_magic_weapon breaks the tie)' },
    );
    return { plan, summary: `${row.agent}'s ${w.name} by ${d.agent}`, why: null };
  }
  const anyTarget = needers.some(({ row }) => dedicationTarget(row));
  return { plan: [], why: anyTarget
    ? 'no dedicator in the stage room with 17 mana who knows enchant weapon'
    : 'no unit at the stage room carries a mundane spare of its own family yet (the keeper reads ' +
      'unread weapons first; the depot or Create Weapon supplies one)' };
}
