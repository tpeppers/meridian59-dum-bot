// AN INTENT IS DESIRED STATE. THIS IS THE ONLY PLACE THAT TURNS IT INTO A WRITE.
//
// Two things happen here and both of them are about not sending things.
//
// THE DIFF. An intent says what the keeper's policy should be; this compares it with
// what the keeper's policy already IS and sends only the fields that differ. A DUM
// that re-asserted the same policy every thirty seconds would look identical to one
// that was working, and would be quietly harmful in two ways: every write lands in the
// persisted roster, and a value written explicitly stops tracking the harness's own
// default for ever. The harness records exactly that trap — a default it changed,
// restarted, and found every live keeper still reporting the old value, because each
// keeper's policy is persisted with the roster and restored on restart.
//
// THE TRANSLATION. The keeper's policy object is camelCase (`bankAbove`) and the MCP
// argument is snake_case (`bank_above`). They are the same field and nothing else in
// this repository should have to know that. Getting it wrong is silent in the worst
// direction: a diff against a key that does not exist reads as "always different", so
// the bot writes every tick and reports success.

/**
 * The fields DUM may set, with the keeper-policy key each corresponds to.
 *
 * Adding a row here is the deliberate act of widening what a doctrine can change.
 * A field with no keeper-policy counterpart cannot be diffed and so is sent every
 * time — which is why `action` and `why` are handled separately below rather than
 * being listed as ordinary fields.
 */
import { runErrand } from './errands.mjs';
import { applyFleetPlan } from './fleet-plan.mjs';

export const ORDER_FIELDS = {
  mode:              { policy: null, note: 'lives on the keeper itself, not its policy' },
  hunt:              { policy: 'hunt' },
  strategy:          { policy: 'strategy' },
  purpose:           { policy: 'purpose' },
  assigned_room:     { policy: 'assignedRoom' },
  max_bots_per_safe_spot: { policy: 'maxBotsPerSafeSpot' },
  partner:           { policy: 'partner' },
  rest_below:        { policy: 'restBelow' },
  flee_below:        { policy: 'fleeBelow' },
  max_carry:         { policy: 'maxCarry' },
  max_weapons:       { policy: 'maxWeapons' },
  buy_food:          { policy: 'buyFood' },
  buy_weapons:       { policy: 'buyWeapons' },
  buy_reagents:      { policy: 'buyReagents' },
  bank_above:        { policy: 'bankAbove' },
  walking_money:     { policy: 'walkingMoney' },
  sell_at_load:      { policy: 'sellAtLoad' },
  sell_when_broke:   { policy: 'sellWhenBroke' },
  sell_when_broke_under: { policy: 'sellWhenBrokeUnder' },
  sell_when_broke_stacks: { policy: 'sellWhenBrokeStacks' },
  // FIGHT ON THE INKY RESERVE. `economy-thresholds` has emitted both of these since the
  // strategy was added, and both were missing here — which is not the harmless half of the
  // failure this table's comment describes. The throw is at the END of the diff loop, so
  // ONE unknown field discards the WHOLE intent, every other threshold in it included. So
  // `max_carry` never reached the keeper, the rule saw drift again on the next tick, and
  // re-fired for ever.
  //
  // Measured on the live fleet 2026-08-16: 6,126 economy-thresholds intents in one day and
  // 6,126 "not in ORDER_FIELDS" errors — one per intent, none of them ever sent. Character
  // rules are FIRST-MATCH-WINS and economy sits above the ladder, so `ladder` and
  // `placement` produced ZERO intents across two days: DUM held work, movement and economy
  // on twenty-one characters and issued not one work order the whole time, while the
  // journal showed a rule firing every tick and the board looked like a managed fleet.
  //
  // The harness has accepted both arguments the whole time (m59-broker.mjs `inky_reserve`,
  // `inky_reserve_floor` -> `policy.inkyReserve`, `policy.inkyReserveFloor`), so this was
  // only ever the missing half of a two-file change.
  inky_reserve:       { policy: 'inkyReserve' },
  inky_reserve_floor: { policy: 'inkyReserveFloor' },
  roam:              { policy: 'roam' },
  roam_limit:        { policy: 'roamLimit' },
  weapon_priority:   { policy: 'weaponPriority', compare: sameList },
  drop_junk:         { policy: 'dropJunk' },
  use_safe_spots:    { policy: 'useSafeSpots' },
  hold_resume_above: { policy: 'holdResumeAbove' },
  fight_above_vigor: { policy: 'fightAboveVigor' },
  pull_within:       { policy: 'pullWithin' },
  decide_ms:         { policy: 'decideMs' },
  resync_ms:         { policy: 'resyncMs' },
  max_threat_over:   { policy: 'maxThreatOver' },
  // The engagement ceiling, as a percentage of max health. Supersedes max_threat_over,
  // which the harness still accepts and no longer consults — a flat number of levels is a
  // different bet at each end of a roster, and this one is the same everywhere.
  threat_ceiling:    { policy: 'threatCeiling', compare: sameObject },
  break_out_via_logoff: { policy: 'breakOutViaLogoff' },
  vault_items:        { policy: 'vaultItems', compare: sameList },
  protect_items:      { policy: 'protectedItems', compare: sameList },
  strategy_stats:     { policy: 'strategyStats', compare: sameObject },
  farm_cleanup:       { policy: 'farmCleanup', compare: sameObject },
  farm_delivery:      { policy: 'farmDelivery', compare: sameObject },
  guild_tithe:        { policy: 'guildTithe', compare: sameObject },
};

function sameList(a, b) {
  const norm = v => Array.isArray(v) ? v.map(String) : (v == null ? [] : [String(v)]);
  const x = norm(a), y = norm(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

function sameObject(a, b) {
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const ordered = value => Object.fromEntries(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)));
  return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
}

const same = (a, b) => (a === b) || (a == null && b == null);

/**
 * What of this intent actually needs sending.
 *
 * @param {object} intent  from decide()
 * @param {object} obs     the observation the intent was decided from
 * @param {object} [opts]
 * @param {string[]} [opts.yieldTo] fields something else owns; dropped and reported
 * @returns {{send: object|null, unchanged: object, yielded: object, unknown: string[], why: string}}
 */
export function planOrders(intent, obs, { yieldTo = [] } = {}) {
  // NO POLICY MEANS NO DIFF, AND NO DIFF MEANS DO NOT SEND.
  //
  // The keeper's policy is not on the free fleet board — only `status` carries it — so
  // an observation that was never deepened has `policy: null`. Falling back to `{}`
  // here would make every field read as "different", so the bot would write every
  // setting on every tick and report success each time. That is the exact silent
  // failure the diff exists to prevent, so it is refused rather than defaulted.
  if (!obs.keeper?.policy)
    throw new Error(`cannot diff orders for ${intent.agent}: this observation came from ` +
                    `the fleet board (depth=${obs.depth ?? 'unknown'}), which does not carry the ` +
                    `keeper's policy. Deepen it with status first — see src/sense/observe.mjs`);
  const live = obs.keeper.policy;
  const liveMode = obs.keeper?.mode ?? null;
  const send = {};
  const unchanged = {};
  const yielded = {};
  const unknown = [];
  const yieldSet = new Set(yieldTo);

  for (const [k, v] of Object.entries(intent.orders ?? {})) {
    if (k === 'action' || k === 'why' || k === 'batch') continue;
    const spec = ORDER_FIELDS[k];
    if (!spec) { unknown.push(k); continue; }
    // YIELDED BEFORE DIFFED, so the journal records the field as deliberately not
    // ours rather than as agreeing by coincidence. Those are different facts: one
    // stays true when the other writer changes its mind.
    if (yieldSet.has(k)) { yielded[k] = v; continue; }
    if (k === 'mode') {
      if (same(liveMode, v)) unchanged[k] = v; else send[k] = v;
      continue;
    }
    const current = live[spec.policy];
    const equal = spec.compare ? spec.compare(current, v) : same(current, v);
    if (equal) unchanged[k] = v; else send[k] = v;
  }

  if (unknown.length)
    // Loud rather than dropped. A rule emitting a field this file has never heard of
    // is a rule that believes it is configuring something and is not.
    throw new Error(`rule "${intent.rule}" wants to set ${unknown.join(', ')}, which is not ` +
                    `in ORDER_FIELDS. Add it there — with the keeper-policy key it maps to — ` +
                    `or the setting is silently discarded`);

  if (!Object.keys(send).length)
    return {
      send: null, unchanged, yielded, unknown,
      why: Object.keys(yielded).length
        ? `nothing left to send: ${Object.keys(yielded).join(', ')} ` +
          `${Object.keys(yielded).length === 1 ? 'is' : 'are'} yielded to another writer, ` +
          `and the keeper already has the rest`
        : 'the keeper already has these orders',
    };

  return {
    send: { agent: intent.agent, action: intent.orders.action ?? 'start', ...send },
    unchanged, yielded, unknown,
    why: intent.why,
  };
}

/**
 * Apply an intent. Returns a record of what happened, whether or not anything was sent.
 *
 * `report` and `none` intents never send. They exist because most of what a directional
 * bot concludes is "leave this alone" or "somebody should look at this", and both are
 * findings that belong in the journal rather than silence.
 */
export async function apply(broker, intent, obs, { commit = false, yieldTo = [], holder = null } = {}) {
  if (!intent) return { acted: false, kind: 'idle' };
  if (intent.kind === 'none' || intent.kind === 'report')
    return { acted: false, kind: intent.kind, why: intent.why, evidence: intent.evidence };

  // AN ERRAND IS A SEQUENCE, NOT A POLICY, so none of the diffing below applies: there
  // is no current value of "has this character been to the basement" to compare against.
  // What stops it being re-issued every tick is the emitting rule's own memory rather
  // than this file's diff — see the note at the top of src/act/errands.mjs, because that
  // substitution is the one thing about errands that can go quietly wrong.
  if (intent.kind === 'errand') return runErrand(broker, intent, { commit, holder });
  if (intent.kind === 'act') return applyFleetPlan(broker, intent, { commit });

  // A BATCH IS INDIVISIBLE IN INTENT AND NOT IN EXECUTION, and saying so is better than
  // pretending. Pairing writes both sides; if the second write fails the fleet is left
  // with a one-sided pairing, which is the exact failure pairing is meant to heal. The
  // caller gets both results and the verifier checks both.
  if (intent.orders?.batch) {
    const results = [];
    for (const one of intent.orders.batch) {
      const r = await broker.write('autopilot', one, { why: intent.why })
        .catch(e => ({ error: e.message, args: one }));
      results.push(r);
    }
    const failed = results.filter(r => r?.error);
    return {
      acted: true, kind: 'batch', sent: intent.orders.batch, results,
      partial: failed.length > 0 && failed.length < results.length,
      why: intent.why,
    };
  }

  const { send, unchanged, yielded, why } = planOrders(intent, obs, { yieldTo });
  if (!send) return { acted: false, kind: 'no-change', unchanged, yielded, why };

  if (!commit) {
    const r = await broker.write('autopilot', send, { why });
    return { acted: false, kind: 'dry-run', sent: send, unchanged, yielded, result: r, why };
  }
  const result = await broker.call('autopilot', send);
  return { acted: true, kind: 'orders', sent: send, unchanged, yielded, result, why };
}
