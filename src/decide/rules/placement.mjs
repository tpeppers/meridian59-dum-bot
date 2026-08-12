// WHERE CHARACTERS STAND IS A FLEET DECISION.
//
// The keeper can hold an assigned room and a safe-wall occupancy cap, but it cannot
// decide either from one character's view. DUM's Spread Out strategy owns both. It is
// opt-in: with no selected units this module sends no policy and moves nobody.

import { STRATEGY_IDS, strategyRows, strategySettings } from '../../strategies/catalog.mjs';
import { activeFactionWork } from './factions.mjs';

export const placementRules = [];

/** Stable, hysteretic room allocation. Capacity exhaustion leaves a unit unpinned. */
export function spreadAssignments(rows = [], rooms = [], maxPerRoom = 4) {
  const allowed = [...new Set(rooms.map(Number).filter(Number.isInteger))];
  const cap = Math.max(1, Math.floor(maxPerRoom));
  const counts = new Map(allowed.map(room => [room, 0]));
  const ordered = [...rows].sort((a, b) => {
    const ah = allowed.includes(a.policy?.assignedRoom) ? 0 : allowed.includes(a.room) ? 1 : 2;
    const bh = allowed.includes(b.policy?.assignedRoom) ? 0 : allowed.includes(b.room) ? 1 : 2;
    return ah - bh || String(a.agent).localeCompare(String(b.agent));
  });
  return ordered.map(row => {
    const preferred = [row.policy?.assignedRoom, row.room]
      .filter((room, i, all) => allowed.includes(room) && all.indexOf(room) === i);
    const open = allowed.filter(room => !preferred.includes(room))
      .sort((a, b) => (counts.get(a) ?? 0) - (counts.get(b) ?? 0));
    const candidates = [...preferred, ...open];
    const to = candidates.find(room => (counts.get(room) ?? 0) < cap) ?? null;
    if (to != null) counts.set(to, (counts.get(to) ?? 0) + 1);
    return { row, to };
  });
}

export const placementFleetRules = [{
  id: 'spread-fleet',
  faculty: 'movement',
  scope: 'fleet',
  why: 'the independently enabled Spread Out strategy caps both room assignments and safe-wall sharing',
  enabled: doctrine => doctrine.strategies?.enabled === true &&
    (doctrine.placement?.rooms?.length ?? 0) > 0,
  offWhy: 'no allowed placement rooms or DUM strategies are disabled',
  decide(fleetObs, doctrine) {
    const selected = strategyRows(fleetObs, doctrine, STRATEGY_IDS.SPREAD_OUT)
      .filter(row => !activeFactionWork(fleetObs, row));
    if (!selected.length) return { kind: 'pass', why: 'Spread Out is off for every live unit' };
    const roomCaps = selected.map(row =>
      strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.SPREAD_OUT).max_bots_per_room);
    // One fleet cannot obey two room caps at once. The strictest selected value is the
    // only interpretation that never exceeds somebody's configured maximum.
    const maxPerRoom = Math.min(...roomCaps);
    const assigned = spreadAssignments(selected, doctrine.placement.rooms, maxPerRoom);
    const plan = assigned.flatMap(({ row, to }) => {
      const settings = strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.SPREAD_OUT);
      const policy = row.policy ?? {};
      if (policy.assignedRoom === to &&
          policy.maxBotsPerSafeSpot === settings.max_bots_per_safe_spot) return [];
      return [{ do: 'placement-policy', agent: row.agent, to,
        max_bots_per_safe_spot: settings.max_bots_per_safe_spot,
        why: to == null
          ? `all ${doctrine.placement.rooms.length} allowed rooms are at the configured cap of ${maxPerRoom}; leave this unit unpinned`
          : `Spread Out assigns room ${to}, capped at ${maxPerRoom}, and safe walls at ${settings.max_bots_per_safe_spot}` }];
    });
    if (!plan.length)
      return { kind: 'pass', why: `${selected.length} selected unit(s) already match Spread Out` };
    return { kind: 'act', plan,
      why: `${plan.length} selected unit(s) need spread policy; max ${maxPerRoom} per room` };
  },
}];
