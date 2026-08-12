// MONEY, AND THE ONE THING A DOCTRINE IS ACTUALLY BUYING BY SETTING A THRESHOLD.
//
// Everything carried drops where a character dies, and a bank balance does not. So a
// banking threshold is not a preference about tidiness — it is a bet about how much of
// the fleet's total is riding on one character that can die in the next eight seconds.
//
// The harness's own default moved twice for exactly this reason, and the second move
// is the instructive one: its best character was found at 8 of 30 health carrying 731
// shillings, which was 46% of everything the fleet owned. At the then-threshold it
// would not have banked, and one bad fight would have put nearly half the fleet's money
// on the floor of a monster room.
//
// DUM'S CONTRIBUTION IS NOT A BETTER NUMBER. The keeper already banks. What a
// fleet-level bot can see that a keeper cannot is CONCENTRATION — which character is
// holding an outsized share — and that is the rule worth having here. The threshold
// rules below exist so a doctrine can express a policy at all; the concentration rule
// is the one that could not have been written inside a single keeper.
//
// NULL MEANS LEAVE IT ALONE, and that is load-bearing. Asserting the harness's own
// default back at it is a write: it lands in the roster and pins a value that would
// otherwise move when the harness's default moved. The harness records discovering
// exactly this — a changed default that never reached any live keeper, because each
// keeper's policy is persisted with the roster and restored on restart.

import { STRATEGY_IDS, strategyEnabled, strategySettings } from '../../strategies/catalog.mjs';

export const economyRules = [
  {
    id: 'purchase-strategy-policy',
    faculty: 'economy',
    why: 'Food, weapon, and reagent purchases are independent opt-in merchant permissions',
    enabled: doctrine => doctrine.strategies?.enabled === true,
    offWhy: 'DUM strategies are disabled',
    decide(obs, doctrine) {
      const want = {
        buy_food: strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.BUY_FOOD),
        buy_weapons: strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.BUY_WEAPONS),
        buy_reagents: strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.BUY_REAGENTS),
      };
      const live = obs.keeper?.policy ?? obs.policy ?? {};
      const keys = { buy_food: 'buyFood', buy_weapons: 'buyWeapons', buy_reagents: 'buyReagents' };
      if (Object.entries(want).every(([key, value]) => live[keys[key]] === value)) return null;
      return {
        kind: 'orders',
        orders: { action: 'start', ...want },
        why: Object.entries(want).map(([key, value]) => `${key}=${value}`).join(', '),
        evidence: { want, keeper_has: pick(live, Object.values(keys)) },
      };
    },
  },
  {
    id: 'max-weapons-policy',
    faculty: 'economy',
    why: 'the Max Weapons strategy limits merchant-trip weapon retention without changing combat selection',
    enabled: doctrine => doctrine.strategies?.enabled === true,
    offWhy: 'DUM strategies are disabled',
    decide(obs, doctrine) {
      const enabled = strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.MAX_WEAPONS);
      const wanted = enabled
        ? strategySettings(obs, doctrine, obs.agent, STRATEGY_IDS.MAX_WEAPONS).max_weapons
        : null;
      const live = obs.keeper?.policy?.maxWeapons ?? obs.policy?.maxWeapons ?? null;
      if (live === wanted) return null;
      if (!enabled && live == null) return null;
      return {
        kind: 'orders',
        orders: { action: 'start', max_weapons: wanted },
        why: enabled
          ? `retain at most ${wanted} weapons after merchant visits, including equipped weapons`
          : 'the Max Weapons strategy is off, so remove the merchant weapon cap',
        evidence: { want: wanted, keeper_has: live },
      };
    },
  },
  {
    id: 'farm-coordination-policy',
    faculty: 'economy',
    why: 'Farm clean-up and Farm delivery are independent keeper capabilities coordinated through DUM strategy assignments',
    enabled: doctrine => doctrine.strategies?.enabled === true,
    offWhy: 'DUM strategies are disabled',
    decide(obs, doctrine) {
      const cleanupOn = strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.FARM_CLEANUP);
      const deliveryOn = strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.FARM_DELIVERY);
      const cleanup = cleanupOn
        ? { enabled: true, ...strategySettings(obs, doctrine, obs.agent, STRATEGY_IDS.FARM_CLEANUP) }
        : null;
      const delivery = deliveryOn
        ? { enabled: true, ...strategySettings(obs, doctrine, obs.agent, STRATEGY_IDS.FARM_DELIVERY) }
        : null;
      const live = obs.keeper?.policy ?? obs.policy ?? {};
      const sameCleanup = sameObject(live.farmCleanup ?? null, cleanup);
      const sameDelivery = sameObject(live.farmDelivery ?? null, delivery);
      if (sameCleanup && sameDelivery) return null;
      if (!cleanupOn && !deliveryOn && live.farmCleanup == null && live.farmDelivery == null) return null;
      return {
        kind: 'orders',
        orders: { action: 'start', farm_cleanup: cleanup, farm_delivery: delivery },
        why: [cleanupOn ? 'clean the farm before sell trips' : 'leave farm cleanup off',
              deliveryOn ? 'resupply active farmers on the return leg' : 'leave farm delivery off'].join('; '),
        evidence: { want: { farm_cleanup: cleanup, farm_delivery: delivery },
          keeper_has: { farm_cleanup: live.farmCleanup ?? null, farm_delivery: live.farmDelivery ?? null } },
      };
    },
  },
  {
    id: 'detailed-strategy-stats-policy',
    faculty: 'economy',
    why: 'the Detailed strategy stats opt-in controls the keeper-side rotating activity recorder',
    enabled: doctrine => doctrine.strategies?.enabled === true,
    offWhy: 'DUM strategies are disabled',
    decide(obs, doctrine) {
      const enabled = strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.DETAILED_STATS);
      const wanted = enabled
        ? { enabled: true, ...strategySettings(obs, doctrine, obs.agent, STRATEGY_IDS.DETAILED_STATS) }
        : null;
      const live = obs.keeper?.policy?.strategyStats ?? obs.policy?.strategyStats ?? null;
      if (sameObject(live, wanted)) return null;
      // Do not write null to keepers that predate this feature. Once explicitly enabled,
      // however, unchecking the strategy must clear it rather than leaving collection on.
      if (!enabled && live == null) return null;
      return {
        kind: 'orders',
        orders: { action: 'start', strategy_stats: wanted },
        why: enabled
          ? `retain opt-in detailed strategy records for ${wanted.retention_hours}h and open dashboards at ${wanted.default_window_hours}h`
          : 'the detailed strategy stats opt-in is off, so stop keeper-side detail collection',
        evidence: { want: wanted, keeper_has: live },
      };
    },
  },
  {
    id: 'vault-accumulation-policy',
    faculty: 'economy',
    why: 'the Accumulate items in vault strategy protects selected drops and stores them during Barloque town loops',
    enabled: doctrine => doctrine.strategies?.enabled === true,
    offWhy: 'DUM strategies are disabled',
    decide(obs, doctrine) {
      const enabled = strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.ACCUMULATE_IN_VAULT);
      const configured = enabled
        ? strategySettings(obs, doctrine, obs.agent, STRATEGY_IDS.ACCUMULATE_IN_VAULT).items
        : [];
      const wanted = configured;
      const live = obs.keeper?.policy?.vaultItems ?? obs.policy?.vaultItems ?? null;
      const held = Array.isArray(live) ? live.map(String) : [];
      if (held.length === wanted.length && held.every((v, i) => v === wanted[i])) return null;
      // null and [] both mean unprotected. This avoids writing an empty policy to every
      // keeper that has never enabled the strategy, while still clearing a previously
      // configured list when the checkbox is turned off.
      if (!wanted.length && live == null) return null;
      return {
        kind: 'orders',
        orders: { action: 'start', vault_items: wanted },
        why: wanted.length
          ? `protect and vault ${wanted.join(', ')} during Barloque town loops`
          : 'the vault accumulation strategy is off, so release its item protections',
        evidence: { want: wanted, keeper_has: held },
      };
    },
  },
  {
    id: 'guild-tithe-policy',
    faculty: 'economy',
    why: 'the Guild Tithe strategy taxes verified town-sale proceeds for guild rent',
    enabled: doctrine => doctrine.strategies?.enabled === true,
    offWhy: 'DUM strategies are disabled',
    decide(obs, doctrine) {
      const enabled = strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.GUILD_TITHE);
      const wanted = enabled
        ? { enabled: true,
            daily_amount: strategySettings(obs, doctrine, obs.agent,
              STRATEGY_IDS.GUILD_TITHE).daily_amount }
        : null;
      const live = obs.keeper?.policy?.guildTithe ?? obs.policy?.guildTithe ?? null;
      if (sameObject(live, wanted)) return null;
      if (!enabled && live == null) return null;
      return { kind: 'orders', orders: { action: 'start', guild_tithe: wanted },
        why: enabled
          ? `reserve up to ${wanted.daily_amount} per day from actual town-sale proceeds for Frular`
          : 'the Guild Tithe strategy is off, so stop taxing sale proceeds',
        evidence: { want: wanted, keeper_has: live } };
    },
  },
  {
    id: 'economy-thresholds',
    faculty: 'economy',
    why: 'the Sell Loot and Bank Surplus strategy owns this keeper\'s pack and purse thresholds',
    enabled: doctrine => doctrine.strategies?.enabled === true,
    offWhy: 'DUM strategies are disabled',
    decide(obs, doctrine) {
      if (!strategyEnabled(obs, doctrine, obs.agent, STRATEGY_IDS.SELL_AND_BANK)) return null;
      const e = strategySettings(obs, doctrine, obs.agent, STRATEGY_IDS.SELL_AND_BANK);
      const want = {
        bank_above: e.bank_above,
        walking_money: e.walking_money,
        max_carry: e.max_carry,
        sell_at_load: e.sell_at_load,
        sell_when_broke: e.sell_when_broke,
        sell_when_broke_under: e.broke_under,
        sell_when_broke_stacks: e.broke_stacks,
      };
      const live = obs.keeper?.policy ?? obs.policy;
      const keys = {
        bank_above: 'bankAbove', walking_money: 'walkingMoney', max_carry: 'maxCarry',
        sell_at_load: 'sellAtLoad', sell_when_broke: 'sellWhenBroke',
        sell_when_broke_under: 'sellWhenBrokeUnder',
        sell_when_broke_stacks: 'sellWhenBrokeStacks',
      };
      if (live && Object.entries(want).every(([key, value]) => live[keys[key]] === value))
        return null;
      return {
        kind: 'orders',
        orders: { action: 'start', ...want },
        why: 'the doctrine sets economy thresholds — ' +
             Object.entries(want).map(([k, v]) => `${k}=${v}`).join(', '),
        evidence: { want, keeper_has: pick(live, Object.values(keys)) },
      };
    },
  },

  {
    // THE RULE A KEEPER COULD NOT HAVE WRITTEN.
    //
    // A keeper knows what it is carrying. It does not know what the fleet is worth, so
    // it cannot tell "carrying a lot" from "carrying most of what everyone owns". This
    // rule is fleet-scoped and reads the board, which is why it lives in the fleet tick
    // rather than the character tick.
    id: 'wealth-concentration',
    faculty: 'economy',
    scope: 'fleet',
    why: 'one character holding an outsized share of the fleet\'s money is a single ' +
         'bad fight away from putting it on the floor of a monster room',
    enabled: doctrine => Number.isFinite(doctrine.economy?.concentration_report_at ?? NaN),
    offWhy: 'economy.concentration_report_at is unset',
    decide(fleetObs, doctrine) {
      const rows = (fleetObs.characters ?? [])
        .map(r => ({ agent: r.agent, carried: Number(r.carried ?? r.shillings ?? NaN) }))
        .filter(r => Number.isFinite(r.carried));
      // NOT ENOUGH EVIDENCE IS AN ANSWER. If the board does not carry per-character
      // money, this rule does nothing rather than approximating.
      if (rows.length < 2) return null;
      const total = rows.reduce((t, r) => t + r.carried, 0);
      if (total <= 0) return null;
      const worst = rows.sort((a, b) => b.carried - a.carried)[0];
      const share = worst.carried / total;
      if (share < doctrine.economy.concentration_report_at) return null;
      return {
        kind: 'report',
        why: `${worst.agent} is carrying ${worst.carried} shillings, ` +
             `${Math.round(share * 100)}% of everything the fleet is holding. ` +
             `A death drops all of it and it is usually unrecoverable`,
        evidence: { agent: worst.agent, carried: worst.carried, fleet_total: total, share },
      };
    },
  },
];

const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj?.[k] ?? null]));
const sameObject = (a, b) => {
  if (a == null || b == null) return a == null && b == null;
  const ordered = value => Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)));
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
};
