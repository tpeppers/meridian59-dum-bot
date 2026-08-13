// AN ERRAND — THE THIRD WRITE SHAPE, AND THE FIRST ONE THAT IS NOT A POLICY.
//
// Everything else DUM writes goes through `autopilot` and is DESIRED STATE: an intent
// says what the keeper's policy should be, orders.mjs diffs it against what the policy
// IS, and sends the difference. That model is why DUM is safe to run every thirty
// seconds — re-deciding the same thing produces no traffic at all.
//
// An errand is not desired state. It is a SEQUENCE that happens once: walk there, stand
// on that square, do the thing, come back. There is nothing to diff it against, so the
// property that keeps the policy path honest — "sending nothing and sending the same
// value are different acts" — has to be replaced with a different one:
//
//   AN ERRAND IS ONLY EMITTED BY A RULE THAT KNOWS WHEN IT LAST RAN.
//
// That is what src/record/memory.mjs is for, and it is not optional. A rule that emits
// an errand off a condition alone re-emits it on every tick, and the fleet tick runs
// every five minutes: the symptom is a character that lives in a basement.
//
// THREE THINGS THIS DOES RATHER THAN DOCUMENTS.
//
// IT STOPS ON THE FIRST STEP THAT DID NOT ARRIVE. Steps are not independent — the whole
// point of a `go` is that the server answers on the square the character is CURRENTLY
// standing on (`user.kod:5656`), so a `go` after a failed walk is not a weaker version
// of the errand, it is a different action in a different place. `expect: 'arrived'` is
// how a step says the ones after it depend on it.
//
// IT STILL RUNS THE STEPS MARKED `always`. The return leg is one. A half-finished
// errand that leaves a character somewhere the doctrine never chose is worse than one
// that failed, because its keeper then makes perfectly reasonable decisions about a
// room nobody meant it to be in.
//
// IT NEVER RETRIES. Same argument as src/act/verify.mjs: a retry loop makes a failing
// errand look like a working one. The failures here are conditions — the route is
// blocked, the square is occupied, the character is under 30 max health and the room
// says nothing — and every one of them wants a human or a different rule, not the same
// walk again in ten seconds.
//
// TWO COSTS THAT ARE NOT VISIBLE IN THIS FILE AND SHOULD BE KNOWN BEFORE ADDING AN
// ERRAND LONGER THAN THE CRATE ONE.
//
// IT BLOCKS THE PASS. `pass()` runs the fleet tick to completion before any character
// tick, and these steps are awaited, so a three-minute errand is three minutes in which
// no character is ticked. That is tolerable precisely because DUM's character decisions
// are directional and change over minutes — but it scales with the errand, not with the
// fleet, and an errand that walked across the world would stand the bot down for the
// duration.
//
// AND IT STALES THE BOARD BEHIND IT. The character rows every character tick in this
// pass will use were read BEFORE the errand ran, so the character that just walked to a
// basement is still described as being where it started. That is the second reason the
// crate errand walks its character back: an errand that returns leaves the observation
// true, and one that does not leaves every rule below it working from a room number
// that is no longer where the character is.

import { recordCrateCheck } from '../decide/rules/crate.mjs';

/**
 * What each errand kind does with the transcript it produced.
 *
 * The interpreter lives NEXT TO THE RULE, not here: "what does 'You rummage around in
 * an open crate' mean" is knowledge about the crate, and putting it in the executor
 * would make the executor grow a copy of every errand's domain. This is only the index.
 */
export const ERRANDS = {
  'crate-check': { record: recordCrateCheck, topic: 'crate' },
  // These leave progress in FactionGoalStore rather than the general Memory topics.
  'faction-request': { record: null, topic: null },
  'faction-offer': { record: null, topic: null },
  'soldier-request': { record: null, topic: null },
  'soldier-hunt': { record: null, topic: null },
  'soldier-report': { record: null, topic: null },
  // Loyalty service, likewise — and its store branch is the one that must distinguish a
  // revoked membership from an ordinary failure, because only one of the two is worth
  // retrying.
  'loyalty-acquire': { record: null, topic: null },
  'loyalty-request': { record: null, topic: null },
  'loyalty-offer': { record: null, topic: null },
  'faction-game-engage': { record: null, topic: null },
  'faction-game-deliver': { record: null, topic: null },
};

/**
 * Run one errand's steps in order.
 *
 * @param {import('../link/broker.mjs').Broker} broker
 * @param {object} intent  kind 'errand', with orders.{errand, agent, steps[]}
 * @param {object} [opts]
 * @param {boolean} [opts.commit]
 * @returns {Promise<object>} the applied record, with the transcript the caller reads
 */
// HOW LONG AN ERRAND EXPECTS TO TAKE, AND WHY IT IS ASKED RATHER THAN ASSUMED.
//
// The supervisor stands off from a character that is `busy`, and `busy` is LEASED — a bot
// that dies must not leave a character nobody supervises. So the lease is the whole
// interface, and a flat number gets it wrong in both directions: too short and the
// supervisor walks in halfway through a walk across the world, too long and a thirty-second
// errand blocks the unstick round for ten minutes.
//
// PADDING IS NOT OPTIMISM, IT IS THE POINT. A leg that goes SLIGHTLY wrong — a replan
// around a blocked square, a step refused and retried, a monster in the doorway — is the
// ordinary case, and it is exactly the case where being interrupted costs the whole
// errand. So the estimate is doubled and floored, and the errand extends as it goes
// besides. Being wrong long costs a supervisor round; being wrong short costs the errand.
const PAD = 2;
const FLOOR_MS = 90_000;
// A CEILING TOO, because the lease exists to protect the fleet from a bot that stopped
// answering. Anything that genuinely needs longer than this should be several errands.
const CEILING_MS = 15 * 60_000;

// What each tool costs when a step does not say. `travel` is a character WALKING at
// roughly a second a square and a route can be twenty-five hops; the rest are one action
// through the pacer.
const DEFAULT_ESTIMATE_MS = { travel: 120_000, walk_to: 45_000, act: 5_000,
  autopilot: 2_000, faction_join: 10_000, faction_soldier: 150_000,
  faction_game: 150_000 };

/** The padded window this errand wants, from the steps it is about to run. */
export function estimateFor(steps = []) {
  const raw = steps.reduce((n, s) =>
    n + (Number(s.estimate_ms) || DEFAULT_ESTIMATE_MS[s.tool] || 10_000), 0);
  return Math.min(CEILING_MS, Math.max(FLOOR_MS, Math.round(raw * PAD)));
}

export async function runErrand(broker, intent, { commit = false, holder = null,
                                                  busyLeaseMs = null } = {}) {
  const { errand, agent, steps = [] } = intent.orders ?? {};
  if (!ERRANDS[errand])
    // Loud rather than executed. An errand kind nothing can interpret would run, walk a
    // character across the world, and leave no record of what it learned — which is the
    // one outcome worse than not running it.
    throw new Error(`rule "${intent.rule}" emitted errand "${errand}", which is not in ` +
                    `ERRANDS in src/act/errands.mjs. Add it there with the function that ` +
                    `reads its transcript, or the walk happens and the finding is lost`);

  const results = [];
  const transcript = [];
  let stopped = null;

  // SAY SO BEFORE WALKING, AND SAY SO EVEN IF THE WALK FAILS.
  //
  // An errand makes a character look stalled to everything watching it: while `busy`, the
  // keeper still owns death, danger and recovery but yields before directional work, and
  // `ms_since_moved` measures the KEEPER, so it climbs while the character is moving
  // perfectly well. The harness's own supervisor would otherwise read that as a stall and
  // restart the keeper out from under the errand — and every line of both logs would look
  // like success.
  //
  // `busy` is the harness's answer to that: it is leased, only the faculty holder may set
  // it, and it makes every stall detector in the fleet step over the character. The claim
  // has to already be in place, which it is — run.mjs claims before the first pass.
  //
  // NOT FATAL IF IT FAILS. An older broker does not know the action, and an errand that
  // refuses to run because it could not announce itself is worse than one that runs
  // unannounced: the announcement protects against a supervisor that may not be running
  // at all. It is recorded and the errand proceeds.
  // ASK FOR THE TIME THIS ERRAND EXPECTS TO NEED, not a constant. See estimateFor().
  let lease = busyLeaseMs ?? estimateFor(steps);
  const claimBusy = async (ms, note) => {
    if (!commit || !holder) return null;
    const said = await broker.call('autopilot', {
      agent, action: 'busy', by: holder, kind: errand,
      label: intent.orders.label ?? errand,
      why: note ?? intent.why, lease_ms: Math.round(ms),
    }).catch(e => ({ error: e.message }));
    if (said?.error || said?.refused) results.push({ tool: 'autopilot', args: { action: 'busy', lease_ms: Math.round(ms) },
      result: said,
      why: 'could not mark the character busy — the keeper still has directional control, so the errand must not walk' });
    return said;
  };
  const announced = await claimBusy(lease, `${intent.why} (expects about ${Math.round(lease / 1000)}s)`);
  if (announced?.error || announced?.refused)
    stopped = `could not mark busy (${announced.error ?? announced.refused})`;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    // EXTEND AS IT GOES, rather than asking for the worst case once.
    //
    // A single up-front lease has to cover the whole errand, so it is either generous
    // enough to block the unstick round long after the errand finished, or tight enough
    // to lapse in the middle of the one leg that went slowly. Re-declaring before each
    // remaining step asks only for what is LEFT, padded — so a fast errand releases the
    // character early and a slow one keeps extending instead of being cut off.
    //
    // It costs one call per step, which is nothing against a leg that is a character
    // walking a hundred squares.
    if (i > 0 && !stopped) {
      const left = estimateFor(steps.slice(i));
      if (left > 15_000) {
        const extended = await claimBusy(left, `${intent.why} (${steps.length - i} step(s) left)`);
        if (extended?.error || extended?.refused)
          stopped = `could not extend busy (${extended.error ?? extended.refused})`;
      }
    }
    if (stopped && !step.always) {
      results.push({ tool: step.tool, skipped: true, why: `after ${stopped}` });
      continue;
    }
    // A STEP WITH NO TARGET IS SKIPPED, NOT SENT. The return leg's destination is the
    // room the character came from, and a board row that did not report a room number
    // would otherwise become `travel to undefined`.
    if (Object.values(step.args ?? {}).some(v => v === undefined || (v === null && !step.allow_null))) {
      results.push({ tool: step.tool, skipped: true, why: 'an argument was not known' });
      continue;
    }

    const r = commit
      ? await broker.call(step.tool, step.args, { timeoutMs: step.timeout_ms })
          .catch(e => ({ error: e.message }))
      : await broker.write(step.tool, step.args, { why: step.why });

    results.push({ tool: step.tool, args: step.args, label: step.label, why: step.why, result: r });

    // In dry-run every step returns a description, so nothing arrives and nothing is
    // collected — which is correct: a plan describes the walk it would take, it does
    // not pretend to know what the crate would have said.
    if (!commit) continue;

    if (step.collect === 'messages' && Array.isArray(r?.messages)) transcript.push(...r.messages);
    if (r?.error) { stopped = `${step.tool} failed: ${r.error}`; continue; }
    if (step.expect === 'arrived' && r?.arrived === false)
      stopped = `${step.tool} did not arrive (${r.reason ?? 'no reason given'})`;
  }

  // FREE IT IN A `finally`-SHAPED WAY: unconditionally, including after a step failed.
  //
  // The lease means a forgotten `busy` heals on its own, but "heals in ten minutes" is a
  // character every stall detector steps over for ten minutes, which on a fleet that
  // restarts stalled keepers is ten minutes of a genuinely stuck character nobody
  // touches. The lease is the net for a bot that DIED; a bot that is still running should
  // put the character back itself.
  if (commit && holder)
    await broker.call('autopilot', { agent, action: 'free', by: holder })
      .catch(e => results.push({ tool: 'autopilot', args: { action: 'free' },
        result: { error: e.message },
        why: 'could not clear busy — it lapses with the lease, but until then every stall ' +
             'detector steps over this character' }));

  return {
    acted: commit, kind: commit ? 'errand' : 'dry-run-errand',
    errand, agent, sent: steps.map(s => ({ tool: s.tool, args: s.args })),
    results, transcript, stopped,
    context: intent.orders?.context ?? null,
    why: intent.why,
  };
}

/**
 * Turn a finished errand into the memory patch it leaves behind, or null.
 *
 * Separated from running it so the tick can journal the patch as DATA — a function
 * hanging off an intent would not survive being written to ndjson, and the journal
 * being replayable is the property the whole record layer exists for.
 */
export function readErrand(applied, { at, memory = {} }) {
  const spec = ERRANDS[applied?.errand];
  if (!spec?.record || !applied.acted) return null;
  // The PRE-errand snapshot, and the topic comes from the registry rather than from the
  // caller: a tick naming the topic itself would have to be edited every time an errand
  // is added, and the failure of forgetting is that the new errand's memory is merged
  // into the old errand's topic.
  const was = memory?.[spec.topic] ?? {};
  const { patch, read } = spec.record({ agent: applied.agent, at, transcript: applied.transcript, was });
  return { topic: spec.topic, patch, read };
}
