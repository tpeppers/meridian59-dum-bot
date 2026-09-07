import assert from 'node:assert/strict';
import { loadDoctrine } from '../src/config/load.mjs';
import { mealsAboard } from '../src/decide/rules/food.mjs';
import { sellCircuitWants, sellrunFleetRules } from '../src/decide/rules/sellrun.mjs';
import { fleetRules, decide } from '../src/decide/index.mjs';
import { CircuitJobs } from '../src/loop/circuits.mjs';
import { runErrand } from '../src/act/errands.mjs';
const test = globalThis.__dumTest;
const now = 1_700_000_000_000;
const row = (agent, extra = {}) => ({ agent, in_game: true, level: 50,
  room: 39, mode: 'farm', health: { value: 50, max: 50, pct: 1 },
  items: [], carrying: 2, purse: 100,
  policy: { assignedRoom: 39, hunt: ['battered skeleton', 'zombie'], roam: false, purpose: 'advance' },
  ...extra });
const cfg = () => loadDoctrine({ overrides: {
  'claim.work': 'bot', 'shift.on': true, 'station.recall': true,
  'shift.stations': [{ room: 39, hunt: ['battered skeleton', 'zombie'], max_health: { at_least: 50 } }, { room: 544, hunt: 'fungus beast', max_health: { below: 50 } }],
  'sellrun.on': true, 'sellrun.trigger.food_empty': true, 'sellrun.finish': 'feast',
} }).config;
test('fuel: protected food is cargo and both wire food spellings are counted', () => {
  assert.equal(mealsAboard(row('a', { items: [{ name: 'Inky-cap mushroom', amount: 7 }],
    policy: { vaultItems: ['Inky cap mushroom'] } })), 0);
  assert.equal(mealsAboard(row('a', { items: [{ name: 'water skin', amount: 2 },
    { name: 'spider eye', amount: 3 }] })), 5);
  assert.equal(mealsAboard({}), null);
});
test('fuel: depleted packs depart, full food packs keep farming, and hurt units recover', () => {
  const c = cfg().sellrun;
  assert.equal(sellCircuitWants(row('a'), c), true);
  assert.equal(sellCircuitWants(row('a', { carrying: 50,
    items: [{ name: 'slice of pork', amount: 100 }] }), c), false);
  assert.equal(sellCircuitWants(row('a', { health: { pct: 0.3 } }), c), false);
  assert.equal(sellCircuitWants(row('a', { items: null }), c), false);
});
test('fuel: a repeated station recall cannot starve the full town circuit', () => {
  const c = cfg();
  const obs = { at: now, characters: [row('a', { room: 38,
    items: [{ name: 'loaf of bread', amount: 1 }] }), row('b')], memory: {} };
  const { intent } = decide(fleetRules, obs, c);
  assert.equal(intent?.rule, 'barloque-sell-circuit');
  assert.equal(intent?.orders.agent, 'b');
});
test('fuel: a depleted larder bypasses a successful cooldown but respects failure backoff', () => {
  const c = cfg(), obs = { at: now, characters: [row('a')], memory: {
    sellrun: { a: { last_run_at: now - 1000, ok: true } } } };
  assert.ok(sellrunFleetRules[0].decide(obs, c));
  obs.memory.sellrun.a.ok = false;
  assert.equal(sellrunFleetRules[0].decide(obs, c), null);
});
test('fuel: local collection items are vaulted before the shops and the hall arrival is verified', () => {
  const c = cfg(), r = row('a');
  r.policy.vaultItems = ['herald shield'];
  c.sellrun.bank = { room: 54, keep: 0 };
  const intent = sellrunFleetRules[0].decide({ at: now, characters: [r], memory: {} }, c);
  const steps = intent.orders.steps;
  assert.ok(steps.find(s => s.tool === 'vault').args.items.includes('herald shield'));
  assert.equal(steps.find(s => s.tool === 'bank').args.keep, 0);
  assert.equal(steps.at(-1).args.to, 953);
  assert.equal(steps.at(-1).expect, 'arrived');
});
test('fuel: two circuits run independently and cannot launch twice for one character', async () => {
  const pending = new Map(), memory = {}, lines = [];
  const ctx = { commit: true, journal: { write: x => lines.push(x), finding() {} },
    memory: { read: () => memory, patch: (topic, patch) => memory[topic] = { ...memory[topic], ...patch } } };
  const jobs = new CircuitJobs(ctx, { now: () => now,
    execute: (_broker, intent) => new Promise(resolve => pending.set(intent.orders.agent, resolve)) });
  const intent = agent => ({ orders: { errand: 'sellrun-circuit', agent } });
  assert.equal(await jobs.start(intent('a')), true);
  assert.equal(await jobs.start(intent('a')), false);
  assert.equal(await jobs.start(intent('b')), true);
  const a = jobs.jobs.get('a').promise, b = jobs.jobs.get('b').promise;
  pending.get('b')({ acted: true, errand: 'sellrun-circuit', agent: 'b', stopped: null });
  await b;
  assert.equal(jobs.has('a'), true);
  assert.equal(jobs.has('b'), false);
  pending.get('a')({ acted: true, errand: 'sellrun-circuit', agent: 'a', stopped: null });
  await a;
  assert.equal(Object.keys(memory.sellrun).length, 2);
  assert.equal(lines.length, 2);
});
test('fuel: shutdown cancels a town circuit before its next step and releases its lease', async () => {
  const control = new AbortController(); control.abort();
  const calls = [], broker = { call: async (tool, args) => { calls.push({ tool, args }); return {}; } };
  const result = await runErrand(broker, { orders: { agent: 'a', errand: 'sellrun-circuit',
    steps: [{ tool: 'travel', args: { agent: 'a', to: 113 }, always: true }] } },
    { commit: true, holder: 'test', signal: control.signal });
  assert.equal(calls.some(x => x.tool === 'travel'), false);
  assert.equal(calls.at(-1).args.action, 'free');
  assert.equal(result.stopped, 'DUM is stopping');
});

test('fuel: a pending journey does not block paced heartbeats or another character', async () => {
  const { Broker } = await import('../src/link/broker.mjs');
  const originalFetch = globalThis.fetch;
  let finishTravel;
  const starts = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body).params;
    starts.push({ request, at: Date.now() });
    if (request.name === 'travel') await new Promise(resolve => { finishTravel = resolve; });
    return { ok: true, json: async () => ({ result: { content: [{ text: '{}' }] } }) };
  };
  try {
    const broker = new Broker({ controlUrl: 'http://127.0.0.1:1', concurrent: true,
      dryRun: false, callsPerSecond: 50 });
    const travel = broker.call('travel', { agent: 'role-a', to: 114 });
    const heartbeat = broker.call('autopilot', { agent: 'role-a', action: 'heartbeat' });
    const observation = broker.call('inventory', { agent: 'role-b' });
    await Promise.race([Promise.all([heartbeat, observation]),
      new Promise((_, reject) => setTimeout(() => reject(Error('journey blocked fleet')), 500))]);
    assert.equal(starts.length, 3);
    assert.ok(starts[1].at - starts[0].at >= 15);
    assert.ok(starts[2].at - starts[1].at >= 15);
    finishTravel();
    await travel;
  } finally { finishTravel?.(); globalThis.fetch = originalFetch; }
});
