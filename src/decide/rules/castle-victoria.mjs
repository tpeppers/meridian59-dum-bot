import { keeperWeaponPriority } from '../weapons.mjs';
import { STRATEGY_IDS, strategyEnabled } from '../../strategies/catalog.mjs';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => x === b[i]);

export function castleAssignments(rows = [], doctrine = {}) {
  const cv = doctrine.castle_victoria;
  const ordered = [...rows].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) ||
    String(a.agent).localeCompare(String(b.agent)));
  const upstairsCount = Math.round(ordered.length * cv.upstairs_share);
  return ordered.map((row, i) => {
    const upstairs = i < upstairsCount;
    // Three battered-skeleton hunters for every zombie hunter upstairs; downstairs is
    // exclusively skeleton work. This names all three requested quarry without putting
    // a low-ceiling zombie hunter in the room whose aggressive resident is level 75.
    const local = upstairs ? i : i - upstairsCount;
    const hunt = upstairs
      ? (local % 3 === 2 ? 'zombie' : 'battered skeleton')
      : 'skeleton';
    const targetLevel = hunt === 'skeleton' ? 75 : hunt === 'battered skeleton' ? 60 : 55;
    return { row, to: upstairs ? cv.rooms.upstairs : cv.rooms.downstairs, hunt,
      max_threat_over: Math.max(0, targetLevel - (row.level ?? targetLevel)) };
  });
}

export function castleDeploymentDiffers(row, orders) {
  const p = row.policy ?? {};
  // A keeper can retain the entire requested policy while being inert. Treating policy
  // equality as deployment equality leaves exactly that unit parked forever; a `start`
  // is idempotent for a live keeper and is the documented revive operation for an inert one.
  return row.commitment?.kind === 'driven' || row.keeper?.inert ||
    row.mode !== 'farm' || p.assignedRoom !== orders.to || p.hunt !== orders.hunt ||
    p.maxThreatOver !== orders.max_threat_over || p.fleeBelow !== orders.flee_below ||
    p.restBelow !== orders.rest_below || p.maxCarry !== orders.max_carry ||
    p.bankAbove !== orders.bank_above || p.roam !== false ||
    p.useSafeSpots !== orders.use_safe_spots || p.strategy !== orders.strategy ||
    p.fightAboveVigor !== orders.fight_above_vigor ||
    p.holdResumeAbove !== orders.hold_resume_above || p.purpose !== orders.purpose ||
    !sameList(p.weaponPriority, orders.weapon_priority);
}

export const castleVictoriaFleetRules = [{
  id: 'castle-victoria-undead-shift',
  faculty: 'work',
  scope: 'fleet',
  why: 'Castle Victoria has two reachable undead generators: send the weaker two-thirds ' +
       'upstairs for zombies and battered skeletons, and the stronger third downstairs ' +
       'for zombies and skeletons, with a ceiling fitted to each named quarry',
  enabled: doctrine => doctrine.castle_victoria?.shift === true,
  offWhy: 'castle_victoria.shift is off',

  decide(fleetObs, doctrine) {
    const live = (fleetObs.characters ?? []).filter(r => r.in_game && !r.parked);
    if (!live.length) return { kind: 'pass', why: 'nobody in game' };
    const cv = doctrine.castle_victoria;
    const assigned = castleAssignments(live, doctrine).map(a => {
      const preset = strategyEnabled(fleetObs, doctrine, a.row.agent, STRATEGY_IDS.VS_SKELETONS)
        ? 'vsSkeletons' : doctrine.weapons.preset;
      const orders = {
        ...a, flee_below: cv.flee_below, rest_below: cv.rest_below,
        fight_above_vigor: cv.fight_above_vigor, max_carry: cv.max_carry,
        bank_above: cv.bank_above, roam: false, use_safe_spots: cv.use_safe_spots,
        hold_resume_above: 0.9, strategy: 'wellfed', purpose: 'advance',
        goals: [{ kind: 'hp' }], weapon_priority: keeperWeaponPriority(preset, doctrine.weapons.presets),
      };
      return { ...orders, differs: castleDeploymentDiffers(a.row, orders) };
    });
    const plan = assigned.filter(a => a.differs).map(a => ({
      do: 'deploy', agent: a.row.agent, to: a.to, hunt: a.hunt,
      max_threat_over: a.max_threat_over, flee_below: a.flee_below,
      rest_below: a.rest_below, fight_above_vigor: a.fight_above_vigor,
      max_carry: a.max_carry, bank_above: a.bank_above, roam: false,
      use_safe_spots: a.use_safe_spots, hold_resume_above: a.hold_resume_above,
      strategy: a.strategy, purpose: a.purpose, goals: a.goals,
      weapon_priority: a.weapon_priority,
      why: `${a.hunt} patrol in room ${a.to}`,
    }));
    if (!plan.length)
      return { kind: 'pass', why: `${live.length} live unit(s) already hold Castle Victoria undead orders` };
    const upstairs = assigned.filter(a => a.to === cv.rooms.upstairs).length;
    return { kind: 'act', plan,
      why: `${plan.length} unit(s) need Castle Victoria orders; ${upstairs} upstairs and ` +
        `${assigned.length - upstairs} downstairs, explicitly targeting zombies, battered skeletons, and skeletons` };
  },
}];
