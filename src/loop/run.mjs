// THE LONG LOOP, AND THE THREE THINGS IT MUST GET RIGHT WHEN NOBODY IS WATCHING.
//
// 1. IT MUST BE ABLE TO DIE WITHOUT TAKING THE FLEET WITH IT. Everything DUM claims is
//    leased: if this process stops, the keeper takes its faculties back and the
//    characters go on defending themselves. That is enforced on the harness side (see
//    docs/harness-contract.md §Gap 2) and asked for here by heartbeating; the worst
//    case is a fleet that reverts to keeper defaults, which is the fleet's normal
//    unattended state and not an incident.
//
// 2. IT MUST NOT FIGHT THE SUPERVISOR. A fleet may already have `sup.mjs` restarting
//    stalled keepers and reapplying its own `rest_below`, `max_carry` and `roam`. Two
//    things writing the same policy fields on different cadences produces a character
//    whose orders oscillate, and each writer's logs look correct. `yield_to` in the
//    doctrine (or `--yield-to`) names the fields DUM must not touch; running both
//    without it is a configuration error rather than a race to be won.
//
// 3. IT MUST STOP CLEANLY. On SIGINT the current tick finishes, the claim is released,
//    and the journal is flushed. A bot killed mid-write leaves a character half
//    reconfigured and no record of which half.

import { pass } from './tick.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function run(ctx, { onPass = () => {} } = {}) {
  const { config, journal } = ctx;
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  journal.write({ kind: 'startup', doctrine: config.name, fleet: config.fleet,
                  claim: config.claim, commit: ctx.commit,
                  why: 'a run begins. Everything below this line is attributable to this doctrine' });

  let lastFleetAt = 0;
  let consecutiveErrors = 0;

  while (!stopping) {
    const began = Date.now();
    const doFleet = began - lastFleetAt >= config.cadence.fleet_ms;
    try {
      const result = await pass(ctx, { only: ctx.only ?? null, decideFleet: doFleet });
      if (doFleet) lastFleetAt = began;
      consecutiveErrors = 0;
      onPass(result);
    } catch (e) {
      consecutiveErrors++;
      journal.write({ kind: 'pass-failed', why: e.message, consecutive: consecutiveErrors });
      // BACK OFF, BUT DO NOT GIVE UP AND DO NOT ESCALATE FOREVER. The common cause is a
      // broker restart, which resolves on its own inside a minute; the backoff is flat
      // rather than exponential because an exponential one turns a two-minute outage
      // into an hour of not looking.
      await sleep(config.cadence.backoff_ms);
    }
    const elapsed = Date.now() - began;
    const wait = Math.max(0, config.cadence.character_ms - elapsed);
    // Sleep in slices so a SIGINT is picked up inside a second rather than at the end
    // of a five-minute cadence.
    for (let left = wait; left > 0 && !stopping; left -= 500) await sleep(Math.min(500, left));
  }

  journal.write({ kind: 'shutdown', why: 'asked to stop; the claim lapses and the keeper ' +
                                         'takes its faculties back' });
  return { stopped: true };
}
