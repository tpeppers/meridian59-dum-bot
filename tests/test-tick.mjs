// THE TWO-PHASE TICK, AGAINST A FAKE BROKER THAT COUNTS CALLS.
//
// The cost model is the design, so it is tested as behaviour rather than trusted as a
// comment. `fleet` is free; `status` is four server requests per character. A quiet
// fleet must cost one call, not one plus N.

import assert from 'node:assert/strict';
import { pass } from '../src/loop/tick.mjs';
import { Journal } from '../src/record/journal.mjs';
import * as fx from './fixtures.mjs';

const test = globalThis.__dumTest;

/** A broker that answers from fixtures and remembers what it was asked. */
function fakeBroker({ board, status = {}, failStatus = false } = {}) {
  const calls = [];
  return {
    calls,
    url: 'http://127.0.0.1:8901',
    health: async () => ({ fleet: 'test', pid: 1, sessions: [] }),
    call: async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 'fleet') return { fleet: board };
      if (tool === 'status') {
        if (failStatus) throw new Error('status refused');
        return status[args.agent] ?? {};
      }
      return {};
    },
    write: async (tool, args, opts) => { calls.push(['write:' + tool, args]); return { dry_run: true }; },
  };
}

const quietJournal = () => new Journal({ dir: 'var/test', enabled: false });

/** A board row in the harness's own shape. */
const row = (agent, over = {}) => ({
  agent, character: agent.toUpperCase(), in_game: true,
  room: 'a hunting room', room_num: 71,
  health: '30/30', vigor_of: '160/200', level: 30,
  activity: 'hunting: giant rat', strategy: 'baseline',
  autopilot: { mode: 'farm', running: true, hunt: 'giant rat' },
  committed: null, parked: null, stalled: false, purse: 100, banked: 0,
  ...over,
});

const statusFor = (policy = {}) => ({
  vitals: { health: { value: 30, max: 30 } },
  where: { num: 71, name: 'a hunting room' },
  autopilot: { mode: 'farm', running: true, policy: { hunt: 'giant rat', strategy: 'baseline', ...policy } },
});

test('tick: a doctrine with no opinion costs exactly one call for the whole fleet', async () => {
  const broker = fakeBroker({ board: [row('role-a'), row('role-b'), row('role-c')] });
  await pass({ broker, config: fx.doctrine({ goals: { ladder: [] } }),
               journal: quietJournal(), commit: false });
  assert.deepEqual(broker.calls.map(c => c[0]), ['fleet']);
});

test('tick: a report-only outcome never pays for status', async () => {
  // A character on an errand is left alone by the first rule in the table, and that
  // conclusion is reachable from the free board.
  const broker = fakeBroker({ board: [row('role-a', { committed: { kind: 'errand', label: 'a loot run' } })] });
  await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false });
  assert.deepEqual(broker.calls.map(c => c[0]), ['fleet']);
});

test('tick: an order pays for status, once, and only for that character', async () => {
  const broker = fakeBroker({
    board: [row('role-a'), row('role-b', { committed: { kind: 'errand', label: 'a loot run' } })],
    status: { 'role-a': statusFor() },
  });
  await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false });
  const tools = broker.calls.map(c => c[0]);
  assert.equal(tools.filter(t => t === 'fleet').length, 1);
  assert.equal(tools.filter(t => t === 'status').length, 1);
  assert.equal(broker.calls.find(c => c[0] === 'status')[1].agent, 'role-a');
});

test('tick: the second decision may find the keeper already has the orders, and then nothing is sent', async () => {
  // The ladder's active rung for a 30-max-health character is `to-60`, orders
  // strategy=trader. Give the keeper that already.
  const broker = fakeBroker({
    board: [row('role-a')],
    status: { 'role-a': statusFor({ strategy: 'trader' }) },
  });
  const result = await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false });
  assert.equal(result.characters[0].applied.kind, 'no-change');
  assert.ok(!broker.calls.some(c => c[0].startsWith('write:')));
});

test('tick: a difference reaches the dry-run write path and no further', async () => {
  const broker = fakeBroker({
    board: [row('role-a')],
    status: { 'role-a': statusFor({ strategy: 'baseline' }) },
  });
  const result = await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false });
  assert.equal(result.characters[0].applied.kind, 'dry-run');
  assert.deepEqual(result.characters[0].applied.sent,
                   { agent: 'role-a', action: 'start', strategy: 'trader' });
});

test('tick: one parked character stands the whole pass down', async () => {
  // A parked keeper is deliberately doing nothing before a fleet update. Reading that
  // as a stall and "fixing" it sends the character back to work in the minute before the
  // broker goes down.
  const broker = fakeBroker({ board: [row('role-a', { parked: { ready: false } }), row('role-b')] });
  const result = await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false });
  assert.match(result.fleet.stood_down, /parking for a fleet update/);
  assert.equal(result.characters.length, 0);
  assert.deepEqual(broker.calls.map(c => c[0]), ['fleet']);
});

test('tick: a character whose status read fails does not stop the ones after it', async () => {
  const broker = fakeBroker({ board: [row('role-a'), row('role-b')], failStatus: true });
  const result = await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false });
  assert.equal(result.characters.length, 2);
  assert.ok(result.characters.every(l => /status refused/.test(l.error)));
});

test('tick: --agent restricts the characters but still reads the board', async () => {
  const broker = fakeBroker({
    board: [row('role-a'), row('role-b')],
    status: { 'role-a': statusFor() },
  });
  const result = await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false },
                            { only: 'role-a' });
  assert.equal(result.characters.length, 1);
  assert.equal(result.characters[0].agent, 'role-a');
});

test('tick: an unknown --agent says so rather than silently doing nothing', async () => {
  const broker = fakeBroker({ board: [row('role-a')] });
  const result = await pass({ broker, config: fx.doctrine(), journal: quietJournal(), commit: false },
                            { only: 'nobody' });
  assert.match(result.note, /no character named "nobody"/);
});

test('tick: fleet rules can be skipped while the board is still read', async () => {
  const broker = fakeBroker({ board: [row('role-a', { committed: { kind: 'errand', label: 'x' } })] });
  const result = await pass({ broker, config: fx.doctrine({ party: { pair: true } }),
                              journal: quietJournal(), commit: false },
                            { decideFleet: false });
  assert.equal(result.fleet.decided, false);
  assert.equal(result.fleet.considered, undefined);
});
