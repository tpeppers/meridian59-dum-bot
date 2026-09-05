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
import { recordSellrun } from '../decide/rules/sellrun.mjs';
import { recordFeastOutbound, recordFeastGrab, recordFeastAbandon, recordFeastPkCheck } from '../decide/rules/feast.mjs';

const sleep = ms => new Promise(res => setTimeout(res, ms));

// WAIT OUT AN ASYNCHRONOUS WALK. Keeper-backed `travel` returns the instant it sets off
// (`started:true`) and walks in the background — the tool's own note is "poll status — do not
// re-issue while busy". So an errand's travel step is NOT finished when the call returns, and
// firing the next travel immediately lands on a character that is still walking and fails
// "busy: walk to ...", which aborts the whole circuit a second after it began. This polls
// `status` until the character is standing in `dest`, or a timeout. Every errand here routes to
// room NUMBERS; a non-numeric destination is not polled (nothing to compare) and is treated as
// launched. A direct-session travel already blocked and reports `arrived`, so it never gets here.
async function waitForArrival(broker, agent, dest, timeoutMs) {
  const target = Number(dest);
  if (!Number.isFinite(target)) return { ok: true, why: 'destination not a room number; not polled' };
  // Read the room from the fleet BOARD, not `status`. A keeper-backed character is held INERT
  // while it travels, and its `status` comes back empty the whole way — so a status poll never
  // sees arrival and every leg times out. The board keeps reporting the character's room the
  // whole walk. On the board `room` is the NAME and `room_num` is the number (normalize.mjs).
  const roomOf = row => {
    const n = Number(row?.room_num ?? row?.room?.num ?? row?.where?.num);
    return Number.isFinite(n) ? n : null;
  };
  const deadline = Date.now() + Math.max(15_000, timeoutMs || 180_000);
  let last = null;
  while (Date.now() < deadline) {
    await sleep(4000);
    const fl = await broker.call('fleet').catch(() => null);
    const rows = fl?.fleet ?? fl?.characters ?? [];
    const room = roomOf(Array.isArray(rows) ? rows.find(r => r.agent === agent) : null);
    if (room != null) last = room;
    if (room === target) return { ok: true, room };
  }
  return { ok: false, why: `still at ${last ?? '?'} after ${Math.round((timeoutMs || 180_000) / 1000)}s` };
}

/**
 * What each errand kind does with the transcript it produced.
 *
 * The interpreter lives NEXT TO THE RULE, not here: "what does 'You rummage around in
 * an open crate' mean" is knowledge about the crate, and putting it in the executor
 * would make the executor grow a copy of every errand's domain. This is only the index.
 */
export const ERRANDS = {
  'crate-check': { record: recordCrateCheck, topic: 'crate' },
  // Walking back to the assigned room after a death or a shop trip. Nothing to record:
  // the fact it would leave — "this character is at its station" — is already on the
  // fleet board as its room, and re-deriving it here would be a second, staler copy.
  // It is registered so the errand runner does not discard the transcript with a warning.
  'return-to-station': { record: null, topic: null },
  // Leaves one fact behind: when this character last ran the Barloque sell circuit, so the
  // rule's per-character cooldown can gate the next one.
  'sellrun-circuit': { record: recordSellrun, topic: 'sellrun' },
  // THE FEAST HALL JOURNEY, IN THREE SHORT ERRANDS JOINED BY MEMORY. The hall is eleven
  // hops from where the fleet farms, and one blocking errand per character would stand
  // the whole bot down for the walk (see "IT BLOCKS THE PASS" above). So `outbound` only
  // LAUNCHES the walk and records that it is on the road and where home is; `grab` fires
  // when a later tick sees the character standing in the hall, takes food until the pack
  // is full and launches the walk home; `abandon` clears a journey that never arrived.
  // All three share the `feast` topic, keyed by agent. See src/decide/rules/feast.mjs.
  'feast-outbound': { record: recordFeastOutbound, topic: 'feast' },
  'feast-grab': { record: recordFeastGrab, topic: 'feast' },
  'feast-abandon': { record: recordFeastAbandon, topic: 'feast' },
  'feast-pk-check': { record: recordFeastPkCheck, topic: 'feast' },
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
  // The sentence that ended a repeated step early, if one did. See `stop_when` below.
  let satisfied = null;

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

  // Labels of the steps that got as far as they were meant to, for `needs` below.
  const reachedLabels = new Set();
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
    // A REPEATED STEP WHOSE WORK IS DONE IS SKIPPED, NOT SENT. `stop_when` on a step
    // names the sentence that means "there is nothing more to get here" — the feast
    // hall's "You can't hold anything more!" — and every later step marked
    // `skip_when_satisfied` steps aside. Not a failure: the pack is full, which is what
    // the errand was for, and the `always` leg home still runs.
    if (satisfied && step.skip_when_satisfied) {
      results.push({ tool: step.tool, skipped: true, why: `after ${satisfied}` });
      continue;
    }
    // `extend_busy: false` on a step skips the re-declaration for it — sixty three-second
    // activations do not each need a lease extension, and the first of them already asked
    // for the whole run.
    if (i > 0 && !stopped && step.extend_busy !== false) {
      const left = estimateFor(steps.slice(i));
      if (left > 15_000) {
        const extended = await claimBusy(left, `${intent.why} (${steps.length - i} step(s) left)`);
        if (extended?.error || extended?.refused)
          stopped = `could not extend busy (${extended.error ?? extended.refused})`;
      }
    }
    if (step.needs && !reachedLabels.has(step.needs)) {
      // The step it depends on did not get far enough. Skipped, and said out loud, rather
      // than sent into a room where the thing it addresses is not.
      results.push({ tool: step.tool, skipped: true,
                     why: `"${step.needs}" did not complete` });
      continue;
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
    if (step.stop_when instanceof RegExp && Array.isArray(r?.messages)) {
      const said = r.messages.find(m => step.stop_when.test(String(m)));
      if (said) satisfied = `the room said "${said}"`;
    }
    // `optional` MEANS THE ERRAND SURVIVES THIS STEP FAILING, and it is a different word from
    // `always`. `always` is about a step running after the errand has already stopped — the
    // way home. `optional` is about a step's own failure not stopping the errand: a detour
    // that did not come off, where everything after it is still worth doing.
    //
    // IT WAS A COMMENT AND NOT A BEHAVIOUR UNTIL NOW. Steps have carried `optional` since the
    // feast errand's walk-to-the-table, on the belief that a failed approach could not cost a
    // courier its food — and the runner had never read the field, so it could and did. The
    // sell circuit made it matter twice more: a vaultman who is not at his counter must not
    // also cancel the banking, and neither must cancel the walk home.
    let stepOk = true;
    const failed = f => {
      stepOk = false;
      if (!step.optional) { stopped = f; return; }
      results.push({ tool: step.tool, optional: true, failed: f,
                     why: `optional — the errand continues past this` });
    };
    if (r?.error) { failed(`${step.tool} failed: ${r.error}`); continue; }
    if (step.expect === 'arrived') {
      if (r?.started === true) {
        // The async keeper-backed walk: block here until it actually arrives, or the next
        // travel step fires into a still-walking character and the errand dies "busy".
        const reached = await waitForArrival(broker, agent, step.args?.to, step.timeout_ms ?? 180_000);
        if (!reached.ok) {
          // CANCEL THE DANGLING WALK. A travel that timed out is still walking toward its
          // destination in the broker; leaving it running makes this errand's own return leg —
          // and the NEXT errand's first travel — fail "busy: walk to ...". cancel_movement is a
          // no-op if nothing is moving. THIS RUNS FOR AN OPTIONAL STEP TOO: a walk nobody is
          // waiting for any more is still a walk in flight, and it is what makes the next
          // step fail "busy".
          await broker.call('cancel_movement', { agent,
            why: `the errand runner clearing a dangling walk (${errand})` }).catch(() => {});
          failed(`${step.tool} did not arrive at ${step.args?.to} (${reached.why})`);
        }
      } else if (r?.arrived === false) {
        failed(`${step.tool} did not arrive (${r.reason ?? 'no reason given'})`);
      }
    }
    // AND A STEP THAT DEPENDS ON AN OPTIONAL ONE HAVING WORKED HAS TO SAY SO. A vault deposit
    // after a walk that did not arrive would be sent from whatever room the character is
    // actually in, where there is no vaultman — harmless, because the tool resolves the NPC
    // off the live room and refuses, but it is a packet sent hopefully, which is the habit
    // this codebase keeps paying for. `needs` names an earlier step's label.
    // ONLY WHEN IT ACTUALLY GOT THERE. Recording the label regardless is the same bug
    // `needs` exists to prevent: a walk that did not arrive would still mark itself
    // reached, and the deposit after it would be sent from the wrong room anyway.
    if (step.label && stepOk) reachedLabels.add(step.label);
  }

  // FREE IT IN A `finally`-SHAPED WAY: unconditionally, including after a step failed.
  //
  // The lease means a forgotten `busy` heals on its own, but "heals in ten minutes" is a
  // character every stall detector steps over for ten minutes, which on a fleet that
  // restarts stalled keepers is ten minutes of a genuinely stuck character nobody
  // touches. The lease is the net for a bot that DIED; a bot that is still running should
  // put the character back itself.
  //
  // THE ONE EXCEPTION IS A JOURNEY, AND IT IS THE POINT OF `hold_busy_ms`. An errand that
  // only LAUNCHES a walk (the feast hall's outbound leg) returns in seconds while the
  // character walks on for ten minutes under its keeper's journey. Freed here, that walker
  // is takeable, and every rule that reads `takeable` — the station recall above all —
  // would send it somewhere else mid-road. So instead of freeing, the errand EXTENDS the
  // busy it already holds to cover the walk, and lets the lease lapse on its own. An
  // extension by the same holder does not cancel movement (m59-autopilot.mjs declareBusy
  // bumps the movement generation only when an operation BEGINS), so the walk it is
  // protecting is not the walk it interrupts. Bounded by CEILING_MS like every lease here.
  const hold = Number(intent.orders?.hold_busy_ms) || 0;
  if (commit && holder && hold > 0 && !stopped) {
    const held = await claimBusy(Math.min(CEILING_MS, hold),
      `${intent.why} (walking; held for ${Math.round(Math.min(CEILING_MS, hold) / 1000)}s)`);
    results.push({ tool: 'autopilot', args: { action: 'busy', lease_ms: Math.round(Math.min(CEILING_MS, hold)) },
      result: held, why: 'held busy for the walk this errand launched, rather than freed' });
  } else if (commit && holder)
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
  // `stopped` is the failure reason or null on success — a record fn that wants to cool down
  // a completed run differently from an aborted one (sellrun) reads it; others ignore it.
  // `results` and `context` ride along for a record fn that counts what ran rather than
  // what was said (the feast hall's silent dispensers) or needs what the rule knew when
  // it composed the errand (where home is). Older record fns ignore them.
  const { patch, read } = spec.record({ agent: applied.agent, at,
    transcript: applied.transcript, was, stopped: applied.stopped ?? null,
    results: applied.results ?? [], context: applied.context ?? null });
  return { topic: spec.topic, patch, read };
}
