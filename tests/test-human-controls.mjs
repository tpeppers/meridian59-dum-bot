import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyStore } from '../src/record/strategies.mjs';
import { HumanControls, strategyFields } from '../src/link/human-controls.mjs';
import { STRATEGY_CATALOG } from '../src/strategies/catalog.mjs';
import { humanIntent } from '../src/strategies/human-overlay.mjs';
const test = globalThis.__dumTest;

test('human controls: running strategies do not silently become external disk edits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-controls-'));
  try {
    const store = new StrategyStore({ dir, fleet: 'fixture', defaults: [] });
    const id = STRATEGY_CATALOG[0].id;
    writeFileSync(store.path, JSON.stringify({ agents: { 'unit-a': [id] } }));
    assert.deepEqual(store.snapshot(['unit-a']).agents['unit-a'], []);
    assert.deepEqual(store.snapshot(['unit-a'], store.read()).agents['unit-a'], [id]);
    store.update(['unit-a'], { [id]: true });
    assert.deepEqual(store.snapshot(['unit-a']).agents['unit-a'], [id]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('human controls: every strategy has an automatically generated editable template', () => {
  for (const s of STRATEGY_CATALOG) {
    assert.ok(strategyFields().some(f => f.id === `strategy.${s.id}.enabled`));
    for (const field of s.settings ?? []) assert.ok(strategyFields().some(f => f.id === `strategy.${s.id}.${field.id}` && f.description));
  }
});

test('human overlays: owned fields cannot starve later rules; room locks hold errands', () => {
  const obs = { agent: 'unit-a', human_controls: { 'unit-a': { fight_above_vigor: 70, confine_rooms: [42] } },
    keeper: { policy: { fightAboveVigor: 70, buyFood: true } } };
  const intent = { agent: 'unit-a', kind: 'orders', orders: { fight_above_vigor: 180, buy_food: true } };
  assert.equal(humanIntent(intent, obs), null);
  assert.deepEqual(humanIntent({ ...intent, orders: { ...intent.orders, buy_food: false } }, obs).orders, { buy_food: false });
  assert.equal(humanIntent({ agent: 'unit-a', kind: 'errand', orders: { errand: 'visit' } }, obs), null);
  assert.deepEqual(humanIntent(intent, { ...obs, human_controls: {} }), intent);
});

test('human controls: read, stage, stale save, policy pin, inherited release and restart preview', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-controls-'));
  try {
    const store = new StrategyStore({ dir, fleet: 'fixture', defaults: [] });
    const state = { no_food_vigor_floor: 70, confine_rooms: [], assigned_room: 42 };
    let writes = 0;
    const broker = { call: async (tool, a) => {
      assert.equal(tool, 'policy_control');
      if (a.action === 'save') { writes++; Object.assign(state, a.patch); }
      return { fleet: 'fixture', pid: 2, revision: 'policy-' + writes, agents: a.agents ?? ['unit-a'], ok: true,
        schema: Object.keys(state).map(k => ({ id: k, title: k, type: k === 'confine_rooms' ? 'array' : 'number' })),
        rows: { 'unit-a': { keeper_pid: 3, room: 42, live: { values: { ...state } }, restart: { values: { ...state, no_food_vigor_floor: 65 } } } } };
    } };
    const config = { strategies: { defaults: [], settings: {}, enabled: true } };
    const ctl = new HumanControls({ broker, store, config, url: 'http://127.0.0.1:1' });
    let view = await ctl.snapshot(['unit-a']);
    assert.equal(writes, 0); assert.equal(view.rows['unit-a'].current['order.no_food_vigor_floor'], 70);
    assert.equal(view.rows['unit-a'].restart['order.no_food_vigor_floor'], 65);
    const payload = patch => ({ fleet: view.fleet, pid: view.pid, revision: view.revision, agents: view.agents, patch });
    await assert.rejects(ctl.save({ ...payload({}), revision: 'stale' }), /changed/);
    assert.equal(writes, 0);
    view = await ctl.save(payload({ 'order.no_food_vigor_floor': 68, room_lock: true }));
    assert.equal(view.ok, true); assert.equal(writes, 1); assert.equal(ctl.pins('unit-a').no_food_vigor_floor, 68);
    assert.deepEqual(ctl.pins('unit-a').confine_rooms, [42]);
    assert.deepEqual(ctl.filterCall('autopilot', { agent: 'unit-a', action: 'start', no_food_vigor_floor: 100 }), { agent: 'unit-a', action: 'start' });
    assert.throws(() => ctl.filterCall('travel', { agent: 'unit-a', to: 43 }), /room lock/);
    const copy = readFileSync(ctl.path, 'utf8'); await ctl.snapshot(['unit-a']); assert.equal(readFileSync(ctl.path, 'utf8'), copy);
    view = await ctl.save({ ...payload({ room_lock: false }), inherit: ['order.no_food_vigor_floor'] });
    assert.equal(state.no_food_vigor_floor, 70); assert.deepEqual(ctl.pins('unit-a'), {});
    assert.deepEqual(ctl.filterCall('travel', { agent: 'unit-a', to: 43 }), { agent: 'unit-a', to: 43 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
