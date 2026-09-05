// THE DUKE'S FEAST HALL — offline, no broker, no server, no clock.
//
// `feast-hall-larder` is pure: the larder it reads, the walk estimate it gates on and the
// journey memory it drives all arrive on the observation. What is pinned, in order of how
// expensive being wrong would be:
//
//   * the journey is THREE SHORT ERRANDS joined by memory, none of which waits for a walk —
//     a blocking errand across eleven hops would stand the whole bot down for the trip;
//   * a character seen standing in the hall is served before anybody else is sent;
//   * the two doors are different: near Tos it is a larder count, from afar it takes an
//     EMPTY larder and no casting's worth of reagents — the supply trip, redirected;
//   * dispatch is capped by max_in_flight and per-character cooldowns, so a hungry fleet
//     queues rather than stampedes down the road that kills it;
//   * a journey that never arrives is given up, out loud, and names the locked hall;
//   * the grab stops on "You can't hold anything more!" and the way home still runs;
//   * the surface admits `act verb:"activate"` on a hall dispenser and on nothing else;
//   * while the feast is on, the purchase rule holds buy_reagents off.

const test = globalThis.__dumTest;

import { feastFleetRules, feastWindow, mealsAboard, canCook, grabsFor,
         recordFeastOutbound, recordFeastGrab, recordFeastAbandon } from '../src/decide/rules/feast.mjs';
import { FEAST_HALL, FEAST_DISPENSER_NAMES } from '../src/decide/feast-hall.mjs';
import { decide } from '../src/decide/engine.mjs';
import { fleetRules } from '../src/decide/index.mjs';
import { ERRANDS, runErrand, readErrand } from '../src/act/errands.mjs';
import { deny } from '../src/link/surface.mjs';
import { loadDoctrine } from '../src/config/load.mjs';
import { validate } from '../src/config/schema.mjs';
import { freshDefaults } from '../src/config/defaults.mjs';
import { normalizeFleetRow } from '../src/sense/normalize.mjs';
import { economyRules } from '../src/decide/rules/economy.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const rule = feastFleetRules[0];

/** A healthy character in Castle Victoria, eleven hops from the hall, with nothing to eat. */
const unit = (agent, over = {}) => ({
  agent, character: agent.toUpperCase(), in_game: true,
  level: 40, max_health: 40,
  health: { value: 40, max: 40, pct: 1 },
  room: 39, room_name: 'Castle Victoria (upstairs)',
  policy: { assignedRoom: 39 },
  pack_items: [{ name: 'hammer', amount: 1 }],
  reagents: { elderberry: 0, herbs: 0 },
  travel_to_feast: { ms: 11 * MIN, hops: 11 },
  commitment: null, parked: null, piloted: null,
  ...over,
});

const fleetObs = (rows, memory = {}, at = NOW) => ({
  at, source: 'fleet', characters: rows, in_game: rows.length, memory: { feast: memory }, depth: 'board',
});

const doctrineWith = (feast = {}, extra = {}) => loadDoctrine({
  file: null,
  overrides: {
    'fleet': 'test-fleet',
    'claim.work': 'bot',
    'feast.on': true,
    ...Object.fromEntries(Object.entries(feast).map(([k, v]) => [`feast.${k}`, v])),
    ...extra,
  },
}).config;

// ---------------------------------------------------------------- reading the larder

test('feast: meals are counted off the free board list, then the flag, and unknown is null', () => {
  eq(mealsAboard({ pack_items: [{ name: 'slice of pork', amount: 7 }, { name: 'hammer', amount: 1 }] }), 7, 'pork counts');
  eq(mealsAboard({ items: [{ name: 'loaf of bread', amount: 2 }, { name: 'Inky-cap mushroom', amount: 1 }] }), 3, 'the paid read wins');
  eq(mealsAboard({ has_food: true }), 1, 'the flag alone is one');
  eq(mealsAboard({ has_food: false }), 0, 'and false is none');
  eq(mealsAboard({}), null, 'nothing on the row is UNKNOWN, not zero');
});

test('feast: a casting is 2 elderberry and 2 herbs, and either short means no cooking', () => {
  ok(canCook({ reagents: { elderberry: 2, herbs: 2 } }), 'exactly one casting');
  ok(!canCook({ reagents: { elderberry: 12, herbs: 1 } }), 'herbs short');
  ok(!canCook({ reagents: null }), 'no reagents read means no cooking');
});

test('feast: the grab count is the doctrine cap, bounded by known pack room', () => {
  eq(grabsFor({}, { max_grabs: 60 }), 60, 'no carry read, the cap');
  eq(grabsFor({ carry: { room_for: { weight: 200, bulk: 900 } } }, { max_grabs: 60 }), 22,
     '200 weight over 9 a slice is 22');
  eq(grabsFor({ carry: { room_for: { weight: 4, bulk: 4 } } }, { max_grabs: 60 }), 1, 'never zero');
});

// ---------------------------------------------------------------- the window

test('feast: an unknown history is a reason to go; a filled pack waits the cooldown; a failure only the backoff', () => {
  eq(feastWindow({}, 'a', NOW, 45 * MIN, 10 * MIN).ready, true, 'never been');
  const filled = feastWindow({ a: { last_visit_at: NOW - 20 * MIN, ok: true } }, 'a', NOW, 45 * MIN, 10 * MIN);
  eq(filled.ready, false, 'filled twenty minutes ago');
  ok(/not again for 25m/.test(filled.why), `arithmetic in the reason: ${filled.why}`);
  const failed = feastWindow({ a: { failed_at: NOW - 20 * MIN, ok: false } }, 'a', NOW, 45 * MIN, 10 * MIN);
  eq(failed.ready, true, 'a failure twenty minutes ago is past its ten-minute backoff');
});

// ---------------------------------------------------------------- door one: near Tos

test('feast: a thin larder near Tos sets off, and the errand LAUNCHES the walk without waiting', () => {
  const rows = [unit('a', { room: 50, travel_to_feast: { ms: 48_000, hops: 3 },
                            pack_items: [{ name: 'slice of pork', amount: 2 }] })];
  const intent = rule.decide(fleetObs(rows), doctrineWith());
  eq(intent.kind, 'errand', 'an errand');
  eq(intent.orders.errand, 'feast-outbound', 'the dispatch errand');
  eq(intent.orders.agent, 'a', 'the one near Tos');
  eq(intent.orders.context.door, 'passing', 'through the near-Tos door');
  // TWO STEPS NOW, AND NEITHER OF THEM WAITS. The first moves the keeper's own station to
  // the hall - which is what actually gets the character there and keeps it there, since
  // DUM holds no lease and the keeper was walking it home again - and the second nudges the
  // walk. The property this test is about is that nothing BLOCKS, not how many steps it is.
  eq(intent.orders.steps.length, 2, 'set the station, then nudge the walk');
  eq(intent.orders.steps[0].tool, 'autopilot', 'the station first');
  eq(intent.orders.steps[0].args.assigned_room, 953, 'to the hall');
  const go = intent.orders.steps.find(x => x.tool === 'travel');
  eq(go.tool, 'travel', 'a travel');
  eq(go.args.to, FEAST_HALL.room, 'to the hall');
  eq(go.args.background, true, 'non-blocking');
  eq(go.args.run_errands, false, 'and not via the keeper\'s own bank/sell/apothecary errands');
  ok(!go.expect, 'and it does NOT wait for arrival — that is what keeps the pass free');
  ok(/near Tos|hop/.test(intent.orders.label + intent.why), `says so: ${intent.why}`);
});

test('feast: near Tos and already fed - it still tops up', () => {
  // UNCAPPED 2026-09-04. "It already has some food" was a reason to walk past free,
  // infinite food, and the fleet's whole ceiling is vigor. Everybody fills up every time
  // they pass; the only refusal left is a pack with no room in it.
  const rows = [unit('a', { room: 50, travel_to_feast: { ms: 48_000, hops: 3 },
                            pack_items: [{ name: 'slice of pork', amount: 9 }] })];
  eq(rule.decide(fleetObs(rows), doctrineWith()).kind, 'errand', 'nine meals is not full');
});

test('feast: near_rooms names a place distance would miss', () => {
  const rows = [unit('a', { room: 70, travel_to_feast: null })];   // the graveyard, no estimate
  eq(rule.decide(fleetObs(rows), doctrineWith()).kind, 'pass', 'no estimate, not near: nobody goes');
  const intent = rule.decide(fleetObs(rows), doctrineWith({ near_rooms: [70] }));
  eq(intent.kind, 'errand', 'named near, it goes');
});

// ---------------------------------------------------------------- door two: the supply trip, redirected

test('feast: no food and no casting, within the walk limit — the supply trip goes to the tables instead', () => {
  const intent = rule.decide(fleetObs([unit('a')]), doctrineWith());
  eq(intent.kind, 'errand', 'sent');
  eq(intent.orders.context.door, 'supply', 'through the worth-the-walk door');
  ok(/tables are free/.test(intent.why), `explains the substitution: ${intent.why}`);
  eq(intent.orders.context.home, 39, 'home is the assigned room');
});

test('feast: from afar, having food or reagents no longer keeps anybody home', () => {
  // Both of these used to be passes. Free food beats cooked food: `create food` costs two
  // elderberry and two herbs and a trip to a counter, and the tables cost a walk.
  const thin = unit('a', { pack_items: [{ name: 'slice of pork', amount: 1 }] });
  eq(rule.decide(fleetObs([thin]), doctrineWith()).kind, 'errand', 'one meal aboard still goes');
  const cook = unit('b', { reagents: { elderberry: 4, herbs: 4 } });
  eq(rule.decide(fleetObs([cook]), doctrineWith()).kind, 'errand', 'able to cook still goes');
});

// ------------------------------------------------- door three: a courier, for the fleet

test('feast: the pack-fullness safety is the ONLY thing that stops a trip', () => {
  // Operator's decision, 2026-09-04: remove every cap that was about the FLEET - how many
  // are on the road, who is a named courier, whether they already have food, how recently
  // they went - and keep one safety that is about the CHARACTER. Both halves must hold.
  const heavy = load => ({ carry: { weight_max: 2700, load: { weight: load } } });

  // Mostly food AND nearly full: the one skip.
  const stuffed = unit('a', { ...heavy(2300), pack_items: [{ name: 'slice of pork', amount: 240 }] });
  const out = rule.decide(fleetObs([stuffed]), doctrineWith());
  eq(out.kind, 'pass', 'no room for more food');
  ok(/pack full of food/.test(out.why), out.why);

  // Nearly full, but of LOOT - it can still carry food, so it goes.
  const looted = unit('b', { ...heavy(2300),
    pack_items: [{ name: 'chain armor', amount: 1 }, { name: 'slice of pork', amount: 10 }] });
  eq(rule.decide(fleetObs([looted]), doctrineWith()).kind, 'errand', 'a heavy pack of loot still tops up');

  // All food, but light - plenty of room, so it goes.
  const light = unit('c', { ...heavy(500), pack_items: [{ name: 'slice of pork', amount: 55 }] });
  eq(rule.decide(fleetObs([light]), doctrineWith()).kind, 'errand', 'room to carry is room to carry');
});

test('feast: an unknown pack is not treated as a full one', () => {
  // Unknown must fail toward GOING. The cost of a wrong walk is a walk; the cost of a wrong
  // refusal is a character at the resting cap for ever, which is what this rule exists for.
  const blind = unit('a', { carry: null, pack_items: null, has_food: null });
  eq(rule.decide(fleetObs([blind]), doctrineWith()).kind, 'errand', 'no carry reading: still goes');
});

test('feast: the walk limit is honoured, and a missing estimate is not read as a short walk', () => {
  const far = unit('a', { travel_to_feast: { ms: 40 * MIN, hops: 30 } });
  eq(rule.decide(fleetObs([far]), doctrineWith()).kind, 'pass', 'forty minutes is over the limit');
  const blind = unit('b', { travel_to_feast: null });
  const out = rule.decide(fleetObs([blind]), doctrineWith());
  eq(out.kind, 'pass', 'no estimate, nobody goes');
  ok(/no walk estimate/.test(out.why), `and says so: ${out.why}`);
});

// ---------------------------------------------------------------- who is left alone

test('feast: hurt, piloted, parked and busy characters are left alone', () => {
  const hurt = unit('a', { health: { value: 20, max: 40, pct: 0.5 } });
  const piloted = unit('b', { piloted: true });
  const parked = unit('c', { parked: true });
  const busy = unit('d', { commitment: { kind: 'errand', takeable: false } });
  eq(rule.decide(fleetObs([hurt, piloted, parked, busy]), doctrineWith()).kind, 'pass', 'nobody');
  // DUM's own claim is ownership, not an operation, and must not block the trip.
  const owned = unit('e', { commitment: { kind: 'bot', takeable: true } });
  eq(rule.decide(fleetObs([owned]), doctrineWith()).kind, 'errand', 'a takeable bot claim goes');
});

test('feast: an unreadable larder is no longer a reason to stay home', () => {
  // It was, while "already has food" was a gate - you cannot check a larder you cannot
  // read. With the gate gone the question never arises, and the trip is free anyway.
  const blind = unit('a', { pack_items: null, has_food: null });
  eq(rule.decide(fleetObs([blind]), doctrineWith()).kind, 'errand', 'sent');
});

// ---------------------------------------------------------------- bounded dispatch

test('feast: there is no cap on how many are on the road', () => {
  // `max_in_flight` is gone. It was a queue for a resource that cannot run out, and it
  // jammed at six - mostly on phantom entries - while the fleet sat at the resting cap.
  const mem = { x: { phase: 'outbound', since: NOW - 5 * MIN },
                y: { phase: 'outbound', since: NOW - 6 * MIN },
                z: { phase: 'outbound', since: NOW - 7 * MIN } };
  eq(rule.decide(fleetObs([unit('a')], mem), doctrineWith({ max_in_flight: 3 })).kind, 'errand',
     'three already out, and a fourth still goes');
});

test('feast: a character\'s own outbound journey is not re-dispatched, and its cooldown gates the next', () => {
  const going = { a: { phase: 'outbound', since: NOW - 2 * MIN } };
  eq(rule.decide(fleetObs([unit('a')], going), doctrineWith()).kind, 'pass', 'already on its way');
  // AND THE COOLDOWN IS GONE. A clock on a free, infinite resource only keeps a character
  // at the resting cap for longer; the pack is the limit now, not the calendar.
  const fed = { a: { phase: 'home', last_visit_at: NOW - MIN, ok: true } };
  eq(rule.decide(fleetObs([unit('a')], fed), doctrineWith()).kind, 'errand',
     'filled up a minute ago, and may go straight back');
});

test('feast: nearest first, then hungriest', () => {
  const near = unit('near', { room: 50, travel_to_feast: { ms: 48_000, hops: 3 },
                               pack_items: [{ name: 'slice of pork', amount: 3 }] });
  const far = unit('far');
  const intent = rule.decide(fleetObs([far, near]), doctrineWith());
  eq(intent.orders.agent, 'near', 'the short walk is the cheap one');
});

// ---------------------------------------------------------------- arrival: the grab

test('feast: a character standing in the hall is served before anybody is sent, and the grab is shaped right', () => {
  const inHall = unit('a', { room: FEAST_HALL.room, travel_to_feast: { ms: 0, hops: 0 } });
  const hungry = unit('b');
  const mem = { a: { phase: 'outbound', since: NOW - 12 * MIN, from: 39 } };
  const intent = rule.decide(fleetObs([hungry, inHall], mem), doctrineWith({ max_grabs: 5 }));
  eq(intent.orders.errand, 'feast-grab', 'the grab');
  eq(intent.orders.agent, 'a', 'the one in the hall');
  const steps = intent.orders.steps;
  const acts = steps.filter(s => s.tool === 'act');
  eq(acts.length, 5, 'max_grabs activations');
  for (const a of acts) {
    eq(a.args.verb, 'activate', 'activate is the mechanic (dispensr.kod TryActivate)');
    eq(a.args.target, 'roast pig', 'the first table the doctrine names');
    ok(a.stop_when instanceof RegExp && a.stop_when.test("You can't hold anything more!"), 'stops on the full-pack sentence');
    eq(a.skip_when_satisfied, true, 'and every later grab steps aside');
    eq(a.collect, 'messages', 'the transcript is how it counts');
    eq(deny('act', a.args), null, 'and the surface admits every one of them');
  }
  eq(acts[0].extend_busy, true, 'the first grab asks for the lease');
  eq(acts[1].extend_busy, false, 'the rest do not re-ask sixty times');
  const home = steps[steps.length - 1];
  eq(home.tool, 'travel', 'then home');
  eq(home.args.to, 39, 'to where the dispatch said home was');
  eq(home.always, true, 'even if a grab failed');
  eq(home.args.background, true, 'non-blocking, like the way out');
});

test('feast: somebody in the hall for their own reasons is fed too', () => {
  const inHall = unit('a', { room: FEAST_HALL.room, travel_to_feast: { ms: 0, hops: 0 } });
  const intent = rule.decide(fleetObs([inHall], {}), doctrineWith());
  eq(intent.orders.errand, 'feast-grab', 'no memory of a journey, still fed');
  eq(intent.orders.context.home, 39, 'home falls back to the assigned room');
  // Standing in the hall is its own reason now: no journey memory required, no cooldown.
  const fed = { a: { phase: 'home', last_visit_at: NOW - MIN, ok: true } };
  eq(rule.decide(fleetObs([inHall], fed), doctrineWith()).orders.errand, 'feast-grab',
     'in the room with the free food, so it takes some');
});

test('feast: grab_from names a table the hall has, in order, and the schema refuses one it does not', () => {
  const inHall = unit('a', { room: FEAST_HALL.room });
  const intent = rule.decide(fleetObs([inHall]), doctrineWith({ grab_from: ['cauldron of soup', 'roast pig'] }));
  eq(intent.orders.steps[0].args.target, 'cauldron of soup', 'first named');
  const c = freshDefaults();
  c.fleet = 'x'; c.feast.on = true; c.feast.grab_from = ['the Duke\'s own plate'];
  ok(validate(c).some(p => p.where === 'feast.grab_from'), 'a table the hall does not have is refused at load');
  ok(FEAST_DISPENSER_NAMES.includes('roast pig') && FEAST_DISPENSER_NAMES.includes('platter of grapes'), 'the tables are the kod\'s');
});

// ---------------------------------------------------------------- a journey that never arrives

test('feast: an outbound journey unseen in the hall past max_trip_ms is abandoned, out loud', () => {
  const stuck = unit('a', { room: 951, travel_to_feast: { ms: 16_000, hops: 1 } });   // the great hall
  const mem = { a: { phase: 'outbound', since: NOW - 31 * MIN, from: 39 } };
  const intent = rule.decide(fleetObs([stuck], mem), doctrineWith());
  eq(intent.orders.errand, 'feast-abandon', 'given up');
  eq(intent.orders.steps[0].tool, 'cancel_movement', 'the dangling walk is cancelled');
  eq(intent.orders.steps[0].always, true, 'unconditionally');
  ok(/LOCKED hall/.test(intent.why), `names the likely cause when it is on the approach: ${intent.why}`);
  eq(deny('cancel_movement', { agent: 'a' }), null, 'and the surface allows the cancel');
});

test('feast: a journey still inside max_trip_ms is left to walk', () => {
  const walking = unit('a', { room: 2 });
  const mem = { a: { phase: 'outbound', since: NOW - 10 * MIN, from: 39 } };
  eq(rule.decide(fleetObs([walking], mem), doctrineWith()).kind, 'pass', 'not yet');
});

// ---------------------------------------------------------------- what each errand leaves behind

test('feast: the records drive the phases, and a failed dispatch backs off rather than marking outbound', () => {
  const out = recordFeastOutbound({ agent: 'a', at: NOW, stopped: null, context: { home: 39 } });
  eq(out.patch.a.phase, 'outbound', 'on the road');
  eq(out.patch.a.from, 39, 'and home is remembered');
  const failed = recordFeastOutbound({ agent: 'a', at: NOW, stopped: 'travel failed: no route', context: { home: 39 } });
  eq(failed.patch.a.phase, null, 'not on the road');
  eq(failed.patch.a.ok, false, 'a failure, for the backoff');

  const say = n => Array.from({ length: n }, () => 'You slice yourself a hefty slab of apple-glazed roast pork.');
  const results = [...Array.from({ length: 8 }, () => ({ tool: 'act' })), { tool: 'act', skipped: true }, { tool: 'travel' }];
  const grab = recordFeastGrab({ agent: 'a', at: NOW, stopped: null, context: { dispenser: 'roast pig' },
    transcript: [...say(7), "You can't hold anything more!"], results });
  eq(grab.patch.a.phase, 'home', 'walking home');
  eq(grab.patch.a.grabbed, 7, 'counted off what the pork said');
  eq(grab.patch.a.pack_full, true, 'and that the pack filled');
  eq(grab.read.verified, true, 'a spoken count is verified');
  eq(grab.patch.a.ok, true, 'a success, for the full cooldown');

  const silent = recordFeastGrab({ agent: 'a', at: NOW, stopped: null, context: { dispenser: 'platter of grapes' },
    transcript: ["You can't hold anything more!"], results });
  eq(silent.patch.a.grabbed, 7, 'a silent table is counted by the activations that ran, less the refusal');
  eq(silent.read.verified, false, 'and says the count is not verified');

  const nothing = recordFeastGrab({ agent: 'a', at: NOW, stopped: 'act failed: nothing here matches "roast pig"',
    context: { dispenser: 'roast pig' }, transcript: [], results: [] });
  eq(nothing.patch.a.ok, false, 'took nothing: a failure');
  eq(nothing.patch.a.phase, 'home', 'but the journey is over either way');

  const gone = recordFeastAbandon({ agent: 'a', at: NOW, context: { where: 951 } });
  eq(gone.patch.a.phase, null, 'cleared');
  eq(gone.patch.a.ok, false, 'backoff');
});

// ---------------------------------------------------------------- the runner

test('feast: the runner stops taking on the full-pack sentence, skips the rest, and still walks home', async () => {
  const sent = [];
  let served = 0;
  const broker = {
    call: async (tool, args) => {
      if (tool === 'autopilot') return {};
      sent.push(tool);
      if (tool === 'act') {
        served++;
        return { messages: [served < 3 ? 'You slice yourself a hefty slab of apple-glazed roast pork.'
                                       : "You can't hold anything more!"] };
      }
      return { started: true };
    },
    write: async () => ({ dry_run: true }),
  };
  const inHall = unit('a', { room: FEAST_HALL.room });
  const intent = { rule: 'feast-hall-larder', ...rule.decide(fleetObs([inHall]), doctrineWith({ max_grabs: 10 })) };
  const applied = await runErrand(broker, intent, { commit: true, holder: 'dum/test@pid-1' });
  eq(sent.filter(t => t === 'act').length, 3, 'two slices and the refusal, then no more');
  eq(sent[sent.length - 1], 'travel', 'the way home ran');
  eq(applied.stopped, null, 'a full pack is not a failure');
  const learned = readErrand(applied, { at: NOW, memory: {} });
  eq(learned.topic, 'feast', 'the feast topic');
  eq(learned.patch.a.grabbed, 2, 'two slices');
  eq(learned.patch.a.pack_full, true, 'and the pack filled');
});

test('feast: the runner does not re-extend busy for every one of sixty grabs', async () => {
  let busyCalls = 0;
  const broker = {
    call: async (tool, args) => {
      if (tool === 'autopilot' && args.action === 'busy') busyCalls++;
      if (tool === 'autopilot') return {};
      return tool === 'act' ? { messages: [] } : { started: true };
    },
    write: async () => ({ dry_run: true }),
  };
  // THE PROPERTY IS THAT EXTENSIONS DO NOT SCALE WITH GRABS, not that there are three of
  // them. A fixed bound broke the day a genuine step was added — walking up to the table
  // before taking from it — and a test that fails when the errand grows a leg is a test
  // that gets its number bumped rather than read. So run it twice, at twenty grabs and at
  // sixty, and assert the count is IDENTICAL: sixty three-second activations must cost the
  // same in leases as twenty, which is the thing worth defending.
  const runWith = async grabs => {
    busyCalls = 0;
    const inHall = unit('a', { room: FEAST_HALL.room });
    const intent = { rule: 'feast-hall-larder',
                     ...rule.decide(fleetObs([inHall]), doctrineWith({ max_grabs: grabs })) };
    await runErrand(broker, intent, { commit: true, holder: 'dum/test@pid-1' });
    return busyCalls;
  };
  const twenty = await runWith(20);
  const sixty = await runWith(60);
  eq(sixty, twenty, `sixty grabs must cost the same leases as twenty (${twenty} vs ${sixty})`);
  ok(twenty <= 6, `and the fixed cost stays small: ${twenty}`);
});

// ---------------------------------------------------------------- the walker is held on the road

test('feast: both legs hold the walker busy for the walk, padded and bounded by the give-up time', () => {
  const out = rule.decide(fleetObs([unit('a')]), doctrineWith());
  eq(out.orders.hold_busy_ms, Math.round(11 * MIN * 1.5 + 2 * MIN), 'the walk in, padded, plus two minutes');
  const capped = rule.decide(fleetObs([unit('a', { travel_to_feast: { ms: 14 * MIN, hops: 12 } })]),
                             doctrineWith({ max_trip_ms: 20 * MIN }));
  eq(capped.orders.hold_busy_ms, 20 * MIN, 'never past max_trip_ms');
  const inHall = unit('a', { room: FEAST_HALL.room });
  const grab = rule.decide(fleetObs([inHall], { a: { phase: 'outbound', since: NOW - 12 * MIN, from: 39, ms: 10 * MIN } }),
                           doctrineWith());
  eq(grab.orders.hold_busy_ms, Math.round(10 * MIN * 1.5 + 2 * MIN), 'the walk home is as long as the walk in');
  const nowhere = rule.decide(fleetObs([unit('b', { room: FEAST_HALL.room, policy: null, assigned_room: null })]),
                              doctrineWith());
  eq(nowhere.orders.hold_busy_ms, 0, 'no home, no walk home, no hold');
});

test('feast: a walker arriving under its own busy hold is served, and a keeper errand is not', () => {
  const held = unit('a', { room: FEAST_HALL.room,
    commitment: { kind: 'bot', takeable: false, label: 'dum/x is steering: feast hall: set off' } });
  const mem = { a: { phase: 'outbound', since: NOW - 12 * MIN, from: 39, ms: 11 * MIN } };
  eq(rule.decide(fleetObs([held], mem), doctrineWith()).orders?.errand, 'feast-grab', 'our own hold is not a reason to wait');
  const other = unit('b', { room: FEAST_HALL.room, commitment: { kind: 'errand', takeable: false } });
  eq(rule.decide(fleetObs([other]), doctrineWith()).kind, 'pass', 'a keeper errand is somebody else\'s');
});

test('feast: the runner HOLDS busy for a launched walk instead of freeing it, and frees on a failure', async () => {
  const calls = [];
  const broker = {
    call: async (tool, args) => {
      if (tool === 'autopilot') { calls.push(`${args.action}:${args.lease_ms ?? ''}`); return {}; }
      return { started: true };
    },
    write: async () => ({ dry_run: true }),
  };
  const intent = { rule: 'feast-hall-larder', ...rule.decide(fleetObs([unit('a')]), doctrineWith()) };
  await runErrand(broker, intent, { commit: true, holder: 'dum/test@pid-1' });
  ok(!calls.some(c => c.startsWith('free')), `never freed: ${calls.join(' ')}`);
  const last = calls[calls.length - 1];
  ok(last.startsWith('busy:'), `the last word is a hold: ${calls.join(' ')}`);
  eq(Number(last.split(':')[1]), Math.min(15 * MIN, intent.orders.hold_busy_ms), 'for the walk, under the runner\'s ceiling');

  const failing = { call: async (tool, args) => {
      if (tool === 'autopilot') { calls.push(args.action); return {}; }
      return { error: 'no route' };
    }, write: async () => ({ dry_run: true }) };
  calls.length = 0;
  await runErrand(failing, intent, { commit: true, holder: 'dum/test@pid-1' });
  eq(calls[calls.length - 1], 'free', 'a walk that never started is freed, not held');
});

// ---------------------------------------------------------------- the surface

test('feast: act verb:"activate" is admitted on a hall table and refused on anything else', () => {
  eq(deny('act', { verb: 'activate', target: 'roast pig' }), null, 'the pork');
  eq(deny('act', { verb: 'activate', target: 'Platter of Grapes' }), null, 'case does not matter');
  ok(/Feast Hall food dispenser/.test(deny('act', { verb: 'activate', target: 'lever' })), 'a lever is not');
  ok(deny('act', { verb: 'activate', target: 12345 }), 'nor a bare object id');
  ok(deny('act', { verb: 'activate' }), 'nor no target at all');
  ok(deny('act', { verb: 'get', target: 'roast pig' }), 'and the table does not open the other verbs');
});

// ---------------------------------------------------------------- wiring

test('feast: every errand kind the rule emits is registered, and the rule is reachable through the fleet table', () => {
  for (const k of ['feast-outbound', 'feast-grab', 'feast-abandon']) {
    ok(ERRANDS[k], `${k} registered`);
    eq(ERRANDS[k].topic, 'feast', `${k} writes the feast topic`);
    eq(typeof ERRANDS[k].record, 'function', `${k} has a record fn`);
  }
  const { intent } = decide(fleetRules, fleetObs([unit('a')]), doctrineWith());
  eq(intent?.rule, 'feast-hall-larder', 'the real table reaches it');
  eq(intent?.orders?.errand, 'feast-outbound', 'and it dispatches');
});

test('feast: off by default, and off means silence', () => {
  const d = loadDoctrine({ file: null, overrides: { fleet: 'test-fleet' } }).config;
  eq(d.feast.on, false, 'off');
  const { intent, considered } = decide(fleetRules, fleetObs([unit('a')]), d);
  ok(intent?.rule !== 'feast-hall-larder', 'does not fire');
  const row = considered.find(c => c.rule === 'feast-hall-larder');
  ok(row && /feast\.on is off/.test(row.why ?? ''), `and says why it is off: ${row?.why}`);
});

test('feast: the normalised board row carries the three larder facts, and null means unanswered', () => {
  const r = normalizeFleetRow({ agent: 'a', room_num: 39, pack_items: [{ name: 'slice of pork', amount: 4 }],
                                reagents: { elderberry: 3, herbs: 0 }, has_food: true });
  eq(r.pack_items.length, 1, 'pack_items');
  eq(r.reagents.elderberry, 3, 'reagents');
  eq(r.has_food, true, 'has_food');
  const old = normalizeFleetRow({ agent: 'b', room_num: 39 });
  eq(old.pack_items, null, 'an older broker: not answered');
  eq(old.reagents, null, 'not answered');
  eq(old.has_food, null, 'not answered');
});

// ---------------------------------------------------------------- the purchase rule

test('feast: while the feast is on, buy_reagents is held off through the purchase rule, and comes back when it is off', () => {
  const purchase = economyRules.find(r => r.id === 'purchase-strategy-policy');
  const obs = { agent: 'a', keeper: { policy: { buyFood: false, buyWeapons: true, buyReagents: true } },
                strategies: { agents: { a: ['buy-weapons', 'buy-reagents'] } } };
  const on = purchase.decide(obs, doctrineWith());
  eq(on?.orders?.buy_reagents, false, 'held off');
  eq(on?.orders?.buy_weapons, true, 'weapons untouched');
  ok(/Feast Hall/.test(on.why), `says why: ${on.why}`);
  const off = purchase.decide(obs, doctrineWith({ on: false }));
  eq(off, null, 'feast off: the keeper already agrees, nothing to send');
  const kept = purchase.decide(obs, doctrineWith({ suspend_reagent_buying: false }));
  eq(kept, null, 'feast on but the suspension declined: nothing changes');
});

test('feast: the schema catches the silent mistakes', () => {
  const c = freshDefaults(); c.fleet = 'x'; c.feast.on = true;
  eq(validate(c).length, 0, 'the defaults, switched on, are usable');
  c.feast.max_in_flight = 0;
  ok(validate(c).some(p => p.where === 'feast.max_in_flight'), 'a fleet that can send nobody');
  c.feast.max_in_flight = 3; c.feast.cooldown_ms = 5_000;
  ok(validate(c).some(p => p.where === 'feast.cooldown_ms'), 'a cooldown that lets a character live at the tables');
  c.feast.cooldown_ms = 45 * MIN; c.feast.max_travel_ms = 1;
  ok(validate(c).some(p => p.where === 'feast.max_travel_ms'), 'a walk limit nothing can meet');
  const off = freshDefaults(); off.fleet = 'x'; off.feast.grab_from = ['nonsense'];
  eq(validate(off).length, 0, 'off, nothing is checked — the block is inert');
});
