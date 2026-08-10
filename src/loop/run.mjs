// THE LONG LOOP, AND THE THREE THINGS IT MUST GET RIGHT WHEN NOBODY IS WATCHING.
//
// 1. IT MUST BE ABLE TO DIE WITHOUT TAKING THE FLEET WITH IT. Everything DUM claims is
//    leased: if this process stops, the keeper takes its faculties back and the
//    characters go on defending themselves. That is enforced on the harness side (see
//    docs/harness-contract.md §Gap 2) and asked for here by heartbeating; the worst
//    case is a fleet that reverts to keeper defaults, which is the fleet's normal
//    unattended state and not an incident.
//
// 2. IT MUST NOT FIGHT THE SUPERVISOR. The harness's own `m59-supervise.mjs` restarts
//    stalled keepers and, on every deploy, rewrites a character's whole policy block:
//    `rest_below`, `max_carry`, `roam`, `flee_below`, `fight_above_vigor`. Two things
//    writing the same fields on different cadences produces a character whose orders
//    oscillate, and each writer's logs look correct. `yield_to` in the doctrine (or
//    `--yield-to`) names the fields DUM must not touch; running both without it is a
//    configuration error rather than a race to be won.
//
//    Until 2026-08-10 this named a `sup.mjs` living outside every repository. That file
//    exists nowhere and no such process runs — its job is `m59-supervise.mjs`, which is
//    IN the harness and starts only when asked. The dead claim had reached four
//    documents and was still being designed against, which is the specific way a stale
//    fact costs something: it does not read as wrong, it reads as context.
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

  // ---------------------------------------------------------------- the claim, for real
  //
  // Until the harness grew per-faculty claims this was a promise the doctrine made and
  // nothing enforced: DUM wrote orders and no one could see who owned the character. It
  // is now a lease, and the three properties that matter are the harness's, not ours —
  // survival and mortality are REFUSED unless that machine's operator has consented, an
  // expired lease reverts to the keeper, and the keeper never stops executing.
  //
  // A claim is per character, because ownership is. `mine` records what was actually
  // granted rather than what was asked for, so the release at the end hands back exactly
  // what we hold and the journal records any refusal instead of assuming success.
  const wanted = Object.entries(config.claim ?? {})
    .filter(([f, owner]) => owner === 'bot' &&
            !['i_accept_the_character_may_die', 'lease_ms'].includes(f))
    .map(([f]) => f);
  // From the context, not recomputed. The identity has to be the SAME STRING everywhere:
  // the harness lets only a claim's holder declare that character busy or free it, so two
  // spellings would be two processes — one that can claim and one that can never release.
  const holder = ctx.holder ?? `dum/${config.name}@pid-${process.pid}`;
  const leaseMs = config.claim?.lease_ms ?? 120_000;
  const mine = new Map();

  async function claimFor(agents) {
    if (!ctx.commit || !wanted.length) return;
    for (const agent of agents) {
      if (mine.has(agent)) continue;
      const r = await ctx.broker.call('autopilot', {
        agent, action: 'claim', faculties: wanted, by: holder,
        lease_ms: leaseMs, why: `doctrine "${config.name}" is directing this character`,
      }).catch(e => ({ error: e.message }));
      if (r?.error) { journal.write({ kind: 'claim-failed', agent, why: r.error }); continue; }
      mine.set(agent, r.granted ?? []);
      // A REFUSAL IS NOT AN ERROR AND MUST NOT BE SILENT. The harness refuses survival
      // and mortality unless the operator consented on that machine; recording it is how
      // a doctrine that quietly did not get what it asked for becomes visible.
      if (r?.refused?.length)
        journal.write({ kind: 'claim-refused', agent, refused: r.refused,
                        why: 'the harness declined part of the claim' });
    }
  }

  async function heartbeat() {
    if (!ctx.commit) return;
    for (const agent of mine.keys())
      await ctx.broker.call('autopilot', { agent, action: 'heartbeat', by: holder, lease_ms: leaseMs })
        .catch(e => journal.write({ kind: 'heartbeat-failed', agent, why: e.message }));
  }

  async function releaseAll() {
    if (!ctx.commit) return;
    for (const agent of mine.keys())
      await ctx.broker.call('autopilot', { agent, action: 'yield', by: holder })
        .catch(() => {});   // the lease expires on its own; a failed release is not fatal
  }

  let lastFleetAt = 0;
  let consecutiveErrors = 0;

  while (!stopping) {
    const began = Date.now();
    const doFleet = began - lastFleetAt >= config.cadence.fleet_ms;
    try {
      const result = await pass(ctx, { only: ctx.only ?? null, decideFleet: doFleet });
      // Claim whoever we just decided about, then push the lease out. Claiming AFTER the
      // pass rather than before it means a character that turned out to be committed to
      // something else is never claimed at all.
      await claimFor((result.characters ?? []).map(l => l.agent).filter(Boolean));
      await heartbeat();
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

  // Hand back what we hold rather than waiting for the lease to lapse. The lease is the
  // SAFETY net for a process that dies badly; a process that stops on purpose should not
  // leave a character owned by a pid that no longer exists for two more minutes.
  await releaseAll();
  journal.write({ kind: 'shutdown', held: [...mine.keys()],
                  why: 'asked to stop; the claim was released and the keeper has its ' +
                       'faculties back. Anything not released lapses on its own' });
  return { stopped: true };
}
