// ONE TICK. sense -> decide -> act -> verify -> record, in that order, for one
// character or for the fleet.
//
// The stages are separate functions rather than one loop because a wrong answer has to
// be attributable to one of them. "The bot did the wrong thing" is not a diagnosis;
// "the observation had a null level so the ladder rung was unanswerable" is.
//
// A TICK NEVER THROWS. Every stage's failure becomes a journal line and the next
// character is still ticked. The alternative — one bad observation stopping the fleet —
// is the failure mode that costs most, because it is silent: a bot that died on
// character three looks exactly like a bot with nothing to do for characters four
// through twenty-one.

import { observeFleet, observeFromBoard, deepen } from '../sense/observe.mjs';
import { characterRules, fleetRules, decide } from '../decide/index.mjs';
import { apply } from '../act/orders.mjs';
import { verify } from '../act/verify.mjs';
import { readErrand } from '../act/errands.mjs';

/**
 * One character.
 *
 * TWO PHASES, and the split is the whole cost model — see src/sense/observe.mjs.
 * Phase one decides from the free fleet board. Only an intent that has to be DIFFED
 * against the keeper's live policy justifies paying for `status`, which is four server
 * requests per character.
 *
 * @param {object} ctx
 * @param {import('../link/broker.mjs').Broker} ctx.broker
 * @param {object} ctx.config
 * @param {import('../record/journal.mjs').Journal} ctx.journal
 * @param {boolean} ctx.commit
 * @param {object} row  this character's normalised fleet-board row
 */
export async function tickCharacter(ctx, row) {
  const { broker, config, journal, commit } = ctx;
  const now = ctx.now?.() ?? Date.now();
  const agent = row.agent;
  const line = { kind: 'tick', at: now, agent };

  try {
    // ---- phase one: free
    let obs = observeFromBoard(row, { now });
    let { intent, considered } = decide(characterRules, obs, config);
    line.considered = considered;

    // ---- phase two: paid, and only for an order
    //
    // `report` and `none` never reach the server. That is not a saving at the margin:
    // on a quiet fleet it is the difference between a tick costing one call and a tick
    // costing eighty-five.
    if (intent && intent.kind === 'orders') {
      obs = await deepen(broker, obs, characterRules.needs(config), { now });
      line.deepened = true;
      // Decide AGAIN on the fuller observation. Rules are pure, so this costs nothing,
      // and the second answer may legitimately differ — a rule that could not see the
      // keeper's policy may now find the keeper already has these orders. That is the
      // design working, not a race.
      ({ intent, considered } = decide(characterRules, obs, config));
      line.considered = considered;
    }

    line.observation = obs;
    line.intent = intent;
    if (!intent) { journal.write(line); return line; }

    const applied = await apply(broker, intent, obs, { commit, yieldTo: config.yield_to ?? [], holder: ctx.holder });
    line.applied = applied;

    if (applied.acted) {
      line.verified = await verify(broker, applied);
      if (line.verified.verified === false)
        journal.finding(agent, line.verified.why, { sent: applied.sent, fields: line.verified.fields });
    }
    if (intent.kind === 'report') journal.finding(agent, intent.why, intent.evidence);

    journal.write(line);
    return line;
  } catch (e) {
    line.error = e.message;
    line.retriable = !!e.retriable;
    journal.write(line);
    return line;
  }
}

/**
 * The fleet-level tick.
 *
 * `decide: false` reads the board and runs no fleet rules. That combination is not a
 * half-measure — the board is the tick's SPINE (it is where the list of characters
 * comes from, and it is free) while the fleet RULES run on a much slower cadence,
 * because each of them stops keepers and walks characters across the world.
 */
export async function tickFleet(ctx, { decide: runRules = true } = {}) {
  const { broker, config, journal, commit } = ctx;
  const now = ctx.now?.() ?? Date.now();
  const line = { kind: 'fleet-tick', at: now, decided: runRules };

  try {
    // WHAT DUM REMEMBERS ARRIVES IN THE OBSERVATION, EXACTLY AS THE CLOCK DOES.
    //
    // `src/decide/` is pure by law — no clock, no randomness, no I/O — and a rule that
    // read the memory file directly would break that for the same reason `Date.now()`
    // would: the decision would stop being reproducible from its own journal line. So it
    // is read ONCE here, put on the observation, and journalled with it. A rule that
    // needs the past gets it as data.
    const memory = ctx.memory?.read() ?? null;
    const obs = { ...await observeFleet(broker, { now }), memory };
    line.observation = obs;

    // STAND DOWN WHILE THE FLEET IS PARKING. A parked keeper is running and
    // deliberately doing nothing, which is exactly what this loop is built to notice
    // and "fix" — and fixing it clears the parking flag and sends the character back to
    // work in the minute before the broker goes down. Worse, deploying is not merely
    // useless here: it stops keepers and walks characters across the world, so an update
    // arriving mid-deploy takes the outage with characters somewhere between towns.
    //
    // One parked character stands the whole tick down. The update is measured in
    // minutes and this runs every few of them; nothing is lost by waiting.
    if (obs.parking > 0) {
      line.stood_down = `${obs.parking} character(s) are parking for a fleet update`;
      journal.write(line);
      return line;
    }

    if (!runRules) { journal.write(line); return line; }

    const { intent, considered } = decide(fleetRules, obs, config);
    line.considered = considered;
    line.intent = intent;
    if (!intent) { journal.write(line); return line; }

    const applied = await apply(broker, intent, obs, { commit, yieldTo: config.yield_to ?? [], holder: ctx.holder });
    line.applied = applied;

    // WHAT AN ERRAND LEARNED, WRITTEN DOWN BEFORE ANYTHING ELSE CAN FAIL.
    //
    // An errand's whole product is what the world said back to it, and that answer exists
    // in exactly one place for a few milliseconds. If this pass throws afterwards — or
    // the broker goes away, or the process is killed — the walk still happened, the
    // window may still have been consumed, and nothing would remember. So the memory is
    // patched here, immediately, and the patch is journalled as data.
    if (applied.errand) {
      // `memory` is the PRE-errand snapshot read at the top of this tick, which is what
      // the interpreter needs: `checked_by` is a per-character map and Memory.patch is
      // deliberately shallow, so the merge has to happen against what was there before.
      const learned = readErrand(applied, { at: now, memory });
      if (learned) {
        line.memory_patch = learned;
        ctx.memory?.patch(learned.topic, learned.patch);
        // A CHECK THAT REACHED NOTHING IS A FINDING, NOT A MISS. On the wire the two are
        // identical — no message either way — so without this a fleet under 30 max health
        // would walk to a basement every half hour for ever and the board would show it
        // working. See readCrateTranscript in src/decide/rules/crate.mjs.
        if (learned.read.reached === false)
          journal.finding(applied.agent, learned.read.why,
                          { errand: applied.errand, transcript: applied.transcript,
                            stopped: applied.stopped ?? null });
      }
      if (applied.stopped)
        journal.finding(applied.agent, `the ${applied.errand} errand stopped early: ${applied.stopped}`,
                        { sent: applied.sent });
    }

    if (applied.acted) line.verified = await verify(broker, applied);
    if (applied.partial)
      journal.finding(null, 'a batch was half applied — see verified.fields for which side is missing',
                      { sent: applied.sent });
    if (intent.kind === 'report') journal.finding(null, intent.why, intent.evidence);

    journal.write(line);
    return line;
  } catch (e) {
    line.error = e.message;
    journal.write(line);
    return line;
  }
}

/**
 * A full pass: the fleet board, then every character the doctrine is responsible for.
 *
 * `only` restricts to one agent, which is what `plan --agent` uses. Restricting is not
 * the same as skipping the board — a single-character plan still reads it, because half
 * of what makes a directional decision correct is what the other twenty characters are
 * doing, and because the board is where the character's own numbers come from.
 */
export async function pass(ctx, { only = null, decideFleet = true } = {}) {
  const fleetLine = await tickFleet(ctx, { decide: decideFleet });
  if (fleetLine.stood_down || fleetLine.error) return { fleet: fleetLine, characters: [] };

  const rows = (fleetLine.observation?.characters ?? [])
    .filter(r => r.in_game)
    .filter(r => !only || r.agent === only);

  if (only && !rows.length)
    return { fleet: fleetLine, characters: [],
             note: `no character named "${only}" is in game on this fleet` };

  const characters = [];
  for (const r of rows) characters.push(await tickCharacter(ctx, r));
  return { fleet: fleetLine, characters };
}
