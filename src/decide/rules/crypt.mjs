// THE MARION CRYPT SHIFT.
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

import { STRATEGY_IDS, strategyEnabled, strategySettings, cryptAssignment }
  from '../../strategies/catalog.mjs';
import { activeFactionWork } from './factions.mjs';
import { keeperWeaponPriority } from '../weapons.mjs';
import { takeable } from '../engine.mjs';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => x === b[i]);

/** What each opted-in unit should be doing, or null for one nothing here can place. */
export function cryptAssignments(rows = [], doctrine = {}, fleetObs = { characters: rows }) {
  return rows.map(row => {
    if (!strategyEnabled(fleetObs, doctrine, row.agent, STRATEGY_IDS.SHORT_SWORDING))
      return { row, to: null, why: 'Short swording is not selected for this unit' };
    const settings = strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.SHORT_SWORDING);
    // `level` on a fleet row IS max health here — the two are the same number in this game
    // and the row carries it under the name the rest of the table uses.
    const found = cryptAssignment(settings.hunt, settings.rooms, row.level);
    if (!found)
      return { row, to: null,
        why: `no crypt quarry is within this unit's engagement ceiling at ${row.level} max health` };
    return { row, to: found.room, hunt: found.quarry, room_name: found.name,
      // Sized to the ROOM's strongest occupant, never to the quarry: 2600 generates
      // level-40 mummies and has a level-75 statue standing in it, and a ceiling set to 40
      // makes the keeper reject its own assigned room and farm somewhere else for ever.
      max_threat_over: Math.max(0, found.threat - (row.level ?? found.threat)),
      town_trips: settings.town_trips !== false };
  });
}

const needsOrders = (row, orders) => {
  const p = row.policy ?? {};
  return row.mode !== 'farm' || p.assignedRoom !== orders.to || p.hunt !== orders.hunt ||
    p.roam !== false || p.purpose !== 'advance';
};

export const cryptFleetRules = [{
  id: 'crypt-shift',
  faculty: 'work',
  scope: 'fleet',
  enabled: doctrine => doctrine.crypt?.shift === true,
  offWhy: 'crypt.shift is off',
  why: 'units running Short swording belong in a crypt room that generates their quarry, with roaming off',
  decide(observation, doctrine) {
    const live = (observation.characters ?? []).filter(r => r.in_game);
    if (!live.length) return { kind: 'pass', why: 'nobody in game' };

    const assignments = cryptAssignments(live, doctrine, observation);
    const placeable = assignments.filter(a => a.to != null);
    if (!placeable.length)
      return { kind: 'pass', why: assignments[0]?.why ?? 'no unit has Short swording selected' };

    // BUSY AND SETTLED ARE DIFFERENT ANSWERS AND MUST NOT SHARE A SENTENCE. Both produce
    // an empty plan, and reporting "already hold their crypt orders" for a unit that was
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
        flee_below: doctrine.crypt.flee_below,
        rest_below: doctrine.crypt.rest_below,
        fight_above_vigor: doctrine.crypt.fight_above_vigor,
        use_safe_spots: doctrine.crypt.use_safe_spots !== false,
        why: `${a.hunt} in ${a.room_name} (${a.to}), roaming off — 2602 is thrashers at level 150`,
      }];
    });

    if (!plan.length)
      return { kind: 'pass', why: busy
        ? `${busy} of ${placeable.length} unit(s) are mid-errand; the rest hold their crypt orders`
        : `${placeable.length} unit(s) already hold their crypt orders` };
    return { kind: 'act', plan,
      why: `deploy ${plan.length} unit(s) into the Marion crypts`,
      evidence: { rooms: [...new Set(placeable.map(a => a.to))],
        quarry: [...new Set(placeable.map(a => a.hunt))],
        unplaceable: assignments.filter(a => a.to == null).length } };
  },
}];
