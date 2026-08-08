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

export const economyRules = [
  {
    id: 'economy-thresholds',
    faculty: 'economy',
    why: 'the doctrine names banking and carrying thresholds this character should be on',
    enabled: doctrine => Object.values(doctrine.economy ?? {}).some(v => v !== null),
    offWhy: 'the doctrine sets no economy thresholds, so the keeper\'s own are left alone',
    decide(obs, doctrine) {
      const want = {};
      const e = doctrine.economy ?? {};
      // Only fields the doctrine actually set. `act/orders.mjs` diffs these against the
      // keeper's live policy, so an agreeing tick sends nothing at all.
      if (e.bank_above !== null && e.bank_above !== undefined) want.bank_above = e.bank_above;
      if (e.max_carry !== null && e.max_carry !== undefined) want.max_carry = e.max_carry;
      if (!Object.keys(want).length) return null;
      return {
        kind: 'orders',
        orders: { action: 'start', ...want },
        why: 'the doctrine sets economy thresholds — ' +
             Object.entries(want).map(([k, v]) => `${k}=${v}`).join(', '),
        evidence: { want, keeper_has: pick(obs.keeper?.policy, ['bankAbove', 'maxCarry']) },
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
