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
  assert.equal(s.length, 1, 'one step per character dispatched');
  assert.equal(s[0].tool, 'travel');
  assert.equal(s[0].args.to, FEAST_HALL.room);
  assert.equal(s[0].args.background, true, 'fired and forgotten');
  assert.equal(s[0].expect, undefined, 'nothing waits for arrival here');
  // The arrival is read off the board by a later tick. A step that waits for it would hold
  // the pass, and the pass is the scarce thing.
  assert.equal(s.some(x => x.tool === 'drop_all' || x.tool === 'say'), false,
               'the giveaway belongs to the sell circuit, which can afford to block');
});

test('feast: several characters go per pass, because one cannot keep a fleet fed', () => {
  // THE ARITHMETIC. The fleet pass is two minutes and this table returns one intent, so one
  // dispatch per pass is one character every two minutes at best — forty-two minutes to send
  // twenty-one against a round trip of about twenty-two.
  const rows = Array.from({ length: 9 }, (_, i) =>
    row({ agent: `a${i}`, travel_to_feast: { hops: 3 + i, ms: (4 + i) * 60_000 } }));
  const out = dispatch(rows);
  const sent = out.orders.steps.map(s => s.args.agent);
  assert.equal(sent.length, 6, 'the default batch');
  assert.equal(new Set(sent).size, 6, 'each character once');
  assert.equal(sent[0], 'a0', 'nearest first');
  assert.deepEqual(out.orders.context.also, sent.slice(1),
                   'and the errand names the others so their memory is written too');
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
