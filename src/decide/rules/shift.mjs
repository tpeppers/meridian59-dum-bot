// THE HUNTING SHIFT — which rooms the fleet works, and in what proportion.
//
// Deliberately much smaller than the Castle Victoria shift it replaces, because it has
// only one job: put every unit that opted into Short swording in the crypt room that
// generates the quarry its engagement ceiling admits, with roaming OFF, and leave it
// there. No two-room balancing, no safe-wall cap, no crate rotation.
//
// ROAMING OFF IS THE SAFETY PROPERTY, NOT A PREFERENCE. Room 2602 is one door from 2601
// and generates thrashers at level 150, rating 870, cap 15. The fleet's ceiling is 90.
// A keeper that goes looking for absent prey and wanders through that door does not come
// back — this is the exact failure the soldier-hunting note in the harness records, where
// re-tasking to a creature that was not there sent characters into the Decaying City of
// Brax. So the room is pinned and `roam` is false, together, always.
//
// And the quarry is resolved FROM the room table rather than named here: a unit whose
// ceiling cannot admit the level-75 skeleton falls through to the level-40 spectral mummy
// in 2600 instead of being sent to a room where it will refuse everything that appears.

import { STRATEGY_IDS, strategyEnabled, HUNT_ROOMS, admits, engagementCeiling }
  from '../../strategies/catalog.mjs';
import { activeFactionWork } from './factions.mjs';
import { keeperWeaponPriority } from '../weapons.mjs';
import { takeable } from '../engine.mjs';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Split the opted-in units across the doctrine's stations by share, and give each one the
 * station its engagement ceiling actually admits.
 *
 * THE SHARE IS ALLOCATED OVER THE UNITS A STATION CAN TAKE, NOT OVER ALL OF THEM. A 75/25
 * split of twenty-one characters where four of them cannot fight the first station's
 * quarry is not 75% of twenty-one — it is 75% of the seventeen that can. Allocating first
 * and filtering afterwards silently shrinks the fleet, and the units that fall out are the
 * small ones, which are exactly the ones somebody is watching.
 *
 * The order is by level then agent, so it is stable across ticks: a unit must not be
 * reassigned to the other end of the world because somebody else levelled.
 */
export function shiftAssignments(rows = [], doctrine = {}, fleetObs = { characters: rows }) {
  const stations = (doctrine.shift?.stations ?? []).filter(st => st && st.room != null);
  const ordered = [...rows].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) ||
    String(a.agent).localeCompare(String(b.agent)));

  const opted = ordered.filter(row =>
    strategyEnabled(fleetObs, doctrine, row.agent, STRATEGY_IDS.SHORT_SWORDING));
  const out = new Map(ordered.map(row => [row.agent,
    { row, to: null, why: 'Short swording is not selected for this unit' }]));

  // Per station, who could work it at all. Computed before any allocation so a share is a
  // share of the eligible, and a unit eligible for nothing is named rather than absorbed.
  const eligible = stations.map(st => new Set(opted
    .filter(row => admits(row.level, Number(st.room), st.hunt)).map(row => row.agent)));

  const taken = new Set();
  stations.forEach((st, i) => {
    const share = Number(st.share);
    const pool = opted.filter(row => eligible[i].has(row.agent) && !taken.has(row.agent));
    // The last station takes the remainder rather than its own rounded share, so the
    // shares cannot lose or duplicate a unit to rounding.
    // `max` IS A CAPACITY AND IT BEATS THE SHARE, because that is what "overflow" means:
    // fill this room, and when it is full the rest go to the next station. A share alone
    // cannot say that — it would put a fixed proportion in each room however crowded the
    // first one got. The last station has no cap and absorbs whatever is left, which is
    // why it must be the one you are willing to have everybody in.
    const cap = Number.isFinite(Number(st.max)) ? Number(st.max) : Infinity;
    const want = Math.min(cap, i === stations.length - 1 ? pool.length
      : Math.round(opted.filter(row => eligible[i].has(row.agent)).length *
          (Number.isFinite(share) ? share : 0)));
    for (const row of pool.slice(0, Math.max(0, want))) {
      const entry = HUNT_ROOMS[Number(st.room)];
      taken.add(row.agent);
      out.set(row.agent, { row, to: entry.room, hunt: st.hunt, room_name: entry.name,
        // Sized to the ROOM's strongest occupant, never to the quarry.
        max_threat_over: Math.max(0, entry.threat - (row.level ?? entry.threat)) });
    }
  });

  // Anybody opted in and still unplaced falls back to whatever station admits it, so a
  // unit too small for the first quarry works the second rather than standing idle.
  for (const row of opted) {
    if (taken.has(row.agent)) continue;
    // The fallback honours capacity too, or an overflowed unit would be handed straight
    // back to the room it overflowed out of.
    const filled = new Map();
    for (const a of out.values()) if (a.to != null) filled.set(a.to, (filled.get(a.to) ?? 0) + 1);
    const i = stations.findIndex((st, idx) => eligible[idx].has(row.agent) &&
      (filled.get(Number(st.room)) ?? 0) < (Number.isFinite(Number(st.max)) ? Number(st.max) : Infinity));
    if (i < 0) {
      out.set(row.agent, { row, to: null,
        why: `no station admits this unit at ${row.level} max health ` +
             `(ceiling ${engagementCeiling(row.level)})` });
      continue;
    }
    const st = stations[i], entry = HUNT_ROOMS[Number(st.room)];
    out.set(row.agent, { row, to: entry.room, hunt: st.hunt, room_name: entry.name,
      max_threat_over: Math.max(0, entry.threat - (row.level ?? entry.threat)) });
  }

  return ordered.map(row => out.get(row.agent));
}

const needsOrders = (row, orders) => {
  const p = row.policy ?? {};
  return row.mode !== 'farm' || p.assignedRoom !== orders.to || p.hunt !== orders.hunt ||
    p.roam !== false || p.purpose !== 'advance';
};

export const shiftFleetRules = [{
  id: 'hunt-shift',
  faculty: 'work',
  scope: 'fleet',
  enabled: doctrine => doctrine.shift?.on === true,
  offWhy: 'shift.on is off',
  why: 'units running Short swording belong in a crypt room that generates their quarry, with roaming off',
  decide(observation, doctrine) {
    const live = (observation.characters ?? []).filter(r => r.in_game);
    if (!live.length) return { kind: 'pass', why: 'nobody in game' };

    const assignments = shiftAssignments(live, doctrine, observation);
    const placeable = assignments.filter(a => a.to != null);
    if (!placeable.length)
      return { kind: 'pass', why: assignments[0]?.why ?? 'no unit has Short swording selected' };

    // BUSY AND SETTLED ARE DIFFERENT ANSWERS AND MUST NOT SHARE A SENTENCE. Both produce
    // an empty plan, and reporting "already hold their station orders" for a unit that was
    // actually stepped over mid-errand is the kind of line that gets believed — it says
    // the retarget landed when it has not started.
    let busy = 0;
    const plan = placeable.flatMap(a => {
      // A unit mid-errand is stepped over rather than re-deployed. Both of these walk a
      // character across the world, and the loser is whichever one is interrupted.
      if (!takeable(a.row) || a.row.parked || a.row.piloted ||
          activeFactionWork(observation, a.row)) { busy += 1; return []; }
      const orders = { to: a.to, hunt: a.hunt };
      if (!needsOrders(a.row, orders)) return [];
      return [{
        do: 'deploy', agent: a.row.agent, to: a.to, hunt: a.hunt,
        roam: false, purpose: 'advance',
        // `purpose` without `goals` is not a working audit — `yieldCheck` answers
        // "purpose is `advance` but no goals are set, so nothing can be checked" and the
        // row renders as not paying whatever the quarry is.
        goals: [{ kind: 'hp' }],
        weapon_priority: keeperWeaponPriority('shortSwording', doctrine.weapons?.presets),
        max_threat_over: a.max_threat_over,
        flee_below: doctrine.shift.flee_below,
        rest_below: doctrine.shift.rest_below,
        fight_above_vigor: doctrine.shift.fight_above_vigor,
        use_safe_spots: doctrine.shift.use_safe_spots !== false,
        why: `${a.hunt} in ${a.room_name} (${a.to}), roaming off — 2602 is thrashers at level 150`,
      }];
    });

    if (!plan.length)
      return { kind: 'pass', why: busy
        ? `${busy} of ${placeable.length} unit(s) are mid-errand; the rest hold their station orders`
        : `${placeable.length} unit(s) already hold their station orders` };
    return { kind: 'act', plan,
      why: `deploy ${plan.length} unit(s) into their assigned stations`,
      evidence: { rooms: [...new Set(placeable.map(a => a.to))],
        quarry: [...new Set(placeable.map(a => a.hunt))],
        unplaceable: assignments.filter(a => a.to == null).length } };
  },
}];
