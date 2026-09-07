// SEND PEOPLE BACK TO THEIR STATION.
//
// A character that dies, or finishes an errand, ends up wherever that left it — the
// Underworld exit, a bank, a road — and NOTHING brings it home. `roam: false` is the
// reason: outside its assigned room the keeper has no room to work and no licence to
// wander, so it idles. It is not stalled and does not report as stalled; it is doing
// exactly what it was told, in the wrong place, indefinitely.
//
// The tell is a log full of "nothing to hunt here" from a character whose orders name a
// creature that does not spawn where it is standing. One character logged minutes of it,
// hunting battered skeleton and zombie, nowhere near the room those spawn in.
//
// WHY THIS IS DUM'S JOB AND NOT THE KEEPER'S. The split is by clock. Deciding that a
// character is out of position and should walk back across the world is a MINUTES
// decision with no single right answer — it depends on what the fleet is doing this
// afternoon — which is the bot's half of the boundary. The keeper's one-second half is
// survival, and it is deliberately not given the authority to start a journey.
//
// WHY THIS IS A CHARACTER RULE, WHICH IT WAS NOT AT FIRST. It began fleet-scoped, and
// exactly ONE fleet intent runs per pass. Below the Castle patrol it never fired, because
// that rule does not converge while anyone is committed and a supply trip is a commitment.
// Above it, it starved the PATROL instead — three passes of return-to-station, zero of
// castle-victoria-undead-shift, so the quarry orders never updated and the fleet could not
// fight at all. A persistently-true rule at the top of a single-slot engine starves
// everything under it, whichever way round the two are.
//
// Character scope removes the competition rather than arbitrating it: each character is
// decided on its own, so a recall for one cannot displace the patrol for the fleet. It
// also staggers itself for free — characters are ticked individually, so a fleet-wide
// displacement becomes a queue rather than twenty simultaneous journeys down roads that
// are the only thing killing anybody.
//
// "LOSE THE GOAL ON DEATH" IS SOMETIMES RIGHT AND IS NOT RIGHT HERE. A fleet grinding one
// room wants the station restored; a fleet whose station just killed someone might not.
// So this is a doctrine switch rather than a default, and it names the rooms it will
// return people to rather than trusting whatever `assignedRoom` happens to say.
import { activeFactionWork } from './factions.mjs';
// Pure data — room numbers read off the kod. See the note in isStranded: a room this
// doctrine's own errands send people to is not a room they are stranded in.
import { FEAST_HALL } from '../feast-hall.mjs';
import { mealsAboard } from './food.mjs';

// The feast rule's own default for how long a journey may take before it is given up. Kept
// here as a number rather than imported so this module does not depend on the feast rule,
// which depends on this one; a doctrine that sets `feast.max_trip_ms` overrides both.
const DEFAULT_MAX_TRIP_MS = 30 * 60_000;

// A CLAIM IS NOT AN OPERATION, and reading it as one made the first version vacuous.
//
// DUM's own claim shows up on the board as a commitment — `kind: "bot"`, "holds work,
// movement, economy ... Not an operation, nothing is mid-flight" — so treating "has a
// commitment" as "is busy" excluded every character DUM steers, which is all of them. The
// rule then reported "everybody is at their station" with thirteen of twenty-one scattered
// across the map and the room earning nothing.
//
// The harness already draws this distinction: a claim leaves a character TAKEABLE, and
// `busy` is what makes everything step over it. So `takeable` is the field to read. An
// errand mid-flight, a two-sided trade, or anything that did not mark itself takeable
// keeps the body; a bare claim does not. A piloted character is off limits regardless —
// that is a person playing it.
export const holdsTheBody = row => Boolean(row.parked) || Boolean(row.piloted) ||
  (Boolean(row.commitment) && row.commitment?.takeable !== true);

/** Where this character is supposed to be, or null if this doctrine does not say. */
export function stationFor(row = {}, doctrine = {}) {
  const cfg = doctrine.station ?? {};
  const home = row.policy?.assignedRoom ?? row.assigned_room;
  if (!Number.isInteger(home)) return null;
  const only = Array.isArray(cfg.rooms) && cfg.rooms.length
    ? new Set(cfg.rooms.map(Number)) : null;
  // A station this doctrine does not claim is somebody else's business.
  if (only && !only.has(home)) return null;
  return home;
}

// A RECALL IS A JOURNEY, AND A JOURNEY HAS A HEALTH FLOOR. This is the whole of what the
// harness already believes and the recall was ignoring: `travel_start_health` defaults to
// 1 — rest to FULL before setting out, because an inn is the one place healing is free —
// and `travel_deaths_allowed` defaults to 0, "a death is a failed journey, not an
// interrupted one. Get out of the Underworld, rest at the inn the exit lands in, and do
// not pick the road back up."
//
// Emitting a bare travel step walked straight past both. One character died in the mountains, came
// out of the Underworld, and was sent home from the Marion inn at 1 of 44 health: its own
// record reads 36 -> 1 over 94 squares across rooms 598, 1, 202, 200, losing 0.46 health a
// second, `reached_shelter_after_s: null`. It passed THROUGH the inn that would have healed
// it for free because it was, technically, out of position there.
//
// So a hurt character is not stranded, it is recovering, and the two look identical from a
// room number alone. Healing first is not a delay before the walk; it is the thing that
// makes the walk survivable.
const healthFraction = row => {
  const v = row.hp ?? row.health ?? row.vitals?.health;
  if (v && Number.isFinite(v.value) && Number.isFinite(v.max) && v.max > 0)
    return v.value / v.max;
  // The board renders it as "36/44".
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(row.health ?? ''));
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  return null;
};

/**
 * Is this room somewhere this doctrine's own errands send people?
 *
 * Only rooms belonging to a rule that is switched ON. With the feast off, 953 is an
 * ordinary room again and a character idling there SHOULD be walked home.
 */
export function isDoctrineDestination(room, doctrine = {}) {
  if (!Number.isInteger(room)) return false;
  const out = new Set();
  // THE HALL ITSELF, AND DELIBERATELY NOT THE APPROACH.
  //
  // The first version of this exempted 950, 951 and 50 as well, reasoning that a courier
  // crossing them is mid-errand. It is — but the `busy` hold already protects it there
  // (30 minutes against an 11-minute walk since max_travel_ms was raised), and exempting
  // the approach STRANDS the other half of the trip: a courier that has filled its pack
  // and is walking home sits in Blackstone Keep for ever, because nothing recalls it and
  // its errand has ended. Caught within minutes of shipping it: a courier was found
  // holding 128 slices of pork in 951 with no reason left to move.
  //
  // Standing in the hall is the only part that needs the exemption, because that is where
  // the character deliberately stops for up to six minutes to work the tables.
  if (doctrine.feast?.on) out.add(FEAST_HALL.room);
  for (const r of doctrine.station?.also_allowed ?? []) out.add(Number(r));
  return out.has(Number(room));
}

/** Is this character somewhere other than the station this doctrine gave it? */
/**
 * Is this character part way through an errand of ours that ends somewhere else?
 *
 * Reads the feast journey out of the memory. The bound is `max_trip_ms`, the same number the
 * feast rule uses to abandon a journey that never arrived (`outboundStale`) — deliberately
 * the same, because two different deadlines for "this walk has failed" is how a character
 * ends up exempt from being rescued by one rule and given up on by the other.
 *
 * @param {object} row        the board row
 * @param {object} doctrine
 * @param {object|null} fleetObs   the observation, for its `memory`
 * @returns {boolean}
 */
export function onAJourney(row = {}, doctrine = {}, fleetObs = null) {
  if (!doctrine.feast?.on) return false;
  const mem = fleetObs?.memory?.feast ?? row?.memory?.feast ?? null;
  const e = mem?.[row.agent];
  if (e?.phase !== 'outbound') return false;
  const maxTripMs = doctrine.feast?.max_trip_ms ?? DEFAULT_MAX_TRIP_MS;
  // An entry with no start time is not a journey anybody can reason about. Treat it as
  // stale rather than as an indefinite exemption.
  if (typeof e.since !== 'number') return false;
  const now = fleetObs?.at ?? row?.at ?? null;
  if (typeof now !== 'number') return true;   // no clock on the observation: trust the phase
  return now - e.since <= maxTripMs;
}

export function isStranded(row = {}, doctrine = {}, fleetObs = null) {
  if (!row.in_game) return false;
  // Refuel before returning to work. A repeated recall otherwise monopolises an
  // empty farmer outside its station before the fleet can assign its town lap.
  const town = (fleetObs?.memory ?? row?.memory)?.sellrun?.[row.agent];
  if (doctrine.sellrun?.on && doctrine.sellrun?.trigger?.food_empty === true
      && (mealsAboard(row) === 0 || town?.pending || town?.ok === false)) return false;
  if (holdsTheBody(row)) return false;
  if (fleetObs && activeFactionWork(fleetObs, row)) return false;

  // A ROOM THIS DOCTRINE SENDS PEOPLE TO IS NOT A ROOM THEY ARE STRANDED IN, and getting
  // that wrong cost the fleet its entire food supply for a day.
  //
  // Measured on prod, 2026-09-04. The feast errand walks a courier eleven hops to the
  // Duke's Feast Hall; this rule then read 953 as "out of position" and walked it straight
  // back out, every time, within about thirty seconds of arrival. One was watched doing
  // it: in the hall at r15c24, and back in Blackstone Keep at r12c9 a minute later, at
  // which point activating a table answered "You can't activate the roast pig; it is no
  // longer accessible" — the server's `GetOwner <> poOwner` refusal, right object, wrong
  // room. In one log: 724 travel-to-39 orders against 20 travel-to-953. Not one courier
  // ever took a single slice of pork.
  //
  // The general rule, not a special case for one hall: anywhere this doctrine's own errands
  // deliberately send a character is somewhere it is allowed to be.
  if (isDoctrineDestination(row.room, doctrine)) return false;

  // AND NEITHER IS A CHARACTER PART WAY ALONG THE WALK TO ONE.
  //
  // The check above asks where the character IS. It is the right question once it has
  // arrived and useless for the eleven hops before that: a courier crossing Tos on its way
  // to the Duke's hall is in none of the rooms that journey ends at, so it read as out of
  // position and was recalled — in one watch, 28 recalls against zero food taken, with the
  // dispatch and the recall issued for the same character in the SAME pass.
  //
  // The journey is in the memory, which is where an errand this fleet started records
  // itself. It is bounded by the same staleness the feast rule uses to give a journey up,
  // so a walker that died on the road stops being exempt rather than being left alone for
  // ever — the failure this rule exists to catch.
  if (onAJourney(row, doctrine, fleetObs)) return false;

  const home = stationFor(row, doctrine);
  if (home == null || !Number.isInteger(row.room)) return false;
  if (row.room === home) return false;

  // Unknown health is not permission. If the board did not say, do not start a journey on
  // the assumption that it is fine — the case this exists for is a character that just died.
  const floor = doctrine.station?.min_health ?? 1;
  const hp = healthFraction(row);
  if (hp == null || hp < floor) return false;
  return true;
}

export const stationRules = [
  {
    id: 'return-to-station',
    faculty: 'movement',
    why: 'walk this character back to the room it is assigned to — with roam off it idles ' +
         'wherever a death or an errand left it, and nothing else will ever bring it home',
    enabled: doctrine => doctrine.station?.recall === true,
    offWhy: 'station.recall is off — nothing returns a character to its assigned room',

    decide(obs, doctrine) {
      const row = obs.keeper ? { ...obs, ...obs.keeper } : obs;
      if (!isStranded(row, doctrine, obs.fleet ?? null)) return null;
      const home = stationFor(row, doctrine);
      return {
        kind: 'errand',
        orders: {
          errand: 'return-to-station',
          agent: row.agent,
          steps: [
            // Foreground and generous: a walk home from where a death leaves you can cross
            // most of the map, and the errand runner already waits out an asynchronous
            // keeper travel rather than judging it on the call returning.
            { tool: 'travel', args: { agent: row.agent, to: home, run_errands: false },
              expect: 'arrived', timeout_ms: 600_000,
              why: `out of position in ${row.room}, assigned to ${home}` },
          ],
        },
        why: `out of position in ${row.room} and healed, walking back to ${home}`,
        evidence: { agent: row.agent, in: row.room, assigned: home },
      };
    },
  },
];

// Kept for the fleet-level report only: "who is out of position" is a useful thing to be
// able to ask about the whole fleet even though the acting is per character now.
export function strandedRows(fleetObs = {}, doctrine = {}) {
  return (fleetObs.characters ?? []).filter(row => isStranded(row, doctrine, fleetObs));
}
