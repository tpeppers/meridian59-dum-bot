// VALIDATION, AND ONE RULE ABOUT WHAT IT IS FOR.
//
// This does not check types for their own sake. It checks the handful of things whose
// wrongness is SILENT — a doctrine that is subtly wrong and runs anyway is worse than
// one that will not load, because it produces a fleet doing something plausible for
// several hours.
//
// The three that matter, in order:
//   * a fleet name, because acting on the wrong fleet is quiet and expensive;
//   * a claim on `survival` without the acknowledgement, because the failure mode is
//     a character standing still while something eats it;
//   * a ladder rung with no `until`, because that rung never completes and the
//     character farms it for ever while the board reports steady progress.
//
// Everything else here is a typo-catcher, which is worth having and is not the point.

// The one place config reaches into act/, and only for data. ORDER_FIELDS is the
// authoritative list of what DUM may set; duplicating the names here would let the two
// drift, and the drift is silent — a doctrine yielding a field this file has not heard
// of would be accepted and then not actually yielded.
import { ORDER_FIELDS } from '../act/orders.mjs';
import { weaponPreset, thresholdRank } from '../decide/weapons.mjs';
import { validateStrategyIds, validateStrategySettingsMap } from '../strategies/catalog.mjs';

const ORDER_FIELD_NAMES = new Set(Object.keys(ORDER_FIELDS));

const FACULTIES = ['identity', 'mortality', 'survival', 'recovery',
                   'work', 'movement', 'economy', 'social'];
const OWNERS = ['keeper', 'bot', 'off'];
const CRITERION_KINDS = ['max_health', 'level', 'skill', 'spell', 'shillings_banked', 'kills'];

const num = v => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {object} c effective configuration
 * @returns {{where: string, why: string}[]} empty when usable
 */
export function validate(c) {
  const bad = [];
  const say = (where, why) => bad.push({ where, why });

  if (c.fleet !== null && typeof c.fleet !== 'string')
    say('fleet', 'must be a fleet name, or null to mean "plan only, never commit"');

  // ---- the link
  if (typeof c.link?.control_url !== 'string' || !/^https?:\/\//.test(c.link.control_url))
    say('link.control_url', 'must be an http(s) URL for a broker that is already running');
  if (/^https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/.test(c.link?.control_url ?? ''))
    // Not fatal — someone may genuinely tunnel — but the harness's control surface is
    // loopback by design and holds account credentials behind it.
    say('link.control_url', 'points off loopback. The broker holds the roster, and the ' +
        'roster is the only record of the account passwords. Say so deliberately if you mean it');
  if (!num(c.link?.timeout_ms) || c.link.timeout_ms < 1000)
    say('link.timeout_ms', 'must be at least 1000 — travel is a multi-hop walk');
  if (!num(c.link?.calls_per_second) || c.link.calls_per_second <= 0)
    say('link.calls_per_second', 'must be a positive number of calls per second');
  try {
    const u = new URL(c.link?.strategy_control_url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
      say('link.strategy_control_url', 'must stay on loopback; it changes live unit strategies');
  } catch { say('link.strategy_control_url', 'must be an http URL on loopback'); }

  // ---- the claim
  for (const f of FACULTIES) {
    const owner = c.claim?.[f];
    if (!OWNERS.includes(owner))
      say(`claim.${f}`, `must be one of ${OWNERS.join(', ')}`);
  }
  const takesLife = ['survival', 'mortality'].filter(f => c.claim?.[f] === 'bot');
  if (takesLife.length && c.claim?.i_accept_the_character_may_die !== true)
    say(`claim.${takesLife[0]}`,
        `claiming ${takesLife.join(' and ')} takes the survival floor off the keeper. ` +
        `An unattended character — one whose bot has crashed or was never started — ` +
        `then stands still while something eats it. Set ` +
        `claim.i_accept_the_character_may_die: true in the doctrine if that is what you mean`);
  const off = FACULTIES.filter(f => c.claim?.[f] === 'off');
  if (off.includes('mortality'))
    say('claim.mortality', `'off' means nothing walks the character out of the Underworld, ` +
        `which has no graph exits — the character stays there for ever. Use 'keeper' or 'bot'`);
  if (!num(c.claim?.lease_ms) || c.claim.lease_ms < 10_000)
    say('claim.lease_ms', 'must be at least 10000. A lease shorter than a few ticks means ' +
        'the keeper takes its faculties back between DUM\'s own decisions');

  // ---- coexistence
  if (!Array.isArray(c.yield_to)) say('yield_to', 'must be a list of order-field names');
  else {
    const unknown = c.yield_to.filter(f => !ORDER_FIELD_NAMES.has(f));
    if (unknown.length)
      // A typo here is silent in the dangerous direction: the field is NOT yielded and
      // DUM writes it, against a supervisor that also writes it, and both logs look
      // correct while the character's orders oscillate.
      say('yield_to', `names ${unknown.join(', ')}, which are not order fields — so they ` +
          `would not actually be yielded. Valid: ${[...ORDER_FIELD_NAMES].join(', ')}`);
  }

  // ---- cadence
  for (const k of ['character_ms', 'fleet_ms', 'backoff_ms']) {
    if (!num(c.cadence?.[k]) || c.cadence[k] < 1000)
      say(`cadence.${k}`, 'must be at least 1000ms');
  }
  if (num(c.cadence?.fleet_ms) && num(c.cadence?.character_ms) &&
      c.cadence.fleet_ms < c.cadence.character_ms)
    say('cadence.fleet_ms', 'fleet decisions are slower than character decisions, not faster — ' +
        'every one of them stops keepers and walks characters across the world');

  // ---- the ladder
  const ladder = c.goals?.ladder;
  if (!Array.isArray(ladder)) say('goals.ladder', 'must be a list of rungs');
  else ladder.forEach((rung, i) => {
    const at = `goals.ladder[${i}]`;
    if (!rung?.id) say(`${at}.id`, 'every rung needs an id — it is what the journal records');
    if (!rung?.until)
      say(`${at}.until`, 'a rung with no completion test never completes, so the character ' +
          'farms it for ever while the board reports steady progress. This is the failure ' +
          'this check exists for');
    else if (!CRITERION_KINDS.includes(rung.until.kind))
      say(`${at}.until.kind`, `must be one of ${CRITERION_KINDS.join(', ')}`);
    else if (!num(rung.until.at_least))
      say(`${at}.until.at_least`, 'must be a number');
    if (!rung?.why)
      say(`${at}.why`, 'a rung without a reason is not finished — the reason is what the ' +
          'journal and `plan` show when the fleet is doing something strange');
  });

  // ---- prey and placement
  if (!num(c.prey?.max_threat_over) || c.prey.max_threat_over < 0)
    say('prey.max_threat_over', 'must be a non-negative number of levels');
  if (!Array.isArray(c.placement?.rooms)) say('placement.rooms', 'must be a list of room numbers');
  else if (c.placement.rooms.some(r => !Number.isInteger(r)))
    say('placement.rooms', 'room numbers are integers — names are not stable across a map rebuild');
  if (c.placement?.spread && !c.placement.rooms.length)
    say('placement.spread', 'spreading needs somewhere to spread to; placement.rooms is empty');
  if (!Number.isInteger(c.placement?.per_room) || c.placement.per_room < 1)
    say('placement.per_room', 'must be at least 1');

  // ---- the crate
  //
  // Only the settings whose wrongness is SILENT, which is the rule this whole file is
  // built on. Four of them are, and every one produces a fleet that looks like it works.
  if (c.crate?.check) {
    if (!Array.isArray(c.crate.zone) || !c.crate.zone.length ||
        c.crate.zone.some(r => !Number.isInteger(r)))
      say('crate.zone', 'must be a non-empty list of room numbers. An empty zone means no ' +
          'character is ever counted as being in the castle, so the rule declines for ever ' +
          'with a reason that is true and useless');
    if (!Number.isInteger(c.crate.quorum) || c.crate.quorum < 2)
      // The one that would look perfectly reasonable in a file. It is a mechanic, not a taste.
      say('crate.quorum', 'must be at least 2. The room refuses whoever found last, in ' +
          'silence, so a fleet that can only ever field one eligible character down there ' +
          'gets exactly one item and then nothing — while every later check goes on ' +
          'reporting a normal miss');
    if (!num(c.crate.probe_every_ms) || c.crate.probe_every_ms < 60_000)
      say('crate.probe_every_ms', 'must be at least 60000. Searching does not make the crate ' +
          'pay any sooner — the counter runs on its own clock — so a short interval buys ' +
          'nothing and keeps a character in a basement instead of in a fight');
    if (!num(c.crate.min_level) || c.crate.min_level < 30)
      say('crate.min_level', 'must be at least 30. Below that both crate squares are gated ' +
          'off by PFLAG_PKILL_ENABLE (dungeon.kod:134) and the room says NOTHING back, so a ' +
          'lower floor sends characters on a walk that cannot succeed and cannot report why');
    if (!num(c.crate.min_health) || c.crate.min_health < 0 || c.crate.min_health > 1)
      say('crate.min_health', 'must be a fraction between 0 and 1');
    if (!Number.isInteger(c.crate.square?.col) || !Number.isInteger(c.crate.square?.row))
      say('crate.square', 'must be {col, row}. walk_to takes col first and the kod states the ' +
          'crate as row 10, col 6 — transposing them walks to a real square that does nothing');
  }

  // ---- economy: nulls are meaningful and are not defaults
  for (const k of ['bank_above', 'walking_money', 'max_carry']) {
    const v = c.economy?.[k];
    if (v !== null && (!num(v) || v < 0))
      say(`economy.${k}`, 'must be a non-negative number, or null to leave the keeper\'s own value alone');
  }
  if (c.economy?.sell_loot !== null && typeof c.economy?.sell_loot !== 'boolean')
    say('economy.sell_loot', 'must be true, false, or null to leave the keeper\'s own value alone');

  // ---- weapon policy and optional staging provision
  try { weaponPreset(c.weapons?.preset, c.weapons?.presets); }
  catch (e) { say('weapons.preset', e.message); }
  if (c.weapons?.provision?.enabled || c.strategies?.defaults?.includes('create-weapons')) {
    try { thresholdRank(c.weapons.provision.threshold, c.weapons.preset, c.weapons.presets); }
    catch (e) { say('weapons.provision.threshold', e.message); }
    if (c.weapons.provision.staging_only !== false && !Number.isInteger(c.weapons.provision.room))
      say('weapons.provision.room', 'must be the staging-room number; provisioning never chases fighters');
    if (!num(c.weapons.provision.mana_cost) || c.weapons.provision.mana_cost < 1)
      say('weapons.provision.mana_cost', 'must be a positive mana cost');
  }

  try { validateStrategyIds(c.strategies?.defaults); }
  catch (e) { say('strategies.defaults', e.message); }
  try { validateStrategySettingsMap(c.strategies?.settings); }
  catch (e) { say('strategies.settings', e.message); }
  if (typeof c.strategies?.enabled !== 'boolean')
    say('strategies.enabled', 'must be true or false');

  if (!Number.isInteger(c.food?.min_items) || c.food.min_items < 0)
    say('food.min_items', 'must be a non-negative item count');
  if (!num(c.food?.mana_cost) || c.food.mana_cost < 1)
    say('food.mana_cost', 'must be a positive mana cost');

  if (c.castle_victoria?.shift) {
    const cv = c.castle_victoria;
    if (!Number.isInteger(cv.rooms?.downstairs) || !Number.isInteger(cv.rooms?.upstairs))
      say('castle_victoria.rooms', 'must name integer downstairs and upstairs room numbers');
    if (!num(cv.upstairs_share) || cv.upstairs_share <= 0 || cv.upstairs_share >= 1)
      say('castle_victoria.upstairs_share', 'must be a fraction strictly between 0 and 1');
  }

  return bad;
}

export { FACULTIES, OWNERS, CRITERION_KINDS, ORDER_FIELD_NAMES };
