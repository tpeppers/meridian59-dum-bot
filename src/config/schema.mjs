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
// Pure data: the tables the Duke's Feast Hall actually has, so a doctrine naming one it
// does not is refused here rather than failing "nothing here matches" in the hall.
import { dispenserNamed, FEAST_DISPENSER_NAMES } from '../decide/feast-hall.mjs';

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
import { HUNT_ROOMS } from '../strategies/catalog.mjs';
// One reader of the throttle's two spellings, so the schema and the rule cannot disagree
// about what 180 and 0.9 mean.
import { floorForThrottle } from '../decide/rules/throttle.mjs';
// The band reader and the hunt-list reader, imported rather than restated. A schema that
// parses a station differently from the rule that acts on it validates a doctrine nobody
// runs — and this is exactly the field where that would be silent, because a band the
// schema read one way and the shift read another still produces a fleet standing somewhere.
import { stationBand, huntList } from '../decide/rules/shift.mjs';

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
  // The ceiling the harness actually consults. Validated as a POSITIVE percentage rather
  // than a non-negative one: zero would refuse every fight, which reads as a broken keeper
  // rather than as a cautious policy, and 100 already means "nothing above my own level".
  // The ceiling the harness actually consults, in either shape.
  if (c.prey?.threat_ceiling !== undefined) {
    const tc = c.prey.threat_ceiling;
    if (!tc || typeof tc !== 'object' || !['percent', 'flat'].includes(tc.mode ?? 'percent'))
      say('prey.threat_ceiling', 'must be {mode:"percent"|"flat", value:N}');
    else if (!num(tc.value) || tc.value < 0 || ((tc.mode ?? 'percent') === 'percent' && tc.value <= 0))
      say('prey.threat_ceiling.value', (tc.mode === 'flat')
        ? 'a flat band is a non-negative number of levels above max health'
        : 'a percentage must be positive — 150 lets a character fight up to 1.5x its own level');
  }
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

  // ---- the Barloque sell circuit: validated only when it is on, and only for the ways it
  // would fail SILENTLY. An empty stop list is the load-bearing one — the rule declines with a
  // true, useless reason and no character ever sells.
  if (c.sellrun?.background != null && typeof c.sellrun.background !== 'boolean')
    say('sellrun.background', 'must be boolean');
  if (c.sellrun?.trigger?.food_empty != null && typeof c.sellrun.trigger.food_empty !== 'boolean')
    say('sellrun.trigger.food_empty', 'must be boolean');
  if (c.sellrun?.on) {
    if (!Array.isArray(c.sellrun.stops) || !c.sellrun.stops.length)
      say('sellrun.stops', 'must be a non-empty list of {room, merchant} stops. An empty list ' +
          'means the circuit is on but routes nowhere, so a heavy pack never sells and the rule ' +
          'declines for ever with a reason that is true and useless');
    else c.sellrun.stops.forEach((s, i) => {
      if (!Number.isInteger(s?.room))
        say(`sellrun.stops[${i}].room`, 'must be a room number — travel routes to it');
      if (typeof s?.merchant !== 'string' || !s.merchant.trim())
        say(`sellrun.stops[${i}].merchant`, 'must name the exact merchant. sell_all resolves it ' +
            'by name in the room, and selling is an allowlist — the wrong name finds nobody and ' +
            'sells nothing, in silence');
      if (s?.max_stack != null && (!Number.isInteger(s.max_stack) || s.max_stack < 1))
        say(`sellrun.stops[${i}].max_stack`, 'must be a positive integer, or null for no cap. ' +
            'The jeweler refuses a gem stack over 25 wholesale (bqmerch.kod:113), so that stop ' +
            'wants 25 — a wrong cap either refuses whole stacks or offers more than the merchant takes');
    });
    if (!num(c.sellrun.cooldown_ms) || c.sellrun.cooldown_ms < 60_000)
      say('sellrun.cooldown_ms', 'must be at least 60000. It is the per-character window that ' +
          'stops the errand re-firing every tick and marching a character to town for ever; a ' +
          'short one buys nothing but a character that lives in a shop');
    const mh = c.sellrun.trigger?.min_health;
    if (mh != null && (!num(mh) || mh < 0 || mh > 1))
      say('sellrun.trigger.min_health', 'must be a fraction between 0 and 1');
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

  // ---- the throttle: a number, or a floor that follows the larder
  //
  // Only the wrongness that is SILENT, as everywhere in this file. A bad number here does
  // not throw — it sets a vigor floor, and a floor is enforced by a character declining to
  // fight, which looks exactly like a quiet room.
  if (c.throttle != null) {
    const t = c.throttle;
    const okFloor = v => num(v) && Number(v) >= 0 && Number(v) <= 200;
    if (typeof t === 'object') {
      if (!okFloor(t.with_food))
        say('throttle.with_food', 'must be a vigor floor — a fraction of 200, or the number ' +
            'itself (180 and 0.9 mean the same thing)');
      if (!okFloor(t.no_food))
        say('throttle.no_food', 'must be a vigor floor for a character that has nothing to eat ' +
            'and nothing to cook. 80 is the resting cap and the last value that cannot deadlock');
      if (okFloor(t.with_food) && okFloor(t.no_food) &&
          floorForThrottle(t.no_food) > floorForThrottle(t.with_food))
        say('throttle', 'no_food is HIGHER than with_food, which idles exactly the characters ' +
            'this split exists to keep fighting — everything above the resting cap of 80 has ' +
            'to be eaten, so an empty larder cannot reach a higher floor than a full one');
      if (t.min_meals != null && (!Number.isInteger(t.min_meals) || t.min_meals < 1))
        say('throttle.min_meals', 'must be a positive count of meals that counts as fed');
    } else if (!okFloor(t)) {
      say('throttle', 'must be a vigor floor (0-200, or a fraction of 200), or ' +
          '{ with_food, no_food } to let it follow the larder');
    }
  }

  // ---- the Duke's Feast Hall
  if (c.feast?.on) {
    const f = c.feast;
    if (!Number.isInteger(f.min_items) || f.min_items < 1)
      say('feast.min_items', 'must be a positive meal count — a character with fewer aboard tops up');
    if (!Number.isInteger(f.max_hops) || f.max_hops < 0)
      say('feast.max_hops', 'must be a non-negative hop count from the hall (Tos is 3)');
    if (!Array.isArray(f.near_rooms) || f.near_rooms.some(r => !Number.isInteger(r)))
      say('feast.near_rooms', 'must be a list of room numbers, or empty to go by distance alone');
    // Optional, and absent means NOBODY. Checked for shape rather than for presence, because
    // the failure worth catching is a bare string where a list belongs, or a handle typed as
    // a number — either of which silently sends no one, which is the exact behaviour a
    // courier list is added to stop.
    if (f.couriers != null &&
        (!Array.isArray(f.couriers) || f.couriers.some(x => typeof x !== 'string')))
      say('feast.couriers', 'must be a list of agent handles or character names — the ones ' +
          'sent to the tables for the FLEET, whose own larder is not the test');
    if (!num(f.max_travel_ms) || f.max_travel_ms < 60_000)
      say('feast.max_travel_ms', 'must be at least 60000 — the longest walk a redirected supply trip may take');
    if (!num(f.min_health) || f.min_health < 0 || f.min_health > 1)
      say('feast.min_health', 'must be a fraction between 0 and 1');
    if (!Number.isInteger(f.max_in_flight) || f.max_in_flight < 1)
      say('feast.max_in_flight', 'must be a positive count of characters on the road at once');
    if (!Array.isArray(f.grab_from) || !f.grab_from.length || !f.grab_from.some(n => dispenserNamed(n)))
      say('feast.grab_from', `must name at least one table the hall actually has: ${FEAST_DISPENSER_NAMES.join(', ')}`);
    if (!Number.isInteger(f.max_grabs) || f.max_grabs < 1)
      say('feast.max_grabs', 'must be a positive number of activations per visit');
    if (!num(f.max_trip_ms) || f.max_trip_ms < 120_000)
      say('feast.max_trip_ms', 'must be at least 120000 — a journey unseen in the hall this long is given up');
    if (!num(f.cooldown_ms) || f.cooldown_ms < 60_000)
      say('feast.cooldown_ms', 'must be at least 60000. It is the per-character window that stops a ' +
                              'character living at the Duke\'s tables');
    if (!num(f.fail_backoff_ms) || f.fail_backoff_ms < 60_000)
      say('feast.fail_backoff_ms', 'must be at least 60000');
    if (typeof f.suspend_reagent_buying !== 'boolean')
      say('feast.suspend_reagent_buying', 'must be true or false');
  }

  if (c.castle_victoria?.shift) {
    const cv = c.castle_victoria;
    if (!Number.isInteger(cv.rooms?.downstairs) || !Number.isInteger(cv.rooms?.upstairs))
      say('castle_victoria.rooms', 'must name integer downstairs and upstairs room numbers');
    if (!num(cv.upstairs_share) || cv.upstairs_share < 0 || cv.upstairs_share > 1)
      say('castle_victoria.upstairs_share', 'must be a fraction from 0 through 1');
    // A quarry the room cannot generate is the silent failure this file exists to catch:
    // the character stands in its assigned room, reports itself healthy, and waits for
    // prey that will never spawn.
    const UPSTAIRS_GENERATES = ['battered skeleton', 'zombie'];
    // One name, or several to take whichever is in front of you. A name the room cannot
    // generate is the silent failure: the character stands in its assigned room reporting
    // itself healthy, waiting for prey that will never spawn.
    const quarry = cv.upstairs_quarry == null ? []
      : (Array.isArray(cv.upstairs_quarry) ? cv.upstairs_quarry : [cv.upstairs_quarry]);
    const unknown = quarry.filter(q => !UPSTAIRS_GENERATES.includes(q));
    if (unknown.length)
      say('castle_victoria.upstairs_quarry',
          `names ${unknown.join(', ')}, which room ${cv.rooms?.upstairs} does not ` +
          `generate — it makes only ${UPSTAIRS_GENERATES.join(' and ')}`);
    if (cv.zombie_only != null && !Array.isArray(cv.zombie_only))
      say('castle_victoria.zombie_only', 'must be a list of agent handles or character names');
  }

  // ---- the hunting shift
  //
  // Only the things whose wrongness is SILENT, which is this file's whole rule. A station
  // naming a room nobody has rated, or a quarry that room does not generate, produces a
  // character standing somewhere doing nothing and reporting itself healthy — the exact
  // failure the statues and the inert room knob both were.
  if (c.shift?.on === true) {
    const stations = Array.isArray(c.shift.stations) ? c.shift.stations : [];
    if (!stations.length)
      say('shift.stations', 'the shift is on and names no stations, so it will move nobody');
    stations.forEach((st, i) => {
      const where = `shift.stations[${i}]`;
      const room = HUNT_ROOMS[Number(st?.room)];
      if (!room) {
        say(where, `room ${st?.room} is not in HUNT_ROOMS. That table is the guard rail that ` +
          'keeps the fleet out of the level-150 rooms next to its hunting grounds, so a room ' +
          'is added there — with its threat and what it generates — rather than here');
        return;
      }
      // ONE NAME OR SEVERAL, AND EVERY ONE OF THEM IS CHECKED. A station naming a pair —
      // which room 39 wants, because its spawn cap is a room-wide TOTAL and a cohort that
      // declines the zombies standing next to it lets them hold the cap that would otherwise
      // have spawned more skeletons — used to fail this outright, since
      // `generates.includes([...])` is false for every array. So the pair was unsayable here
      // and had to live in the castle block instead.
      const hunts = huntList(st);
      if (!hunts.length)
        say(where, 'a station with no `hunt` puts a character in a room and tells it to kill ' +
          'nothing, which reads as a working assignment on every board');
      const cannot = hunts.filter(q => !room.generates.includes(q));
      if (cannot.length)
        say(where, `${room.name} does not generate ${cannot.map(q => `"${q}"`).join(', ')} — it makes ` +
          `${room.generates.join(' or ')}. A quarry a room cannot produce is a character ` +
          'hunting nothing, and the keeper will not say so because its own room check reads ' +
          'the spawn table, which lists placed-once residents for ever');
      // A MISSPELT TRAINING STYLE MUST FAIL HERE OR IT COSTS THE WHOLE ORDER. The harness
      // reports an unrecognised value rather than applying it, so the keeper would keep its
      // old style while every board showed the new doctrine — and DUM's own order diff
      // throws at the END of its loop, so one bad field discards every other field in the
      // same intent. That is the 2026-08-16 failure in orders.mjs, and it presents as a rule
      // firing every tick with nothing ever reaching the fleet.
      const styles = ['normal', 'short_sword', 'unarmed', 'alternate', 'alternate_on_improve'];
      if (st?.training_style !== undefined && !styles.includes(String(st.training_style)))
        say(`${where}.training_style`, `must be one of ${styles.join(', ')} — got ` +
          `"${st.training_style}". \`alternate_on_improve\` is the one to want: it flips ` +
          'between an exact short sword and bare hands only when an ability actually rises. ' +
          'Bare `alternate` flips per quarry, and the server needs 75 swings on ONE proficiency ' +
          'before any improvement can fire (SWINGS_PER_IMPROVE_CHECK, player.kod:100), so on ' +
          'prey that dies faster than that it trains nothing at all and says nothing about it');
      // BUFF_ALLIES IS AN OBJECT AND THE BROKER REFUSES A BARE `true`. Same trap as
      // training_style above: the harness reports an unrecognised value rather than applying
      // it, and DUM's order diff throws at the END of its loop, so one bad field discards
      // every other field in the same intent. A station that said `"buff_allies": true`
      // would silently stop deploying the room, the hunt and the training style with it.
      if (st?.buff_allies !== undefined && st.buff_allies !== null) {
        const b = st.buff_allies;
        if (typeof b !== 'object' || Array.isArray(b))
          say(`${where}.buff_allies`, 'must be null or an object like ' +
            '{ "enabled": true, "spells": ["super strength", "bless"] } — the broker takes ' +
            'a settings object, never a bare true');
        else {
          if (b.enabled !== true)
            say(`${where}.buff_allies.enabled`, 'must be true — the broker refuses an object ' +
              'that does not say so, because casting on an ally spends mana and two reagents ' +
              'a throw and being installed has to be a decision somebody made');
          if (b.spells !== undefined &&
              (!Array.isArray(b.spells) || b.spells.some(x => typeof x !== 'string')))
            say(`${where}.buff_allies.spells`, 'must be an array of spell names, ' +
              'e.g. ["super strength", "bless"]');
          if (b.gap_ms !== undefined && !(Number(b.gap_ms) > 0))
            say(`${where}.buff_allies.gap_ms`, 'must be a positive number of milliseconds');
        }
      }
      // A REQUIREMENT NOBODY CAN READ IS A STATION NOBODY ENTERS. `requires` is checked
      // against the skill list on the fleet row, so a malformed clause silently admits no
      // one — the same failure shape as a band with a hole in it, and just as quiet.
      for (const req of (st?.requires == null ? [] : [].concat(st.requires))) {
        if (!req || typeof req !== 'object' || Array.isArray(req)) {
          say(`${where}.requires`, 'each clause must be an object like ' +
            '{skill: "hammer wielding", at_least: 1}');
          continue;
        }
        // A string, or a LIST meaning "any of these". Graduating on hammer-or-axe-or-fencing
        // is one decision; writing it as three clauses would mean all three, which nobody
        // holds on the day they graduate.
        const names = req.skill == null ? [] : [].concat(req.skill);
        if (!names.length || names.some(n => typeof n !== 'string' || !n.trim()))
          say(`${where}.requires`, 'every clause needs a `skill` name, or a list of names ' +
            'meaning any one of them');
        for (const k of Object.keys(req))
          if (!['skill', 'at_least', 'below', 'why'].includes(k))
            say(`${where}.requires.${k}`, 'unknown key. A clause is {skill, at_least?, ' +
              'below?, why?} — `at_least` defaults to 1, which reads as "holds it at all"');
        for (const k of ['at_least', 'below'])
          if (req[k] !== undefined && !num(req[k]))
            say(`${where}.requires.${k}`, 'must be a number');
      }

      // A BAND THAT ADMITS NOBODY IS AN EMPTY ROOM WITH ORDERS IN IT.
      const b = st?.max_health;
      if (b !== undefined) {
        if (!b || typeof b !== 'object' || Array.isArray(b))
          say(`${where}.max_health`, 'must be {at_least: N} or {below: N} or both — the band of ' +
            'max health this station is for');
        else {
          for (const k of Object.keys(b))
            if (!['at_least', 'below'].includes(k))
              say(`${where}.max_health.${k}`, 'unknown band bound. `at_least` is inclusive and ' +
                '`below` is exclusive, which is what lets two stations tile a range with no gap ' +
                'and no overlap at the boundary');
          const lo = b.at_least, hi = b.below;
          if (lo !== undefined && !num(lo)) say(`${where}.max_health.at_least`, 'must be a number');
          if (hi !== undefined && !num(hi)) say(`${where}.max_health.below`, 'must be a number');
          if (num(lo) && num(hi) && lo >= hi)
            say(`${where}.max_health`, `at_least ${lo} and below ${hi} admit nobody, so this ` +
              'station is a room with orders in it and no characters — and the fleet would ' +
              'quietly pile into whichever station is left');
        }
      }
      // A NIGHT ROOM WITHOUT `when` IS THE EXPENSIVE MISTAKE. The undead generators make
      // nothing for 85 minutes in every 120, so a station on one without a gate parks a
      // shift in an empty field for most of the day and looks fine doing it.
      if (room.night_only && String(st?.when ?? '').toLowerCase() !== 'night')
        say(where, `${room.name} generates nothing outside its 35-minute window, so this ` +
          'station needs `"when": "night"` or it will stand in an empty field for most of ' +
          'every cycle');
      if (st?.when != null && !['night', 'day', 'always'].includes(String(st.when).toLowerCase()))
        say(where, `unknown \`when\` "${st.when}" — use night, day, or leave it out`);
      if (st?.share != null && !(Number(st.share) >= 0 && Number(st.share) <= 1))
        say(where, '`share` is a fraction between 0 and 1');
      if (st?.max != null && !(Number.isInteger(Number(st.max)) && Number(st.max) >= 0))
        say(where, '`max` is a whole number of characters');
    });

    // A HOLE BETWEEN TWO BANDS IS THE SILENT ONE, AND IT IS WHY THIS CHECK EXISTS.
    //
    // The bands decide where a character works. A character no band admits is left unplaced
    // with `roam: false`, which means it stands wherever it is, indefinitely, hunting a
    // creature that does not spawn there — not stalled, not flagged, and reporting itself
    // healthy the entire time. That is the same failure `station.recall` was written for and
    // it would arrive here through a typo: `{below: 50}` and `{at_least: 51}` looks like a
    // pair and leaves everybody at exactly 50 with nowhere to go.
    //
    // Only checked when SOME station declares a band. A doctrine with no bands has the old
    // behaviour, where an unbanded station admits whoever its ceiling allows, and there is
    // no range to cover.
    // A TIER IS NOT A BAND. A station gated on `requires` is excluded from the coverage
    // check below: bands must tile the whole max-health range because a character in no
    // band stands still for ever, but a tier is a graduation only some characters have
    // reached, and demanding it cover a range would make every tiered doctrine unloadable.
    //
    // What still has to be true is that SOMEBODY takes the ungraduated. One station with no
    // `requires` is the floor, and a doctrine without one is refused here rather than
    // discovered later as a character standing in a field.
    const tiered = stations.filter(st => st.requires != null);
    if (tiered.length && !stations.some(st => st.requires == null))
      say('shift.stations', 'every station is gated on `requires`, so a character that has ' +
        'graduated nothing is admitted by none of them and stands where it is for ever with ' +
        'roaming off. Leave one station ungated as the floor.');
    const banded = stations.filter(st => stationBand(st) != null && st.requires == null);
    if (banded.length && banded.length === stations.length) {
      // Walk the boundaries in order and look for a value nothing claims. The bands are
      // half-open [at_least, below), so the only places a hole can start are 0 and each
      // `below`; anything above the last band's ceiling is a hole too.
      const claims = banded.map(st => stationBand(st));
      const edges = [0, ...claims.flatMap(b => [b.at_least, b.below].filter(v => v != null))]
        .filter(v => Number.isFinite(v)).sort((x, y) => x - y);
      const covered = v => claims.some(b =>
        (b.at_least == null || v >= b.at_least) && (b.below == null || v < b.below));
      const holes = [...new Set(edges)].filter(v => !covered(v));
      const openTop = !claims.some(b => b.below == null);
      if (holes.length)
        say('shift.stations', `no station admits max health ${holes.join(', ')}. A character ` +
          'in no band is left unplaced with roaming off, so it stands where it is for ever ' +
          'hunting something that does not spawn there — and reports itself healthy while it ' +
          'does. `at_least` is inclusive and `below` is exclusive, so {below: N} and ' +
          '{at_least: N} are the pair that tiles cleanly');
      if (openTop)
        say('shift.stations', 'every station has a `below`, so a character that grows past the ' +
          'highest one falls out of the shift entirely. The top band is the one you are ' +
          'willing to leave people in: give it `at_least` and no `below`');
    }
  }

  return bad;
}

export { FACULTIES, OWNERS, CRITERION_KINDS, ORDER_FIELD_NAMES };
