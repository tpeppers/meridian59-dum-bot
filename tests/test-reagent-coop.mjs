import assert from 'node:assert/strict';
import { sellrunFleetRules } from '../src/decide/rules/sellrun.mjs';
import { finishCoop, runErrand } from '../src/act/errands.mjs';
import { deny } from '../src/link/surface.mjs';
const test = globalThis.__dumTest;
test('reagent coop wraps real sell circuits only when the live policy enables it', () => {
  const rule = sellrunFleetRules.find(r => r.id === 'barloque-sell-circuit');
  const row = { agent: 'a', in_game: true, room: 39, carrying: 30, purse: 4000,
    health: { pct: 1 }, policy: { reagentCoop: { enabled: true } } };
  const result = rule.decide({ at: 123456, memory: {}, characters: [row] },
    { sellrun: { on: true, cooldown_ms: 60000, trigger: { carry_at: 10, min_health: .8 } } });
  const steps = result.orders.steps;
  const chances = steps.filter(s => s.coop_opportunity);
  assert.equal(steps[0], chances[0]);
  assert.equal(chances.length, 4);
  assert.ok(chances.every(s => s.optional && s.args.action === 'town'));
  assert.deepEqual(chances.map(s => s.args.next_room), [114, 113, 109, 104]);
  assert.equal(chances[0].args.first, true);
  assert.ok(chances.slice(1).every(s => !s.args.first));
  assert.ok(steps.findLastIndex(s => s.coop_opportunity) < steps.findLastIndex(s => s.tool === 'sell_all'));
  assert.equal(chances[0].args.request_id, 'dum-sellrun:a:123456:town:0');
  assert.equal(deny('reagent_coop', chances[0].args), null);
  assert.ok(deny('reagent_coop', { action: 'tithe' }));
});
test('coop polling reuses one request identity until its confirmed result', async () => {
  const seen = [], args = { agent: 'a', action: 'tithe', request_id: 'one-trip' };
  const broker = { async call(tool, input) { seen.push({ tool, ...input });
    return seen.length < 3 ? { pending: true } : { shillings: 200 }; } };
  const result = await finishCoop(broker, { args }, null, null, async () => {});
  assert.equal(result.shillings, 200);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(s => s.request_id === 'one-trip'));
});

const secrecyCircuit = () => sellrunFleetRules.find(r => r.id === 'barloque-sell-circuit').decide(
  { at: 123456, memory: {}, characters: [{ agent: 'a', in_game: true, room: 39, carrying: 30, purse: 4000,
    health: { pct: 1 }, policy: { reagentCoop: { enabled: true } } }] },
  { sellrun: { on: true, cooldown_ms: 60000, trigger: { carry_at: 10, min_health: .8 } } });
for (const succeedsAt of [1, 3, Infinity]) test('secret tithe schedule continues its town work; succeeds at ' + succeedsAt, async () => {
  const calls = []; let attempts = 0;
  const broker = { async call(tool, args) {
    calls.push({ tool, ...args });
    if (tool === 'reagent_coop') return ++attempts < succeedsAt ? { deferred: true } : { shillings: 20 };
    if (tool === 'travel') return { arrived: true };
    return {};
  } };
  const intent = secrecyCircuit();
  // This test drives actual errand ordering without exercising the separate
  // multi-offer sale protocol.
  for (const step of intent.orders.steps) if (step.tool === 'sell_all') delete step.args.max_offers;
  const result = await runErrand(broker, intent, { commit: true });
  assert.equal(result.stopped, null);
  assert.equal(attempts, Math.min(succeedsAt, 4));
  assert.equal(calls.filter(c => c.tool === 'sell_all').length, 3);
  assert.ok(calls.some(c => c.tool === 'vault'));
  assert.ok(calls.some(c => c.tool === 'bank' && c.action === 'deposit'));
  assert.equal(calls.at(-1).to, 39);
  assert.ok(calls.findLastIndex(c => c.tool === 'reagent_coop') < calls.findLastIndex(c => c.tool === 'sell_all'));
});
