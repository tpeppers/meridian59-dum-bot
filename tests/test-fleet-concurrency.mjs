import assert from 'node:assert/strict';
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
  const { intent, intents } = decide(set(ruleFor('a', 't1'), ruleFor('b', 't2')), {}, doctrine());
  assert.equal(intents.length, 1);
  assert.equal(intent.rule, 'a');
});

test('concurrency: raising the cap lets a later rule act on a DIFFERENT character', () => {
  const r = decide(set(ruleFor('a', 't1'), ruleFor('b', 't2')), {}, doctrine(), { max: 3 });
  assert.deepEqual(r.intents.map(i => i.rule), ['a', 'b']);
  // `intent` still names the first, so every existing caller keeps working.
  assert.equal(r.intent.rule, 'a');
});

test('concurrency: but never twice on the SAME character', () => {
  const r = decide(set(ruleFor('a', 't1'), ruleFor('b', 't1')), {}, doctrine(), { max: 3 });
  assert.deepEqual(r.intents.map(i => i.rule), ['a']);
  const said = r.considered.find(c => c.rule === 'b');
  assert.equal(said.verdict, 'no');
  assert.match(said.why, /already decided this pass/);
  // The reason names the character AND the rule that took it, because "why did my rule not
  // run" is the only question anyone asks of this table.
  assert.match(said.why, /t1/);
  assert.match(said.why, /"a"/);
});

test('concurrency: an intent whose reach cannot be read is exclusive, not universal', () => {
  // Empty reach would compare disjoint with everything, which is the dangerous direction:
  // a fleet-wide policy write would run beside a rule steering the same bodies.
  const opaque = { id: 'opaque', faculty: 'work', scope: 'fleet', why: 'opaque',
                   decide: () => ({ kind: 'orders', orders: {}, why: 'opaque' }) };
  const r = decide(set(ruleFor('a', 't1'), opaque, ruleFor('c', 't3')), {}, doctrine(), { max: 4 });
  // Skipped for THIS pass — but the readable rule below it is not punished for that.
  assert.deepEqual(r.intents.map(i => i.rule), ['a', 'c']);
  assert.match(r.considered.find(c => c.rule === 'opaque').why, /treated as exclusive/);
  // And it is not starved: on a pass where it fires first, it takes the turn.
  assert.equal(decide(set(opaque, ruleFor('c', 't3')), {}, doctrine(), { max: 4 })
                 .intents[0].rule, 'opaque');
});

test('concurrency: the cap bounds the batch, which is the traffic control', () => {
  const rules = ['a', 'b', 'c', 'd'].map((id, i) => ruleFor(id, `t${i + 1}`));
  assert.equal(decide(set(...rules), {}, doctrine(), { max: 2 }).intents.length, 2);
  assert.equal(decide(set(...rules), {}, doctrine(), { max: 9 }).intents.length, 4);
});

test('concurrency: a rule that passes still does not consume a slot', () => {
  const passer = { id: 'p', faculty: 'work', scope: 'fleet', why: 'p',
                   decide: () => ({ kind: 'pass', why: 'nothing to do' }) };
  const r = decide(set(passer, ruleFor('a', 't1'), ruleFor('b', 't2')), {}, doctrine(), { max: 2 });
  assert.deepEqual(r.intents.map(i => i.rule), ['a', 'b']);
});

test('intentAgents reads every shape a fleet intent names characters in', () => {
  assert.deepEqual([...intentAgents({ agent: 't1' })], ['t1']);
  assert.deepEqual([...intentAgents({ orders: { agent: 't2' } })], ['t2']);
  // A supply plan names both sides; taking one half and leaving the other is the failure
  // the commitment guard exists to prevent, so both count as touched.
  assert.deepEqual([...intentAgents({ plan: [{ from: 't3', to: 't4' }] })].sort(), ['t3', 't4']);
  assert.deepEqual([...intentAgents({ plan: [{ args: { agent: 't5' } }] })], ['t5']);
  assert.equal(intentAgents(null).size, 0);
});

test('the cap is validated, because below one switches DUM off quietly', () => {
  const bad = { ...freshDefaults(), cadence: { ...freshDefaults().cadence, fleet_intents_per_pass: 0 } };
  assert.ok(validate(bad).some(p => p.where === 'cadence.fleet_intents_per_pass'));
  const good = { ...freshDefaults(), cadence: { ...freshDefaults().cadence, fleet_intents_per_pass: 3 } };
  assert.equal(validate(good).filter(p => p.where === 'cadence.fleet_intents_per_pass').length, 0);
});
