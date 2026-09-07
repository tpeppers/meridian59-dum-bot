import assert from 'node:assert/strict';
import { recordFeastOutbound, recordFeastGrab, recordFeastAbandon,
         feastStats, feastStatsLine, STATS_KEY } from '../src/decide/rules/feast.mjs';

const test = globalThis.__dumTest;

// COUNT WHAT THE FEAST ACTUALLY DID.
//
// It took a day to get one slice of pork out of the Duke's hall, and most of that day went
// on questions the fleet could not answer about itself: had a courier ever arrived, had one
// ever taken anything, was "no food" a routing failure or a taking failure. Every answer
// came from reading a keeper's pack by hand. These counters are so the next question is one
// line of the pass report.

// The memory merge the tick performs: a patch's top-level keys replace, which is why the
// counters are computed from the pre-errand snapshot `was` rather than incremented in place.
const apply = (mem, { patch }) => { for (const [k, v] of Object.entries(patch)) mem[k] = v; return mem; };
const TOOK = 'You slice yourself a hefty slab of roast pig.';   // pork.kod's own line
const FULL = "You can't hold anything more!";
const ctx = { dispenser: 'roast pig' };

test('feast stats: they accumulate across errands rather than resetting', () => {
  let mem = {};
  apply(mem, recordFeastOutbound({ agent: 'a', at: 1, context: { home: 39, ms: 6e5 }, was: mem }));
  apply(mem, recordFeastOutbound({ agent: 'b', at: 2, context: { home: 39, ms: 6e5 }, was: mem }));
  assert.equal(feastStats(mem).dispatched, 2, 'two journeys started');

  apply(mem, recordFeastGrab({ agent: 'a', at: 3, transcript: [TOOK, TOOK, TOOK],
                               results: [{ tool: 'act' }, { tool: 'act' }, { tool: 'act' }],
                               context: ctx, was: mem }));
  const s = feastStats(mem);
  assert.equal(s.dispatched, 2, 'the dispatch count survived the grab');
  assert.equal(s.taken, 3, 'three slices');
  assert.equal(s.arrived, 1);
  assert.equal(s.trips_ok, 1);
});

test('feast stats: a pack that fills is counted, and is not a failure', () => {
  let mem = {};
  apply(mem, recordFeastGrab({ agent: 'a', at: 1, transcript: [TOOK, TOOK, FULL],
                               results: [{ tool: 'act' }, { tool: 'act' }, { tool: 'act' }],
                               context: ctx, was: mem }));
  const s = feastStats(mem);
  assert.equal(s.taken, 2, 'the refusal is not a slice');
  assert.equal(s.packs_filled, 1);
  assert.equal(s.trips_ok, 1, 'filling the pack is the errand SUCCEEDING');
  assert.equal(s.trips_empty, 0);
});

test('feast stats: a trip that took nothing is counted as empty', () => {
  // The case the whole investigation was about: arrived, and came away with nothing.
  let mem = {};
  apply(mem, recordFeastGrab({ agent: 'a', at: 1, transcript: [],
                               results: [], context: ctx, was: mem }));
  const s = feastStats(mem);
  assert.equal(s.taken, 0);
  assert.equal(s.trips_ok, 0);
  assert.equal(s.trips_empty, 1);
});

test('feast stats: an abandoned journey is counted separately from an empty trip', () => {
  let mem = {};
  apply(mem, recordFeastAbandon({ agent: 'a', at: 1, context: { where: 950 }, was: mem }));
  assert.equal(feastStats(mem).abandoned, 1);
  assert.equal(feastStats(mem).trips_empty, 0, 'never arriving is not the same as taking nothing');
});

test('feast stats: the counters are not mistaken for a character', () => {
  // The memory is `agent -> entry` and the counters live in it under a key no agent can
  // have. If a loop over the memory ever treats `_stats` as a character, the symptom is an
  // errand addressed to an agent that does not exist.
  assert.equal(STATS_KEY.startsWith('_'), true, 'not a legal agent name');
  let mem = {};
  apply(mem, recordFeastOutbound({ agent: 'a', at: 1, context: { home: 39, ms: 6e5 }, was: mem }));
  assert.equal(mem[STATS_KEY].phase, undefined, 'the counters have no phase to be walked on');
});

test('feast stats: the report line says nothing until something has happened', () => {
  assert.equal(feastStatsLine({}), '', 'a quiet fleet gets a quiet report');
  let mem = {};
  apply(mem, recordFeastGrab({ agent: 'a', at: 1, transcript: [TOOK, TOOK],
                               results: [{ tool: 'act' }, { tool: 'act' }],
                               context: ctx, was: mem }));
  const line = feastStatsLine(mem);
  assert.match(line, /2 food taken over 1 trip/);
  assert.match(line, /2\/trip/, 'the per-trip average is the number worth watching');
});
