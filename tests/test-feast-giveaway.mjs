import assert from 'node:assert/strict';
import { feastFleetRules, boundForBarloque,
         STREETS_OF_TOS, GIVEAWAY_YELL, GIVEAWAY_KEEP } from '../src/decide/rules/feast.mjs';
import { FEAST_HALL } from '../src/decide/feast-hall.mjs';
import { deny } from '../src/link/surface.mjs';

const test = globalThis.__dumTest;
const rule = feastFleetRules.find(r => r.id === 'feast-hall-larder');

// LOOT ON A ROUTE THAT PASSES NO MERCHANT IS DEAD WEIGHT.
//
// The sell circuit exists to turn a pack into banked shillings, and it goes to Barloque. The
// feast run goes to Tos and back and passes nobody who buys anything — so everything not
// worn is being carried eleven hops in each direction for nothing, in a pack whose whole
// purpose on that trip is to come home full of food.
//
// So it goes in the road, in the Streets of Tos, and the character yells about it. On a
// SHARED SERVER a pile of free equipment in a public street is a gift rather than litter,
// which is the operator's call and the reason the yell is part of it rather than an
// afterthought. Operator's words, 2026-09-05.

const NOW = 1_700_000_000_000;
const doctrineWith = (over = {}) => ({
  feast: { on: true, giveaway: { on: true }, ...(over.feast ?? {}) },
  food: {}, ...over,
});
const row = (over = {}) => ({ agent: 'a', in_game: true, room: 39, carrying: 6,
                              health: { pct: 1 }, travel_to_feast: { hops: 4, ms: 5 * 60_000 },
                              policy: { assignedRoom: 39 }, ...over });
const obs = (r, memory = {}) => ({ at: NOW, memory: { feast: memory }, characters: [r] });
const steps = (r = row(), d = doctrineWith()) => {
  const out = rule.decide(obs(r), d);
  return out?.orders?.steps ?? [];
};
const tools = (...args) => steps(...args).map(s => s.tool);

test('giveaway: the pack goes in the road before the hall, and the street is told', () => {
  const s = steps();
  assert.deepEqual(s.map(x => x.tool), ['travel', 'drop_all', 'say', 'travel']);
  assert.equal(s[0].args.to, STREETS_OF_TOS, 'the Streets of Tos');
  assert.equal(s[3].args.to, FEAST_HALL.room, 'and then the hall');
  assert.equal(s[2].args.text, GIVEAWAY_YELL);
  assert.equal(s[2].args.type, 'yell', 'a yell carries to the adjacent rooms; a say does not');
});

test('giveaway: the stop is free — it is on the way, not a detour', () => {
  // Measured off the bake: Castle Victoria to the hall is 11 room hops, and Castle Victoria
  // -> Streets of Tos -> the hall is 8 + 3. That is most of the argument for doing this on
  // the feast run rather than as an errand of its own, so it is worth stating in a test
  // that will be read the next time somebody wonders why the giveaway lives here.
  assert.equal(STREETS_OF_TOS, 50);
});

test('giveaway: a pack worth selling goes to Barloque instead', () => {
  // THE WHOLE GATE. "Personal routes that do not go to Barloque" — a pack heavy enough for
  // the sell circuit is worth the trip that turns it into banked shillings, and dropping it
  // would throw that trip away. It reads the circuit's OWN trigger so the two rules cannot
  // drift into disagreeing about what "heavy" means.
  const selling = { sellrun: { on: true, trigger: { carry_at: 32 } } };
  assert.equal(boundForBarloque({ carrying: 40 }, selling), true);
  assert.equal(boundForBarloque({ carrying: 31 }, selling), false);
  assert.deepEqual(tools(row({ carrying: 40 }), doctrineWith(selling)),
                   ['travel'], 'the heavy one just goes to the hall, pack intact');
  assert.deepEqual(tools(row({ carrying: 6 }), doctrineWith(selling)),
                   ['travel', 'drop_all', 'say', 'travel']);
});

test('giveaway: with no sell circuit there is no Barloque route to spare a pack for', () => {
  assert.equal(boundForBarloque({ carrying: 999 }, { sellrun: { on: false } }), false);
  assert.equal(boundForBarloque({ carrying: 999 }, {}), false);
});

test('giveaway: off by default — it is irreversible, so it is opted into', () => {
  // Dropped is gone. There is no retrieval fee and no undo, which is the one way this is
  // unlike the vault, so silence must mean the behaviour that was already there.
  assert.deepEqual(tools(row(), { feast: { on: true }, food: {} }), ['travel']);
  assert.deepEqual(tools(row(), { feast: { on: true, giveaway: { on: false } }, food: {} }),
                   ['travel']);
});

test('giveaway: the food it is walking there for is never dropped', () => {
  // Shedding the meal on the way to fetch the meal. The reagents are what Create Food is
  // made of, and they are the other thing worth more in the pack than in the road.
  const keep = steps()[1].args.keep;
  for (const meal of ['slice of pork', 'bowl of soup', 'edible mushroom', 'Inky-cap mushroom'])
    assert.ok(keep.some(k => meal.toLowerCase().includes(k.toLowerCase())), meal);
  for (const reagent of ['herb', 'elderberry'])
    assert.ok(keep.includes(reagent), reagent);
  // Money and worn items are NOT here on purpose: they are floors the harness enforces for
  // itself, because the caller that forgets them is exactly the case a floor exists for.
  assert.equal(keep.some(k => /shilling/i.test(k)), false,
               'money is the harness\'s floor, not a list entry');
  assert.deepEqual(keep, GIVEAWAY_KEEP);
});

test('giveaway: nothing is shed in a room the walk never reached', () => {
  // A pile in a merchant's doorway or on a staging square is antisocial in a way the street
  // is not, so the drop and the yell both name the walk they depend on.
  const s = steps();
  assert.equal(s[0].label, 'in-the-street');
  assert.equal(s[0].expect, 'arrived');
  assert.equal(s[1].needs, 'in-the-street');
  assert.equal(s[2].needs, 'in-the-street');
  // And none of the three may cost the character its food run.
  for (const i of [0, 1, 2]) assert.equal(s[i].optional, true, `step ${i} is optional`);
});

test('giveaway: the surface lets it put things down, and still not pick them up', () => {
  // `drop_all` cannot name an item — it sheds everything not worn, not money and not kept,
  // and refuses when the equipment set is unknown. The item-by-item pack verbs stay out.
  assert.equal(deny('drop_all', { agent: 'a', keep: [] }), null);
  assert.match(deny('act', { verb: 'drop', target: 'wand' }) ?? '', /reaches into/);
  assert.match(deny('act', { verb: 'get', target: 'wand' }) ?? '', /reaches into/);
  assert.equal(deny('say', { text: GIVEAWAY_YELL, type: 'yell' }), null);
});
