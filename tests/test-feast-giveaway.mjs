import assert from 'node:assert/strict';
import { feastFleetRules } from '../src/decide/rules/feast.mjs';
import { FEAST_HALL } from '../src/decide/feast-hall.mjs';
import { GIVEAWAY_YELL, GIVEAWAY_KEEP, STREETS_OF_TOS, giveawaySteps }
  from '../src/decide/street-giveaway.mjs';
import { deny } from '../src/link/surface.mjs';

const test = globalThis.__dumTest;
const rule = feastFleetRules.find(r => r.id === 'feast-hall-larder');

// THE OUTBOUND ERRAND IS A LAUNCH, AND THAT IS A THROUGHPUT PROPERTY, NOT A STYLE.
//
// The street giveaway was bolted onto the front of this errand for a few hours. The
// behaviour was what the operator asked for and the placement was a bug: the giveaway's
// first step is a `travel` with `expect: 'arrived'`, which BLOCKS — eight room hops to Tos,
// then a drop, then a yell, before the step that actually launches the walk to the hall.
//
// A fleet pass runs ONE errand and the pass is two minutes, so every dispatch held the whole
// rule table for ten minutes and the fleet managed one character per pass at best against a
// round trip of twenty-two minutes. It can never catch up with itself.
//
// The giveaway now runs on the sell circuit, which is a deliberate long errand that can
// afford to block, and which every character takes anyway because that circuit finishes at
// the Duke's tables. Its ordering is asserted in test-sellrun-vault-bank.mjs.

const NOW = 1_700_000_000_000;
const doctrine = { feast: { on: true }, food: {} };
const row = (over = {}) => ({ agent: 'a', in_game: true, room: 39, carrying: 6,
                              health: { pct: 1 }, travel_to_feast: { hops: 4, ms: 5 * 60_000 },
                              policy: { assignedRoom: 39 }, ...over });
const dispatch = (rows = [row()], d = doctrine) =>
  rule.decide({ at: NOW, memory: { feast: {} }, characters: rows }, d);

test('feast: the outbound errand launches and returns — nothing in it blocks', () => {
  const s = dispatch().orders.steps;
  // THE STATION FIRST, AND IT IS THE STEP THAT ACTUALLY WORKS.
  //
  // Read live on prod: `faculties = { work: "keeper", movement: "keeper", ... }` — DUM holds
  // nothing, the doctrine's `claim` block is an intention rather than a fact, and the keeper
  // (mode farm, assignedRoom 39, roam false) was walking every dispatched character straight
  // back home to farm. Asking it to travel and then leaving it under its own orders is asking
  // it to change its mind, which it does not. Moving its station moves where it wants to be.
  assert.equal(s[0].tool, 'autopilot');
  assert.equal(s[0].args.assigned_room, FEAST_HALL.room);
  const walk = s.find(x => x.tool === 'travel');
  assert.equal(walk.args.to, FEAST_HALL.room);
  assert.equal(walk.args.background, true, 'fired and forgotten');
  assert.equal(walk.expect, undefined, 'nothing waits for arrival here');
  for (const step of s) assert.notEqual(step.expect, 'arrived', `${step.tool} must not block`);
  // The arrival is read off the board by a later tick. A step that waits for it would hold
  // the pass, and the pass is the scarce thing.
  assert.equal(s.some(x => x.tool === 'drop_all' || x.tool === 'say'), false,
               'the giveaway belongs to the sell circuit, which can afford to block');
});

test('feast: the station is handed back, or the character lives at the feast', () => {
  // The outbound leg makes the hall this character's home so its keeper will go and stay.
  // Leaving it there is a character that has its food and never works again.
  const grab = rule.decide({ at: NOW, memory: { feast: { a: { phase: 'outbound', since: NOW, from: 39 } } },
                             characters: [row({ room: FEAST_HALL.room, policy: { assignedRoom: FEAST_HALL.room } })] }, doctrine);
  const back = (grab.orders.steps ?? []).filter(x => x.tool === 'autopilot');
  assert.equal(back.length, 1, 'exactly one hand-back');
  assert.equal(back[0].args.assigned_room, 39, 'to where it came from');
  assert.equal(back[0].always, true, 'even if the taking failed');
  const idx = grab.orders.steps.indexOf(back[0]);
  const home = grab.orders.steps.findIndex(x => x.tool === 'travel');
  assert.ok(idx < home, 'and before the walk home, which is only a nudge');
});

test('feast: several characters go per pass, because one cannot keep a fleet fed', () => {
  // THE ARITHMETIC. The fleet pass is two minutes and this table returns one intent, so one
  // dispatch per pass is one character every two minutes at best — forty-two minutes to send
  // twenty-one against a round trip of about twenty-two.
  const rows = Array.from({ length: 9 }, (_, i) =>
    row({ agent: `a${i}`, travel_to_feast: { hops: 3 + i, ms: (4 + i) * 60_000 } }));
  const out = dispatch(rows);
  const agents = [...new Set(out.orders.steps.map(s => s.args.agent))];
  assert.equal(agents.length, 6, 'six characters go per pass');
  assert.equal(agents[0], 'a0', 'nearest first');
  assert.deepEqual(out.orders.context.also, agents.slice(1),
                   'and the errand names the others so their memory is written too');
  // Each of them gets the station move AND the nudge, so the count is two per character.
  assert.equal(out.orders.steps.length, agents.length * 2);
});

test('feast: every launched character gets a memory entry, not just the addressed one', async () => {
  // A walk with no memory entry behind it is a walk the station rule reads as being out of
  // position and recalls — the exact failure that produced 28 recalls and zero food. The
  // errand holds `busy` on one agent; the rest are protected by `phase: 'outbound'`.
  const { recordFeastOutbound } = await import('../src/decide/rules/feast.mjs');
  const { patch } = recordFeastOutbound({
    agent: 'a', at: NOW, was: {},
    context: { home: 39, ms: 6e5, also: ['b', 'c'],
               home_by_agent: { a: 39, b: 41, c: 39 }, ms_by_agent: { b: 7e5 } },
  });
  for (const who of ['a', 'b', 'c'])
    assert.equal(patch[who].phase, 'outbound', `${who} is on the road`);
  assert.equal(patch.b.from, 41, 'each remembers its own home to walk back to');
  assert.equal(patch.b.ms, 7e5, 'and its own walk length, for the hold on the way back');
  assert.equal(patch._stats.dispatched, 3, 'all three are counted, not one');
});

test('feast: every stale journey is cleared in ONE pass', async () => {
  // A stale entry BLOCKS re-dispatch — `phase === 'outbound'` reads as "already walking
  // there" — so clearing them one per pass is two minutes of that character going nowhere,
  // each. Measured on prod: nine sat in `outbound` for over two hours while the sweep that
  // would have cleared them was starved by a rule above it in the table.
  const { recordFeastAbandon } = await import('../src/decide/rules/feast.mjs');
  const { patch, read } = recordFeastAbandon({
    agent: 'a', at: NOW, was: {},
    context: { where: 39, also: ['b', 'c'], where_by_agent: { b: 950, c: null } },
  });
  for (const who of ['a', 'b', 'c']) assert.equal(patch[who].phase, null, who);
  assert.match(patch.b.why, /last seen in 950/, 'each says where it actually stopped');
  assert.match(patch.c.why, /last seen in \?/, 'and unknown says unknown');
  assert.equal(patch._stats.abandoned, 3);
  assert.deepEqual(read.also_cleared, ['b', 'c']);
});

test('feast: a character already on the road is not sent again', () => {
  const out = rule.decide({ at: NOW, characters: [row()],
                            memory: { feast: { a: { phase: 'outbound', since: NOW - 60_000 } } } },
                          doctrine);
  assert.equal(out?.kind, 'pass', JSON.stringify(out?.orders ?? out));
});

test('giveaway: the shared step builder is what both routes use', () => {
  // One definition, imported by the sell circuit and by nothing else now. Kept under test
  // here because this file is where the giveaway's argument is written down.
  const s = giveawaySteps('a');
  assert.deepEqual(s.map(x => x.tool), ['travel', 'drop_all', 'say']);
  assert.equal(s[0].args.to, STREETS_OF_TOS);
  assert.equal(s[0].label, 'in-the-street');
  assert.equal(s[1].needs, 'in-the-street');
  assert.equal(s[2].needs, 'in-the-street');
  assert.equal(s[2].args.text, GIVEAWAY_YELL);
  assert.equal(s[2].args.type, 'yell');
  for (const step of s) assert.equal(step.optional, true, step.tool);
  assert.deepEqual(s[1].args.keep, GIVEAWAY_KEEP);
});

test('giveaway: every food the Duke hands out is spared, all seven', async () => {
  // THE LIST WAS TYPED AND IT DRIFTED. It named two of the seven things the hall dispenses,
  // so `spider eye`, `bunch of grapes`, `drumstick`, `goblet of ale` and `fortune cookie`
  // were dropped in the road or sold in Barloque — and the spider eye is nutrition 9, the
  // same as a slice of pork, with six hundred of them in the fleet's packs.
  //
  // It is derived from FEAST_DISPENSERS now, which is the same list the grab errand walks up
  // to and activates, so it cannot disagree with what actually comes home. This test exists
  // so a future hand-edit that breaks the derivation is caught rather than discovered.
  const { FEAST_DISPENSERS } = await import('../src/decide/feast-hall.mjs');
  const kept = n => GIVEAWAY_KEEP.some(k => n.toLowerCase().includes(String(k).toLowerCase()));
  for (const d of FEAST_DISPENSERS)
    assert.equal(kept(d.item), true, `${d.item} comes from the hall and must not be shed`);
  assert.equal(FEAST_DISPENSERS.length, 7, 'seven tables; if this changes, read the hall');
});

test('giveaway: the keep list spares food and reagents, and never a weapon', () => {
  const kept = n => GIVEAWAY_KEEP.some(k => n.toLowerCase().includes(k.toLowerCase()));
  for (const meal of ['slice of pork', 'bowl of soup', 'edible mushroom', 'Inky-cap mushroom'])
    assert.equal(kept(meal), true, meal);
  for (const reagent of ['herb', 'elderberry']) assert.equal(kept(reagent), true, reagent);
  for (const weapon of ['battle axe', 'long sword', 'mace', 'dagger'])
    assert.equal(kept(weapon), false, `${weapon} is sold in Barloque, not spared here`);
  // Money and worn items are the harness's own floors, deliberately not repeated here.
  assert.equal(GIVEAWAY_KEEP.some(k => /shilling/i.test(k)), false);
});

test('giveaway: the surface lets it put things down, and still not pick them up', () => {
  assert.equal(deny('drop_all', { agent: 'a', keep: [] }), null);
  assert.match(deny('act', { verb: 'drop', target: 'wand' }) ?? '', /reaches into/);
  assert.match(deny('act', { verb: 'get', target: 'wand' }) ?? '', /reaches into/);
  assert.equal(deny('say', { text: GIVEAWAY_YELL, type: 'yell' }), null);
});

// ---------------------------------------------------------------- the two rules cooperate
//
// A CHARACTER WALKED OUT OF THE FEAST HALL WITH TEN LONG SWORDS AND 150 MUSHROOMS.
//
// Both halves of the design existed and the ORDERING starved one of them. The rule table
// returns one intent per pass; the feast sits above the sell circuit and is uncapped, so it
// had something to say on nearly every pass and the circuit below it was never reached.
// Measured on prod the same day, 20,340 journal lines: sell 0, vault 0, bank 0, drop_all 0.
// Not rare — never. So the giveaway, which lives on the circuit, could not run either, and
// characters arrived at the free food with no room to carry any of it.
//
// The fix is that the feast rule declines the characters the circuit wants. It costs the
// feast nothing, because `sellrun.finish` is `feast` — the circuit ENDS at the Duke's tables.
test('feast: a heavy character is left to the sell circuit, which ends at the hall anyway', () => {
  const withSell = { ...doctrine, sellrun: { on: true, trigger: { carry_at: 32, min_health: 0.8 } } };
  const heavy = rule.decide({ at: NOW, characters: [row({ carrying: 40 })], memory: {} }, withSell);
  assert.notEqual(heavy?.orders?.errand, 'feast-outbound',
                  'a heavy character must not be dispatched straight to the hall');
  // And the refusal says which rule is taking it, so an operator reading the skip list is
  // not left thinking the character was simply ignored.
  const why = JSON.stringify(heavy?.evidence ?? heavy ?? {});
  assert.match(why + JSON.stringify(heavy?.why ?? ''), /sell circuit|heavy/i);
});

test('feast: a light character is still dispatched — the refusal is about the pack, not the trip', () => {
  const withSell = { ...doctrine, sellrun: { on: true, trigger: { carry_at: 32, min_health: 0.8 } } };
  const light = rule.decide({ at: NOW, characters: [row({ carrying: 6 })], memory: {} }, withSell);
  assert.equal(light?.orders?.errand, 'feast-outbound', 'a light pack has nothing to sell');
});

test('feast: turning the sell circuit off does not quietly stop the feast', () => {
  // The refusal reads the circuit's own config, so it switches itself off with it. Otherwise
  // an operator disabling selling would strand every heavy character with no route to food.
  const off = { ...doctrine, sellrun: { on: false, trigger: { carry_at: 32 } } };
  const d = rule.decide({ at: NOW, characters: [row({ carrying: 40 })], memory: {} }, off);
  assert.equal(d?.orders?.errand, 'feast-outbound');
});

test('feast: with no sellrun block at all the feast behaves as it always did', () => {
  const d = rule.decide({ at: NOW, characters: [row({ carrying: 6 })], memory: {} }, doctrine);
  assert.equal(d?.orders?.errand, 'feast-outbound');
});
