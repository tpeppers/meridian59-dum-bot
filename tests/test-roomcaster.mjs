// THE POSTED CASTER — offline, no broker, no server, no clock.
//
// Every rule here is a pure decision over a board row, so every case is a fixture. What is
// pinned, in order of how expensive being wrong would be:
//
//   * A DOCTRINE THAT CLAIMS work OR movement IS REFUSED AT LOAD. That is the whole feature:
//     the keeper only keeps a room enchantment up while nobody else is steering, so claiming
//     either one switches the post off with every log on both sides reading correct.
//   * `caster-post` CONVERGES. A maintenance rule sitting above work that cannot agree with
//     the keeper wins the match every tick and starves every rule below it — twice in this
//     repository's recorded history, once for two days.
//   * UNKNOWN IS NOT ZERO. A board row with no pack must not send a 20-health character
//     across the world to buy reagents he is already carrying.
//   * THE BINDING REAGENT IS NAMED. 3 elderberry against 94 emeralds is ONE cast and reads
//     as well stocked to anything that sums.
//   * THE RESCUE REMEMBERS IT WAS CAST. It lands 15-25s later, so the trigger stays true for
//     the whole delay; without the memory it re-casts every tick at one emerald a throw.
//   * THE WAY HOME IS `always`. An errand that leaves this character in a shop is worse than
//     one that failed — his keeper then makes reasonable decisions about a room nobody chose.
//   * A restock target at or below the trip's own floor is refused: it is a trip that cannot
//     fix what opened it, and every lap reports success.

const test = globalThis.__dumTest;

import { roomCasterRules, castsOnHand, spendableEmeralds, posture, agreesOn,
         recordCasterResupply, recordCasterRescue, coolingDown, rescuePending, unpinned,
         stillHoldingHandOff, handOffBlocking,
         shortOfReagents, FORCES_OF_LIGHT, RESCUE,
         ROOM_CASTER_TOPIC, RESCUE_WINDOW_MS, RESCUE_CAST_TIMEOUT_MS,
         RESCUE_LANDING_MS } from '../src/decide/rules/roomcaster.mjs';
import { isDoctrineDestination } from '../src/decide/rules/station.mjs';
import { bindBuyLines, ERRANDS } from '../src/act/errands.mjs';
import { ORDER_FIELDS, planOrders } from '../src/act/orders.mjs';
import { validate } from '../src/config/schema.mjs';
import { DEFAULTS } from '../src/config/defaults.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const [post, rescueOut, resupply, returnHome] = roomCasterRules;

const ROOM = 38;
const ARMED = {
  room_caster: { on: true, agent: 'acct08', room: ROOM, spell: 'forces of light',
                 margin_ms: 8000, mana_floor: 19, rest_below: 0.5, flee_below: 0.9,
                 restock_below_casts: 10, restock_to_casts: 60, emerald_reserve: 2,
                 rescue: true, min_health: 1, min_bulk_free: 40 },
  claim: { work: 'keeper', movement: 'keeper', economy: 'bot' },
};

/** A pack with `casts` castings' worth of both halves aboard. */
const stocked = (casts, over = {}) => [
  { name: 'elderberry', amount: casts * 2, tag: 1 },
  { name: 'emerald', amount: casts * 1 + (over.spareGems ?? 4), tag: 1 },
  { name: 'shilling', amount: 4000, tag: 1 },
];

const caster = (over = {}) => ({
  // A NATO fixture name, not the live one. `tools/dum-guard.mjs` matches a roster's character
  // names EVERYWHERE, source included, and "it is only a test fixture" is exactly the
  // reasonable-sounding exception that check exists so that nobody has to weigh.
  agent: 'acct08', character: 'Alpha', in_game: true,
  room: ROOM, at: 1_000_000,
  health: { value: 20, max: 20 }, mana: { value: 65, max: 65 }, purse: 4000,
  pack_items: stocked(60),
  commitment: null, piloted: null,
  memory: {},
  keeper: { mode: 'idle', policy: liveFor() },
  ...over,
});

/** The keeper policy a converged post has. Built from `posture` so the two cannot drift. */
function liveFor(overrides = {}) {
  const want = posture(ARMED);
  return {
    assignedRoom: want.assigned_room, confineRooms: want.confine_rooms, roam: want.roam,
    useSafeSpots: want.use_safe_spots, restBelow: want.rest_below, fleeBelow: want.flee_below,
    roomEnchant: { ...want.room_enchant, assume_ability: 63 },
    acceptDonations: { ...want.accept_donations },
    protectedItems: want.protect_items, buyReagents: want.buy_reagents,
    ...overrides,
  };
}

// ------------------------------------------------------------------ the load-time refusal

test('caster: a doctrine that claims work or movement is REFUSED, and the message says why', () => {
  const bad = { ...DEFAULTS, ...ARMED, name: 'x', fleet: 'f',
                claim: { ...DEFAULTS.claim, work: 'bot', movement: 'bot' } };
  const problems = validate(bad);
  const hit = problems.find(p => /isRoomEnchantPost/.test(String(p.why ?? p)));
  ok(hit, 'the claim check fired');
  ok(/silently/i.test(String(hit.why ?? hit)),
     'and it says the failure is silent, which is the entire reason it exists');
});

test('caster: the doctrine this ships with passes validation', () => {
  const good = { ...DEFAULTS, ...ARMED, name: 'x', fleet: 'f',
                 claim: { ...DEFAULTS.claim, work: 'keeper', movement: 'keeper', economy: 'bot' } };
  eq(validate(good).length, 0, 'no problems: ' + JSON.stringify(validate(good)));
});

test('caster: a restock target at or below the trip floor is refused', () => {
  const bad = { ...DEFAULTS, ...ARMED, name: 'x', fleet: 'f',
                claim: { ...DEFAULTS.claim, work: 'keeper', movement: 'keeper', economy: 'bot' },
                room_caster: { ...ARMED.room_caster, restock_below_casts: 20, restock_to_casts: 20 } };
  ok(validate(bad).some(p => /sets out again immediately/.test(String(p.why ?? p))),
     'a trip that cannot fix what opened it is refused at load');
});

test('caster: `on` with no room is refused — there is no room to guess', () => {
  const bad = { ...DEFAULTS, ...ARMED, name: 'x', fleet: 'f',
                claim: { ...DEFAULTS.claim, work: 'keeper', movement: 'keeper', economy: 'bot' },
                room_caster: { ...ARMED.room_caster, room: null } };
  ok(validate(bad).some(p => p.where === 'room_caster.room'), 'refused');
});

// ------------------------------------------------------------------ counting

test('caster: the BINDING reagent is named, not the deepest one', () => {
  // The pair is unbalanced in practice and the scarce half is not the one anybody watches.
  const row = { pack_items: [{ name: 'elderberry', amount: 6 }, { name: 'emerald', amount: 94 }] };
  const s = castsOnHand(row, FORCES_OF_LIGHT.lines);
  eq(s.casts, 3, 'three casts, bound by the berries');
  eq(s.binding.join(','), 'elderberry', 'and it says which half is binding');
});

test('caster: the kod spells it "ElderBerry" and the counter may say "Elder Berry"', () => {
  const row = { pack_items: [{ name: 'ElderBerry', amount: 10 }, { name: 'Emerald', amount: 10 }] };
  eq(castsOnHand(row, FORCES_OF_LIGHT.lines).casts, 5, 'matched regardless of spelling');
});

test('caster: UNKNOWN IS NOT ZERO — a board row with no pack does not open a shopping trip', () => {
  const s = castsOnHand({}, FORCES_OF_LIGHT.lines);
  eq(s.known, false, 'not known');
  eq(s.casts, null, 'and not zero');
  const short = shortOfReagents({}, {}, ARMED);
  ok(short.pass, 'said out loud rather than silently treated as stocked');
  ok(/not the same as none/.test(short.why), 'and it says which of the two it is');
  eq(resupply.decide(caster({ pack_items: null, memory: {} }), ARMED).kind, 'pass',
     'so no trip is dispatched');
});

test('caster: the emerald reserve is what keeps the trip possible, so it is not spendable', () => {
  const row = { pack_items: [{ name: 'emerald', amount: 3 }] };
  eq(spendableEmeralds(row, ARMED), 1, 'three gems, a reserve of two, one to spend');
  eq(spendableEmeralds({}, ARMED), null, 'and an unread pack is null, never zero');
});

// ------------------------------------------------------------------ the posture

test('caster: the posture asks for a safe spot, the enchantment, and donations', () => {
  const want = posture(ARMED);
  eq(want.mode, 'idle', 'idle is what isRoomEnchantPost tests by name');
  eq(want.use_safe_spots, true, 'the flag that buys takeRecoverySpot');
  eq(want.roam, false, 'a post does not wander');
  eq(want.assigned_room, ROOM);
  eq(JSON.stringify(want.confine_rooms), JSON.stringify([ROOM]));
  eq(want.room_enchant.spells.join(','), 'forces of light');
  eq(want.accept_donations.enabled, true, 'the fleet may hand him reagents unasked');
  eq(JSON.stringify(want.accept_donations.drop_for_space), '[]',
     'and he puts NOTHING down to make room — he carries the collection');
  eq(JSON.stringify(want.protect_items), JSON.stringify(['elderberry', 'emerald']),
     'a sell pass takes the gems first, and the gems are what make the trip possible');
  eq(want.buy_reagents, false,
     "the keeper's own reagent buying goes to one apothecary and never buys a gem");
});

test('caster: `caster-post` CONVERGES — the whole table depends on it', () => {
  // A maintenance rule above work that cannot agree with the keeper wins the match every
  // tick and starves everything below it. Measured twice on this fleet: 6,126 intents in
  // one day, none sent, `ladder` and `placement` silent for two days.
  eq(post.decide(caster(), ARMED), null, 'agrees, and returns null rather than an empty send');
});

test('caster: it converges THROUGH the harness normalising what it stored', () => {
  // The broker lowercases names, floors numbers and drops keys it was not given. A
  // whole-object compare against what comes back therefore never agrees.
  const live = liveFor({
    roomEnchant: { enabled: true, spells: ['Forces Of Light'], margin_ms: 8000,
                   mana_floor: 19, assume_ability: 63 },
    acceptDonations: { enabled: true, reagents: ['ELDERBERRY', 'Emerald'],
                       drop_for_space: [], min_bulk_free: 40 },
    protectedItems: ['Elderberry', 'EMERALD'],
  });
  eq(post.decide(caster({ keeper: { mode: 'idle', policy: live } }), ARMED), null,
     'still agrees');
});

test('caster: a FRACTION is compared as a fraction — 0.85 and 0.5 are not the same line', () => {
  // The first draft of `agreesOn` floored numbers, on the reasoning that the broker floors
  // its millisecond and count fields. `rest_below` and `flee_below` are fractions of max
  // health, so flooring made every value between 0 and 1 identical and the rule reported
  // converged against a caster still holding a farmer's flee line. Caught on the live fleet
  // within a minute of shipping, which is the only reason it is a test and not a bug.
  const farmerish = liveFor({ restBelow: 0.85, fleeBelow: 0.45 });
  const out = post.decide(caster({ keeper: { mode: 'idle', policy: farmerish } }), ARMED);
  eq(out.kind, 'orders', 'the disagreement is seen');
  eq(out.orders.rest_below, 0.5);
  eq(out.orders.flee_below, 0.9);
  ok(!agreesOn(farmerish, { rest_below: 0.5 }, { rest_below: 'restBelow' }), 'and directly');
});

test('caster: a keeper that disagrees about ONE key gets the whole posture', () => {
  const live = liveFor({ useSafeSpots: false });
  const out = post.decide(caster({ keeper: { mode: 'idle', policy: live } }), ARMED);
  eq(out.kind, 'orders', 'an order is emitted');
  eq(out.orders.use_safe_spots, true, 'with the flag that was wrong');
  eq(out.orders.action, 'start', 'and start, which inherits the live policy keeper-side');
});

test('caster: a keeper in the wrong MODE is corrected — idle is a precondition', () => {
  const out = post.decide(caster({ keeper: { mode: 'farm', policy: liveFor() } }), ARMED);
  eq(out.kind, 'orders');
  eq(out.orders.mode, 'idle');
});

test('caster: every field the posture emits is routable by planOrders', () => {
  // THE TWO-FILE CHANGE THIS REPOSITORY HAS PAID FOR. `planOrders` throws on an
  // unrecognised key at the END of the diff loop, so one missing row discards the WHOLE
  // intent — and the emitting rule's own test goes on passing.
  for (const key of Object.keys(posture(ARMED)))
    ok(ORDER_FIELDS[key], `${key} is in ORDER_FIELDS`);
});

test('caster: planOrders sends nothing when the keeper already has the posture', () => {
  const obs = caster();
  const intent = { rule: 'caster-post', agent: 'acct08',
                   orders: { action: 'start', ...posture(ARMED) }, why: 'x' };
  const plan = planOrders(intent, { keeper: { policy: liveFor(), mode: 'idle' } });
  eq(plan.send, null, 'nothing to send: ' + JSON.stringify(plan.send));
  ok(obs, 'fixture used');
});

test('caster: a field the OPERATOR has pinned is dropped from both halves', () => {
  // The engine strips pinned keys at the SENDING end (`filterCall`), which is too late:
  // first-match-wins happens before the send, so a rule that kept its opinion about a pinned
  // field would fire every tick against a keeper that can never be made to agree — and
  // starve the walk home, which is the rule directly below it.
  //
  // Alfa is the live case: releasing an operator room lock writes `confine_rooms: []` to the
  // keeper and leaves the pin in place.
  const pinned = { human_controls: { acct08: { confine_rooms: [] } } };
  const live = liveFor({ confineRooms: [] });
  eq(post.decide(caster({ ...pinned, keeper: { mode: 'idle', policy: live } }), ARMED), null,
     'agrees about everything it still owns');
  // And without the drop it would never converge, which is the whole point.
  ok(post.decide(caster({ keeper: { mode: 'idle', policy: live } }), ARMED)?.kind === 'orders',
     'unpinned, the same disagreement is real');
  eq(JSON.stringify(Object.keys(unpinned({ mode: 'idle', confine_rooms: [38] },
                                         { agent: 'acct08', ...pinned }))),
     JSON.stringify(['mode']), 'only the pinned key goes');
});

test('caster: the post does not THROW when the pinned field is the one it talks about', () => {
  // Measured on the live fleet: the operator overlay pinned `room_enchant`, `unpinned` dropped
  // it, and the rule's own `why` read `want.room_enchant.spells` — so `caster-post` threw on
  // every tick. The engine catches a throwing rule and carries on, so nothing broke loudly:
  // the walk home still happened and the only sign was one `error` line in `considered`.
  const pinned = { human_controls: { acct08: { room_enchant: true, mode: true } } };
  const live = liveFor({ confineRooms: null });
  const out = post.decide(caster({ ...pinned, keeper: { mode: 'farm', policy: live } }), ARMED);
  eq(out.kind, 'orders', 'it still fires for the fields it does own');
  ok(!Object.hasOwn(out.orders, 'room_enchant'), 'without the pinned one');
  ok(!Object.hasOwn(out.orders, 'mode'), 'or the pinned mode, even against a farm keeper');
  eq(JSON.stringify(out.orders.confine_rooms), JSON.stringify([ROOM]), 'and with the one it does');
  ok(typeof out.why === 'string' && out.why.length > 0, 'and it can still say why');
});

test('caster: a post whose every field is pinned passes rather than taking the turn', () => {
  const all = Object.fromEntries(Object.keys(posture(ARMED)).map(k => [k, true]));
  const out = post.decide(caster({ human_controls: { acct08: all } }), ARMED);
  eq(out.kind, 'pass');
  ok(/nothing left for this rule to own/.test(out.why));
});

test('caster: a piloted body is left alone, and the pass SAYS so', () => {
  const out = post.decide(caster({ commitment: { kind: 'pilot', takeable: false } }), ARMED);
  eq(out.kind, 'pass', 'not an order');
});

test('caster: a board row with no keeper policy is a `pass`, never a diff against {}', () => {
  const out = post.decide(caster({ keeper: { mode: 'idle', policy: null }, policy: null }), ARMED);
  eq(out.kind, 'pass');
  ok(/no keeper policy/.test(out.why), 'and it says which of the two it is');
});

test('caster: everything is off until a doctrine arms it', () => {
  for (const rule of roomCasterRules)
    eq(rule.enabled({ room_caster: { on: false } }), false, `${rule.id} is off`);
});

test('caster: a doctrine that names a different agent does not touch this one', () => {
  const elsewhere = { ...ARMED, room_caster: { ...ARMED.room_caster, agent: 'acct04' } };
  for (const rule of roomCasterRules)
    eq(rule.decide(caster({ pack_items: stocked(1) }), elsewhere), null, `${rule.id} declines`);
});

// ------------------------------------------------------------------ the supply trip

const empty = (over = {}) => caster({
  pack_items: [{ name: 'elderberry', amount: 4 }, { name: 'emerald', amount: 6 },
               { name: 'shilling', amount: 4000 }],
  ...over,
});

test('caster: a stocked caster starts no trip, and says nothing about it every tick', () => {
  eq(resupply.decide(caster(), ARMED), null, 'null, not a pass — this is the ordinary case');
  eq(rescueOut.decide(caster(), ARMED), null);
});

test('caster: below the floor it visits BOTH counters and comes home', () => {
  const out = resupply.decide(empty(), ARMED);
  eq(out.kind, 'errand');
  eq(out.orders.errand, 'caster-resupply');
  const travels = out.orders.steps.filter(s => s.tool === 'travel').map(s => s.args.to);
  eq(JSON.stringify(travels), JSON.stringify([104, 109, ROOM]),
     'apothecary, then the gem merchant, then home — the two halves are not sold by one person');
  const home = out.orders.steps.find(s => s.label === 'home');
  eq(home.args.to, ROOM);
  eq(home.always, true,
     'and the way home runs even if everything above it failed');
});

test('caster: the trip lifts its own confinement and puts it back AFTER the walk home', () => {
  // `posture()` confines this caster to its post and `Autopilot.travel` enforces that, so an
  // unlifted trip is refused by the character's own orders on every leg. Restoring it before
  // the walk home would refuse the one leg that matters most.
  const steps = resupply.decide(empty(), ARMED).orders.steps;
  const lift = steps.findIndex(s => s.label === 'lift-confinement');
  const restore = steps.findIndex(s => s.label === 'restore-confinement');
  const home = steps.findIndex(s => s.label === 'home');
  eq(lift, 0, 'lifted before anything walks');
  eq(JSON.stringify(steps[lift].args.confine_rooms), '[]');
  ok(home < restore, 'the walk home happens while the confinement is still off');
  eq(JSON.stringify(steps[restore].args.confine_rooms), JSON.stringify([ROOM]));
  eq(steps[restore].always, true, 'and it goes back on even when the trip failed');
});

test('caster: every buy is preceded by a LISTING it learns its ids from', () => {
  const out = resupply.decide(empty(), ARMED);
  const buys = out.orders.steps.filter(s => s.buy_from);
  eq(buys.length, 2, 'two counters, two buys');
  for (const b of buys) {
    const list = out.orders.steps.find(s => s.label === b.buy_from.label);
    ok(list, `${b.buy_from.label} is a real step`);
    ok(!list.buy_from, 'and it is the LISTING call, with no buy_ids of its own');
    ok(out.orders.steps.indexOf(list) < out.orders.steps.indexOf(b), 'and it runs first');
  }
});

test('caster: it buys the SHORTFALL to the target, not a flat amount', () => {
  const out = resupply.decide(empty(), ARMED);
  const lines = out.orders.steps.filter(s => s.buy_from).flatMap(s => s.buy_from.lines);
  const eb = lines.find(l => /elder/.test(l.match));
  const em = lines.find(l => /emerald/.test(l.match));
  eq(eb.amount, 60 * 2 - 4, 'sixty casts of berries, less the four aboard');
  eq(em.amount, 60 * 1 - 6, 'and sixty casts of gems, less the six aboard');
});

test('caster: it reads the PACK back, because a counter reply is not evidence', () => {
  const out = resupply.decide(empty(), ARMED);
  const read = out.orders.steps.find(s => s.label === 'read-back');
  ok(read, 'the pack is read back');
  eq(read.always, true, 'even when the buy failed — an unread pack is not a verdict');
});

// ------------------------------------------------------------------ the hand-off gate

const HOLDING = { ...ARMED, room_caster: { ...ARMED.room_caster, hand_off_item: 'chalice',
                                           hand_off_floor_casts: 2 } };
// Six castings: under the trip's floor of 10, comfortably over the hand-off floor of 2 — the
// window the gate exists for.
const withCup = (over = {}) => caster({
  pack_items: [{ name: 'elderberry', amount: 12 }, { name: 'emerald', amount: 8 },
               { name: 'shilling', amount: 4000 }, { name: 'Chalice of the Rain', amount: 1 }],
  ...over,
});

test('caster: it will not leave the post carrying the thing the fleet queues for', () => {
  // Measured on prod 2026-09-24: the harness raised its relief ticket at 17:23:20Z, nothing
  // claimed it, it timed out, and nine minutes later this trip walked out of the castle with
  // the fleet's only chalice — two triggers two castings apart and no gate between them.
  for (const rule of [rescueOut, resupply]) {
    const out = rule.decide(withCup(), HOLDING);
    eq(out.kind, 'pass', `${rule.id} waits`);
    ok(/still carrying chalice/.test(out.why), 'and says what it is waiting to put down');
  }
});

test('caster: with the cup handed over, the same trip goes', () => {
  eq(resupply.decide(empty(), HOLDING).kind, 'errand', 'nothing blocking once it is gone');
});

test('caster: an unread pack is not permission to leave with it', () => {
  // Unknown is not "he put it down" — read the other way it walks off with the chalice on the
  // strength of a board row that did not answer. (The rule itself already passes one gate
  // earlier for the same reason, so the helper is what carries this.)
  const held = stillHoldingHandOff({ pack_items: null }, HOLDING);
  eq(held.holding, true, 'treated as still holding it');
  eq(held.known, false, 'and honest that nobody looked');
  ok(/not permission to leave with it/.test(handOffBlocking({ pack_items: null }, HOLDING, 6)));
  eq(resupply.decide(withCup({ pack_items: null }), HOLDING).kind, 'pass', 'and no trip goes');
});

test('caster: but it does not wait for ever — below the floor it goes anyway', () => {
  // A caster holding the cup and unable to cast serves the fleet exactly as little as one who
  // has walked off with it.
  const out = resupply.decide(withCup({
    pack_items: [{ name: 'elderberry', amount: 4 }, { name: 'emerald', amount: 2 },
                 { name: 'shilling', amount: 4000 }, { name: 'Chalice of the Rain', amount: 1 }],
  }), HOLDING);
  eq(out.kind, 'errand', 'two castings left: the post is already dark');
});

test('caster: the gate is off unless a doctrine names the item', () => {
  eq(resupply.decide(withCup(), ARMED).kind, 'errand', 'no hand_off_item, no gate');
});

test('caster: a floor at or above the trip floor is refused — it could never hold anything up', () => {
  const bad = { ...DEFAULTS, ...HOLDING, name: 'x', fleet: 'f',
                claim: { ...DEFAULTS.claim, work: 'keeper', movement: 'keeper', economy: 'bot' },
                room_caster: { ...HOLDING.room_caster, hand_off_floor_casts: 10 } };
  ok(validate(bad).some(p => p.where === 'room_caster.hand_off_floor_casts'), 'refused at load');
});

test('caster: a hand_off_item that will not compile is refused at load', () => {
  const bad = { ...DEFAULTS, ...HOLDING, name: 'x', fleet: 'f',
                claim: { ...DEFAULTS.claim, work: 'keeper', movement: 'keeper', economy: 'bot' },
                room_caster: { ...HOLDING.room_caster, hand_off_item: '[' } };
  ok(validate(bad).some(p => p.where === 'room_caster.hand_off_item'),
     'a gate that never fires is worse than none');
});

test('caster: a failed trip backs off rather than setting out again every pass', () => {
  const rec = recordCasterResupply({ agent: 'acct08', at: 5_000, stopped: 'travel failed', results: [] });
  eq(rec.patch.acct08.ok, false);
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: rec.patch.acct08 } };
  ok(coolingDown(memory, 'acct08', 5_000 + 60_000) > 0, 'inside the backoff');
  const out = resupply.decide(empty({ memory, at: 5_000 + 60_000 }), ARMED);
  eq(out.kind, 'pass');
  ok(/backoff/.test(out.why), 'and the pass says why');
  eq(coolingDown(memory, 'acct08', 5_000 + 31 * 60_000), null, 'and it expires');
});

const CTX = { reagents: [{ item: 'elderberry', match: 'elder\\s?berr' },
                         { item: 'emerald', match: 'emerald' }] };
const pack = (label, items) => ({ tool: 'inventory', label, args: { agent: 'acct08' }, result: { items } });
const buy = () => ({ tool: 'shop', args: { agent: 'acct08', seller: 'Joguer', buy_ids: [{ id: 5, amount: 40 }] },
                     result: { bought: [] } });

test('caster: a trip is judged on what the PACK gained, not on the counter answering', () => {
  const rec = recordCasterResupply({ agent: 'acct08', at: 9, stopped: null, context: CTX, results: [
    pack('pack-before', [{ name: 'elderberry', amount: 4 }, { name: 'emerald', amount: 6 }]),
    buy(),
    pack('read-back', [{ name: 'elderberry', amount: 184 }, { name: 'emerald', amount: 6 }]),
  ] });
  eq(rec.patch.acct08.ok, true);
  eq(rec.patch.acct08.rescued_at, null, 'and the teleport is closed off behind it');
  ok(/gained 180 elderberry/.test(rec.read.verified), 'and it says what arrived');
});

test('caster: TWO SUCCESSFUL COUNTERS AND AN EMPTY PACK IS A FAILURE', () => {
  // The loop this exists to close, measured on prod 2026-09-24. `shop` clamps every line to
  // the purse and reports success either way, so nineteen shillings bought nothing while both
  // calls returned cleanly. Scored on the reply that was `ok: true`, no backoff, and the trip
  // set out again on the next tick at one emerald a lap.
  const rec = recordCasterResupply({ agent: 'acct08', at: 9, stopped: null, context: CTX, results: [
    pack('pack-before', [{ name: 'elderberry', amount: 21 }, { name: 'emerald', amount: 24 }]),
    buy(), buy(),
    pack('read-back', [{ name: 'elderberry', amount: 21 }, { name: 'emerald', amount: 24 }]),
  ] });
  eq(rec.patch.acct08.ok, false, 'nothing entered the pack, so nothing was bought');
  ok(/NOTHING entered the pack/.test(rec.read.verified), 'and it names the usual reason');
  // Which is what engages the backoff, which is what stops the lap loop.
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: rec.patch.acct08 } };
  ok(coolingDown(memory, 'acct08', 9 + 60_000) > 0, 'and the next pass is held off');
});

test('caster: a trip read at only one end is NOT a success — a gain is a difference', () => {
  // Three answers, not two: it worked, it did not, and nobody looked.
  const rec = recordCasterResupply({ agent: 'acct08', at: 9, stopped: null, context: CTX, results: [
    buy(), pack('read-back', [{ name: 'elderberry', amount: 44 }]),
  ] });
  eq(rec.patch.acct08.ok, false, 'not proved');
  ok(/not read at both ends/.test(rec.read.verified), 'and it says so rather than claiming a verdict');
});

test('caster: the trip carries what it went out for, so the verdict cannot drift', () => {
  const out = resupply.decide(empty(), ARMED);
  const names = (out.orders.context?.reagents ?? []).map(r => r.item).join(',');
  eq(names, 'elderberry,emerald', 'the recorder measures these and not whatever the file says later');
  const labels = out.orders.steps.filter(s => s.tool === 'inventory').map(s => s.label);
  eq(JSON.stringify(labels), JSON.stringify(['pack-before', 'read-back']), 'read at both ends');
});

test('caster: a hurt caster heals before it travels', () => {
  const out = resupply.decide(empty({ health: { value: 9, max: 20 } }), ARMED);
  eq(out.kind, 'pass');
  ok(/healing first/.test(out.why));
});

test('caster: unknown health is not permission to start a journey', () => {
  const out = resupply.decide(empty({ health: null }), ARMED);
  eq(out.kind, 'pass');
  ok(/unknown health is not permission/.test(out.why));
});

// ------------------------------------------------------------------ the rescue

test('caster: the rescue is ONE cast and nothing else', () => {
  const out = rescueOut.decide(empty(), ARMED);
  eq(out.kind, 'errand');
  eq(out.orders.errand, 'caster-rescue');
  eq(out.orders.steps.length, 1, 'one step: it lands 15-25s later, so nothing may follow it');
  eq(out.orders.steps[0].tool, 'cast');
  eq(out.orders.steps[0].args.spell, RESCUE.spell);
  ok(!('target' in out.orders.steps[0].args), 'and it is aimed at nothing — 0 targets in the kod');
});

test('caster: the rescue REMEMBERS, or it re-casts every tick at a gem a throw', () => {
  const rec = recordCasterRescue({ agent: 'acct08', at: 5_000, stopped: null });
  eq(rec.patch.acct08.rescued_at, 5_000);
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: rec.patch.acct08 } };
  ok(rescuePending(memory, 'acct08', 5_000 + 20_000), 'still in flight at twenty seconds');
  const out = rescueOut.decide(empty({ memory, at: 5_000 + 20_000 }), ARMED);
  eq(out.kind, 'pass', 'and it does not cast again');
  ok(!rescuePending(memory, 'acct08', 5_000 + 120_000), 'the window closes');
});

test('caster: a cast that never went out leaves NO memory behind', () => {
  // Otherwise a refused cast would be remembered as a teleport in flight, and the return
  // rule would refuse to walk him home for the whole window.
  eq(recordCasterRescue({ agent: 'acct08', at: 5, stopped: 'surface refused' }).patch.acct08.rescued_at,
     null);
});

test('caster: it will not spend the last gem to go and buy gems', () => {
  const out = rescueOut.decide(empty({
    pack_items: [{ name: 'elderberry', amount: 4 }, { name: 'emerald', amount: 2 }] }), ARMED);
  eq(out.kind, 'pass');
  ok(/reserve must survive/.test(out.why), 'and it says the walk is still available');
});

test('caster: it only rescues FROM the post — anywhere else is a teleport mid-trip', () => {
  eq(rescueOut.decide(empty({ room: 104 }), ARMED), null);
});

test('caster: the shopping leg waits for the landing rather than predicting it', () => {
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: { rescued_at: 5_000 } } };
  const out = resupply.decide(empty({ memory, at: 5_000 + 10_000 }), ARMED);
  eq(out.kind, 'pass');
  ok(/not knowable until it does/.test(out.why),
     'rescue.kod picks its own destination, so where he is is read rather than guessed');
});

test('caster: the window covers the slowest cast plus the latest landing', () => {
  ok(RESCUE_WINDOW_MS >= RESCUE_CAST_TIMEOUT_MS + RESCUE_LANDING_MS,
     'a window shorter than that re-casts on a teleport that is still coming');
  eq(rescueOut.decide(empty(), ARMED).orders.steps[0].timeout_ms, RESCUE_CAST_TIMEOUT_MS,
     'and the step times out on the same number the window is built from');
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: { rescued_at: 5_000 } } };
  ok(rescuePending(memory, 'acct08', 5_000 + RESCUE_CAST_TIMEOUT_MS + RESCUE_LANDING_MS),
     'still in flight at the latest possible landing');
});

test('caster: once the rescue has landed the shopping leg goes at once', () => {
  // Inside the window but no longer at the post: the room changing IS the landing, and
  // waiting out the rest of the window leaves him standing wherever it put him.
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: { rescued_at: 5_000 } } };
  const out = resupply.decide(empty({ memory, at: 5_000 + 20_000, room: 106 }), ARMED);
  eq(out.kind, 'errand');
  eq(out.orders.errand, 'caster-resupply');
});

test('caster: with rescue switched off the trip simply walks', () => {
  const walking = { ...ARMED, room_caster: { ...ARMED.room_caster, rescue: false } };
  eq(rescueOut.enabled(walking), false, 'the rescue rule is off');
  eq(resupply.decide(empty(), walking).kind, 'errand', 'and the counters leg is unaffected');
});

// ------------------------------------------------------------------ the way back

test('caster: out of position with reagents aboard, he walks back to the post', () => {
  const out = returnHome.decide(caster({ room: 101 }), ARMED);
  eq(out.kind, 'errand');
  eq(out.orders.errand, 'caster-return');
  eq(out.orders.steps[0].args.to, ROOM);
});

test('caster: standing at the post is nothing to say', () => {
  eq(returnHome.decide(caster(), ARMED), null);
});

test('caster: out of position AND out of reagents belongs to the supply trip', () => {
  // Walking him back to stand in a room he cannot light is the wasted half of two journeys.
  const out = returnHome.decide(empty({ room: 101 }), ARMED);
  eq(out.kind, 'pass');
  ok(/the supply trip owns this one/.test(out.why));
});

test('caster: but a supply trip inside its backoff releases him to walk home', () => {
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: { ok: false, last_try_at: 1_000 } } };
  const out = returnHome.decide(empty({ room: 101, memory, at: 1_000 + 60_000 }), ARMED);
  eq(out.kind, 'errand', 'he is not left standing in a shop for half an hour');
});

test('caster: he is not walked home out of his own teleport', () => {
  const memory = { [ROOM_CASTER_TOPIC]: { acct08: { rescued_at: 1_000 } } };
  const out = returnHome.decide(empty({ room: 101, memory, at: 1_000 + 10_000 }), ARMED);
  eq(out.kind, 'pass');
  ok(/being out of the post room is the point/.test(out.why));
});

test('caster: the post room and both counters are doctrine destinations', () => {
  // Or the station recall and the supply trip fight over one body, the recall winning the
  // moment the busy lease lapses and the caster arriving home with nothing.
  const armed = { ...ARMED, room_caster: { ...ARMED.room_caster,
    reagents: FORCES_OF_LIGHT.lines.map(l => ({ ...l })) } };
  ok(isDoctrineDestination(ROOM, armed), 'the post');
  ok(isDoctrineDestination(104, armed), 'the apothecary');
  ok(isDoctrineDestination(109, armed), 'the gem merchant');
  ok(!isDoctrineDestination(104, { ...armed, room_caster: { ...armed.room_caster, on: false } }),
     'and with the post off they are ordinary rooms again');
});

// ------------------------------------------------------------------ the buy binding

const listing = (label, items) => ({ label, tool: 'shop', result: { items } });

test('buy: a line is matched off the listing and carries its quantity', () => {
  const out = bindBuyLines(
    { buy_from: { label: 'list-0', lines: [{ match: 'elder\\s?berr', amount: 40 }] } },
    [listing('list-0', [{ id: 7, name: 'Elder Berry', cost: 28 }, { id: 8, name: 'Herbs' }])]);
  eq(JSON.stringify(out.buy_ids), JSON.stringify([{ id: 7, amount: 40 }]),
     'the id came from the shelf, not from the rule');
});

test('buy: NO LISTING and AN EMPTY SHELF are different sentences', () => {
  const noList = bindBuyLines({ buy_from: { label: 'list-0', lines: [{ match: 'x', amount: 1 }] } }, []);
  ok(/never opened/.test(noList.why), 'nobody asked');
  const noRow = bindBuyLines({ buy_from: { label: 'l', lines: [{ match: 'emerald', amount: 1 }] } },
                             [listing('l', [{ id: 1, name: 'herbs' }])]);
  ok(/does not stock it/.test(noRow.why), 'the merchant does not sell it');
});

test('buy: a negative id is an array index wearing an id\'s field name, and is refused', () => {
  const out = bindBuyLines({ buy_from: { label: 'l', lines: [{ match: 'emerald', amount: 2 }] } },
                           [listing('l', [{ id: -1, name: 'emerald' }])]);
  ok(out.why, 'refused rather than aimed at nothing');
});

test('buy: one line missing still buys the other, and says which it could not find', () => {
  const out = bindBuyLines({ buy_from: { label: 'l', lines: [
    { match: 'elder', amount: 4 }, { match: 'emerald', amount: 2 }] } },
    [listing('l', [{ id: 3, name: 'elderberry' }])]);
  eq(out.buy_ids.length, 1);
  eq(JSON.stringify(out.partial), JSON.stringify(['emerald']));
});

test('caster: both errand kinds are registered with a reader', () => {
  // An errand kind nothing can interpret would run, walk a character across the world, and
  // leave no record of what it learned.
  for (const kind of ['caster-rescue', 'caster-resupply', 'caster-return'])
    ok(ERRANDS[kind], `${kind} is in ERRANDS`);
  eq(ERRANDS['caster-rescue'].topic, ROOM_CASTER_TOPIC);
  eq(ERRANDS['caster-resupply'].topic, ROOM_CASTER_TOPIC);
});
