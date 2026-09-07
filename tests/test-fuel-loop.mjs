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

test('fuel: empty farmers outside their station await refuelling instead of recall', async () => {
  const { isStranded } = await import('../src/decide/rules/station.mjs');
  const r = row('role-a', { room: 38 });
  assert.equal(isStranded(r, cfg()), false);
  r.items = [{ name: 'slice of pork', amount: 100 }];
  assert.equal(isStranded(r, cfg()), true);
});
test('fuel: failed busy acquisition cannot run even an always travel step', async () => {
  const calls = [];
  const broker = { call: async (tool, args) => { calls.push({ tool, args }); return { refused: 'another owner' }; } };
  const result = await runErrand(broker, { orders: { agent: 'role-a', errand: 'sellrun-circuit',
    steps: [{ tool: 'travel', args: { agent: 'role-a', to: 953 }, always: true }] } },
    { commit: true, holder: 'test' });
  assert.equal(result.acted, false);
  assert.equal(calls.some(x => x.tool === 'travel'), false);
  assert.equal(calls.at(-1).args.action, 'free');
});
test('fuel: commerce waits for the room after launching an asynchronous journey', async () => {
  const calls = [];
  const broker = { call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'travel') return { started: true };
    if (tool === 'fleet') return { fleet: [{ agent: 'role-a', room_num: 114 }] };
    return {};
  } };
  await runErrand(broker, { orders: { agent: 'role-a', errand: 'sellrun-circuit', steps: [
    { tool: 'travel', args: { agent: 'role-a', to: 114 }, expect: 'arrived' },
    { tool: 'vault', args: { agent: 'role-a', action: 'deposit' } },
  ] } }, { commit: true, holder: 'test' });
  assert.equal(calls.find(x => x.tool === 'travel').args.background, true);
  assert.ok(calls.findIndex(x => x.tool === 'fleet') < calls.findIndex(x => x.tool === 'vault'));
});

test('fuel: arrival rest keeps the body until the preceding job has finished', async () => {
  let polls = 0, deposited = false;
  const broker = { call: async (tool) => {
    if (tool === 'travel') return { started: true };
    if (tool === 'fleet') return { fleet: [{ agent: 'role-a', room_num: 114,
      ...(++polls === 1 ? { busy: 'walk to vault' } : {}) }] };
    if (tool === 'vault') { assert.equal(polls, 2); deposited = true; }
    return {};
  } };
  await runErrand(broker, { orders: { agent: 'role-a', errand: 'sellrun-circuit', steps: [
    { tool: 'travel', args: { agent: 'role-a', to: 114 }, expect: 'arrived' },
    { tool: 'vault', args: { agent: 'role-a', action: 'deposit' } },
  ] } }, { commit: true, holder: 'test' });
  assert.equal(deposited, true);
});

test('fuel: a terminal journey failure ends the wait without sending dependent commerce', async () => {
  const calls = [];
  const broker = { call: async (tool) => {
    calls.push(tool);
    if (tool === 'travel') return { started: true };
    if (tool === 'fleet') return { fleet: [{ agent: 'role-a', room_num: 107,
      failed: 'route_progressing_exits_exhausted' }] };
    return {};
  } };
  const result = await runErrand(broker, { orders: { agent: 'role-a', errand: 'sellrun-circuit', steps: [
    { tool: 'travel', args: { agent: 'role-a', to: 113 }, expect: 'arrived' },
    { tool: 'sell_all', args: { agent: 'role-a' } },
  ] } }, { commit: true, holder: 'test' });
  assert.match(result.stopped, /route_progressing_exits_exhausted/);
  assert.equal(calls.includes('sell_all'), false);
});

test('fuel: journey timeout follows new ground and recovery, not total duration or oscillation', async () => {
  const { JourneyProgress } = await import('../src/act/journey-progress.mjs');
  const watch = new JourneyProgress({ now: 0, stallMs: 100, maxMs: 1000 });
  const at = (col, more = {}) => ({ room_num: 10, position: { row: 2, col }, ...more });
  assert.equal(watch.observe(at(1), 0), null);
  assert.equal(watch.observe(at(2), 90), null);
  assert.equal(watch.observe(at(3), 180), null, 'a progressing trip outlives its idle budget');
  assert.equal(watch.observe(at(2), 220), null);
  assert.match(watch.observe(at(3), 281), /no new ground/, 'oscillation is not progress');
  const rest = new JourneyProgress({ now: 0, stallMs: 100 });
  assert.equal(rest.observe(at(1, { health: '10/50', vigor: 70, activity: 'holding a wall' }), 0), null);
  assert.equal(rest.observe(at(1, { health: '20/50', vigor: 80, activity: 'holding a wall' }), 90), null);
  assert.equal(rest.observe(at(1, { health: '30/50', vigor: 80, activity: 'holding a wall' }), 180), null);
  assert.match(rest.observe(at(1, { health: '30/50', vigor: 80, activity: 'holding a wall' }), 281), /no new ground/);
});
