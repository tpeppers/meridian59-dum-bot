import assert from 'node:assert/strict';
import { sellrunFleetRules, recordSellrun } from '../src/decide/rules/sellrun.mjs';
import { runErrand } from '../src/act/errands.mjs';
const test = globalThis.__dumTest;
const rule = sellrunFleetRules.find(r => r.id === 'barloque-sell-circuit');
const receipt = { tool: 'vault', result: { refused: ['scroll', 'wand'],
  messages: ['The vaultman says, "Storing these items would cost 10 shillings - which I see you do not have."'] } };
const cfg = { on: true, trigger: { food_empty: true }, vault: { room: 114, items: ['scroll', 'wand'] },
  bank: { room: 54, keep: 0 }, stops: [{ room: 113, merchant: 'smith' }], finish: 'feast' };
const plan = (purse = 0, fee = 10) => rule.decide({ at: 1000000,
  characters: [{ agent: 'a', in_game: true, room: 114, carrying: 2, purse, health: { pct: 1 } }],
  memory: { sellrun: { a: { last_run_at: 1, ok: false, pending: true, vault_fee: fee } } },
}, { sellrun: cfg }).orders.steps;

test('sellrun: remember an actual unfunded vault quote and recover only the shortfall', () => {
  const rec = recordSellrun({ agent: 'a', at: 1, stopped: 'vault refused protected cargo',
    context: { fuel_driven: true }, results: [receipt] });
  assert.equal(rec.patch.a.vault_fee, 10);
  assert.equal(rec.patch.a.pending, true);
  assert.equal(plan()[0].args.to, 54);
  assert.deepEqual(plan()[1].args, { agent: 'a', action: 'withdraw', amount: 10 });
  assert.equal(plan(7)[1].args.amount, 3);
  assert.equal(plan(10)[0].args.to, 114, 'already holding the fee: no repeated withdrawal');
  assert.equal(plan(0, null)[0].args.to, 114, 'no quote: no invented fee');
  assert.equal(plan().find(s => s.tool === 'bank' && s.args.action === 'deposit').args.keep, 0);
});

test('sellrun: successful storage clears fee recovery even if a later journey fails', () => {
  const rec = recordSellrun({ agent: 'a', at: 2, stopped: 'travel failed',
    was: { a: { vault_fee: 10, pending: true } },
    results: [{ tool: 'vault', result: { refused: [] } }] });
  assert.equal(rec.patch.a.vault_fee, null);
  const refused = recordSellrun({ agent: 'a', at: 2, stopped: 'vault refused',
    results: [{ tool: 'vault', result: { refused: ['wand'], messages: ['No room for that.'] } }] });
  assert.equal(refused.patch.a.vault_fee, undefined, 'capacity refusals do not invent a fee');
});

test('errands: a fee withdrawal must be acknowledged before continuing to the vault', async () => {
  const steps = plan().slice(0, 3);
  for (const confirmed of [false, true]) {
    const sent = [];
    const broker = { call: async (tool, args) => {
      sent.push({ tool, args });
      if (tool === 'travel') return { arrived: true };
      return { banker_said: [confirmed ? 'Here are your 10 shillings. Thank you for your business.' : 'You have no money to withdraw!'] };
    } };
    const r = await runErrand(broker, { why: 'recover quoted storage fee', orders: {
      errand: 'sellrun-circuit', agent: 'a', steps,
    } }, { commit: true });
    assert.equal(Boolean(r.stopped), !confirmed);
    assert.equal(sent.some(s => s.tool === 'travel' && s.args.to === 114), confirmed);
  }
});
