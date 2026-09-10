import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RuleSet, decide, intentAgents } from '../src/decide/engine.mjs';
import { freshDefaults } from '../src/config/defaults.mjs';
import { validate } from '../src/config/schema.mjs';

const test = globalThis.__dumTest;

// SEVERAL DECISIONS PER FLEET PASS, ON DISJOINT CHARACTERS.
//
// The engine's invariant is one directional decision per CHARACTER. Halting the whole fleet
// table after the first rule was always stricter, and the cost was measured: `hunt-shift`
// fired on 78 of 78 fleet passes -- there is always somebody to station -- so every rule
// below it went unevaluated for a day, including the entire fuel model. `feast-hall-larder`
// and the sell circuit were switched ON in the doctrine and never once reached, while
// eighteen of twenty characters ran out of food.

const doctrine = () => {
  const d = freshDefaults();
  d.claim.work = 'bot';
  return d;
};
const ruleFor = (id, agent) => ({
  id, faculty: 'work', scope: 'fleet', why: id,
  decide: () => ({ kind: 'orders', orders: { agent }, why: id }),
});
const set = (...rules) => new RuleSet('fleet', rules);

test('concurrency: the default is one decision per pass, exactly as before', () => {
  const { intent, intents } = decide(set(ruleFor('a', 'role-a'), ruleFor('b', 'role-b')), {}, doctrine());
  assert.equal(intents.length, 1);
  assert.equal(intent.rule, 'a');
});

test('concurrency: raising the cap lets a later rule act on a DIFFERENT character', () => {
  const r = decide(set(ruleFor('a', 'role-a'), ruleFor('b', 'role-b')), {}, doctrine(), { max: 3 });
  assert.deepEqual(r.intents.map(i => i.rule), ['a', 'b']);
  // `intent` still names the first, so every existing caller keeps working.
  assert.equal(r.intent.rule, 'a');
});

test('concurrency: but never twice on the SAME character', () => {
  const r = decide(set(ruleFor('a', 'role-a'), ruleFor('b', 'role-a')), {}, doctrine(), { max: 3 });
  assert.deepEqual(r.intents.map(i => i.rule), ['a']);
  const said = r.considered.find(c => c.rule === 'b');
  assert.equal(said.verdict, 'no');
  assert.match(said.why, /already decided this pass/);
  // The reason names the character AND the rule that took it, because "why did my rule not
  // run" is the only question anyone asks of this table.
  assert.match(said.why, /role-a/);
  assert.match(said.why, /"a"/);
});

test('concurrency: an intent whose reach cannot be read is exclusive, not universal', () => {
  // Empty reach would compare disjoint with everything, which is the dangerous direction:
  // a fleet-wide policy write would run beside a rule steering the same bodies.
  const opaque = { id: 'opaque', faculty: 'work', scope: 'fleet', why: 'opaque',
                   decide: () => ({ kind: 'orders', orders: {}, why: 'opaque' }) };
  const r = decide(set(ruleFor('a', 'role-a'), opaque, ruleFor('c', 'role-c')), {}, doctrine(), { max: 4 });
  // Skipped for THIS pass — but the readable rule below it is not punished for that.
  assert.deepEqual(r.intents.map(i => i.rule), ['a', 'c']);
  assert.match(r.considered.find(c => c.rule === 'opaque').why, /treated as exclusive/);
  // And it is not starved: on a pass where it fires first, it takes the turn.
  assert.equal(decide(set(opaque, ruleFor('c', 'role-c')), {}, doctrine(), { max: 4 })
                 .intents[0].rule, 'opaque');
});

test('concurrency: the cap bounds the batch, which is the traffic control', () => {
  const rules = ['a', 'b', 'c', 'd'].map((id, i) => ruleFor(id, `role-${i}`));
  assert.equal(decide(set(...rules), {}, doctrine(), { max: 2 }).intents.length, 2);
  assert.equal(decide(set(...rules), {}, doctrine(), { max: 9 }).intents.length, 4);
});

test('concurrency: a rule that passes still does not consume a slot', () => {
  const passer = { id: 'p', faculty: 'work', scope: 'fleet', why: 'p',
                   decide: () => ({ kind: 'pass', why: 'nothing to do' }) };
  const r = decide(set(passer, ruleFor('a', 'role-a'), ruleFor('b', 'role-b')), {}, doctrine(), { max: 2 });
  assert.deepEqual(r.intents.map(i => i.rule), ['a', 'b']);
});

test('intentAgents reads every shape a fleet intent names characters in', () => {
  assert.deepEqual([...intentAgents({ agent: 'role-a' })], ['role-a']);
  assert.deepEqual([...intentAgents({ orders: { agent: 'role-b' } })], ['role-b']);
  // A supply plan names both sides; taking one half and leaving the other is the failure
  // the commitment guard exists to prevent, so both count as touched.
  assert.deepEqual([...intentAgents({ plan: [{ from: 'role-c', to: 'role-d' }] })].sort(), ['role-c', 'role-d']);
  assert.deepEqual([...intentAgents({ plan: [{ args: { agent: 'role-e' } }] })], ['role-e']);
  assert.equal(intentAgents(null).size, 0);
});

test('the cap is validated, because below one switches DUM off quietly', () => {
  const bad = { ...freshDefaults(), cadence: { ...freshDefaults().cadence, fleet_intents_per_pass: 0 } };
  assert.ok(validate(bad).some(p => p.where === 'cadence.fleet_intents_per_pass'));
  const good = { ...freshDefaults(), cadence: { ...freshDefaults().cadence, fleet_intents_per_pass: 3 } };
  assert.equal(validate(good).filter(p => p.where === 'cadence.fleet_intents_per_pass').length, 0);
});

// ============ A SECONDARY DECISION MUST NOT BE ABLE TO WEDGE THE PASS ============
//
// Measured on prod the first time the cap ran committed: 320 broker calls in eleven
// minutes and NOT ONE tick or fleet-tick line, with no `pass-failed` either — so nothing
// threw, an await simply never resolved. The extras are applied before `write()`, so the
// whole pass was swallowed: no journal line, no character ticks below it, and the fleet
// ran on its keepers alone until somebody restarted the process.
//
// The dry path completed fine at the same cap. That is the trap: 451 offline tests and a
// clean `plan` said nothing, because every one of them runs commit:false.

test('a hanging secondary decision is abandoned, not awaited for ever', async () => {
  const { withDeadline, EXTRA_INTENT_MS } = await import('../src/loop/tick.mjs');
  const never = () => new Promise(() => {});          // the exact shape of the prod hang
  const began = Date.now();
  await assert.rejects(() => withDeadline(60, never), /abandoned after 60ms/);
  // It gave up promptly rather than inheriting the caller's patience.
  assert.ok(Date.now() - began < 2000);
  // And the real budget is generous enough for a claim plus a batch of writes.
  assert.ok(EXTRA_INTENT_MS >= 10_000 && EXTRA_INTENT_MS <= 60_000);
});

test('a secondary decision that finishes in time returns its value untouched', async () => {
  const { withDeadline } = await import('../src/loop/tick.mjs');
  assert.equal(await withDeadline(5000, async () => 'applied'), 'applied');
});

test('the deadline does not leave a timer holding the process open', async () => {
  // `finally { clearTimeout }` — without it a fast pass would keep a 20s handle alive on
  // every extra, and a loop that ticks faster than that never drains them.
  const { withDeadline } = await import('../src/loop/tick.mjs');
  const src = readFileSync(new URL('../src/loop/tick.mjs', import.meta.url), 'utf8');
  assert.match(src, /finally \{ if \(timer\) clearTimeout\(timer\); \}/);
  await withDeadline(50_000, async () => 'quick');    // would hang the suite if it leaked
});

test('the PRIMARY decision is deliberately not bounded by it', () => {
  // Cutting the doctrine's highest-ranked decision short would trade a visible hang for a
  // silently half-applied order, which is worse. Only the extras are raced.
  const src = readFileSync(new URL('../src/loop/tick.mjs', import.meta.url), 'utf8');
  const primary = src.slice(src.indexOf('const applied = await apply(broker, intent'),
                            src.indexOf('for (const extra of rest)'));
  assert.ok(!/withDeadline/.test(primary));
  assert.match(src.slice(src.indexOf('for (const extra of rest)')), /withDeadline\(EXTRA_INTENT_MS/);
});

test('a background errand is STARTED as an extra, not run inline', () => {
  // The actual prod hang. `sellrun-circuit` and `feast-grab` are circuits — minutes of
  // walking, selling and banking — handed to circuits.start so the tick returns at once.
  // That branch existed only for the FIRST intent; a secondary one fell into apply() and
  // ran the whole Barloque round trip inside the pass. Journalled 2026-09-09 23:27:
  // `barloque-sell-circuit` as an extra, "abandoned after 20000ms".
  const src = readFileSync(new URL('../src/loop/tick.mjs', import.meta.url), 'utf8');
  const extras = src.slice(src.indexOf('for (const extra of rest)'));
  assert.match(extras, /ctx\.circuits\.start\(extra\)/);
  assert.match(extras, /\['sellrun-circuit', 'feast-grab'\]\.includes\(extra\.orders\?\.errand\)/);
  // Started BEFORE the inline apply is considered, or the branch is decorative.
  assert.ok(extras.indexOf('ctx.circuits.start(extra)') < extras.indexOf('return apply(broker, extra'));
  // And the primary path still does the same thing, so the two halves cannot drift.
  assert.match(src, /ctx\.circuits\.start\(intent\)/);
});
