// DID THE ORDER TAKE? — and the rule that an order which did not take is a FINDING,
// not something to try again.
//
// This is the discipline the LLM bot got right and it is worth copying exactly: an
// action is not complete because the call returned 200. It is complete when a fresh
// read of the world agrees. The harness's whole evidence model is built on the same
// distinction — a safe spot "works" because the character stood in it and was not hit,
// not because the geometry said it should.
//
// AND WHY NOT RETRY. A retry loop makes a failing order look like a working one:
// twenty writes a minute, every one reporting success, and the character's policy never
// changing. The failures that actually happen here are conditions rather than
// transients — the keeper refused, the character is on an errand, the field name was
// wrong — and every one of them wants a human or a different rule, not the same write
// again three seconds later. When the fleet is unattended, an unexplained no-op that
// repeats for an hour is far more expensive than one that stops and says so.
//
// The one exception is a call that never reached the broker at all. That is
// `retriable` on the BrokerError and is handled by the tick's backoff, not here.

import { ORDER_FIELDS } from './orders.mjs';

/**
 * Re-read the character and confirm each field we sent is now what we sent.
 *
 * @param {import('../link/broker.mjs').Broker} broker
 * @param {object} applied  the record from apply()
 * @returns {Promise<{verified: boolean|null, fields: object, why: string}>}
 */
export async function verify(broker, applied) {
  if (!applied?.acted || !applied.sent) return { verified: null, fields: {}, why: 'nothing was sent' };

  // AN ERRAND HAS NOTHING TO RE-READ, AND THAT IS NOT A HOLE IN THE EVIDENCE.
  //
  // Everything else in this file is a policy: a value was written, so a fresh read can be
  // asked whether the keeper holds it. An errand is a sequence that already happened, and
  // its outcome is not a state anyone can look up afterwards — "we rummaged in a crate
  // and it gave us nothing" leaves no trace on the character, in the room, or on the
  // board. The transcript IS the evidence, and it is captured at the instant it exists
  // (`collect: 'messages'` in src/act/errands.mjs) rather than reconstructed later.
  //
  // Saying so out loud matters because a bare `verified: null` reads as "nobody checked",
  // which is exactly the impression this file exists to make impossible.
  if (applied.kind === 'errand' || applied.kind === 'dry-run-errand')
    return { verified: null, fields: {},
             why: `${applied.errand} is a sequence, not a policy — no later read could ` +
                  `confirm it. Its evidence is the transcript, captured as it happened ` +
                  `and journalled under memory_patch` };

  if (applied.kind === 'fleet-plan') {
    const failed = applied.failures ?? [];
    return { verified: failed.length ? false : null, fields: {},
             why: failed.length
               ? `${failed.length} fleet call(s) failed: ${failed.map(f => f.error).join('; ')}`
               : 'fleet calls were accepted; placement and transfers are verified from the next fleet observation' };
  }

  if (applied.kind === 'batch') {
    // Each half of a pairing is verified independently, because the interesting failure
    // is exactly the asymmetric one: side A believes it has a partner and side B has
    // never heard of it. That state is worse than no pairing at all and it is invisible
    // from either character alone.
    const fields = {};
    let allOk = true;
    for (const one of applied.sent) {
      const got = await broker.call('autopilot', { agent: one.agent, action: 'status' })
        .catch(e => ({ error: e.message }));
      const policy = got?.policy ?? got?.autopilot?.policy ?? got?.keeper?.policy ?? {};
      const ok = policy.partner === one.partner;
      fields[one.agent] = { wanted: one.partner ?? null, got: policy.partner ?? null, ok };
      allOk = allOk && ok;
    }
    return {
      verified: allOk, fields,
      why: allOk ? 'both sides of every pairing agree'
                 : 'a one-sided pairing was left behind — one character believes it has a ' +
                   'partner and the other has never heard of it',
    };
  }

  const agent = applied.sent.agent;
  // Generic `status` describes the character and deliberately carries no keeper object.
  // The fresh policy read is the autopilot tool's status action; using the generic one
  // made every successful policy write verify against `{}` and report a false failure.
  const got = await broker.call('autopilot', { agent, action: 'status' })
    .catch(e => ({ error: e.message }));
  if (got?.error) return { verified: null, fields: {}, why: `could not re-read ${agent}: ${got.error}` };

  const policy = got?.policy ?? got?.autopilot?.policy ?? got?.keeper?.policy ?? {};
  const mode = got?.mode ?? got?.autopilot?.mode ?? got?.keeper?.mode ?? null;
  const fields = {};
  let allOk = true;

  for (const [k, wanted] of Object.entries(applied.sent)) {
    if (k === 'agent' || k === 'action') continue;
    const spec = ORDER_FIELDS[k];
    const gotValue = k === 'mode' ? mode : policy[spec?.policy];
    const ok = spec?.compare ? spec.compare(gotValue, wanted)
                             : (gotValue === wanted || (gotValue == null && wanted == null));
    fields[k] = { wanted, got: gotValue ?? null, ok };
    allOk = allOk && ok;
  }

  return {
    verified: allOk,
    fields,
    why: allOk
      ? 'the keeper reports the orders DUM sent'
      : `the keeper did not take ${Object.entries(fields).filter(([, f]) => !f.ok)
          .map(([k, f]) => `${k} (wanted ${JSON.stringify(f.wanted)}, has ${JSON.stringify(f.got)})`)
          .join(', ')}. This is a finding, not something to send again — a retry loop ` +
        `makes a failing order look like a working one`,
  };
}
