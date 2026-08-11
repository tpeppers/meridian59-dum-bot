import assert from 'node:assert/strict';
import { RuleSet, decide, respectCommitment } from '../src/decide/engine.mjs';
import { characterRules } from '../src/decide/index.mjs';
import { evaluateLadder, criterionMet } from '../src/decide/rules/ladder.mjs';
import { pairUp } from '../src/decide/rules/party.mjs';
import * as fx from './fixtures.mjs';

const test = globalThis.__dumTest;

// ---------------------------------------------------------------- the engine

test('engine: a rule whose faculty is not claimed cannot fire', () => {
  const set = new RuleSet('t', [{
    id: 'takes-survival', faculty: 'survival', why: 'would run from a fight',
    decide: () => ({ kind: 'orders', orders: {} }),
  }]);
  const d = fx.doctrine();                       // survival stays with the keeper
  const { intent, considered } = decide(set, fx.working(), d);
  assert.equal(intent, null);
  assert.equal(considered[0].verdict, 'not-claimed');
});

test('engine: first match wins and later rules are never consulted', () => {
  const seen = [];
  const set = new RuleSet('t', [
    { id: 'a', faculty: 'work', why: 'first', decide: () => { seen.push('a'); return { kind: 'report' }; } },
    { id: 'b', faculty: 'work', why: 'second', decide: () => { seen.push('b'); return { kind: 'report' }; } },
  ]);
  const { intent } = decide(set, fx.working(), fx.doctrine());
  assert.equal(intent.rule, 'a');
  assert.deepEqual(seen, ['a']);
});

test('engine: a throwing rule does not stop the table', () => {
  const set = new RuleSet('t', [
    { id: 'bad', faculty: 'work', why: 'throws', decide: () => { throw new Error('boom'); } },
    { id: 'good', faculty: 'work', why: 'works', decide: () => ({ kind: 'report' }) },
  ]);
  const { intent, considered } = decide(set, fx.working(), fx.doctrine());
  assert.equal(intent.rule, 'good');
  assert.equal(considered[0].verdict, 'error');
  assert.match(considered[0].why, /boom/);
});

test('engine: every declined rule is still recorded', () => {
  // "Nothing happened" is the answer most of the time and it is the one that cannot be
  // debugged without this trail.
  const { intent, considered } = decide(characterRules, fx.working(), fx.doctrine({
    goals: { ladder: [] },
  }));
  assert.equal(intent, null);
  assert.equal(considered.length, characterRules.rules.length);
  assert.ok(considered.some(v => v.verdict === 'off'));
});

test('engine: a rule with no why does not load', () => {
  assert.throws(() => new RuleSet('t', [{ id: 'x', faculty: 'work', decide: () => null }]),
                /has no why/);
});

test('engine: a rule claiming a faculty that does not exist does not load', () => {
  assert.throws(() => new RuleSet('t', [{ id: 'x', faculty: 'vibes', why: 'w', decide: () => null }]),
                /not one of/);
});

// ---------------------------------------------------------------- commitment

test('commitment: a character on an errand is left alone', () => {
  const out = respectCommitment.decide(fx.onErrand());
  assert.equal(out.kind, 'none');
  assert.match(out.why, /signet/);
});

test('commitment: a pairing does not block a change of orders', () => {
  const o = fx.working();
  o.commitment = { kind: 'partner', label: 'fighting alongside role-b' };
  assert.equal(respectCommitment.decide(o), null);
});

test('commitment: it is first in the table, so an errand blocks everything below it', () => {
  const { intent } = decide(characterRules, fx.onErrand(), fx.doctrine());
  assert.equal(intent.rule, 'respect-commitment');
  assert.equal(intent.kind, 'none');
});

// ---------------------------------------------------------------- the ladder

test('ladder: the first unmet rung is the active one', () => {
  const d = fx.doctrine();
  const { active } = evaluateLadder(d.goals.ladder, fx.working());   // 30 max health
  assert.equal(active.id, 'to-60');
});

test('ladder: a character knocked back down falls back to the earlier rung, with no state kept', () => {
  const d = fx.doctrine();
  const { active } = evaluateLadder(d.goals.ladder, fx.setBack());   // 22 max health
  assert.equal(active.id, 'to-30');
});

test('ladder: missing evidence is unanswerable, not incomplete', () => {
  // Treating "the harness did not report this" as "the target is not met" would park a
  // character on a rung it may have finished weeks ago.
  assert.equal(criterionMet({ kind: 'skill', name: 'slash', at_least: 40 }, fx.working()), null);
  const d = fx.doctrine({ goals: { ladder: [
    { id: 's', until: { kind: 'skill', name: 'slash', at_least: 40 }, orders: {}, why: 'w' },
  ] } });
  const { active, unanswerable, complete } = evaluateLadder(d.goals.ladder, fx.working());
  assert.equal(active, null);
  assert.equal(complete, false);
  assert.deepEqual(unanswerable.map(r => r.id), ['s']);
});

test('ladder: a level of null never satisfies a "below" test', () => {
  const o = fx.working();
  o.max_health = null;
  o.health = { value: null, max: null, pct: null };
  assert.equal(criterionMet({ kind: 'max_health', at_least: 30 }, o), null);
});

test('ladder: the active rung produces the rung orders, with its reason', () => {
  const { intent } = decide(characterRules, fx.working(), fx.doctrine());
  assert.equal(intent.rule, 'ladder-active-rung');
  assert.equal(intent.orders.strategy, 'trader');
  assert.equal(intent.orders.action, 'start');
  assert.match(intent.why, /to-60/);
});

test('ladder: an empty ladder means DUM has no opinion', () => {
  const { intent, considered } = decide(characterRules, fx.working(),
                                        fx.doctrine({ goals: { ladder: [] } }));
  assert.equal(intent, null);
  assert.ok(considered.find(v => v.rule === 'ladder-active-rung').why.includes('no opinion'));
});

// ---------------------------------------------------------------- escalation

test('escalate: an opaque stall is reported, never restarted', () => {
  const d = fx.doctrine({ escalate: { unstick: true } });
  const { intent } = decide(characterRules, fx.stalledOpaque(), d);
  assert.equal(intent.rule, 'stall-report-only');
  assert.equal(intent.kind, 'report');
  // The keeper's own prose is carried as evidence and is NOT matched against.
  assert.ok(intent.evidence.keeper_says.length);
});

test('escalate: a structured refusal leaves the character alone', () => {
  const d = fx.doctrine({ escalate: { unstick: true } });
  const { intent } = decide(characterRules, fx.stalledStructured(), d);
  assert.equal(intent.kind, 'none');
  assert.match(intent.why, /NO_SAFE_WALL/);
  assert.match(intent.why, /A refusal is not a stall/);
});

test('escalate: nothing fires at all when unstick is off', () => {
  const { intent } = decide(characterRules, fx.stalledStructured(), fx.doctrine());
  // The ladder still has an opinion, but the stall rule declined.
  assert.notEqual(intent?.rule, 'stall-report-only');
});

// ---------------------------------------------------------------- pairing

test('pairing: an existing mutual pair is never disturbed', () => {
  const { pairs, kept } = pairUp(fx.fleet().characters);
  assert.equal(kept, 1);            // role-a/role-b kept; role-c/role-d newly matched
  assert.ok(pairs.some(([a, b]) => a.agent === 'role-a' && b.agent === 'role-b'));
  assert.ok(pairs.some(([a, b]) => a.agent === 'role-c' && b.agent === 'role-d'));
});

test('pairing: a one-sided pairing is not preserved as a working pair', () => {
  // role-b has never heard of role-a. The one-sided state is the failure being healed,
  // so it must NOT be counted as an existing pair and left alone — it goes back into
  // the pool and is re-matched with both sides written.
  const rows = fx.fleet().characters;
  rows[1].partner = null;
  const { kept } = pairUp(rows);
  assert.equal(kept, 0);
});

test('pairing: an odd fleet reports the odd one out rather than hiding it', () => {
  const rows = fx.fleet().characters.slice(0, 3);
  rows[0].partner = null; rows[1].partner = null;
  const { odd } = pairUp(rows);
  assert.ok(odd);
});

test('pairing: the same board always produces the same pairing', () => {
  const a = pairUp(fx.fleet().characters).pairs.map(p => p.map(x => x.agent));
  const b = pairUp([...fx.fleet().characters].reverse()).pairs.map(p => p.map(x => x.agent));
  assert.deepEqual(new Set(a.map(String)), new Set(b.map(String)));
});

// ---------------------------------------------------------------- the GY shift's orders
//
// Both of these were paid for live, on a 35-minute window, and both look like fussiness
// until the fleet walks out of a spawning graveyard in front of you.
import { ordersFor as gyOrders, SHIFT_MAX_CARRY } from '../src/decide/rules/graveyard.mjs';

const armoured = { character: 'A', equipped: [{ name: 'chain armor' }, { name: 'mace' }] };
const bare = { character: 'B', equipped: [{ name: 'mace' }] };

test('gy shift: hunts the prey the room actually makes, armoured or not', () => {
  // 70 is 85% zombie and the crypt 80%. A farm keeper told to hunt the 15% concludes the
  // room cannot produce its prey and leaves — which emptied both rooms inside a minute.
  assert.equal(gyOrders(armoured).hunt, 'zombie');
  assert.equal(gyOrders(bare).hunt, 'zombie');
});

test('gy shift: armour buys the CEILING, not a different quarry', () => {
  // Hunt says what to look for; max_threat_over says what may be engaged when it turns up.
  assert.ok(gyOrders(armoured).max_threat_over > gyOrders(bare).max_threat_over);
});

test('gy shift: banking and selling are suppressed for the window', () => {
  // bank_above 500 and max_carry 14 both trip on a pack full from the PREVIOUS shift, so
  // the window opens and the fleet sets off for Barloque. Eleven of twenty-one did.
  for (const row of [armoured, bare]) {
    assert.equal(gyOrders(row).bank_above, null);
    assert.equal(gyOrders(row).max_carry, SHIFT_MAX_CARRY);
    assert.equal(gyOrders(row).roam, false);
  }
});
