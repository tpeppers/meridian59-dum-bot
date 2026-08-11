import { keeperWeaponPriority } from '../weapons.mjs';
import { STRATEGY_IDS, strategyEnabled, strategySettings } from '../../strategies/catalog.mjs';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => x === b[i]);

// The patrol owns quarry and combat posture. Spread Out alone owns whether that posture
// includes a forced room and a safe-wall occupancy cap.
export function castleAssignments(rows = [], doctrine = {}, fleetObs = { characters: rows }) {
  const cv = doctrine.castle_victoria;
  const ordered = [...rows].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) ||
    String(a.agent).localeCompare(String(b.agent)));
  const upstairsCount = Math.round(ordered.length * cv.upstairs_share);
  const selected = ordered.filter(row =>
    strategyEnabled(fleetObs, doctrine, row.agent, STRATEGY_IDS.SPREAD_OUT));
  const maxPerRoom = selected.length
    ? Math.min(...selected.map(row =>
      strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.SPREAD_OUT).max_bots_per_room))
    : null;
  const counts = new Map([[cv.rooms.upstairs, 0], [cv.rooms.downstairs, 0]]);

  return ordered.map((row, i) => {
    const spreading = strategyEnabled(fleetObs, doctrine, row.agent, STRATEGY_IDS.SPREAD_OUT);
    let to = null;
    let maxBotsPerSafeSpot = null;
    if (spreading) {
      const settings = strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.SPREAD_OUT);
      maxBotsPerSafeSpot = settings.max_bots_per_safe_spot;
      const preferred = i < upstairsCount ? cv.rooms.upstairs : cv.rooms.downstairs;
      const other = preferred === cv.rooms.upstairs ? cv.rooms.downstairs : cv.rooms.upstairs;
      to = [row.room, preferred, other].find(room => counts.has(room) &&
        (counts.get(room) ?? 0) < maxPerRoom) ?? null;
      if (to != null) counts.set(to, (counts.get(to) ?? 0) + 1);
    }

    const effectiveRoom = to ?? row.room;
    const upstairs = effectiveRoom !== cv.rooms.downstairs;
    // Downstairs targets skeletons. Upstairs (and a unit still travelling there) uses
    // a stable 2:1 battered-skeleton/zombie mix.
    const hunt = upstairs ? (i % 3 === 2 ? 'zombie' : 'battered skeleton') : 'skeleton';
    const targetLevel = hunt === 'skeleton' ? 75 : hunt === 'battered skeleton' ? 60 : 55;
    return { row, to, hunt, max_bots_per_safe_spot: maxBotsPerSafeSpot,
      max_threat_over: Math.max(0, targetLevel - (row.level ?? targetLevel)), spreading };
  });
}

export function castleDeploymentDiffers(row, orders) {
  const p = row.policy ?? {};
  return row.commitment?.kind === 'driven' || row.keeper?.inert ||
    row.mode !== 'farm' || p.assignedRoom !== orders.to || p.hunt !== orders.hunt ||
    p.maxBotsPerSafeSpot !== orders.max_bots_per_safe_spot ||
    p.maxThreatOver !== orders.max_threat_over || p.fleeBelow !== orders.flee_below ||
    p.restBelow !== orders.rest_below || p.roam !== false ||
    p.useSafeSpots !== orders.use_safe_spots || p.strategy !== orders.strategy ||
    p.fightAboveVigor !== orders.fight_above_vigor ||
    p.holdResumeAbove !== orders.hold_resume_above || p.purpose !== orders.purpose ||
    !sameList(p.weaponPriority, orders.weapon_priority);
}

export const castleVictoriaFleetRules = [{
  id: 'castle-victoria-undead-shift',
  faculty: 'work',
  scope: 'fleet',
  why: 'maintain Castle Victoria undead quarry and combat orders; room and wall spreading are an independent strategy',
  enabled: doctrine => doctrine.castle_victoria?.shift === true,
  offWhy: 'castle_victoria.shift is off',

  decide(fleetObs, doctrine) {
    const live = (fleetObs.characters ?? []).filter(r => r.in_game && !r.parked);
    if (!live.length) return { kind: 'pass', why: 'nobody in game' };
    const cv = doctrine.castle_victoria;
    const assigned = castleAssignments(live, doctrine, fleetObs).map(a => {
      const preset = strategyEnabled(fleetObs, doctrine, a.row.agent, STRATEGY_IDS.VS_SKELETONS)
        ? 'vsSkeletons' : doctrine.weapons.preset;
      const orders = {
        ...a, flee_below: cv.flee_below, rest_below: cv.rest_below,
        fight_above_vigor: cv.fight_above_vigor,
        roam: false, use_safe_spots: cv.use_safe_spots,
        hold_resume_above: 0.9, strategy: 'wellfed', purpose: 'advance',
        goals: [{ kind: 'hp' }], weapon_priority: keeperWeaponPriority(preset, doctrine.weapons.presets),
      };
      return { ...orders, differs: castleDeploymentDiffers(a.row, orders) };
    });
    const plan = assigned.filter(a => a.differs).map(a => ({
      do: 'deploy', agent: a.row.agent, to: a.to, hunt: a.hunt,
      max_bots_per_safe_spot: a.max_bots_per_safe_spot,
      max_threat_over: a.max_threat_over, flee_below: a.flee_below,
      rest_below: a.rest_below, fight_above_vigor: a.fight_above_vigor,
      roam: false, use_safe_spots: a.use_safe_spots,
      hold_resume_above: a.hold_resume_above,
      strategy: a.strategy, purpose: a.purpose, goals: a.goals,
      weapon_priority: a.weapon_priority,
      why: a.to == null
        ? `${a.hunt} patrol with Spread Out off: clear the forced room and safe-wall cap`
        : `${a.hunt} patrol in room ${a.to}`,
    }));
    if (!plan.length)
      return { kind: 'pass', why: `${live.length} live unit(s) already hold Castle Victoria undead orders` };
    const pinned = assigned.filter(a => a.to != null).length;
    return { kind: 'act', plan,
      why: `${plan.length} unit(s) need Castle Victoria orders; ${pinned} room-pinned by Spread Out and ` +
        `${assigned.length - pinned} deliberately unpinned` };
  },
}];
