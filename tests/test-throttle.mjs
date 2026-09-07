// THE THROTTLE — the target vigor the fleet maintains, as a fraction of 200.
//
// Offline: the rule is pure (obs + doctrine in, an order or null out), so the mapping and the
// converge-when-the-keeper-agrees contract are both fixtures.

const test = globalThis.__dumTest;

import { throttleRules, floorForThrottle, throttleFloors, fedEnough, vigorValue } from '../src/decide/rules/throttle.mjs';
import { normalizeFleetRow } from '../src/sense/normalize.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const rule = throttleRules.find(r => r.id === 'throttle-vigor');
const obsWith = (throttle, keeperFloor) => ({ agent: 'a', keeper: { policy: { fightAboveVigor: keeperFloor } } });

test('throttle: a floor may be said as a fraction of 200 or as the vigor itself', () => {
  eq(floorForThrottle(1.0), 200, 'full throttle is ~max vigor');
  eq(floorForThrottle(0.9), 180, 'the fleet default floor');
  eq(floorForThrottle(0.4), 80, 'the rest cap');
  eq(floorForThrottle(0), 0, 'zero');
  eq(floorForThrottle(-1), 0, 'clamped below 0');

  // ABSOLUTE ABOVE 1, AND THIS CHANGED. It used to clamp anything over 1 to 200, on the
  // reading that the only legal spelling was a fraction. But an operator says "get them to
  // 180 before they start a fight", not "get them to nine tenths", and a doctrine that has
  // to translate is a doctrine that gets it wrong once.
  //
  // The boundary is safe because it is not ambiguous in practice: a floor of one vigor or
  // less is not a thing anybody means, and every doctrine in this repository spells the
  // throttle as a fraction at or below 1.0, so none of them changes meaning. What DID
  // change is the clamp on nonsense — `2` now means two vigor rather than two hundred.
  eq(floorForThrottle(180), 180, 'said out loud');
  eq(floorForThrottle(2), 2, 'and no longer silently promoted to 200');
  eq(floorForThrottle(250), 200, 'still clamped at the maximum');
});

test('throttle: the floor follows the larder when the doctrine gives it two', () => {
  // The failure this exists for, measured 2026-09-04: a cohort given a flat 140 with no
  // supply line had a character sitting at vigor 76 with no reagents and no shillings for
  // thirty-six minutes — not hurt, not lost, not stalled by any detector, just standing in
  // the right room correctly refusing to fight. A single number is a bet on the larder.
  const split = { with_food: 180, no_food: 80 };
  eq(throttleFloors(split).withFood, 180, 'fed');
  eq(throttleFloors(split).noFood, 80, 'and not');
  eq(throttleFloors(0.7).withFood, 140, 'a bare number still means one floor for both');
  eq(throttleFloors(0.7).split, false, 'and says it is not a split');

  // A no_food ABOVE with_food is a typo, not a fleet that eats to relax — everything over
  // the resting cap has to be eaten, so an empty larder cannot reach the higher number.
  // Obeying it would idle exactly the characters the split exists to keep fighting.
  eq(throttleFloors({ with_food: 80, no_food: 180 }).noFood, 80, 'held down to with_food');
});

test('throttle: fed means the larder can CLOSE THE GAP, not merely that it is non-empty', () => {
  // The failure this replaced, measured on prod 2026-09-04. Six water skins is six meals
  // and eighteen vigor; the gap to a 180 floor from the resting cap is a hundred. Counting
  // meals called that fed, raised the floor, and the character then held a safe spot
  // indefinitely — correctly refusing to fight, technically fed. The split idle-locked the
  // exact character it exists to keep fighting.
  const waterskins = { larder_vigor: 18, vigor: 80, reagents: { elderberry: 0, herbs: 0 } };
  ok(!fedEnough(waterskins, {}, 1, 180), 'eighteen vigor does not close a hundred-point gap');
  ok(fedEnough({ ...waterskins, larder_vigor: 120 }, {}, 1, 180), 'a hundred and twenty does');

  // Reagents are credited as the meal they would become, so a courier carrying a casting is
  // not written off for having eaten its last slice.
  ok(fedEnough({ larder_vigor: 50, vigor: 80, reagents: { elderberry: 40, herbs: 40 } }, {}, 1, 180),
     'fifty plus a casting closes it');

  // Already at or above the floor is trivially fed — nothing has to be eaten to stay there.
  ok(fedEnough({ larder_vigor: 0, vigor: 190, reagents: {} }, {}, 1, 180), 'no climb needed');

  // A board too old to report the sum falls back to the meal count rather than starving
  // everybody, and no vigor reading is a question rather than a zero.
  ok(fedEnough({ pack_items: [{ name: 'slice of pork', amount: 3 }] }, {}, 1, 180),
     'no larder_vigor -> the old coarse test');
  ok(fedEnough({ larder_vigor: 5, reagents: { elderberry: 9, herbs: 9 } }, {}, 1, 180),
     'no vigor reading -> fall through, do not declare a stocked pack insufficient');
});

test('throttle: a normalised vigor is an OBJECT, and the gate in front of the arithmetic must open', () => {
  // The third silent failure in one afternoon, and the meanest. larder_vigor was published
  // by the broker, carried by the normaliser and read by fedEnough — and the split still used
  // the coarse meal count, because `normalizeFleetRow` runs every vital through `vital()`,
  // which returns {value, max, pct}. `Number({...})` is NaN, the `Number.isFinite` guard took
  // the fallback branch, and seven characters held a 180 floor they could not reach. Every
  // layer was right; the reading of the shape was not.
  const norm = normalizeFleetRow({ agent: 'unit-1', in_game: true, vigor_of: '80/200',
                                   larder_vigor: 18, reagents: { elderberry: 0, herbs: 0 } });
  eq(typeof norm.vigor, 'object', 'the normaliser really does hand back an object');
  eq(vigorValue(norm), 80, 'and the reader gets the number out of it');
  ok(!fedEnough(norm, {}, 1, 180), '18 vigor of larder does not close a 100-point gap');

  // Both spellings, so a rule may be handed a raw board row or a normalised one.
  eq(vigorValue({ vigor: 143 }), 143, 'a plain number still works');
  ok(Number.isNaN(vigorValue({})), 'and nothing readable is NaN, which falls through');
});

test('throttle: larder_vigor survives the normaliser — the whitelist is where this silently died', () => {
  // Adding the field to the broker was NOT enough. `normalizeFleetRow` is a whitelist, so an
  // un-listed field is dropped without a word and every rule downstream falls back to the
  // coarse test it was written to replace. Measured 2026-09-04: the harness published
  // larder_vigor, fedEnough read it, and five characters still held a 180 floor on 0-50
  // vigor of food, because the number never crossed this boundary.
  const row = normalizeFleetRow({ agent: 'unit-1', in_game: true, larder_vigor: 42 });
  eq(row.larder_vigor, 42, 'carried through');
  eq(normalizeFleetRow({ agent: 'unit-1', in_game: true }).larder_vigor, null,
     'and absent is UNKNOWN, not zero — an older broker must not starve the fleet');
});

test('throttle: fed means something to eat OR something to cook, and unknown is not empty', () => {
  ok(fedEnough({ pack_items: [{ name: 'slice of pork', amount: 3 }] }), 'meals aboard');
  ok(fedEnough({ reagents: { elderberry: 2, herbs: 2 } }), 'or a casting in the pack');
  ok(!fedEnough({ pack_items: [{ name: 'hammer', amount: 1 }], reagents: { elderberry: 0, herbs: 0 } }),
     'neither');
  // A larder the board did not report is UNKNOWN. Reading that as empty would drop a
  // well-stocked character to the resting cap on one bad snapshot.
  ok(fedEnough({ reagents: { elderberry: 9, herbs: 9 } }), 'unknown larder, but it can cook');
  eq(throttleFloors({ with_food: 180, no_food: 80 }).split, true, 'and the split is declared');
});

test('throttle: a split doctrine orders the fed floor for a fed character and the other for a starved one', () => {
  const doctrine = { throttle: { with_food: 180, no_food: 80 }, food: {} };
  const fed = { agent: 'a', keeper: { policy: { fightAboveVigor: 80 },
                                      pack_items: [{ name: 'slice of pork', amount: 6 }] } };
  const starved = { agent: 'b', keeper: { policy: { fightAboveVigor: 180 },
                                          pack_items: [{ name: 'hammer', amount: 1 }],
                                          reagents: { elderberry: 0, herbs: 0 } } };
  eq(rule.decide(fed, doctrine).orders.fight_above_vigor, 180, 'fed climbs');
  eq(rule.decide(starved, doctrine).orders.fight_above_vigor, 80,
     'and one that cannot eat is dropped to the cap rather than idle-locked above it');
});

test('throttle: off unless the doctrine sets one', () => {
  eq(rule.enabled({}), false, 'no throttle key');
  eq(rule.enabled({ throttle: null }), false, 'explicit null is off');
  eq(rule.enabled({ throttle: 1.0 }), true, 'a number turns it on');
  eq(rule.enabled({ throttle: 0 }), true, 'zero is a real throttle, not "off"');
});

test('throttle: sets fight_above_vigor when the keeper does not hold the target', () => {
  const intent = rule.decide(obsWith(1.0, 180), { throttle: 1.0 });
  ok(intent, 'full throttle over a keeper at 180 emits an order');
  eq(intent.kind, 'orders', 'a policy write');
  eq(intent.orders.action, 'start', 'an autopilot start');
  eq(intent.orders.fight_above_vigor, 200, 'to the full-throttle floor');
  ok(/throttle 100% -> fight_above_vigor=200/.test(intent.why), `readable why: ${intent.why}`);
});

test('throttle: returns null once the keeper already holds the floor AND the ceiling', () => {
  // CONVERGENCE NOW MEANS BOTH HALVES. It used to mean the floor alone, which is how the
  // ceiling became something nobody had chosen: a keeper on the right floor was left alone
  // for ever whatever its ceiling said, and on prod all 21 characters reported
  // `vigorCeiling: undefined` while every one of them was in fact eating to 200.
  //
  // The contract this test exists for — the rule cannot wedge the table — is unchanged: one
  // order sets both, and the pass after it returns null.
  eq(rule.decide({ agent: 'a', keeper: { policy: { fightAboveVigor: 180, vigorCeiling: 200 } } },
                 { throttle: 0.9 }), null, 'converged, so no order');
  const half = rule.decide(obsWith(0.9, 180), { throttle: 0.9 });
  ok(half, 'a keeper with no ceiling at all is still corrected once');
  eq(half.orders.vigor_ceiling, 200, '...to the top of the band');
  eq(half.orders.fight_above_vigor, 180, '...without disturbing the floor it already had');
});

test('throttle: reads obs.policy when there is no keeper snapshot', () => {
  const intent = rule.decide({ agent: 'a', policy: { fightAboveVigor: 80 } }, { throttle: 0.9 });
  eq(intent?.orders?.fight_above_vigor, 180, 'raises the floor from 80 to 180');
});

// ---------------------------------------------------------------- "turbo": floor moves, ceiling does not
//
// The operator's phrasing, 2026-09-05, and it names a distinction the fleet had lost:
//
//     "0.8 turbo"  ->  160 minimum to start a fight, keep eating until 200
//     "0.4 turbo"  ->   80 minimum to start a fight, keep eating until 200
//
// A floor and a ceiling are different questions and one number was answering both. Health
// returns as ((200-vigor)^2/6 + 1000) ms a point — 1.0 hp/s at 200 against 0.29 at 80 — so
// the BAND is the whole value: set out at the top, fight down to the floor, eat back up.
//
// Measured on prod before this: ten of twenty-one characters were on fight_above_vigor 200
// against a ceiling that was also 200, so they had to be at exactly full to swing and dropped
// out of the fight on the first tick of vigor burn; and all twenty-one reported
// `vigorCeiling: undefined`, because the ceiling could only be inherited from whichever
// strategy plan happened to be selected. The band was real, nobody had chosen it, and nothing
// reported it.
test('throttle: turbo keeps the ceiling at 200 however low the floor goes', () => {
  eq(throttleFloors({ with_food: 0.8, no_food: 0.4 }).ceiling, 200, '0.8 turbo tops out at 200');
  eq(throttleFloors({ with_food: 0.8, no_food: 0.4 }).withFood, 160, '...and starts fights at 160');
  eq(throttleFloors({ with_food: 0.4, no_food: 0.4 }).ceiling, 200, '0.4 turbo still tops out at 200');
  eq(throttleFloors({ with_food: 0.4, no_food: 0.4 }).withFood, 80, '...and starts fights at 80');
  // A flat throttle is turbo too — the ceiling is not a property of the split.
  eq(throttleFloors(0.8).ceiling, 200, 'a flat throttle also eats to the top');
  // Opting out returns the old behaviour: send no ceiling, leave the strategy's own alone.
  eq(throttleFloors({ with_food: 0.8, turbo: false }).ceiling, null, 'turbo:false sends no ceiling');
  // And an explicit ceiling beats both.
  eq(throttleFloors({ with_food: 0.8, ceiling: 180 }).ceiling, 180, 'an explicit ceiling wins');
});

test('throttle: the order carries both halves, and the ceiling never lands below the floor', () => {
  const d = { throttle: { with_food: 0.8, no_food: 0.4 }, food: {} };
  const row = normalizeFleetRow({ agent: 'a', in_game: true, vigor: 150,
                                  larder_vigor: 500, pack_items: [{ name: 'slice of pork', amount: 50 }] });
  const out = rule.decide({ ...row, keeper: { policy: { fightAboveVigor: 0 } } }, d);
  ok(out, 'it wants something');
  eq(out.orders.fight_above_vigor, 160, 'the floor');
  eq(out.orders.vigor_ceiling, 200, 'and the ceiling, in the same order');
  // A CEILING BELOW THE FLOOR IS A CHARACTER THAT MUST EAT DOWNWARDS. There is no such
  // action, so the broker refuses it — this makes sure we never send one.
  const tight = rule.decide({ ...row, keeper: { policy: { fightAboveVigor: 0 } } },
                            { throttle: { with_food: 1.0, ceiling: 100 }, food: {} });
  ok(tight.orders.vigor_ceiling >= tight.orders.fight_above_vigor,
     `ceiling ${tight.orders.vigor_ceiling} must not be under floor ${tight.orders.fight_above_vigor}`);
});

test('throttle: a keeper with the right floor but the wrong ceiling is still corrected', () => {
  // Checking only the floor is how the band became something nobody had chosen: a keeper on
  // the right floor was left alone for ever whatever its ceiling said.
  const d = { throttle: { with_food: 0.8, no_food: 0.4 }, food: {} };
  const row = normalizeFleetRow({ agent: 'a', in_game: true, vigor: 150,
                                  larder_vigor: 500, pack_items: [{ name: 'slice of pork', amount: 50 }] });
  const agreed = rule.decide({ ...row, keeper: { policy: { fightAboveVigor: 160, vigorCeiling: 200 } } }, d);
  eq(agreed, null, 'both halves agree — nothing to do');
  const half = rule.decide({ ...row, keeper: { policy: { fightAboveVigor: 160, vigorCeiling: 160 } } }, d);
  ok(half, 'the floor agrees and the ceiling does not, so it still corrects');
  eq(half.orders.vigor_ceiling, 200, 'back to the top of the band');
});

test('throttle: vigor_ceiling is a routable order field, not a silently discarded one', async () => {
  // DUM REFUSES TO SEND A FIELD IT HAS NOT BEEN TAUGHT, LOUDLY — and it caught this exact
  // mistake in production the first time the rule sent a ceiling: "rule throttle-vigor wants
  // to set vigor_ceiling, which is not in ORDER_FIELDS ... or the setting is silently
  // discarded". That guard is the reason a whole afternoon of turbo did not quietly do
  // nothing, so this pins the registration rather than trusting it.
  const { ORDER_FIELDS } = await import('../src/act/orders.mjs');
  ok(ORDER_FIELDS.vigor_ceiling, 'vigor_ceiling is registered');
  eq(ORDER_FIELDS.vigor_ceiling.policy, 'vigorCeiling', 'and maps to the keeper policy key');
  eq(ORDER_FIELDS.fight_above_vigor.policy, 'fightAboveVigor', 'the floor still maps to its own');
});

test('observe: a neutral character is never asked to play a faction game', async () => {
  // A NEUTRAL CANNOT PLAY, AND ASKING COSTS A ROUND TRIP TO BE TOLD SO. The broker refuses
  // the scan outright — "faction games require observed faction membership; profile says
  // neutral" — and the loop used to catch that, record it, and ask again next tick.
  //
  // Measured on prod 2026-09-07: 20 of 21 characters neutral, one rebel, so 20 of every 21
  // scans could never succeed. 38 of 219 broker calls in one fifteen-minute window, each
  // under a 45s timeout — about a sixth of every pass spent on a question the fleet row had
  // already answered.
  const { enrichFactionGames } = await import('../src/sense/observe.mjs');
  const asked = [];
  const broker = { call: async (_t, a) => { asked.push(a.agent); return { carrying: [], targets: [] }; } };
  const rows = [{ agent: 'a', faction: 'neutral' }, { agent: 'b', faction: 'rebel' },
                { agent: 'c' }, { agent: 'd', faction: 'Neutral' }];
  await enrichFactionGames(broker, rows);
  eq(asked.length, 1, 'only the faction member is asked');
  eq(asked[0], 'b', 'and it is the rebel');
  // THE CAPABILITY IS NOT SWITCHED OFF — that would have taken the working case with it.
  ok(rows[1].faction_game, 'the rebel still gets a scan result');
  // null rather than undefined: the rules read `row.faction_game?.carrying`, so a skipped
  // row and an empty one must mean the same thing to them.
  eq(rows[0].faction_game, null, 'a skipped row reads as nothing to do, not as unasked');
  ok(rows[0].faction_game_skipped, 'and it says why it was skipped');
});
