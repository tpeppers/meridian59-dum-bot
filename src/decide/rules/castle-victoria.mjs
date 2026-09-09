import { keeperWeaponPriority } from '../weapons.mjs';
import { STRATEGY_IDS, strategyEnabled, strategySettings } from '../../strategies/catalog.mjs';
import { activeFactionWork } from './factions.mjs';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => x === b[i]);

// An order may name one creature or several. Comparing those with `!==` compares ARRAY
// REFERENCES, so a multi-quarry order would look different from itself on every pass and
// the deploy would be re-sent for ever — stopping and restarting the keeper each time.
// The order of the names carries no meaning (see huntNames in the harness), so equality
// is set equality, not sequence equality.
const huntDiffers = (a, b) => {
  const norm = h => (Array.isArray(h) ? [...h] : [h]).filter(Boolean).map(String).sort();
  const [x, y] = [norm(a), norm(b)];
  return x.length !== y.length || x.some((v, i) => v !== y[i]);
};

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
    // `upstairs_quarry` names one creature for the whole upstairs cohort and retires the
    // mix. An operator narrowing the shift to one generator wants ONE answer, and the
    // rotation cannot express it: every third character is a zombie hunter by index, so
    // "battered skeletons only" was unreachable from a doctrine. Absent means the mix,
    // which is the behaviour that was already here.
    // `zombie_only` pins named characters to the weaker of the two upstairs generators.
    // It is the safety valve for the bottom of the roster: a kill pays while the
    // creature's level is above max health, so the zombie's 55 still advances everybody
    // here, and it hits far softer than the battered skeleton's 60. Matched against the
    // agent handle OR the character name, like `only`.
    const pinned = Array.isArray(cv.zombie_only)
      ? cv.zombie_only.filter(x => typeof x === 'string').map(s => s.toLowerCase()) : [];
    const zombiePinned = pinned.length > 0 &&
      (pinned.includes(String(row.agent).toLowerCase()) ||
       pinned.includes(String(row.character ?? '').toLowerCase()));
    const zombieStillPays = (row.level ?? 0) < 55;
    const hunt = upstairs
      ? (zombiePinned ? 'zombie'
         : cv.upstairs_quarry ??
           (zombieStillPays && i % 3 === 2 ? 'zombie' : 'battered skeleton'))
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
    row.mode !== 'farm' || p.assignedRoom !== orders.to || huntDiffers(p.hunt, orders.hunt) ||
    p.maxBotsPerSafeSpot !== orders.max_bots_per_safe_spot ||
    p.maxThreatOver !== orders.max_threat_over || p.fleeBelow !== orders.flee_below ||
    p.restBelow !== orders.rest_below || p.roam !== false ||
    p.useSafeSpots !== orders.use_safe_spots || p.strategy !== orders.strategy ||
    // THE VIGOR FLOOR IS NOT THIS RULE'S, WHEN SOMETHING ELSE IS DECIDING IT PER CHARACTER.
    //
    // `throttle-vigor` sets the floor from what each character can actually eat its way to;
    // this rule sets one number for the whole cohort. Comparing it here makes the patrol
    // re-deploy every time the throttle moves it, and the throttle re-order every time the
    // patrol puts it back — a keeper stopped and restarted on every pass, with both journals
    // reading correct. That loop ran across all twenty-one characters on 2026-09-03 (five
    // `-> 80` deploys against five bare `-> 140` orders per character in one window) and was
    // reintroduced on 2026-09-04 the moment the throttle learned to differ per character.
    //
    // One field, one owner. The patrol still SENDS a floor below, so a cohort with no
    // throttle set is unchanged; it just stops treating a different value as a reason to
    // redeploy. `orders.fight_above_vigor` is undefined when a doctrine leaves it out, and
    // an undefined never differs from itself.
    (orders.fight_above_vigor !== undefined &&
      p.fightAboveVigor !== orders.fight_above_vigor) ||
    p.holdResumeAbove !== orders.hold_resume_above || p.purpose !== orders.purpose ||
    !sameList(p.weaponPriority, orders.weapon_priority);
}

export const castleVictoriaFleetRules = [{
  id: 'castle-victoria-undead-shift',
  faculty: 'work',
  scope: 'fleet',
  why: 'maintain Castle Victoria undead quarry and combat orders; room and wall spreading are an independent strategy',
  // TWO RULES MUST NOT BOTH ASSIGN ROOMS, AND THE STATIONS WIN.
  //
  // `shift.stations` and this rule are both station authorities: each decides which room a
  // character works and sends `autopilot start` to say so. With both on they overwrite each
  // other every pass, and which one the fleet actually obeys is decided by nothing more
  // principled than their positions in a first-match-wins table.
  //
  // That is not theoretical. The weaponcraft doctrine inherits `castle_victoria.shift: true`
  // from castle-victoria.jsonc and never turned it off; it stayed quiet only because
  // `feast-hall-larder` sat above it and had something to say on nearly every pass. The
  // moment the feast stopped starving it — 2026-09-08, when learning was moved above the
  // feast and this rule travelled with it — it fired once and assigned ALL TWENTY-ONE
  // characters to room 39 with `upstairs_share: 1`, including the eighteen whose stations
  // put them on fungus beasts in the valley.
  //
  // A rule kept correct by the accident of another rule's traffic is not correct. So this
  // one stands down whenever the shift is on: a doctrine that has written stations has
  // stated where its characters go, and `shift.stations` expresses everything this rule
  // does — including "everybody upstairs" — with tiers and requirements on top.
  enabled: doctrine => doctrine.castle_victoria?.shift === true && doctrine.shift?.on !== true,
  offWhy: 'castle_victoria.shift is off, or shift.stations is on and owns room assignment',

  decide(fleetObs, doctrine) {
    let live = (fleetObs.characters ?? []).filter(r => r.in_game && !r.parked &&
      !activeFactionWork(fleetObs, r));
    const cv = doctrine.castle_victoria;

    // A SHIFT IS FLEET-SCOPED, AND SOMETIMES THE FLEET IS THREE PEOPLE.
    //
    // This rule ordered EVERY character in game, which is right when the whole fleet works
    // one place and catastrophic when it does not: on 2026-08-19 eighteen characters were
    // parked in a sanctuary precisely because the roads between them and here were killing
    // them, and a fleet-scoped deploy would have walked all eighteen straight back out.
    // `--agent` does not help — it applies that character's OVERRIDES, it does not narrow a
    // fleet rule, which the dry run showed by naming all twenty-one anyway.
    //
    // `castle_victoria.only` is that narrowing, matched against the agent handle OR the
    // character name so a doctrine can use whichever it has. ABSENT MEANS EVERYBODY, which
    // is the behaviour that was already here — an empty list would silently stand the whole
    // shift down, and this file must not learn to do that by accident.
    const only = Array.isArray(cv?.only) ? cv.only.filter(x => typeof x === 'string') : null;
    if (only?.length) {
      const want = new Set(only.map(s => s.toLowerCase()));
      live = live.filter(r => want.has(String(r.agent).toLowerCase()) ||
                              want.has(String(r.character ?? '').toLowerCase()));
    }
    if (!live.length) {
      return { kind: 'pass', why: only?.length
        ? `castle_victoria.only names ${only.join(', ')} and none are in game here`
        : 'nobody in game' };
    }
    const assigned = castleAssignments(live, doctrine, fleetObs).map(a => {
      const preset = strategyEnabled(fleetObs, doctrine, a.row.agent, STRATEGY_IDS.VS_SKELETONS)
        ? 'vsSkeletons' : doctrine.weapons.preset;
      const orders = {
        ...a, flee_below: cv.flee_below, rest_below: cv.rest_below,
        // STILL SENT, EVEN WHEN THE THROTTLE OWNS IT — and NOT sending it was a live bug.
        //
        // The deploy also carries `strategy`, and the harness's start handler reads the two
        // together: `if (a.strategy !== undefined) { ... if (a.fight_above_vigor === undefined)
        // p.policy.fightAboveVigor = plan.fightAboveVigor ?? 0 }`. `fieldrest` names no floor,
        // so omitting ours did not leave the throttle's value alone — it ZEROED it. Measured
        // 2026-09-04: a character deployed at fight_above_vigor 0, which is not a low floor,
        // it is no floor at all — it fights at any vigor, however exhausted, and never rests
        // to climb. Worse than the churn it was meant to avoid.
        //
        // So the patrol keeps sending a floor and the throttle keeps adjusting it per
        // character. What stops the two writers fighting is the DIFFS check, not the send:
        // castleDeploymentDiffers no longer treats a different floor as a reason to redeploy.
        // One owner for the DECISION, both for the write, and only one of them re-triggers.
        fight_above_vigor: cv.fight_above_vigor,
        roam: false, use_safe_spots: cv.use_safe_spots,
        // `wellfed` WAS HARDCODED HERE, AND IT CARRIES `restInTown: true` — which walks a
        // hurt character back to an inn to recover, a journey, with its assignment still
        // reading 39 and the board still reading healthy. That is exactly how a confinement
        // leaks, and it is not a thing a doctrine could previously say anything about.
        // `fieldrest` is the one strategy that never walks back to town. Default unchanged.
        hold_resume_above: 0.9, strategy: cv.strategy ?? 'wellfed', purpose: 'advance',
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
