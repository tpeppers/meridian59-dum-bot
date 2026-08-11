// THE CRATE UNDER CASTLE VICTORIA — a room timer nobody can read, and a lockout that
// refuses in silence.
//
// `DungeonVictoria` (room 41, "Underbasement of Victoria") holds one crate that hands
// out one item every few hours. Two squares matter and both are worked with the GO
// action rather than by walking:
//
//   (row 10, col 7)  "You climb up on the crate."   — teleports you to 10,6. Flavour.
//   (row 10, col 6)  "You rummage around in an open crate."  — the one that can pay.
//
// Everything below is arithmetic out of `kod/object/active/holder/room/dungeon.kod`,
// and each number is here rather than in a doctrine because none of it is a preference:
// it is what the server does.
//
// THE TIMER. `piHoursCounter` starts at `HOURS_PER_TOY` (100) and drops by one every
// game hour (`dungeon.kod:100`, on the room's `RecalcLightAndWeather`). A rummage pays
// out only when the counter has gone BELOW ZERO, and paying resets it to
// `100 + random(0,100) - 50` — 50 to 150 game hours (`dungeon.kod:145`). A game hour is
// the server's `NEW_HOUR_MSG` tick, `60 * KodPeriod` seconds, and `KodPeriod` defaults
// to 5 (`blakserv/systimer.c:93`, `blakserv/config.c:137`). Five real minutes.
//
// So after a find the crate is dry for AT LEAST 4h15m and up again by 12h35m at the
// latest. There is no packet for any of this. The only way to know the counter went
// negative is that somebody rummaged and was given something.
//
// SEARCHING DOES NOT ADVANCE THE TIMER, so checking often produces nothing faster. It
// only decides who is standing there when the window opens, and how long the item sits
// there before somebody else on a shared server takes it.
//
// NOTHING ACCUMULATES EITHER. Once the counter is negative it just keeps going more
// negative; twelve idle hours still yield exactly one item.
//
// THE LOCKOUT IS THE REASON THIS RULE IS FLEET-LEVEL. `if what = poLastFinder { return
// TRUE; }` (`dungeon.kod:138`) refuses the last successful finder — before the timer is
// even consulted, and with no message of any kind. One character working the crate
// alone therefore gets EXACTLY ONE ITEM, EVER. It takes a rotation of at least two, and
// "which of our characters found last" is not a fact any read of the world returns. It
// is remembered, in src/record/memory.mjs.
//
// THE PK GATE. Both squares are guarded by `CheckPlayerFlag PFLAG_PKILL_ENABLE`
// (`dungeon.kod:112`, `:134`). Nobody sets that deliberately; `EvaluatePKStatus`
// (`player.kod:11047`) turns it on when base max health reaches 30, or on guilding. A
// character below it gets no message at all — the go falls through to ordinary movement
// — so a fleet of small characters would probe for ever and never learn why.
//
// WHAT IT PAYS, AND THE PART THAT BITES. Eleven classes, uniform 1-in-11
// (`dungeon.kod:56`): TrueLute 2500, Book 1000, GuildShield 400, ShrunkenHead 50,
// Tanktop 40, Rose / AphrodesiacPotion / LabeledWand 20 each, Junk — and TWO MONSTERS.
// SpiderBaby (level 25, difficulty 4, attack rating 315) and NarthylWorm (level 120,
// difficulty 7, rating 780) are spawned at (11,6), the square immediately south of the
// character that just "found something of interest". That is roughly 18% of every
// successful find, and the worm is far outside the band any character in this fleet may
// fight — `refuseEngagement` caps at max health + 6, and the fleet tops out at 50.
//
// So the median item is worth about forty shillings and one find in nine puts a
// level-120 monster next to the character that got it. THIS IS NOT AN INCOME STREAM AND
// THE DOCTRINE SHOULD NOT TREAT IT AS ONE. It is opt-in, it is gated on the fleet
// ALREADY being in the castle, and the character it sends is the healthiest available
// rather than the most expendable — because the survival floor that has to get it out
// belongs to the keeper, and a keeper has more to work with at full health.

/** Five real minutes. `blakserv/systimer.c:93` with `KodPeriod` at its default of 5. */
import { STRATEGY_IDS, strategyEnabled, strategySettings } from '../../strategies/catalog.mjs';

export const GAME_HOUR_MS = 5 * 60 * 1000;

/**
 * The counter is reset to 50..150 and the payout test is `< 0`, so from a reset of N it
 * takes N+1 decrements. 51 game hours is 4h15m; 151 is 12h35m.
 *
 * EARLIEST IS A HARD REFUSAL AND IT IS SOUND EVEN ON A SHARED SERVER. Our own find
 * reset the counter; anybody else's find after ours resets it AGAIN, later. So the time
 * of our last find is a LOWER BOUND on the last reset, and inside this window the
 * counter cannot be negative for anyone.
 */
export const EARLIEST_MS = 51 * GAME_HOUR_MS;
export const LATEST_MS = 151 * GAME_HOUR_MS;

/**
 * `EvaluatePKStatus` turns `PFLAG_PKILL_ENABLE` on at this base max health
 * (`player.kod:11047`, `PKILL_ENABLE_HP`). Below it the crate does not answer.
 */
export const PK_ENABLE_HP = 30;

/** What the server says. Matched loosely, because it is prose and it is all we get. */
const RUMMAGED = /rummage/i;
const FOUND = /find something of interest/i;

/**
 * Is the crate worth a walk right now, and if not, why not.
 *
 * Pure. `now` and everything about the past arrive as arguments — see the note at the
 * top of src/decide/engine.mjs about why no rule may read a clock.
 *
 * @param {object} crate     the remembered topic: {last_check, last_find, last_finder}
 * @param {number} now
 * @param {number} probeEveryMs
 * @returns {{ready: boolean, state: string, why: string}}
 */
export function crateWindow(crate = {}, now, probeEveryMs) {
  const since = t => (typeof t === 'number' && Number.isFinite(t)) ? now - t : null;
  const mins = ms => `${Math.round(ms / 60000)}m`;

  const sinceCheck = since(crate.last_check);
  const sinceFind = since(crate.last_find);

  // FIRST, BECAUSE THE FLEET TICK RUNS EVERY FIVE MINUTES AND THE CRATE DOES NOT.
  // Without this the rule would fire on every fleet tick from the moment the window
  // opened, which is a character in the basement more or less permanently.
  if (sinceCheck !== null && sinceCheck < probeEveryMs)
    return { ready: false, state: 'just-checked',
             why: `checked ${mins(sinceCheck)} ago; not checking again for ` +
                  `${mins(probeEveryMs - sinceCheck)}` };

  // NOTHING REMEMBERED MEANS GO AND LOOK, and that is the safe direction: the cost of
  // being wrong is one walk to a room one hop away. The opposite convention — treating
  // silence as "recently taken" — produces a fleet that never checks and no symptom.
  if (sinceFind === null)
    return { ready: true, state: 'unknown',
             why: 'no find has been recorded, so the counter may already be below zero' };

  if (sinceFind < EARLIEST_MS)
    return { ready: false, state: 'cooling',
             why: `something was found ${mins(sinceFind)} ago and the counter resets to at ` +
                  `least 51 game hours, so the crate cannot pay for another ` +
                  `${mins(EARLIEST_MS - sinceFind)}` };

  if (sinceFind < LATEST_MS)
    return { ready: true, state: 'possible',
             why: `${mins(sinceFind)} since the last find — inside the 4h15m to 12h35m ` +
                  `window the counter resets into, so it may be up` };

  return { ready: true, state: 'overdue',
           why: `${mins(sinceFind)} since the last find, past the 12h35m ceiling. Either ` +
                `nobody has taken it or another player reset the clock where we cannot see it` };
}

/**
 * Who may go, best first.
 *
 * Pure, and every exclusion is a fact about the room rather than a preference:
 *
 *   * the LAST FINDER is refused by the server in silence, so sending it is a
 *     guaranteed wasted walk that produces the "rummage" line and looks like a normal
 *     miss (`dungeon.kod:138`);
 *   * below `PK_ENABLE_HP` the squares do not answer at all;
 *   * a committed character is halfway through something with another end to it;
 *   * hurt characters are not sent, because one find in nine spawns a monster adjacent
 *     and getting out of that is the keeper's job.
 *
 * The ORDER is by turns: whoever went longest ago, which rotates the fleet through the
 * lockout on its own without anybody needing to model it — and never-been is first.
 */
export function eligibleCheckers(rows, crate = {}, {
  minHealth = 0.8, minLevel = PK_ENABLE_HP, lastFinder = null,
} = {}) {
  const checkedAt = crate.checked_by ?? {};
  const finder = lastFinder ?? crate.last_finder ?? null;

  const ok = (rows ?? []).filter(r =>
    r.in_game && !r.stalled && !r.parked &&
    // ANY commitment, including `partner`. Everywhere else in DUM a partner is the weak
    // kind that does not block a change of orders — but this one WALKS THE CHARACTER OUT
    // OF THE ROOM, and the other half of the pair is standing in the castle waiting for
    // somebody who is now in a basement.
    !r.commitment?.kind &&
    r.agent !== finder &&
    (r.level ?? 0) >= minLevel &&
    // null health is not zero health: a row that did not report is not eligible, because
    // the whole point of the floor is having looked.
    (r.health?.pct ?? null) !== null && r.health.pct >= minHealth);

  return ok.sort((a, b) => {
    const ta = checkedAt[a.agent] ?? -Infinity;
    const tb = checkedAt[b.agent] ?? -Infinity;
    return ta - tb                                   // longest since it last went
        || (b.level ?? 0) - (a.level ?? 0)           // then the one best able to walk out
        || String(a.agent).localeCompare(String(b.agent));   // then deterministically
  });
}

/**
 * What the transcript of one check means.
 *
 * Pure, and the three outcomes are genuinely different rather than degrees of failure:
 *
 *   FOUND     the counter was below zero and has now been reset; this character is the
 *             new `poLastFinder` and is locked out until somebody else finds something.
 *   RUMMAGED  we stood on the right square, the PK gate let us through, and the counter
 *             was not below zero. A clean, informative miss.
 *   NEITHER   the go did not reach the crate mechanic at all — wrong square, or the
 *             character is under 30 base max health and the room said nothing. THAT IS A
 *             FINDING, not a miss, because it is indistinguishable from a miss on the
 *             wire and would otherwise repeat for ever.
 */
export function readCrateTranscript(messages = []) {
  const said = (messages ?? []).filter(m => typeof m === 'string');
  const rummaged = said.some(m => RUMMAGED.test(m));
  const found = said.some(m => FOUND.test(m));
  if (found) return {
    reached: true, found: true, messages: said,
    why: 'found something of interest — the room timer has just been reset and this ' +
         'character is now the one the crate will refuse',
  };
  if (rummaged) return {
    reached: true, found: false, messages: said,
    why: 'rummaged and got nothing, so the counter was not below zero',
  };
  return {
    reached: false, found: false, messages: said,
    why: 'the go produced neither "rummage" nor "find" — the character was not on ' +
         '(row 10, col 6), or it is under 30 base max health and the crate refuses ' +
         'without saying so (dungeon.kod:134). This repeats silently until somebody looks',
  };
}

/**
 * The memory patch one completed check leaves behind.
 *
 * `last_check` moves on any attempt at all, INCLUDING one that reached nothing, because
 * its job is to stop the fleet tick sending somebody every five minutes and a check that
 * failed for a structural reason will fail the same way in five minutes' time.
 *
 * `last_find` and `last_finder` move only on an actual find, because they are claims
 * about the SERVER's state — where the counter is, and who the room will now refuse —
 * and a miss is evidence about neither.
 *
 * `was` is the topic as it stood before this check. It is a parameter rather than
 * something the writer merges, because `checked_by` is a per-character map and
 * Memory.patch is deliberately shallow: handing it `{[agent]: at}` would REPLACE every
 * other character's timestamp, and the rotation would collapse to whoever went last.
 * Keeping the merge here also keeps this function total — the patch it returns is the
 * whole truth about the topic afterwards, which is what makes it journalable.
 */
export function recordCrateCheck({ agent, at, transcript, was = {} }) {
  const read = readCrateTranscript(transcript);
  const patch = {
    last_check: at,
    last_check_by: agent,
    last_reached: read.reached,
    checked_by: { ...(was.checked_by ?? {}), [agent]: at },
  };
  if (read.found) { patch.last_find = at; patch.last_finder = agent; }
  return { patch, read };
}

export const crateFleetRules = [
  {
    id: 'crate-check',
    faculty: 'work',
    scope: 'fleet',
    why: 'the crate under Castle Victoria pays one item every few hours to whoever is ' +
         'standing on it, and refuses whoever found last — so it is worth a short walk ' +
         'only while the fleet is already in the castle, and only by a character that ' +
         'is not the one it will silently refuse',
    enabled: doctrine => doctrine.crate?.check === true,
    offWhy: 'crate.check is off. It walks a character out of the room it is hunting in ' +
            'for a median forty shillings, and one find in nine spawns a monster next to ' +
            'it — so it is opted into rather than assumed',

    decide(fleetObs, doctrine) {
      const c = doctrine.crate ?? {};
      const now = fleetObs.at;
      const zone = new Set(c.zone ?? []);
      const rows = (fleetObs.characters ?? []).filter(r =>
        // Observations produced before the strategy system retain the historical
        // crate.check behaviour. A live DUM snapshot makes the selection explicit.
        !fleetObs.strategies || strategyEnabled(fleetObs, doctrine, r.agent, STRATEGY_IDS.CHECK_CV_CRATE));

      if (!rows.some(r => r.in_game))
        return { kind: 'pass', why: 'no live unit has Check CV Crate enabled' };

      // THE QUORUM IS A PROXIMITY TEST, NOT A VOTE. Two reasons, and both are about the
      // trip being cheap rather than about consensus: the crate is one hop from Castle
      // Victoria and most of a world away from anywhere else, and the lockout means a
      // fleet that can only ever field ONE eligible character down there collects one
      // item and then nothing, for ever.
      const present = rows.filter(r => r.in_game && zone.has(r.room));
      if (present.length < (c.quorum ?? 2))
        return { kind: 'pass',
                 why: `${present.length} character(s) in Castle Victoria; the crate is only ` +
                      `worth a walk from inside it, and the room refuses whoever found last, ` +
                      `so it takes ${c.quorum ?? 2}` };

      const crate = fleetObs.memory?.crate ?? {};
      const window = crateWindow(crate, now, c.probe_every_ms ?? 30 * 60_000);
      if (!window.ready) return { kind: 'pass', why: window.why };

      const eligible = eligibleCheckers(present, crate, {
        minHealth: c.min_health ?? 0.8,
        minLevel: c.min_level ?? PK_ENABLE_HP,
      });
      if (!eligible.length)
        // NOT SILENCE. This is the state that looks exactly like the feature working —
        // the window is open, nobody is going, and nothing says why. The commonest cause
        // is that the only characters in the castle are under 30 max health, which is
        // permanent until they grow.
        return { kind: 'pass',
                 why: `the crate ${window.state === 'unknown' ? 'may be up' : 'is ' + window.state}, ` +
                      `but none of the ${present.length} character(s) in the castle may go: ` +
                      `${crate.last_finder ? `${crate.last_finder} found last and is refused, ` : ''}` +
                      `the rest are committed, hurt, or under ${c.min_level ?? PK_ENABLE_HP} max health` };

      const who = eligible[0];
      const room = c.room ?? 41;
      const square = c.square ?? { col: 6, row: 10 };
      const back = who.room ?? null;
      const observeReward = strategyEnabled(fleetObs, doctrine, who.agent, STRATEGY_IDS.DETAILED_STATS) &&
        strategySettings(fleetObs, doctrine, who.agent, STRATEGY_IDS.DETAILED_STATS).crate_check;

      return {
        kind: 'errand',
        orders: {
          errand: 'crate-check',
          agent: who.agent,
          steps: [
            // One hop from the castle. Foreground rather than `background: true`, because
            // the next two steps depend on having arrived and a backgrounded travel would
            // have the character walk while we told it to stand on a square.
            { tool: 'travel', args: { agent: who.agent, to: room },
              expect: 'arrived', timeout_ms: c.travel_timeout_ms ?? 180_000,
              // One hop from the castle, and the walk inside room 41 is most of its length.
              estimate_ms: 90_000, why: 'to the Underbasement of Victoria' },
            // walk_to takes col,row — the kod's square is row 10, col 6.
            { tool: 'walk_to', args: { agent: who.agent, col: square.col, row: square.row },
              expect: 'arrived', timeout_ms: c.walk_timeout_ms ?? 90_000,
              // Fourteen rows up an open floor at roughly a second a square.
              estimate_ms: 30_000, why: 'onto the crate square itself' },
            ...(observeReward ? [{ tool: 'inventory', args: { agent: who.agent },
              label: 'crate-before', estimate_ms: 3_000,
              why: 'snapshot the pack so a successful crate check can name its reward' }] : []),
            // `act verb:'go'` IS THE MECHANIC. Not walking — `UserGo` sends the
            // character's CURRENT square (`user.kod:5656`) and the room answers on that.
            // It must not run unless the walk arrived: a `go` on an exit square takes
            // the exit, and room 41's exit to the castle is at (25,2).
            { tool: 'act', args: { agent: who.agent, verb: 'go' },
              timeout_ms: 30_000, collect: 'messages', estimate_ms: 5_000,
              why: 'rummage in the crate and read what the room says back' },
            ...(observeReward ? [{ tool: 'inventory', args: { agent: who.agent },
              label: 'crate-after', estimate_ms: 3_000,
              why: 'read the pack delta after the crate answers' }] : []),
            ...(c.return_after === false ? [] : [
              // ALWAYS, INCLUDING AFTER A FAILURE. Leaving a character standing in the
              // basement because the walk did not arrive is worse than the failed check:
              // its keeper will make its own decision about a room the doctrine never
              // sent it to. A travel to the room it is already in returns at once.
              { tool: 'travel', args: { agent: who.agent, to: back },
                timeout_ms: c.travel_timeout_ms ?? 180_000, always: true, estimate_ms: 90_000,
                why: 'back to the room it was hunting in' },
            ]),
          ],
        },
        why: `${window.why}. Sending ${who.agent} down from ${who.room_name ?? `room ${who.room}`}` +
             (crate.last_finder ? ` (${crate.last_finder} found last and would be refused in silence)` : ''),
        evidence: {
          state: window.state,
          in_castle: present.map(r => r.agent),
          eligible: eligible.map(r => r.agent),
          last_finder: crate.last_finder ?? null,
          last_find: crate.last_find ?? null,
          last_check: crate.last_check ?? null,
        },
      };
    },
  },
];
