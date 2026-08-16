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
import { ORDER_FIELDS, planOrders } from '../src/act/orders.mjs';

const test = globalThis.__dumTest;

test('strategies: catalogue contains the independently selectable behaviours', () => {
  assert.deepEqual(STRATEGY_CATALOG.map(s => s.id), [
    STRATEGY_IDS.AUTO_LEVEL_PLANNED,
    STRATEGY_IDS.PLAY_FACTION_GAMES,
    STRATEGY_IDS.CREATE_WEAPONS, STRATEGY_IDS.CREATE_FOOD,
    STRATEGY_IDS.VS_SKELETONS, STRATEGY_IDS.SHORT_SWORDING, STRATEGY_IDS.CHECK_CV_CRATE,
    STRATEGY_IDS.SPREAD_OUT, STRATEGY_IDS.SELL_AND_BANK,
    STRATEGY_IDS.SUPPLY_LIMITED_FARMING, STRATEGY_IDS.INKY_RESERVE, STRATEGY_IDS.GUILD_TITHE,
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
  const travelling = spreadAssignments([
    { agent: 'a', room: 11, policy: { assignedRoom: 10 } },
    { agent: 'b', room: 10, policy: { assignedRoom: 11 } },
  ], [10, 11], 1);
  assert.deepEqual(Object.fromEntries(travelling.map(a => [a.row.agent, a.to])), { a: 10, b: 11 });
});

test('strategies: the inky reserve is opt-in and bounded', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rule = economyRules.find(r => r.id === 'economy-thresholds');
  const obs = (agent, picks) => ({ agent, policy: {}, keeper: { policy: {} }, strategies: {
    agents: { [agent]: picks }, settings: { [agent]: {} } } });

  // Not selected must read as OFF, not as "leave it alone". The keeper's own default is
  // off, so an absent strategy that silently kept a previous true would be unturnoffable.
  const without = rule.decide(obs('plain', [STRATEGY_IDS.SELL_AND_BANK]), doctrine).orders;
  assert.equal(without.inky_reserve, false);
  assert.equal(without.inky_reserve_floor, undefined);

  const with_ = rule.decide(obs('fed', [STRATEGY_IDS.SELL_AND_BANK, STRATEGY_IDS.INKY_RESERVE]),
                            doctrine).orders;
  assert.equal(with_.inky_reserve, true);
  // Bounded: it relaxes the wellfed floor, it does not remove the survival one.
  assert.equal(with_.inky_reserve_floor, 120);
});

// A YIELDED FIELD IS PERMANENT DRIFT, AND PERMANENT DRIFT ABOVE THE LADDER IS A WEDGE.
//
// `yield_to` names fields something else writes. planOrders honours it at the sending end;
// the rule's own convergence test did not, so a yielded field the other writer holds at a
// different value read as drift that could never clear. The rule returned an intent every
// tick, the send was empty every tick, and because the table is first-match-wins, `ladder`
// and `placement` never ran at all.
//
// Measured on prod: keeper-parity yields `max_carry`, the rule wanted 14, the keeper held
// 50. One field — 6,126 intents in a day, zero calls, two days of no work orders.
test('strategies: a yielded threshold is not drift, and cannot wedge the table', () => {
  const base = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rule = economyRules.find(r => r.id === 'economy-thresholds');
  const agent = 'held';
  const picks = [STRATEGY_IDS.SELL_AND_BANK];
  const settled = agrees => ({ agent, policy: {}, keeper: { policy: agrees },
    strategies: { agents: { [agent]: picks }, settings: { [agent]: {} } } });

  // What the rule wants when nothing is yielded, so the keeper below can be built to
  // agree with all of it except the one field the operator has given away.
  const full = rule.decide(settled({}), base).orders;
  const KEYS = { bank_above: 'bankAbove', walking_money: 'walkingMoney', max_carry: 'maxCarry',
    sell_at_load: 'sellAtLoad', sell_when_broke: 'sellWhenBroke', inky_reserve: 'inkyReserve',
    sell_when_broke_under: 'sellWhenBrokeUnder', sell_when_broke_stacks: 'sellWhenBrokeStacks' };
  const keeper = {};
  for (const [k, v] of Object.entries(full)) if (KEYS[k]) keeper[KEYS[k]] = v;
  // The other writer holds max_carry somewhere else, and will go on holding it. Any value
  // the rule does not want will do; prod's pair was want 14 against a keeper holding 50.
  keeper.maxCarry = full.max_carry + 1;

  // Without the yield the rule is right to fire: that IS drift it owns.
  assert.ok(rule.decide(settled(keeper), base),
            'an unyielded field at a different value is real drift and should fire');

  // With the yield it must go quiet, because it can never make that field true.
  const yielding = { ...base, yield_to: ['max_carry'] };
  assert.equal(rule.decide(settled(keeper), yielding), null,
    'a rule that only disagrees about a YIELDED field must return null — firing every ' +
    'tick over a field it cannot write starves every rule below it in a first-match table');

  // And it must not have gone quiet by going blind: something it does own still fires.
  assert.ok(rule.decide(settled({ ...keeper, bankAbove: 1 }), yielding),
            'yielding one field must not suppress the fields the rule still owns');
  // The emitted orders no longer mention the yielded field at all.
  assert.equal(rule.decide(settled({ ...keeper, bankAbove: 1 }), yielding).orders.max_carry,
               undefined);
});

// A RULE THAT EMITS A FIELD THE WRITER CANNOT ROUTE IS WORSE THAN A RULE THAT DOES
// NOTHING, AND THE TEST ABOVE PASSED THROUGHOUT.
//
// It asserts what economy-thresholds EMITS. Nothing asserted that the emitted field could
// be written, and the two live in different files. `planOrders` throws on the first
// unrecognised key AFTER diffing the rest, so one missing row discards the whole intent —
// which means the drift the rule is correcting never clears and the rule re-fires for
// ever. Character rules are first-match-wins, so a rule wedged like that starves every
// rule below it: measured live, `ladder` and `placement` produced no intents at all for
// two days while `economy-thresholds` errored 6,126 times in a single day.
//
// So: whatever the rule can emit, under any combination of the strategies that feed it,
// has to be routable. This is the assertion that ties the two files together.
test('strategies: every threshold the economy rule can emit is routable by planOrders', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rule = economyRules.find(r => r.id === 'economy-thresholds');
  const combos = [
    [STRATEGY_IDS.SELL_AND_BANK],
    [STRATEGY_IDS.SELL_AND_BANK, STRATEGY_IDS.INKY_RESERVE],
    [STRATEGY_IDS.SELL_AND_BANK, STRATEGY_IDS.SUPPLY_LIMITED_FARMING],
    [STRATEGY_IDS.SELL_AND_BANK, STRATEGY_IDS.SUPPLY_LIMITED_FARMING, STRATEGY_IDS.INKY_RESERVE],
  ];
  for (const picks of combos) {
    const agent = picks.join('+');
    const obs = { agent, policy: {}, keeper: { policy: {} },
      strategies: { agents: { [agent]: picks }, settings: { [agent]: {} } } };
    const intent = rule.decide(obs, doctrine);
    assert.ok(intent, `${agent}: expected an intent against an empty keeper policy`);
    const unroutable = Object.keys(intent.orders)
      .filter(k => k !== 'action' && k !== 'why' && k !== 'batch' && !ORDER_FIELDS[k]);
    assert.deepEqual(unroutable, [],
      `${agent}: economy-thresholds emits ${unroutable.join(', ')}, which planOrders would ` +
      `throw on — discarding the whole intent, including the fields that ARE routable`);
    // And the round trip itself, because the throw is what actually reaches the journal.
    assert.doesNotThrow(() => planOrders({ ...intent, agent }, obs));
  }
});

test('strategies: supply-limited farming owns the market trigger, not the purse', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rule = economyRules.find(r => r.id === 'economy-thresholds');
  const obs = agent => ({ agent, policy: {}, keeper: { policy: {} }, strategies: {
    agents: { [agent]: agent === 'supplied'
      ? [STRATEGY_IDS.SELL_AND_BANK, STRATEGY_IDS.SUPPLY_LIMITED_FARMING]
      : [STRATEGY_IDS.SELL_AND_BANK] },
    settings: { [agent]: { [STRATEGY_IDS.SELL_AND_BANK]: { sell_at_load: 0.7 } } },
  } });

  // Two strategies have an opinion about what sends a character to a market, and one
  // keeper value to put it in. Selecting Supply-Limited Farming has to WIN that, or the
  // load fraction it exists to switch off keeps booking trips.
  assert.equal(rule.decide(obs('plain'), doctrine).orders.sell_at_load, 0.7);
  assert.equal(rule.decide(obs('supplied'), doctrine).orders.sell_at_load, 0.95);

  // and it takes only that one. The purse thresholds are a different question and stay
  // with Sell Loot, so enabling this must not quietly re-open banking policy.
  const supplied = rule.decide(obs('supplied'), doctrine).orders;
  assert.equal(supplied.bank_above, 4000);
  // The band between these two is what pays for an outfitting, not either number alone.
  // walking_money is the floor spending refuses to go under, so it stays low.
  assert.equal(supplied.walking_money, 400);
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
  // The doctrine deliberately DIFFERS from the catalog defaults above, which is the whole
  // point of this test's name. Castle Victoria carries 4,000 before banking and keeps
  // 2,500 so that one town trip funds a whole outfitting — 40 elderberry at 28sh plus 40
  // herbs at 14sh is 1,680 before food or armour, and at the catalog's 1,000 float every
  // re-supply took two round trips.
  assert.equal(intent.orders.bank_above, 4000);
  assert.equal(intent.orders.walking_money, 400);
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

test('strategies: Spread Out owns the wall cap; the shift owns which room', () => {
  // THE SUBJECT HERE IS THE DIVISION OF LABOUR, NOT WHICH ROOM THE FLEET IS IN THIS WEEK.
  // `upstairs_share` is a live tuning knob — it went to 0 the day the fleet outgrew the
  // level-60 battered skeleton — so the two-room assertions below set it explicitly rather
  // than inheriting the shipped value. That value has its own test underneath, where a
  // change to it is supposed to be noticed rather than absorbed.
  const doctrine = structuredClone(loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config);
  doctrine.castle_victoria.upstairs_share = 1;
  const rows = Array.from({ length: 21 }, (_, i) => ({ agent: `a${i + 1}`, in_game: true,
    level: 43 + (i % 9), policy: {}, mode: 'farm' }));

  // A ONE-ROOM DOCTRINE FORCES THE ROOM WITHOUT SPREAD OUT, and this assertion used to say
  // the opposite. It was wrong in the direction that made a doctrine change inert: with
  // Spread Out off — which the Castle doctrine deliberately runs with — nothing was ever
  // assigned a room, so retiring a room retired nothing and the fleet went on hunting
  // whatever generator it was already standing in.
  const unspread = castleAssignments(rows, doctrine);
  assert.ok(unspread.every(a => a.to === 39), 'a retired room is still a room assignment');
  // The WALL cap really is Spread Out's, and naming a room must not start pinning walls.
  assert.ok(unspread.every(a => a.max_bots_per_safe_spot === null));
  // With a genuine two-room split there is something to balance, and that IS Spread Out's.
  const mixed = structuredClone(doctrine);
  mixed.castle_victoria.upstairs_share = 0.5;
  assert.ok(castleAssignments(rows, mixed).every(a => a.to === null && a.max_bots_per_safe_spot === null));
  const obs = { characters: rows, strategies: { agents: Object.fromEntries(rows.map(row =>
    [row.agent, [STRATEGY_IDS.SPREAD_OUT]])) } };
  const assigned = castleAssignments(rows, doctrine, obs);
  assert.equal(assigned.filter(a => a.to === 39).length, 4);
  assert.equal(assigned.filter(a => a.to === 38).length, 0);
  assert.equal(assigned.filter(a => a.to === null).length, 17);
  assert.ok(assigned.filter(a => a.to != null).every(a => a.max_bots_per_safe_spot === 3));
  assert.deepEqual(new Set(assigned.map(a => a.hunt)),
    new Set(['zombie', 'battered skeleton']));
  const enRoute = [{ agent: 'traveller', in_game: true, level: 60, room: 826,
    policy: { assignedRoom: 38 }, mode: 'farm' }];
  const enRouteObs = { characters: enRoute,
    strategies: { agents: { traveller: [STRATEGY_IDS.SPREAD_OUT] } } };
  const mixedDoctrine = structuredClone(doctrine);
  mixedDoctrine.castle_victoria.upstairs_share = 0.67;
  assert.equal(castleAssignments(enRoute, mixedDoctrine, enRouteObs)[0].to, 38);
  assert.equal(castleAssignments(enRoute, doctrine, enRouteObs)[0].to, 39,
    'a retired room is not preserved merely because it was the previous assignment');
  assert.equal(castleAssignments([{ ...enRoute[0], policy: {} }], doctrine, enRouteObs)[0].hunt,
    'battered skeleton', 'a level-60 unit is never assigned a zombie that cannot advance it');
  const zombie = assigned.find(a => a.to === 39 && a.hunt === 'zombie');
  assert.equal(zombie.row.level + zombie.max_threat_over, 60,
    'an upstairs zombie assignment admits the battered skeleton sharing that generator');
});

test('strategies: the shipped Castle shift hunts the full skeleton, not the battered one', () => {
  // A KILL PAYS ONLY WHILE THE CREATURE'S LEVEL IS STRICTLY ABOVE MAX HEALTH, and max
  // health is the level here. The battered skeleton is 60 and most of this fleet is 60, so
  // upstairs pays them nothing while reporting kills the whole time — the exact shape
  // `yieldCheck` exists to catch. The full skeleton downstairs is 75.
  //
  // Pinned because it is a deliberate choice that looks like a typo: one character in a
  // JSON file moves twenty-one characters into a harder room.
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  assert.equal(doctrine.castle_victoria.upstairs_share, 0);
  const rows = Array.from({ length: 21 }, (_, i) => ({ agent: `a${i + 1}`, in_game: true,
    level: 60, policy: {}, mode: 'farm' }));
  const obs = { characters: rows, strategies: { agents: Object.fromEntries(rows.map(row =>
    [row.agent, [STRATEGY_IDS.SPREAD_OUT]])) } };
  const assigned = castleAssignments(rows, doctrine, obs);
  assert.deepEqual(new Set(assigned.map(a => a.hunt)), new Set(['skeleton']),
    'no zombie and no battered skeleton: neither can advance a level-60 character');
  assert.equal(assigned.filter(a => a.to === 39).length, 0);

  // The ceiling is sized to the strongest normal spawn in the ASSIGNED room, not to the
  // quarry — a skeleton hunter downstairs shares that generator with nothing worse, but
  // sizing it to the quarry is how a unit ends up rejecting its own room.
  const placed = assigned.filter(a => a.to != null);
  assert.ok(placed.length > 0);
  assert.ok(placed.every(a => a.row.level + a.max_threat_over === 75));
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
