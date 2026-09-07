import assert from 'node:assert/strict';
import { finishSale, runErrand } from '../src/act/errands.mjs';
import { sellrunFleetRules, sellCircuitWants, recordSellrun } from '../src/decide/rules/sellrun.mjs';
const test = globalThis.__dumTest;
test('sale batches carry refusals forward and collect every confirmed receipt', async () => {
  const calls = []; let n = 0;
  const broker = { call: async (_tool, args) => { calls.push(args); return ++n === 1
    ? { sold: [{ name: 'long sword', amount: 1 }], count: 1, total_received: 40,
        refused: ['mushroom'], more: true, resume: { skip_names: ['mushroom'] } }
    : { sold: [{ name: 'long sword', amount: 1 }], count: 1, total_received: 41, more: false }; } };
  const r = await finishSale(broker, { args: { agent: 'a', max_offers: 1 } });
  assert.equal(r.count, 2); assert.equal(r.total_received, 81);
  assert.deepEqual(calls[1].skip_names, ['mushroom']);
});
test('fuel circuit cannot proceed to the hall after a sale fails', async () => {
  const doctrine = { sellrun: { on: true, trigger: { food_empty: true }, finish: 'feast' } };
  const intent = sellrunFleetRules[0].decide({ at: 1000, memory: {}, characters: [
    { agent: 'a', in_game: true, room: 39, items: [], health: { pct: 1 } }] }, doctrine);
  const calls = [], broker = { call: async (tool,args) => { calls.push({tool,args});
    return tool === 'sell_all' ? { error: 'connection lost' } : { arrived: true }; } };
  const r = await runErrand(broker, intent, { commit: true });
  assert.match(r.stopped, /connection lost/);
  assert.equal(calls.some(c => c.tool === 'travel' && c.args.to === 953), false);
  const memory = { sellrun: recordSellrun({ agent: 'a', at: 1001, stopped: r.stopped,
    context: intent.orders.context }).patch };
  assert.equal(memory.sellrun.a.pending, true);
  assert.equal(sellCircuitWants({ agent: 'a', items: [{ name: 'slice of pork', amount: 10 }] }, doctrine.sellrun, memory), true);
});

test('fuel circuit retries vault after earning its fee and preserves protected leftovers', () => {
  const d = { sellrun: { on: true, trigger: { food_empty: true }, finish: 'feast',
    giveaway: { on: true, keep: [] }, keep: ['wand'], vault: { room: 114, items: ['wand'] } } };
  const intent = sellrunFleetRules[0].decide({ at: 1000, memory: {}, characters: [
    { agent: 'a', in_game: true, room: 39, items: [], health: { pct: 1 } }] }, d);
  const steps = intent.orders.steps;
  assert.equal(steps.filter(s => s.tool === 'vault').length, 2);
  assert.ok(steps.findIndex(s => s.expect === 'vaulted') > steps.findLastIndex(s => s.tool === 'sell_all'));
  assert.ok(steps.findIndex(s => s.expect === 'vaulted') < steps.findIndex(s => s.tool === 'bank'));
  assert.ok(steps.find(s => s.tool === 'drop_all').args.keep.includes('wand'));
});
