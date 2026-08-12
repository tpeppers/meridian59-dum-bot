import assert from 'node:assert/strict';
import { shareOut, shortfalls, mootFleetRules } from '../src/decide/rules/moot.mjs';
import { RuleSet, decide } from '../src/decide/engine.mjs';
import { apply } from '../src/act/orders.mjs';
import { ensureFleetIntentClaim, fleetIntentAgents, fleetPlanAgents } from '../src/loop/tick.mjs';

const test = globalThis.__dumTest;

const carry = min => ({ carry: [{ item: 'herb', min, weight: 2, kind: 'reagent' }] });
const row = (agent, amount, id, over = {}) => ({
  agent, character: agent.toUpperCase(), in_game: true, room: 52, mode: 'idle',
  loadout: carry(20), items: amount ? [{ id, name: 'Herb', amount }] : [], ...over,
});

test('moot: equal-fraction sharing names exact donors and never cuts below their floor', () => {
  const share = shareOut([row('donor', 50, 101), row('a', 0, 201), row('b', 0, 301)]);
  assert.deepEqual(share.plan.map(p => [p.agent, p.give, p.cover]),
                   [['a', 15, 0.75], ['b', 15, 0.75]]);
  assert.deepEqual(share.transfers.map(t => [t.from, t.to, t.amount]),
                   [['donor', 'a', 15], ['donor', 'b', 15]]);
  assert.equal(share.transfers.reduce((n, t) => n + t.amount, 0), 30);
  assert.deepEqual(share.transfers.map(t => t.what),
                   [[{ id: 101, amount: 15 }], [{ id: 101, amount: 15 }]]);
  assert.equal(shortfalls(share)[0].unmet, 10);
});

test('moot: a one-unit award is explicit because a bare id means the whole stack', () => {
  const donor = { ...row('donor', 21, 101), loadout: carry(20) };
  const recipient = { ...row('a', 19, 201), loadout: carry(20) };
  const share = shareOut([donor, recipient]);
  assert.deepEqual(share.transfers[0].what, [{ id: 101, amount: 1 }]);
});

test('moot: a fleet intent keeps its plan through the decision engine', () => {
  const set = new RuleSet('moot-test', mootFleetRules);
  const obs = { characters: [
    row('here', 20, 1, { mode: 'farm' }),
    row('away', 20, 2, { room: 70, mode: 'farm' }),
  ] };
  const { intent } = decide(set, obs, {
    claim: { economy: 'bot' }, moot: { hold: true, room: 52, inns: [52], quorum: 2 },
  });
  assert.equal(intent.kind, 'act');
  assert.ok(intent.plan.some(p => p.do === 'hold' && p.agent === 'here'));
  assert.ok(intent.plan.some(p => p.do === 'muster' && p.agent === 'away'));
});

test('moot: dry-run compiles holds, background travel, and exact-id supply without calling', async () => {
  const writes = [];
  const broker = {
    write: async (tool, args) => { writes.push([tool, args]); return { dry_run: true }; },
    call: async () => { throw new Error('commit path reached in dry run'); },
  };
  const out = await apply(broker, { kind: 'act', why: 'moot', plan: [
    { do: 'hold', agent: 'a' },
    { do: 'muster', agent: 'b', to: 52 },
    { do: 'give', from: 'a', to: 'b', what: [{ id: 9, amount: 4 }] },
  ] }, {}, { commit: false });
  assert.equal(out.kind, 'dry-run-fleet-plan');
  assert.deepEqual(writes.map(x => x[0]), ['autopilot', 'autopilot', 'travel', 'supply']);
  assert.equal(writes[2][1].background, true);
  assert.deepEqual(writes[3][1].what, [{ id: 9, amount: 4 }]);
});

test('moot: the whole fleet plan is validated before its first write', async () => {
  let writes = 0;
  const broker = { write: async () => { writes++; }, call: async () => { writes++; } };
  await assert.rejects(() => apply(broker, { kind: 'act', plan: [
    { do: 'hold', agent: 'a' }, { do: 'invented', agent: 'b' },
  ] }, {}, { commit: true }), /no executor/);
  assert.equal(writes, 0);
});

test('moot: claim targets distinguish a destination room from a recipient agent', () => {
  assert.deepEqual(fleetPlanAgents([
    { do: 'muster', agent: 'a', to: 52 },
    { do: 'give', from: 'a', to: 'b' },
  ]), ['a', 'b']);
});

test('fleet tick: an errand claims its actor before apply without requiring a fleet plan', async () => {
  const claimed = [];
  const agents = await ensureFleetIntentClaim({
    ensureClaim: async names => claimed.push(...names),
  }, { kind: 'errand', agent: 'scout', plan: null });
  assert.deepEqual(agents, ['scout']);
  assert.deepEqual(claimed, ['scout']);
});
