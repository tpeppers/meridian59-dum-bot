import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyStore } from '../src/record/strategies.mjs';
import { Journal } from '../src/record/journal.mjs';
import { DetailStats, inventoryGain } from '../src/record/detail-stats.mjs';
import { STRATEGY_CATALOG, STRATEGY_IDS } from '../src/strategies/catalog.mjs';
import { foodFleetRules } from '../src/decide/rules/food.mjs';
import { castleAssignments, castleDeploymentDiffers } from '../src/decide/rules/castle-victoria.mjs';
import { spreadAssignments } from '../src/decide/rules/placement.mjs';
import { economyRules } from '../src/decide/rules/economy.mjs';
import { loadDoctrine } from '../src/config/load.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
import { fleetRules } from '../src/decide/index.mjs';
import { canonicalItemSettings } from '../src/link/strategy-control.mjs';

const test = globalThis.__dumTest;

test('strategies: catalogue contains the independently selectable behaviours', () => {
  assert.deepEqual(STRATEGY_CATALOG.map(s => s.id), [
    STRATEGY_IDS.CREATE_WEAPONS, STRATEGY_IDS.CREATE_FOOD,
    STRATEGY_IDS.VS_SKELETONS, STRATEGY_IDS.CHECK_CV_CRATE,
    STRATEGY_IDS.SPREAD_OUT, STRATEGY_IDS.SELL_AND_BANK, STRATEGY_IDS.GUILD_TITHE,
    STRATEGY_IDS.MAX_WEAPONS,
    STRATEGY_IDS.BUY_FOOD, STRATEGY_IDS.BUY_WEAPONS, STRATEGY_IDS.BUY_REAGENTS,
    STRATEGY_IDS.ACCUMULATE_IN_VAULT,
    STRATEGY_IDS.FARM_CLEANUP, STRATEGY_IDS.FARM_DELIVERY,
    STRATEGY_IDS.DETAILED_STATS,
  ]);
  assert.equal(STRATEGY_CATALOG.filter(s => s.group === 'Kraanan upkeep').length, 2);
});

test('strategies: detailed stats are opt-in, independently filtered, and expire on their selected clock', () => {
  const definition = STRATEGY_CATALOG.find(s => s.id === STRATEGY_IDS.DETAILED_STATS);
  const defaults = Object.fromEntries(definition.settings.map(s => [s.id, s.default]));
  assert.equal(defaults.retention_hours, 24);
  assert.equal(defaults.default_window_hours, 2);
  assert.ok(['crate_check', 'travel', 'fighting', 'trading', 'vault_accumulation', 'create_food',
    'farm_cleanup', 'farm_delivery']
    .every(key => defaults[key] === true));
  assert.deepEqual(inventoryGain([{ name: 'mace', amount: 1 }],
    [{ name: 'mace', amount: 1 }, { name: 'rose', amount: 2 }]),
    [{ name: 'rose', amount: 2 }]);

  const dir = mkdtempSync(join(tmpdir(), 'dum-detail-stats-'));
  let now = Date.UTC(2026, 7, 11, 12);
  try {
    const stats = new DetailStats({ dir, now: () => now });
    stats.write({ category: 'crate-check', event: 'check', agent: 'a', retention_hours: 1 });
    assert.equal(stats.report({ hours: 2 }).crate.checks, 1);
    now += 61 * 60_000;
    stats.rotate(now);
    assert.equal(stats.report({ hours: 2 }).crate.checks, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strategies: farm coordination is independent, configurable, and clears when disabled', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rule = economyRules.find(r => r.id === 'farm-coordination-policy');
  const obs = { agent: 'courier', keeper: { policy: { farmCleanup: null, farmDelivery: null } },
    strategies: { agents: { courier: [STRATEGY_IDS.FARM_CLEANUP, STRATEGY_IDS.FARM_DELIVERY] },
      settings: { courier: { [STRATEGY_IDS.FARM_CLEANUP]: { max_floor_items: 8 },
        [STRATEGY_IDS.FARM_DELIVERY]: { herbs_per_farmer: 30, max_recipients: 2 } } } } };
  const on = rule.decide(obs, doctrine);
  assert.deepEqual(on.orders.farm_cleanup,
    { enabled: true, max_floor_items: 8, keep_free_stacks: 1 });
  // An explicitly-set setting overrides; every other one arrives at its catalogue default,
  // which is what lets a new setting reach the keeper without every doctrine restating it.
  assert.deepEqual(on.orders.farm_delivery,
    { enabled: true, herbs_per_farmer: 30, elderberries_per_farmer: 10, max_recipients: 2,
      per_farmer_default: 10, radius_rooms: 2 });
  obs.keeper.policy.farmCleanup = on.orders.farm_cleanup;
  obs.keeper.policy.farmDelivery = on.orders.farm_delivery;
  obs.strategies.agents.courier = [];
  assert.deepEqual(rule.decide(obs, doctrine).orders,
    { action: 'start', farm_cleanup: null, farm_delivery: null });
});

test('strategies: disabling detailed stats clears a previously enabled keeper policy', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rule = economyRules.find(r => r.id === 'detailed-strategy-stats-policy');
  const obs = { agent: 'watcher', keeper: { policy: { strategyStats: null } }, strategies: {
    agents: { watcher: [STRATEGY_IDS.DETAILED_STATS] }, settings: { watcher: {} },
  } };
  const enabled = rule.decide(obs, doctrine);
  assert.equal(enabled.orders.strategy_stats.enabled, true);
  assert.equal(enabled.orders.strategy_stats.default_window_hours, 2);
  obs.strategies.agents.watcher = [];
  obs.keeper.policy.strategyStats = enabled.orders.strategy_stats;
  assert.equal(rule.decide(obs, doctrine).orders.strategy_stats, null);
});

test('strategies: vault accumulation accepts several items and clears protection when disabled', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const strategy = STRATEGY_CATALOG.find(s => s.id === STRATEGY_IDS.ACCUMULATE_IN_VAULT);
  assert.deepEqual(strategy.settings[0].default, [
    'dark angel feather',
    'Inky-cap mushroom',
    'blue dragon scale',
    'arrows',
    'nerudite arrows',
  ]);
  const enabled = { agent: 'collector', keeper: { policy: { vaultItems: [] } }, strategies: {
    agents: { collector: [STRATEGY_IDS.ACCUMULATE_IN_VAULT] },
    settings: { collector: { [STRATEGY_IDS.ACCUMULATE_IN_VAULT]: {
      items: ['inky cap mushroom', 'dark angel feather'],
    } } },
  } };
  const rule = economyRules.find(r => r.id === 'vault-accumulation-policy');
  assert.deepEqual(rule.decide(enabled, doctrine).orders.vault_items,
    ['inky cap mushroom', 'dark angel feather']);
  enabled.strategies.agents.collector = [];
  enabled.keeper.policy.vaultItems = ['inky cap mushroom'];
  assert.deepEqual(rule.decide(enabled, doctrine).orders.vault_items, []);
});

test('strategies: vault item saves use the harness canonical item resolver', async () => {
  const settings = { [STRATEGY_IDS.ACCUMULATE_IN_VAULT]: {
    items: ['inky cap mushrooms', 'arrow'],
  } };
  const resolved = await canonicalItemSettings(settings, async items => {
    assert.deepEqual(items, ['inky cap mushrooms', 'arrow']);
    return { items: ['Inky-cap mushroom', 'arrows'] };
  });
  assert.deepEqual(resolved[STRATEGY_IDS.ACCUMULATE_IN_VAULT].items,
    ['Inky-cap mushroom', 'arrows']);
  await assert.rejects(() => canonicalItemSettings(settings, async () => {
    throw new Error('item "mush" does not resolve');
  }), /does not resolve/);
});

test('observability: current-process counters group interventions by rule and kind', () => {
  const journal = new Journal({ dir: join(tmpdir(), 'dum-observability-fixture'), enabled: false });
  journal.write({ kind: 'tick', intent: { kind: 'orders', rule: 'vault-accumulation-policy' },
    applied: { acted: true, kind: 'orders' }, verified: { verified: true } });
  journal.write({ kind: 'tick', intent: { kind: 'orders', rule: 'vault-accumulation-policy' },
    applied: { acted: false, kind: 'no-change' }, verified: { verified: false } });
  journal.finding('collector', 'fixture finding');
  const metrics = journal.observability();
  assert.equal(metrics.interventions_triggered, 2);
  assert.equal(metrics.interventions_applied, 1);
  assert.equal(metrics.interventions_no_change, 1);
  assert.equal(metrics.verification_failures, 1);
  assert.deepEqual(metrics.by_rule, [{ name: 'vault-accumulation-policy', count: 2 }]);
  assert.deepEqual(metrics.by_kind, [{ name: 'orders', count: 2 }]);
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
  const intent = economyRules.find(rule => rule.id === 'economy-thresholds').decide(obs, doctrine);
  assert.equal(intent.orders.bank_above, 3000);
  assert.equal(intent.orders.walking_money, 1000);
  assert.equal(intent.orders.max_carry, 50);
  assert.equal(intent.orders.sell_at_load, 0.95);
  assert.equal(intent.orders.sell_when_broke, false);
});

test('strategies: Guild Tithe installs a restart-safe daily sale-proceeds policy', () => {
  const strategy = STRATEGY_CATALOG.find(s => s.id === STRATEGY_IDS.GUILD_TITHE);
  assert.equal(strategy.settings[0].default, 2000);
  const rule = economyRules.find(r => r.id === 'guild-tithe-policy');
  const obs = { agent: 'member', policy: {}, keeper: { policy: { guildTithe: null } },
    strategies: { agents: { member: [STRATEGY_IDS.GUILD_TITHE] }, settings: {} } };
  const intent = rule.decide(obs, { strategies: { enabled: true, defaults: [], settings: {} } });
  assert.deepEqual(intent.orders.guild_tithe, { enabled: true, daily_amount: 2000 });
  obs.keeper.policy.guildTithe = intent.orders.guild_tithe;
  assert.equal(rule.decide(obs, { strategies: { enabled: true, defaults: [], settings: {} } }), null);
});

test('strategies: Max Weapons defaults on at two and clears the keeper cap when disabled', () => {
  const defaultDoctrine = loadDoctrine({ file: 'doctrines/survive.jsonc' }).config;
  assert.ok(defaultDoctrine.strategies.defaults.includes(STRATEGY_IDS.MAX_WEAPONS));
  const strategy = STRATEGY_CATALOG.find(s => s.id === STRATEGY_IDS.MAX_WEAPONS);
  assert.equal(strategy.settings[0].default, 2);

  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rule = economyRules.find(r => r.id === 'max-weapons-policy');
  const obs = { agent: 'seller', keeper: { policy: { maxWeapons: null } }, strategies: {
    agents: { seller: [STRATEGY_IDS.MAX_WEAPONS] },
    settings: { seller: { [STRATEGY_IDS.MAX_WEAPONS]: { max_weapons: 2 } } },
  } };
  assert.equal(rule.decide(obs, doctrine).orders.max_weapons, 2);
  obs.keeper.policy.maxWeapons = 2;
  obs.strategies.agents.seller = [];
  assert.equal(rule.decide(obs, doctrine).orders.max_weapons, null);
});

test('strategies: food, weapon, and reagent buying are independent keeper permissions', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  for (const id of [STRATEGY_IDS.BUY_FOOD, STRATEGY_IDS.BUY_WEAPONS, STRATEGY_IDS.BUY_REAGENTS])
    assert.ok(doctrine.strategies.defaults.includes(id));
  const rule = economyRules.find(r => r.id === 'purchase-strategy-policy');
  const obs = { agent: 'shopper', keeper: { policy: {
    buyFood: true, buyWeapons: true, buyReagents: true,
  } }, strategies: { agents: { shopper: [STRATEGY_IDS.BUY_REAGENTS] } } };
  assert.deepEqual(rule.decide(obs, doctrine).orders, {
    action: 'start', buy_food: false, buy_weapons: false, buy_reagents: true,
  });
  obs.keeper.policy = { buyFood: false, buyWeapons: false, buyReagents: true };
  assert.equal(rule.decide(obs, doctrine), null);
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
    store.update(['a', 'b'], {}, { [STRATEGY_IDS.ACCUMULATE_IN_VAULT]: {
      items: ['inky cap mushroom', 'dark angel feather'],
    } });
    const itemState = store.states(['a', 'b']).states[STRATEGY_IDS.ACCUMULATE_IN_VAULT];
    assert.deepEqual(itemState.settings.items, ['inky cap mushroom', 'dark angel feather']);
    assert.deepEqual(itemState.mixed_settings, []);
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
  const zombie = assigned.find(a => a.to === 39 && a.hunt === 'zombie');
  assert.equal(zombie.row.level + zombie.max_threat_over, 60,
    'an upstairs zombie assignment admits the battered skeleton sharing that generator');
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
