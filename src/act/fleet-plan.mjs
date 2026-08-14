// FLEET PLANS ARE PROGRAMS, SMALL ON PURPOSE.
//
// A fleet rule is pure and emits named actions. This file is the sole interpreter for
// those actions. It validates the WHOLE plan before sending the first call, so a typo in
// action seventeen cannot leave sixteen characters moved and then discover that the
// intended operation was never executable.

const need = (step, field) => {
  if (step?.[field] == null || step[field] === '')
    throw new Error(`fleet action "${step?.do ?? '?'}" needs ${field}`);
  return step[field];
};

const resumeKeeper = (agent, why) => ({
  tool: 'autopilot',
  args: { agent, action: 'revive', why: 'DUM maintenance action finished' },
  why,
});

export function callsForFleetPlan(plan = [], why = null) {
  if (!Array.isArray(plan)) throw new Error('fleet intent plan must be an array');
  const calls = [];
  for (const step of plan) {
    if (step.do === 'hold') {
      calls.push({ tool: 'autopilot', args: { agent: need(step, 'agent'), action: 'start', mode: 'idle' },
                   why: step.why ?? why });
      continue;
    }
    if (step.do === 'muster') {
      const agent = need(step, 'agent'), to = need(step, 'to');
      calls.push({ tool: 'autopilot', args: { agent, action: 'start', mode: 'idle' },
                   why: step.why ?? why });
      // Background travel lets all hands set off in one paced burst instead of making
      // the last character wait for twenty foreground journeys. Arrival is verified by
      // the next fleet observation; a failed/partial journey is simply mustered again.
      calls.push({ tool: 'travel', args: { agent, to, background: true },
                   timeoutMs: 300_000, why: step.why ?? why });
      continue;
    }
    if (step.do === 'give') {
      const from = need(step, 'from'), to = need(step, 'to');
      const what = need(step, 'what');
      if (!Array.isArray(what) || !what.length)
        throw new Error(`fleet give ${from} -> ${to} has no exact inventory ids`);
      calls.push({ tool: 'supply',
                   args: { from, to, what, who_travels: 'neither' },
                   timeoutMs: 180_000, why: step.why ?? why });
      continue;
    }
    if (step.do === 'give-weapon') {
      const from = need(step, 'from'), to = need(step, 'to'), what = need(step, 'what');
      if (!Array.isArray(what) || !what.length)
        throw new Error(`fleet weapon handoff ${from} -> ${to} has no exact inventory id`);
      calls.push({ tool: 'supply', args: { from, to, what, who_travels: 'neither' },
                   timeoutMs: 180_000, why: step.why ?? why });
      // Direct inventory operations ask the keeper to stand aside. This transfer is
      // bounded maintenance, not a new owner, so wake both sides even if it fails.
      // applyFleetPlan continues after an error, making these explicit calls the
      // equivalent of a finally block while keeping the complete program journalled.
      calls.push(resumeKeeper(from, step.why ?? why), resumeKeeper(to, step.why ?? why));
      continue;
    }
    if (step.do === 'weapon-policy') {
      calls.push({ tool: 'autopilot', args: { agent: need(step, 'agent'), action: 'start',
        weapon_priority: need(step, 'priority') }, why: step.why ?? why });
      continue;
    }
    if (step.do === 'placement-policy') {
      calls.push({ tool: 'autopilot', args: { agent: need(step, 'agent'), action: 'start',
        assigned_room: step.to == null ? null : Number(step.to),
        max_bots_per_safe_spot: step.max_bots_per_safe_spot == null
          ? null : Number(step.max_bots_per_safe_spot) }, why: step.why ?? why });
      continue;
    }
    if (step.do === 'equip-best') {
      const agent = need(step, 'agent');
      calls.push({ tool: 'equip_best', args: { agent },
                   timeoutMs: 90_000, why: step.why ?? why });
      calls.push(resumeKeeper(agent, step.why ?? why));
      continue;
    }
    if (step.do === 'cast-create-weapon') {
      const agent = need(step, 'agent');
      calls.push({ tool: 'cast', args: { agent, spell: 'create weapon' },
                   timeoutMs: 60_000, why: step.why ?? why });
      calls.push(resumeKeeper(agent, step.why ?? why));
      continue;
    }
    if (step.do === 'cast-create-food') {
      const agent = need(step, 'agent');
      calls.push({ tool: 'cast', args: { agent, spell: 'create food', observe_created: true },
                   timeoutMs: 60_000, why: step.why ?? why });
      calls.push(resumeKeeper(agent, step.why ?? why));
      continue;
    }
    if (step.do === 'buy-next-planned') {
      const agent = need(step, 'agent');
      // The harness deliberately accepts a list but starts only one verified purchase
      // per character. Keeping one agent per plan step makes ownership and the journal
      // name the exact character whose external learning errand was queued.
      calls.push({ tool: 'buy_next_planned_skills', args: { agents: [agent] },
                   why: step.why ?? why });
      continue;
    }
    if (step.do === 'deploy') {
      const agent = need(step, 'agent');
      const assigned_room = step.to == null ? null : Number(step.to);
      calls.push({ tool: 'autopilot', args: {
        agent, action: 'start', mode: 'farm', assigned_room,
        hunt: step.hunt,
        max_threat_over: step.max_threat_over,
        flee_below: step.flee_below,
        max_carry: step.max_carry,
        bank_above: step.bank_above,
        roam: step.roam,
        use_safe_spots: step.use_safe_spots,
        weapon_priority: step.weapon_priority,
        strategy: step.strategy,
        rest_below: step.rest_below,
        fight_above_vigor: step.fight_above_vigor,
        hold_resume_above: step.hold_resume_above,
        purpose: step.purpose,
        goals: step.goals,
        max_bots_per_safe_spot: step.max_bots_per_safe_spot,
      }, why: step.why ?? why });
      continue;
    }
    // WALK THERE. `deploy` sets the assignment and trusts the keeper to act on it, which
    // is right nearly always — the keeper owns movement at one second and knows about
    // walls, monsters in doorways and its own health. But when it does NOT act, nothing
    // else in the system notices: the orders read correct, the board reads healthy, and
    // the character stands still. Measured: eleven characters held safe walls in a room
    // whose generator was dead for hours, every one of them carrying `assignedRoom: 38`.
    //
    // Background, so a fleet pass does not block behind twenty walks.
    if (step.do === 'relocate') {
      const agent = need(step, 'agent');
      calls.push({ tool: 'travel', args: { agent, to: Number(step.to), background: true },
        why: step.why ?? why });
      continue;
    }
    if (step.do === 'stand-down') {
      const agent = need(step, 'agent'), assigned_room = need(step, 'assigned_room');
      calls.push({ tool: 'autopilot', args: { agent, action: 'start', mode: 'idle',
        assigned_room, roam: step.roam }, why: step.why ?? why });
      if (step.moved) calls.push({ tool: 'travel', args: { agent, to: assigned_room, background: true },
        timeoutMs: 300_000, why: step.why ?? why });
      continue;
    }
    throw new Error(`fleet action "${step?.do ?? '?'}" has no executor in src/act/fleet-plan.mjs`);
  }
  return calls;
}

export async function applyFleetPlan(broker, intent, { commit = false } = {}) {
  const calls = callsForFleetPlan(intent.plan, intent.why); // validate all before acting
  const results = [];
  for (const call of calls) {
    const invoke = commit ? broker.call.bind(broker) : broker.write.bind(broker);
    try {
      const result = commit
        ? await invoke(call.tool, call.args, { timeoutMs: call.timeoutMs })
        : await invoke(call.tool, call.args, { why: call.why });
      results.push({ ...call, result });
    } catch (e) {
      // A background muster from the previous pass is success still in progress, not a
      // failed new journey. The next fleet board verifies where it actually arrived.
      if (call.tool === 'travel' && / is busy: walk to /i.test(e.message))
        results.push({ ...call, pending: true, result: { already_walking: true, why: e.message } });
      else results.push({ ...call, error: e.message });
    }
  }
  const failures = results.filter(r => r.error);
  return {
    acted: commit && calls.length > 0,
    kind: commit ? 'fleet-plan' : 'dry-run-fleet-plan',
    plan: intent.plan,
    // `sent` means the exact harness calls, which keeps plan output and the journal useful.
    sent: calls.map(({ tool, args }) => ({ tool, args })),
    results,
    failures,
    partial: failures.length > 0 && failures.length < results.length,
    shortfalls: intent.shortfalls,
    notes: intent.notes,
    why: intent.why,
  };
}
