import { keeperWeaponPriority } from '../weapons.mjs';
import { STRATEGY_IDS, strategyEnabled, strategySettings } from '../../strategies/catalog.mjs';
import { activeFactionWork } from './factions.mjs';

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
    // A RETIRED ROOM IS THE SHIFT'S DECISION, NOT SPREAD OUT'S — and it used to be
    // unreachable without it.
    //
    // The division of labour is: the shift owns WHICH room the fleet works; Spread Out
    // owns the occupancy cap and the balancing across two of them. But `to` was only ever
    // set inside the `spreading` branch, so on a doctrine with Spread Out off — which this
    // one is, deliberately — nobody was assigned anywhere, `effectiveRoom` fell back to
    // wherever the character already stood, and the quarry was derived from that.
    //
    // The visible consequence is that moving `upstairs_share` to 0 or 1 DID NOTHING: the
    // fleet stayed in the room it was already in and went on hunting that room's prey,
    // while the doctrine said otherwise and every journal line agreed with the doctrine.
    // Found when retargeting the Castle fleet off the level-60 battered skeleton, which it
    // had outgrown, onto the level-75 skeleton downstairs — the whole change would have
    // been silently inert.
    //
    // A share of 0 or 1 names exactly one room, so there is nothing to balance and no need
    // for Spread Out to be involved. `maxBotsPerSafeSpot` stays null: the wall cap really
    // is Spread Out's, and naming a room must not start pinning walls as a side effect.
    const onlyRoom = cv.upstairs_share >= 1 ? cv.rooms.upstairs
      : cv.upstairs_share <= 0 ? cv.rooms.downstairs : null;
    if (!spreading && onlyRoom != null) to = onlyRoom;
    if (spreading) {
      const settings = strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.SPREAD_OUT);
      maxBotsPerSafeSpot = settings.max_bots_per_safe_spot;
      const preferred = i < upstairsCount ? cv.rooms.upstairs : cv.rooms.downstairs;
      const other = preferred === cv.rooms.upstairs ? cv.rooms.downstairs : cv.rooms.upstairs;
      // Preserve the policy assignment while the character is travelling through some
      // intermediate room. Current room used to win here, so a cohort/rank change could
      // rewrite 38 to 39 between two travel legs and start a return journey.
      // A 100%/0% split deliberately retires one room. Do not let the sticky-assignment
      // guard preserve a room the doctrine has removed from service; in a mixed split it
      // still prevents an en-route character from changing destinations mid-journey.
      const allowed = cv.upstairs_share >= 1 ? new Set([cv.rooms.upstairs])
        : cv.upstairs_share <= 0 ? new Set([cv.rooms.downstairs])
        : new Set([cv.rooms.upstairs, cv.rooms.downstairs]);
      to = [row.policy?.assignedRoom, row.room, preferred, other].find(room =>
        allowed.has(room) && counts.has(room) &&
        (counts.get(room) ?? 0) < maxPerRoom) ?? null;
      if (to != null) counts.set(to, (counts.get(to) ?? 0) + 1);
    }

    // A RETIRED ROOM ALSO DECIDES THE QUARRY, even for a character with no assignment.
    //
    // `to` is null whenever the occupancy cap is already met, and the fallback to
    // `row.room` then reads the quarry off wherever the character is standing — which,
    // during a migration, is the room being retired. So the last few characters over the
    // cap would keep hunting the old prey in the old room, indefinitely and invisibly,
    // because every other signal says the fleet was retargeted. `onlyRoom` sits ahead of
    // the fallback so a one-room doctrine answers for them too.
    const effectiveRoom = to ?? onlyRoom ?? row.room;
    const upstairs = effectiveRoom !== cv.rooms.downstairs;
    // Downstairs targets skeletons. Upstairs (and a unit still travelling there) uses
    // a stable 2:1 battered-skeleton/zombie mix.
    // A kill advances only while monster level is strictly above max health. Zombies
    // stop paying at 55, so the mature cohort must not spend its safe upstairs time on
    // them merely to preserve the old 2:1 room mix.
    const zombieStillPays = (row.level ?? 0) < 55;
    const hunt = upstairs ? (zombieStillPays && i % 3 === 2 ? 'zombie' : 'battered skeleton')
                          : 'skeleton';
    // The keeper's ceiling gates the WHOLE generator, not only the quarry. A zombie
    // hunter assigned upstairs still shares the room with level-60 battered skeletons;
    // setting its ceiling to the zombie's 55 makes preyRooms() reject its own assigned
    // room and leaves it farming zombies elsewhere forever. Size the ceiling to the
    // strongest normal spawn in the assigned Castle room.
    const roomThreatLevel = upstairs ? 60 : 75;
    return { row, to, hunt, max_bots_per_safe_spot: maxBotsPerSafeSpot,
      max_threat_over: Math.max(0, roomThreatLevel - (row.level ?? roomThreatLevel)), spreading };
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
    const live = (fleetObs.characters ?? []).filter(r => r.in_game && !r.parked &&
      !activeFactionWork(fleetObs, r));
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
