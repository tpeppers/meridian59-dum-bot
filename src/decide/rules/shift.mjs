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
import { takeable } from '../engine.mjs';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => x === b[i]);

// A STATION MAY NAME THE BAND OF CHARACTER IT IS FOR, AND THAT IS WHAT LETS ONE DOCTRINE
// RUN TWO COHORTS.
//
// Until this existed, "these ten work here and those eleven work there" could not be said
// inside a doctrine at all. It was said with `--agent` and two DUM processes, and the cost
// was not the second process — it was that MEMBERSHIP WAS A LIST OF NAMES somebody had to
// maintain. Such a list is a snapshot of one afternoon: prod-valley-ileria.jsonc says
// "rotate them back the moment max health reaches 50", and rotating them back meant an
// operator noticing, editing two files and restarting two processes. Between the noticing
// and the restart the graduates went on killing a level-50 fungus beast that no longer paid
// them anything, at 28 kills an hour, reading healthy on every board. `yield_check` was the
// only field in the whole system that said so.
//
// So the band is a PREDICATE ON THE CHARACTER rather than a roster. A kill advances a
// character only while the creature's level is strictly above its max health, which makes
// max health the number that decides which room pays — and it is on every board row. The
// fleet re-sorts itself every pass and nobody has to be told.
//
// `at_least` is inclusive and `below` is exclusive, so `{at_least: 50}` and `{below: 50}`
// tile the whole range with no gap and no overlap at the boundary. That pair is the point,
// and the schema refuses a set of bands that leaves a hole: a character in no band is left
// unplaced with `roam: false` and then stands where it is for ever, which looks exactly
// like a character that is working.

/** The band a station declares, or null when it takes anyone its ceiling admits. */
export function stationBand(st = {}) {
  const b = st.max_health;
  if (!b || typeof b !== 'object') return null;
  const at_least = Number.isFinite(Number(b.at_least)) ? Number(b.at_least) : null;
  const below = Number.isFinite(Number(b.below)) ? Number(b.below) : null;
  return (at_least == null && below == null) ? null : { at_least, below };
}

/**
 * Is this character's max health inside this station's band?
 *
 * A station with no band admits everyone — that is what every doctrine written before this
 * had, and it must not change under them.
 *
 * UNKNOWN MAX HEALTH IS REFUSED BY A BANDED STATION, and that direction is deliberate. The
 * whole feature is "put this character where its size says"; a row with no size is a
 * question rather than a permission, and admitting it would place a character on the
 * strength of a field that was missing.
 */
export function bandAdmits(st = {}, maxHealth) {
  const band = stationBand(st);
  if (!band) return true;
  const mh = Number(maxHealth);
  if (!Number.isFinite(mh)) return false;
  if (band.at_least != null && mh < band.at_least) return false;
  if (band.below != null && mh >= band.below) return false;
  return true;
}

// ONE NAME OR SEVERAL. The harness's `hunt` has taken a list since 03982c3 and the castle
// cohort depends on it: room 39's spawn cap is a room-wide TOTAL, so a cohort that declines
// the zombies standing next to it lets them hold the cap that would otherwise have spawned
// more skeletons. A station that says one name still means one name.
export const huntList = st => Array.isArray(st?.hunt) ? st.hunt.filter(Boolean)
  : (st?.hunt == null ? [] : [st.hunt]);

// EVERY NAMED QUARRY HAS TO CLEAR THE CEILING, NOT JUST THE FIRST. A station naming two
// creatures is telling the keeper it may take either, so a character admitted on the
// strength of the softer one would stand in the room refusing the other half of what
// appears — which is the "everything works and none of it is worth anything" shape.
const admitsStation = (st, maxHealth) => {
  const hunts = huntList(st);
  return hunts.length > 0 && hunts.every(q => admits(maxHealth, Number(st.room), q));
};

/**
 * Which of these stations this character belongs to, by index, or -1 for none.
 *
 * Exported because three other things have to agree with it and must not re-derive it: the
 * schema's coverage check, the handover that notices a character has changed band, and the
 * `plan` output an operator reads.
 */
export function stationIndexFor(stations = [], maxHealth) {
  return stations.findIndex(st => bandAdmits(st, maxHealth) && admitsStation(st, maxHealth));
}

/** A stable name for a station, for the memory and for the journal. */
export const stationKey = st => `${st?.room}`;

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
// THE LEAD IS MEASURED WHEN IT CAN BE, AND TYPED WHEN IT CANNOT.
//
// `lead_ms` in the doctrine is a floor and a fallback, not the answer: it was right on the
// day somebody wrote it, and the walk changes when the fleet moves, when the router picks
// a different corridor, and when a door starts refusing. When the harness has supplied a
// real estimate — the sum of the recorded time for each hop of the ACTUAL planned route —
// that wins.
//
// AND IT IS THE SLOWEST OF THE UNITS THAT WILL ACTUALLY GO, WHICH IS NOT THE SLOWEST IN
// THE FLEET. Taking the fleet maximum was the obvious thing and it is wrong in a way that
// costs exactly what this feature was built to save: measured live, the nearest character
// was 19 seconds from the graveyard and the furthest 322, so a lead built on the furthest
// opened the station six minutes early and had the near ones stand in a dead room for five
// and a half of them. That is the walking time re-spent as waiting time.
//
// So the station takes the NEAREST units — `pickOrder` below — and the lead is the k-th
// smallest walk, where k is how many it is about to take. The slowest of the ones going,
// and nobody else's problem. Padded a tenth, because arriving a few seconds early costs a
// few seconds and arriving late costs the walk.
const walkMs = row => {
  const ms = row?.travel_to_station?.ms;
  return Number.isFinite(ms) ? ms : null;
};

// A LEAD SHORTER THAN THE TICK IS A LEAD THAT MOSTLY DOES NOT HAPPEN.
//
// The rules only run on the fleet cadence, so a station that opens 97 seconds before its
// window against a 120-second tick is deployed at some uniformly random point in that 97
// seconds — and 19% of the time no tick lands inside it at all and the shift leaves AFTER
// the window opened. Measured on the first live window: the lead was 97s, the deploy fired
// at T-6s, and the shift reached the graveyard 43 seconds into a 35-minute window.
//
// So the lead carries one whole cadence on top of the walk. Then the first tick after the
// station opens is at most one cadence later, which is still at least `walk` before the
// window — so the shift is always in the room when it opens, rather than usually.
const leadFor = (station, rows = [], take = null, cadenceMs = 0) => {
  const typed = Number(station.lead_ms);
  const walks = rows.map(walkMs).filter(ms => ms != null && ms > 0).sort((a, b) => a - b);
  const tick = Number.isFinite(Number(cadenceMs)) ? Number(cadenceMs) : 0;
  if (!walks.length) return Number.isFinite(typed) ? typed + tick : typed;
  // The k-th smallest, where k is the station's take. Clamped into the array, and falling
  // back to the whole set when the take is unknown.
  const k = Number.isFinite(take) && take > 0 ? Math.min(Math.ceil(take), walks.length) : walks.length;
  const slowestGoing = walks[k - 1];
  return Math.max(Number.isFinite(typed) ? typed : 0, Math.round(slowestGoing * 1.1)) + tick;
};

// A TIME-LIMITED ROOM SHOULD BE WORKED BY WHOEVER IS NEAREST IT. Everywhere else the order
// is by level then agent, which is stable and fair; here stability matters less than the
// window, and sending the far units costs the shift minutes it cannot get back. Units with
// no estimate sort last rather than first — an unknown walk must not push a known-near
// unit out of the shift.
const pickOrder = (rows, byDistance) => byDistance
  ? [...rows].sort((a, b) => (walkMs(a) ?? Infinity) - (walkMs(b) ?? Infinity))
  : rows;

export function shiftAssignments(rows = [], doctrine = {}, fleetObs = { characters: rows }) {
  // A STATION CAN BE OPEN OR SHUT, AND THE CLOCK DECIDES WHICH.
  //
  // The undead generators run for 35 minutes in every 120 and produce nothing at all in
  // between, so a night station is a real room for a quarter of the time and an empty
  // field for the rest. `when` is what says so, and the whole point is that nobody has to
  // do anything: the window opens, the station appears, units are allocated to it, and
  // when it closes they are allocated back.
  //
  // A NIGHT STATION IS SHUT WHEN THE CLOCK IS UNKNOWN, NOT OPEN. `world_clock` is null
  // until an operator has watched a window begin and written the anchor down — which is a
  // different fact from "it is daytime" — and guessing would park a shift in an empty
  // graveyard on a schedule nobody verified. Failing shut costs a window; failing open
  // costs however long it takes somebody to notice a fleet killing nothing.
  //
  // AND A STATION OPENS EARLY BY THE LENGTH OF THE WALK. The graveyard runs for 35 minutes
  // and the walk to it is a minute and a half from the King's Way — so a shift that sets
  // off when the window OPENS spends the first twentieth of it in a corridor, every cycle,
  // for ever. `lead_ms` brings the station into existence that much sooner, which turns
  // travel time into window time. It is only ever early: the station still closes exactly
  // when the room stops generating, because arriving late is a wasted walk but STAYING
  // late is standing in an empty field.
  const clock = fleetObs.world_clock ?? null;
  const open = st => {
    const when = String(st.when ?? 'always').toLowerCase();
    if (when === 'always') return true;
    if (!clock) return false;
    const on = when === 'night' ? clock.night === true : clock.night === false;
    if (on) return true;
    // Not open yet — but is it close enough that leaving now is right? `opens_in_ms` is
    // only present on the phase that is waiting, which is exactly when this applies.
    // How many this station is about to take — so the lead is the slowest of THOSE,
    // not of the whole fleet.
    // `Number(undefined)` is NaN and NaN SLIPS PAST `??`, so a station with no `max` was
    // handing NaN to the lead, which fell all the way back to the fleet maximum — the
    // exact six-minutes-early bug this was meant to fix, reintroduced by a nullish check
    // that does not catch NaN. Resolve the cap explicitly.
    const cap = Number.isFinite(Number(st.max)) ? Number(st.max) : Infinity;
    const take = Math.round(rows.length * (Number(st.share) || 0)) || rows.length;
    const lead = leadFor(st, rows, Math.min(take, cap), doctrine.cadence?.fleet_ms);
    if (!Number.isFinite(lead) || lead <= 0) return false;
    const until = when === 'night' ? clock.opens_in_ms : clock.closes_in_ms;
    return Number.isFinite(until) && until <= lead;
  };
  const stations = (doctrine.shift?.stations ?? [])
    .filter(st => st && st.room != null).filter(open);
  const ordered = [...rows].sort((a, b) => (a.level ?? 0) - (b.level ?? 0) ||
    String(a.agent).localeCompare(String(b.agent)));

  // THE SHIFT IS NOT A WEAPON STRATEGY AND SHOULD NEVER HAVE BEEN GATED ON ONE.
  //
  // This used to require Short swording, because the shift was written for the crypt and
  // the crypt was that strategy's room. That conflated two unrelated decisions: WHERE the
  // fleet works and WHICH ORDER it draws weapons in. The cost showed up the moment the
  // fleet moved back to Castle Victoria on vsSkeletons — every unit fell out of the shift
  // at once, silently, because it no longer held a strategy about short swords.
  //
  // A doctrine that turns the shift on means all of its units, and `enabled` on the rule
  // is where opting out belongs.
  const opted = ordered;
  const out = new Map(ordered.map(row => [row.agent, { row, to: null, why: 'unplaced' }]));

  // Per station, who could work it at all. Computed before any allocation so a share is a
  // share of the eligible, and a unit eligible for nothing is named rather than absorbed.
  // A BAND IS A HARD GATE AND NOT A PREFERENCE, so it belongs here rather than in the
  // allocation below: everything downstream — the share, the capacity overflow, and the
  // fallback that catches whoever is left — reads this set, and a band that only narrowed
  // the first of the three would hand an under-50 character to the castle by the back door
  // and call it an overflow.
  const eligible = stations.map(st => new Set(opted
    .filter(row => bandAdmits(st, row.level) && admitsStation(st, row.level))
    .map(row => row.agent)));

  const taken = new Set();
  stations.forEach((st, i) => {
    const share = Number(st.share);
    // A station with a lead is time-limited, so it takes the NEAREST. Without a lead it
    // takes them in the order they arrive in — see pickOrder, which returns the rows
    // untouched. NOT level-ordered: this comment used to say it was, and a doctrine was
    // written against that belief on the assumption a share would leave the largest
    // characters on the hardest quarry. It does not. The split is arbitrary with respect
    // to level, and anything that needs to select on level has to say so itself.
    const pool = pickOrder(
      opted.filter(row => eligible[i].has(row.agent) && !taken.has(row.agent)),
      Number(st.lead_ms) > 0);
    // The last station takes the remainder rather than its own rounded share, so the
    // shares cannot lose or duplicate a unit to rounding.
    // `max` IS A CAPACITY AND IT BEATS THE SHARE, because that is what "overflow" means:
    // fill this room, and when it is full the rest go to the next station. A share alone
    // cannot say that — it would put a fixed proportion in each room however crowded the
    // first one got. The last station has no cap and absorbs whatever is left, which is
    // why it must be the one you are willing to have everybody in.
    const cap = Number.isFinite(Number(st.max)) ? Number(st.max) : Infinity;
    // A BANDED STATION TAKES ITS WHOLE BAND, AND SAYING SO EXPLICITLY IS THE POINT.
    //
    // Without this line a station with a band and no `share` computes `want = round(n * 0)`
    // = 0, every character falls through to the fallback loop at the bottom, and the
    // fallback — which walks the stations in order and takes the first the band admits —
    // happens to produce exactly the right answer. That is the worst possible arrangement:
    // correct today, by accident, through a path whose comment says it exists for units too
    // SMALL for the first quarry. The next person to touch either half breaks it silently.
    //
    // A share still wins where one is written, because "put a third of the eligible over
    // there" is a different instruction from "this room is for these characters".
    const bandTakesAll = stationBand(st) != null && !Number.isFinite(share);
    const want = Math.min(cap, (bandTakesAll || i === stations.length - 1) ? pool.length
      : Math.round(opted.filter(row => eligible[i].has(row.agent)).length *
          (Number.isFinite(share) ? share : 0)));
    for (const row of pool.slice(0, Math.max(0, want))) {
      const entry = HUNT_ROOMS[Number(st.room)];
      taken.add(row.agent);
      out.set(row.agent, { row, to: entry.room, hunt: st.hunt, room_name: entry.name, station: st,
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
    out.set(row.agent, { row, to: entry.room, hunt: st.hunt, room_name: entry.name, station: st,
      max_threat_over: Math.max(0, entry.threat - (row.level ?? entry.threat)) });
  }

  return ordered.map(row => out.get(row.agent));
}

// THE POSTURE IS THE STATION'S FIRST AND THE SHIFT'S SECOND, because two rooms that need
// the same posture do not need this feature and two that do cannot use one number.
//
// The worked case is the pair this was built for: the Valley of Ileria measured BETTER with
// safe spots off (`takeSafeSpot -> returnToSpot` oscillates on the fine walker there — hours
// of "travelling / NOT MOVING" with fungus beasts in reach and zero kills, against 16 in the
// first hour with it off), while Upstairs Castle Victoria is a difficulty-4 fight where the
// wall is worth having. Before this, expressing both meant two doctrines, which meant two
// processes, which meant cohort membership was a hand-maintained list of names.
const posture = (st, shift, key) => st?.[key] ?? shift?.[key];

const needsOrders = (row, orders) => {
  const p = row.policy ?? {};
  return row.mode !== 'farm' || p.assignedRoom !== orders.to ||
    !sameHunt(p.hunt, orders.hunt) || p.roam !== false || p.purpose !== 'advance';
};

// A HUNT IS A SET, AND COMPARING IT WITH `!==` MEANT REDEPLOYING EVERY PASS.
//
// The keeper's `hunt` comes back as an array whenever more than one quarry was ordered
// (m59-spawns.mjs huntNames), and the doctrine may write either shape. `['battered
// skeleton','zombie'] !== ['battered skeleton','zombie']` is true for two arrays that are
// equal in every way that matters, so a station naming a pair would have looked like drift
// on every single pass: deploy, stop the keeper, restart it, read the same value back,
// deploy again. That is the exact deploy/re-order loop the castle doctrine's
// `fight_above_vigor` comment paid for once already.
function sameHunt(a, b) {
  const list = v => (Array.isArray(v) ? v : (v == null ? [] : [v])).map(String);
  return sameList(list(a), list(b));
}

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
      // ORDERS MATCHING IS NOT THE SAME AS BEING THERE, and conflating the two is how a
      // shift quietly stops working. `deploy` sets the assignment and leaves the walk to
      // the keeper, which is correct — movement is a one-second decision and the keeper
      // knows about walls and doorways. But when the keeper does not walk, every signal
      // in the system still reads healthy: the policy is right, the board is green, and
      // DUM reports "the rest hold their station orders".
      //
      // Measured: eleven characters stood on safe walls in room 2601 for hours, all
      // carrying `assignedRoom: 38`, in a room whose generator was dead because 26 surviving
      // statues held it over its cap. Nothing was wrong with the orders and nothing was
      // going to fix it.
      //
      // So a unit whose orders are right but which is somewhere else gets walked. Only
      // when it is genuinely idle: a keeper mid-travel or mid-fight is making progress of
      // its own and must not have a second journey started underneath it.
      // A KEEPER MID-JOURNEY OR MID-FIGHT IS LEFT ALONE WHETHER OR NOT ITS ORDERS CHANGED.
      //
      // This used to guard only the `orders already right` branch, so a unit whose orders
      // were REWRITTEN — which is what happens the moment a station's share is retuned —
      // was deployed on the spot, starting a second journey underneath a character that was
      // already walking or already swinging. That is the one thing this repository says
      // must never happen to a trip: a planned journey accepts its risk when it is planned,
      // and nothing else may cancel it on the character's behalf.
      //
      // Deferring costs nothing. `hunting` and `holding` are not in this list, so a unit
      // takes its new orders at the very next idle moment — which for a fleet on station is
      // seconds away — and a share change rolls through the fleet instead of interrupting
      // it all at once.
      const busyDoing = /travel|fight|pull|rest|recover|park|eat/i.test(String(a.row.activity ?? ''));
      if (busyDoing) return [];
      if (!needsOrders(a.row, orders)) {
        const settled = a.row.room != null && a.row.room !== a.to;
        if (settled)
          return [{ do: 'relocate', agent: a.row.agent, to: a.to,
            why: `orders say ${a.to} and it is standing in ${a.row.room} — walk it there` }];
        return [];
      }
      return [{
        do: 'deploy', agent: a.row.agent, to: a.to, hunt: a.hunt,
        roam: false, purpose: 'advance',
        // `purpose` without `goals` is not a working audit — `yieldCheck` answers
        // "purpose is `advance` but no goals are set, so nothing can be checked" and the
        // row renders as not paying whatever the quarry is.
        goals: [{ kind: 'hp' }],
        // NO WEAPON ORDER HERE. `maintain-qualifying-weapons` owns which order a unit
        // draws in, from its strategies and the doctrine's preset. This used to hardcode
        // `shortSwording` — a second home for that decision, and one that went stale the
        // moment the fleet changed weapon doctrine, quietly reimposing short swords on a
        // shift that had gone back to blunt.
        max_threat_over: a.max_threat_over,
        flee_below: posture(a.station, doctrine.shift, 'flee_below'),
        rest_below: posture(a.station, doctrine.shift, 'rest_below'),
        fight_above_vigor: posture(a.station, doctrine.shift, 'fight_above_vigor'),
        use_safe_spots: posture(a.station, doctrine.shift, 'use_safe_spots') !== false,
        // THE WALL CAP TRAVELS WITH THE STATION OR IT IS NOT SENT AT ALL. `undefined` is
        // dropped by the order diff, which is what a doctrine that says nothing should get —
        // the keeper keeps whatever it had. A doctrine that DOES say so is stating the number
        // that has killed somebody on this project: raised to the size of the fleet, every
        // character is entitled to the same wall square, and the postmortem is wedged 113
        // seconds, gross squares 0, ten monsters in the room, health 40 -> 4 at -0.44/s. Not
        // out-fought — unable to move, with every escape the ladder has being a walk. So it
        // is written beside the room it applies to and not somewhere central.
        max_bots_per_safe_spot: posture(a.station, doctrine.shift, 'max_bots_per_safe_spot'),
        hold_resume_above: posture(a.station, doctrine.shift, 'hold_resume_above'),
        // `strategy` AND `fight_above_vigor` TRAVEL TOGETHER OR THE FLOOR IS ZEROED.
        //
        // The harness's start handler reads the pair: `if (a.strategy !== undefined) { ... if
        // (a.fight_above_vigor === undefined) p.policy.fightAboveVigor = plan.fightAboveVigor
        // ?? 0 }`. `fieldrest` names no floor of its own, so sending the strategy without a
        // vigor floor does not leave the throttle's value alone — it sets it to ZERO, which is
        // not a low floor, it is no floor: the character fights at any vigor however exhausted
        // and never rests to climb. Measured on prod 2026-09-04. `fight_above_vigor` is
        // unconditional above, which is what makes this safe to add.
        //
        // AND WHICH STRATEGY IS LOAD-BEARING. `wellfed` carries `restInTown: true` — it walks
        // a hurt character back to an inn, a journey, with its assignment still reading its
        // station and every board still reading healthy, which is exactly how a confinement
        // leaks. `fieldrest` is the one that never walks back to town.
        strategy: posture(a.station, doctrine.shift, 'strategy'),
        why: `${[].concat(a.hunt).join(' or ')} in ${a.room_name} (${a.to}), roaming off` +
             `${stationBand(a.station) ? ` — ${bandWhy(a.station)} and this unit is ${a.row.level}` : ''}`,
      }];
    });

    if (!plan.length)
      return { kind: 'pass', why: busy
        ? `${busy} of ${placeable.length} unit(s) are mid-errand; the rest hold their station orders`
        : `${placeable.length} unit(s) already hold their station orders` };
    return { kind: 'act', plan,
      // WHAT THE FLEET RE-SORTED ITSELF INTO, WRITTEN DOWN BEFORE ANYTHING WALKS.
      //
      // A band change is the one decision here nobody asked for — the doctrine did not
      // name this character and no operator typed its name — so it has to leave a record
      // that the next rule can read and a person can argue with. `handover` is the reading
      // the sell circuit acts on; the journal gets the same object.
      remember: bandMemory(placeable, plan, observation, doctrine),
      why: `deploy ${plan.length} unit(s) into their assigned stations`,
      evidence: { rooms: [...new Set(placeable.map(a => a.to))],
        quarry: [...new Set(placeable.flatMap(a => [].concat(a.hunt)))],
        bands: placeable.filter(a => stationBand(a.station))
          .map(a => `${a.row.agent} ${a.row.level} -> ${a.to}`),
        unplaceable: assignments.filter(a => a.to == null).length } };
  },
}];

const bandWhy = st => {
  const b = stationBand(st);
  if (!b) return 'no band';
  if (b.at_least != null && b.below != null) return `max health ${b.at_least}-${b.below - 1}`;
  if (b.at_least != null) return `max health ${b.at_least} and over`;
  return `max health under ${b.below}`;
};

/**
 * What this pass learned about who belongs where — the `band` topic, keyed by agent.
 *
 * WHY THIS IS WRITTEN AT ALL, when the band is derivable from the board on any tick. The
 * band is; the CHANGE is not. "This character crossed 50 and should wrap up at the old
 * station before it settles at the new one" is answerable for about two minutes and then
 * the evidence is gone — the orders match, the room matches, and nothing distinguishes a
 * graduate from a character that has always been here. So the crossing is recorded at the
 * moment it is acted on, which is this one.
 *
 * IT IS DELIBERATELY NOT CLEARED BY ANYTHING. `handover_since` is a timestamp, and the sell
 * circuit reads it against its own `last_run_at`: a run that happened AFTER the crossing
 * satisfies it. That is what makes the flag self-clearing without a second write — and a
 * second write is exactly what this repository has no mechanism for, because `readErrand`
 * returns one topic and the shift is not an errand.
 *
 * FIRST SIGHT IS NOT A CROSSING. A fleet that has never run this doctrine has no memory at
 * all, and treating that as "everybody just changed band" would send twenty-one characters
 * to Barloque in one round — down the roads that are the only thing killing this fleet.
 * An agent with no entry gets its band recorded and no handover.
 */
export function bandMemory(placeable = [], plan = [], observation = {}, doctrine = {}) {
  const banded = placeable.filter(a => stationBand(a.station));
  if (!banded.length || doctrine.shift?.handover?.on === false) return null;
  const was = observation.memory?.band ?? {};
  const now = observation.at;
  // ONLY THE UNITS THIS PASS ACTUALLY DEPLOYED. A character that was stepped over for being
  // mid-errand has not moved station yet, and recording its new band now would owe a
  // handover run that ends by walking home to the room it has not been reassigned to.
  const moved = new Set(plan.filter(s => s.do === 'deploy').map(s => s.agent));
  const patch = {};
  for (const a of banded) {
    const key = stationKey(a.station);
    const prev = was[a.row.agent];
    if (prev?.band === key) continue;                       // nothing changed; leave it alone
    if (prev && !moved.has(a.row.agent)) continue;          // changed, but not acted on yet
    patch[a.row.agent] = {
      band: key, at: now, max_health: a.row.level ?? null,
      // A first sighting owes nothing. Only a character that was somewhere else does.
      handover_since: prev ? now : null,
      from: prev?.band ?? null,
    };
  }
  return Object.keys(patch).length ? { topic: 'band', patch } : null;
}
