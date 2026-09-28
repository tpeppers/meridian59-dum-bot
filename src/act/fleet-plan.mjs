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

const keptHeld = step => new Set(Array.isArray(step?.keep_held) ? step.keep_held : []);
export const ENCHANT_TRANCE_MS = 33_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const resumeKeeper = (agent, why) => ({
  tool: 'autopilot',
  args: { agent, action: 'revive', why: 'DUM maintenance action finished' },
  why,
});

// A FIELD THE OPERATOR OWNS IS NOT WRITTEN BY A DEPLOY EITHER. Added 2026-09-10.
//
// `yield_to` is documented as "fields something else writes", and until now it was honoured
// in exactly one place: `planOrders`, the policy-DIFF path. A fleet `deploy` does not go
// through that path — it builds the flat argument object below and sends it — so every
// yielded field was written anyway, on every deploy, silently. From the operator: "Why should
// hunt-shift override the settings we want, we want it to keep fighting with the settings we
// want."
//
// It could not be worked around from a doctrine, which is what made it a bug rather than a
// preference: `posture()` in rules/shift.mjs falls back station -> `doctrine.shift` -> built-in
// default, so DELETING a field from a station does not stop it being sent, it just sends the
// default instead. The only way to say "leave this alone" is here.
//
// Dropped fields are RETURNED, never merely omitted — a setting that quietly does nothing is
// the failure this repository has paid for twice (`purpose` missing from a schema for a year,
// and the whitelist ten lines below this one).
const dropYielded = (args, yieldSet, dropped) => {
  if (!yieldSet.size) return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (yieldSet.has(k) && v !== undefined) { dropped.push(k); continue; }
    out[k] = v;
  }
  return out;
};

export function callsForFleetPlan(plan = [], why = null, { yieldTo = [] } = {}) {
  const yieldSet = new Set(yieldTo);
  const yieldedFields = [];
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
      // `keep_held` names a side that must NOT wake yet — a dedicator mid-round (see
      // `inert-keeper`), whose keeper otherwise wields the weapon it was just handed.
      for (const agent of [from, to])
        if (!keptHeld(step).has(agent)) calls.push(resumeKeeper(agent, step.why ?? why));
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
      calls.push({ tool: 'autopilot', args: dropYielded({
        agent, action: 'start', mode: 'farm', assigned_room,
        hunt: step.hunt,
        max_threat_over: step.max_threat_over,
        flee_below: step.flee_below,
        max_carry: step.max_carry,
        bank_above: step.bank_above,
        roam: step.roam,
        use_safe_spots: step.use_safe_spots,
        weapon_priority: step.weapon_priority,
        // THIS OBJECT IS A WHITELIST AND SILENCE IS ITS FAILURE MODE. A field the rule sets
        // and this list omits is dropped here with no error raised anywhere: the doctrine
        // reads correct, the journal shows the rule firing, and the keeper never hears it.
        // Adding an order field is a FOUR-file change — schema.mjs to validate it,
        // shift.mjs to put it on the intent, this object to carry it, and orders.mjs so the
        // diff can tell whether it already matches.
        training_style: step.training_style,
        training_weapon: step.training_weapon,
        buff_allies: step.buff_allies,
        banned_weapons: step.banned_weapons,
        strategy: step.strategy,
        rest_below: step.rest_below,
        fight_above_vigor: step.fight_above_vigor,
        hold_resume_above: step.hold_resume_above,
        purpose: step.purpose,
        goals: step.goals,
        max_bots_per_safe_spot: step.max_bots_per_safe_spot,
        prefer_magic_weapon: step.prefer_magic_weapon,
        threat_ceiling: step.threat_ceiling,
        vigor_ceiling: step.vigor_ceiling,
        no_food_vigor_floor: step.no_food_vigor_floor,
        // The troll crew's sell triggers, raised while a stage-room courier takes their loot.
        sell_at_load: step.sell_at_load,
      }, yieldSet, yieldedFields), why: step.why ?? why });
      continue;
    }
    // THE KEEPER'S MAGIC TIE-BREAK ON ITS OWN, for a unit held at a stage room: it must already
    // prefer the enchanted twin the moment a dedication hands it back.
    if (step.do === 'magic-policy') {
      calls.push({ tool: 'autopilot', args: { agent: need(step, 'agent'), action: 'start',
        prefer_magic_weapon: step.prefer !== false }, why: step.why ?? why });
      continue;
    }
    // A REAGENT BY NAME. `supply` takes a single reagent's whole name and an amount
    // (m59-broker.mjs `supply.what`), and the free board carries names without ids, so this is
    // the one hand-over that is not addressed by object id.
    if (step.do === 'give-gear') {
      // BY NAME, one piece: the harness never offers a worn item by name, caps singles at
      // `amount`, and hands over no gear at all when the giver's use list is unknown.
      const from = need(step, 'from'), to = need(step, 'to'), item = need(step, 'item');
      calls.push({ tool: 'supply', args: { from, to, what: String(item), amount: 1,
        who_travels: 'neither' }, timeoutMs: 180_000, why: step.why ?? why });
      for (const agent of [from, to]) calls.push(resumeKeeper(agent, step.why ?? why));
      continue;
    }
    if (step.do === 'wear-best') {
      const agent = need(step, 'agent');
      calls.push({ tool: 'wear_best', args: { agent }, timeoutMs: 90_000, why: step.why ?? why });
      calls.push(resumeKeeper(agent, step.why ?? why));
      continue;
    }
    if (step.do === 'give-reagent') {
      const from = need(step, 'from'), to = need(step, 'to'), item = need(step, 'item');
      calls.push({ tool: 'supply', args: { from, to, what: String(item),
        amount: Number(step.amount ?? 1), who_travels: 'neither' },
        timeoutMs: 180_000, why: step.why ?? why });
      for (const agent of [from, to])
        if (!keptHeld(step).has(agent)) calls.push(resumeKeeper(agent, step.why ?? why));
      continue;
    }
    // HOLD A KEEPER STILL ACROSS SEVERAL STEPS. A dedication round is give, cast, give back,
    // and on 2026-09-26 the first live one failed in the gap: `give-weapon` revived Raphael's
    // keeper, which wielded the axe it had just been handed (axe outranks his mace), and the
    // hand-back of a wielded weapon was refused. `supply` leaves a hold it did not take alone,
    // so an inert keeper stays inert through the trades until the last step revives it.
    if (step.do === 'inert-keeper') {
      calls.push({ tool: 'autopilot', args: { agent: need(step, 'agent'), action: 'inert',
        why: step.why ?? why ?? 'held for a fleet round' }, why: step.why ?? why });
      continue;
    }
    // KRAANAN'S DEDICATION, aimed at a weapon IN THE CASTER'S OWN PACK by object id
    // (enchwp.kod: the target must be in range, and a pack is). 17 mana, 3 elderberry, 1 orc
    // tooth, a 30-second trance. The weapon goes back to its owner in the NEXT step whether or
    // not this landed — applyFleetPlan carries on past a failure, which is the finally block.
    if (step.do === 'cast-enchant-weapon') {
      const agent = need(step, 'agent'), target = need(step, 'target');
      // `holdMs` makes the KEEPER hold still for the whole trance (its own default is 15s).
      // The broker defaults it from the spell's cast time too; sent explicitly so an older
      // broker that only forwards what it is given still holds long enough.
      const trance = Number(step.trance_ms ?? ENCHANT_TRANCE_MS);
      calls.push({ tool: 'cast', args: { agent, spell: 'enchant weapon', target: Number(target),
                                         holdMs: trance + 7_000 },
                   timeoutMs: 90_000, why: step.why ?? why });
      // AND WAIT OUT THE TRANCE (viCast_time 30000, enchwp.kod). `cast` returns within about
      // four seconds; the first live round handed the weapon back six seconds after casting,
      // which broke the trance — no reagents spent, no enchantment. Nothing is revived here:
      // the hand-back that follows wakes both sides once the spell has had its time.
      calls.push({ tool: 'wait', local: true, ms: trance,
                   why: 'enchant weapon is a 30-second trance; any action before it ends breaks it' });
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
      calls.push({ tool: 'autopilot', args: dropYielded({ agent, action: 'start', mode: 'idle',
        assigned_room, roam: step.roam, fight_above_vigor: step.fight_above_vigor,
        vigor_ceiling: step.vigor_ceiling, no_food_vigor_floor: step.no_food_vigor_floor,
        sell_at_load: step.sell_at_load, max_carry: step.max_carry, bank_above: step.bank_above },
        yieldSet, yieldedFields), why: step.why ?? why });
      if (step.moved) calls.push({ tool: 'travel', args: { agent, to: assigned_room, background: true },
        timeoutMs: 300_000, why: step.why ?? why });
      continue;
    }
    throw new Error(`fleet action "${step?.do ?? '?'}" has no executor in src/act/fleet-plan.mjs`);
  }
  // Non-enumerable so every existing caller that maps or compares this array is unaffected,
  // and `deepEqual` on the calls in the tests still passes.
  Object.defineProperty(calls, 'yielded', { value: [...new Set(yieldedFields)], enumerable: false });
  return calls;
}

/**
 * The memory patch for an applied plan's refused hand-overs, or null. Pure. Topic `supply`,
 * one key per `from>to` pair (Memory.patch is shallow, so each pair overwrites only itself).
 */
export function refusedSupplies(applied, at) {
  if (!applied?.refused?.length) return null;
  const patch = {};
  for (const r of applied.refused)
    patch[`${r.from}>${r.to}`] = { at, reason_code: r.reason_code, ids: (r.what ?? []).map(w => w.id) };
  return { topic: 'supply', patch };
}

export async function applyFleetPlan(broker, intent, { commit = false, yieldTo = [] } = {}) {
  const calls = callsForFleetPlan(intent.plan, intent.why, { yieldTo }); // validate all before acting
  const results = [];
  for (const call of calls) {
    // A LOCAL STEP never reaches the broker: today only `wait`, and a dry run does not wait.
    if (call.local && call.tool === 'wait') {
      if (commit) await sleep(call.ms);
      results.push({ ...call, result: { waited_ms: commit ? call.ms : 0 } });
      continue;
    }
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
  const refused = results.filter(r => r.tool === 'supply' && r.result?.supplied === false);
  return {
    acted: commit && calls.length > 0,
    kind: commit ? 'fleet-plan' : 'dry-run-fleet-plan',
    plan: intent.plan,
    // `sent` means the exact harness calls, which keeps plan output and the journal useful.
    sent: calls.map(({ tool, args }) => ({ tool, args })),
    results,
    failures,
    // A `supply` that ANSWERED is not one that happened: it returns `supplied: false` with the
    // server's reason (receiver_full, counterparty_busy...) instead of throwing. Listed apart
    // from `failures` so `partial` keeps meaning what it meant; `refusedSupplies` turns these
    // into memory so the next pass does not plan the same refused trade.
    ...(refused.length ? { refused: refused.map(r => ({ from: r.args.from, to: r.args.to,
      what: r.args.what, reason_code: r.result.reason_code ?? null,
      reason: r.result.reason ?? null })) } : {}),
    partial: failures.length > 0 && failures.length < results.length,
    // Which fields this plan did NOT write because the doctrine yields them. Present only
    // when something was actually dropped, so it reads as an event rather than as noise,
    // and it lands in the journal beside the calls that WERE sent.
    ...(calls.yielded?.length ? { yielded: calls.yielded } : {}),
    shortfalls: intent.shortfalls,
    notes: intent.notes,
    why: intent.why,
  };
}
