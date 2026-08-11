import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyStore } from '../src/record/strategies.mjs';
import { STRATEGY_CATALOG, STRATEGY_IDS } from '../src/strategies/catalog.mjs';
import { foodFleetRules } from '../src/decide/rules/food.mjs';
import { castleAssignments, castleDeploymentDiffers } from '../src/decide/rules/castle-victoria.mjs';
import { spreadAssignments } from '../src/decide/rules/placement.mjs';
import { economyRules } from '../src/decide/rules/economy.mjs';
import { loadDoctrine } from '../src/config/load.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
import { fleetRules } from '../src/decide/index.mjs';

const test = globalThis.__dumTest;

test('strategies: catalogue contains the independently selectable behaviours', () => {
  assert.deepEqual(STRATEGY_CATALOG.map(s => s.id), [
    STRATEGY_IDS.CREATE_WEAPONS, STRATEGY_IDS.CREATE_FOOD,
    STRATEGY_IDS.VS_SKELETONS, STRATEGY_IDS.CHECK_CV_CRATE,
    STRATEGY_IDS.SPREAD_OUT, STRATEGY_IDS.SELL_AND_BANK,
  ]);
  assert.equal(STRATEGY_CATALOG.filter(s => s.group === 'Kraanan upkeep').length, 2);
});

test('strategies: an empty larder is serviced before repeat weapon rolls', () => {
  const ids = fleetRules.rules.map(rule => rule.id);
  assert.ok(ids.indexOf('create-food-to-keep-fed') < ids.indexOf('maintain-qualifying-weapons'));
});

test('strategies: Spread Out defaults off and its enabled caps preserve the old values', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/survive.jsonc' }).config;
  assert.ok(!doctrine.strategies.defaults.includes(STRATEGY_IDS.SPREAD_OUT));
  const spread = STRATEGY_CATALOG.find(s => s.id === STRATEGY_IDS.SPREAD_OUT);
  assert.deepEqual(Object.fromEntries(spread.settings.map(s => [s.id, s.default])), {
    max_bots_per_safe_spot: 3, max_bots_per_room: 4,
  });
  const rows = Array.from({ length: 6 }, (_, i) => ({ agent: `u${i}`, room: null, policy: {} }));
  const assigned = spreadAssignments(rows, [10, 11], 2);
  assert.equal(assigned.filter(a => a.to === 10).length, 2);
  assert.equal(assigned.filter(a => a.to === 11).length, 2);
  assert.equal(assigned.filter(a => a.to === null).length, 2);
});

test('strategies: selling and banking values are independently maintained', () => {
  const economy = STRATEGY_CATALOG.find(s => s.id === STRATEGY_IDS.SELL_AND_BANK);
  assert.deepEqual(Object.fromEntries(economy.settings.map(s => [s.id, s.default])), {
    bank_above: 3000, walking_money: 1000, max_carry: 50, sell_at_load: 0.95,
    sell_when_broke: false, broke_under: 500, broke_stacks: 8,
  });
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const obs = { agent: 'banker', policy: {}, keeper: { policy: {} }, strategies: {
    agents: { banker: [STRATEGY_IDS.SELL_AND_BANK] },
  } };
  const intent = economyRules[0].decide(obs, doctrine);
  assert.equal(intent.orders.bank_above, 3000);
  assert.equal(intent.orders.walking_money, 1000);
  assert.equal(intent.orders.max_carry, 50);
  assert.equal(intent.orders.sell_at_load, 0.95);
  assert.equal(intent.orders.sell_when_broke, false);
});

test('strategies: a multi-unit toggle changes only the named behaviour', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-strategies-'));
  try {
    const store = new StrategyStore({ dir, fleet: 'fixture', enabled: true,
      defaults: Object.values(STRATEGY_IDS) });
    assert.equal(store.states(['a', 'b']).states[STRATEGY_IDS.CREATE_FOOD].state, 'all');
    store.update(['a'], { [STRATEGY_IDS.CREATE_FOOD]: false });
    const states = store.states(['a', 'b']).states;
    assert.equal(states[STRATEGY_IDS.CREATE_FOOD].state, 'some');
    assert.equal(states[STRATEGY_IDS.CREATE_WEAPONS].state, 'all');
    store.update(['a', 'b'], {}, { [STRATEGY_IDS.SPREAD_OUT]: {
      max_bots_per_safe_spot: 2, max_bots_per_room: 5,
    } });
    const configured = store.snapshot(['a', 'b']);
    assert.equal(configured.settings.a[STRATEGY_IDS.SPREAD_OUT].max_bots_per_safe_spot, 2);
    assert.equal(configured.settings.b[STRATEGY_IDS.SPREAD_OUT].max_bots_per_room, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strategies: Create Food fires only for selected units with spell, mana, and reagents', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const row = agent => ({ agent, in_game: true, items: [
    { name: 'elderberry', amount: 2 }, { name: 'herb', amount: 2 },
  ], provides: ['create food'], mana: { value: 10 } });
  const obs = { characters: [row('cook'), row('off')], strategies: { agents: {
    cook: [STRATEGY_IDS.CREATE_FOOD], off: [],
  } } };
  const result = foodFleetRules[0].decide(obs, doctrine);
  assert.equal(result.kind, 'act');
  assert.deepEqual(result.plan.map(p => p.agent), ['cook']);
  assert.equal(result.plan[0].do, 'cast-create-food');
  assert.deepEqual(callsForFleetPlan(result.plan).map(x => x.tool), ['cast', 'autopilot']);
});

test('strategies: Castle Victoria only pins rooms and walls when Spread Out is enabled', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rows = Array.from({ length: 21 }, (_, i) => ({ agent: `a${i + 1}`, in_game: true,
    level: 43 + (i % 9), policy: {}, mode: 'farm' }));
  const unspread = castleAssignments(rows, doctrine);
  assert.ok(unspread.every(a => a.to === null && a.max_bots_per_safe_spot === null));
  const obs = { characters: rows, strategies: { agents: Object.fromEntries(rows.map(row =>
    [row.agent, [STRATEGY_IDS.SPREAD_OUT]])) } };
  const assigned = castleAssignments(rows, doctrine, obs);
  assert.equal(assigned.filter(a => a.to === 39).length, 4);
  assert.equal(assigned.filter(a => a.to === 38).length, 4);
  assert.equal(assigned.filter(a => a.to === null).length, 13);
  assert.ok(assigned.filter(a => a.to != null).every(a => a.max_bots_per_safe_spot === 3));
  assert.deepEqual(new Set(assigned.map(a => a.hunt)),
    new Set(['zombie', 'battered skeleton', 'skeleton']));
  const skeleton = assigned.find(a => a.hunt === 'skeleton');
  assert.equal(skeleton.row.level + skeleton.max_threat_over, 75);
});

test('strategies: Castle policy diff includes live maintenance fields', () => {
  const orders = { to: 39, hunt: 'battered skeleton', max_threat_over: 10,
    max_bots_per_safe_spot: null,
    flee_below: .35, rest_below: .75, max_carry: 14, bank_above: 2000,
    use_safe_spots: true, strategy: 'wellfed', fight_above_vigor: 180,
    hold_resume_above: .9, purpose: 'advance', weapon_priority: ['hammer'] };
  const row = { mode: 'farm', policy: { assignedRoom: 39, hunt: 'battered skeleton',
    maxBotsPerSafeSpot: null,
    maxThreatOver: 10, fleeBelow: .35, restBelow: .75, maxCarry: 14,
    bankAbove: 2000, roam: false, useSafeSpots: true, strategy: 'wellfed',
    fightAboveVigor: 180, holdResumeAbove: .9, purpose: 'advance',
    weaponPriority: ['hammer'] } };
  assert.equal(castleDeploymentDiffers(row, orders), false);
  row.commitment = { kind: 'driven' };
  assert.equal(castleDeploymentDiffers(row, orders), true);
  row.commitment = null;
  row.policy.weaponPriority = ['sword'];
  assert.equal(castleDeploymentDiffers(row, orders), true);
});
