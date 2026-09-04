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

/** Is this character somewhere other than the station this doctrine gave it? */
export function isStranded(row = {}, doctrine = {}, fleetObs = null) {
  if (!row.in_game) return false;
  if (holdsTheBody(row)) return false;
  if (fleetObs && activeFactionWork(fleetObs, row)) return false;
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
            { tool: 'travel', args: { agent: row.agent, to: home },
              timeout_ms: 600_000,
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
