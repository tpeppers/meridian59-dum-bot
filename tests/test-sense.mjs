import assert from 'node:assert/strict';
import { normalizeFleetRow, normalizeStatus } from '../src/sense/normalize.mjs';

const test = globalThis.__dumTest;

// A row in the shape the harness's `fleet` tool actually emits. Kept verbatim rather
// than tidied, because the point of these tests is the gap between what the harness
// says and what the rules read.
const boardRow = () => ({
  agent: 'role-a',
  character: 'ROLE-A',
  room: 'a hunting room',          // <- the NAME, not the number
  room_num: 71,
  health: '27/30',                 // <- a string, not an object
  mana: '18/20',
  level: 30,
  vigor: 160,
  vigor_of: '160/200',
  has_weapon: true,
  has_food: true,
  activity: 'hunting: giant rat',
  parked: null,
  committed: null,                 // <- `committed`, not `commitment`
  carrying: 9,
  purse: 731,
  banked: 1200,
  strategy: 'baseline',
  partner: 'role-b',
  partner_ok: false,
  kills_30m: 4,
  autopilot: { mode: 'farm', running: true, kills: 41, kills_30m: 4, hunt: 'giant rat' },
  stalled: false,
});

test('board: `room` is a name and `room_num` is the number', () => {
  // Reading row.room as a number silently yields NaN, and every room comparison then
  // fails closed — a rule that never matches looks exactly like a rule with nothing
  // to do.
  const r = normalizeFleetRow(boardRow());
  assert.equal(r.room, 71);
  assert.equal(r.room_name, 'a hunting room');
});

test('board: "27/30" is parsed into a vital', () => {
  const r = normalizeFleetRow(boardRow());
  assert.deepEqual(r.health, { value: 27, max: 30, pct: 0.9 });
  assert.equal(r.vigor.max, 200);
});

test('board: max health IS the level', () => {
  const r = normalizeFleetRow(boardRow());
  assert.equal(r.max_health, 30);
  assert.equal(r.level, 30);
});

test('board: `committed` is read as the commitment', () => {
  // Reading the wrong one sees no commitments at all, which means happily redirecting
  // characters that are halfway through an errand.
  const raw = boardRow();
  raw.committed = { kind: 'errand', label: 'signet: an owner' };
  assert.equal(normalizeFleetRow(raw).commitment.kind, 'errand');
});

test('board: mode and hunt come out of the nested autopilot summary', () => {
  const r = normalizeFleetRow(boardRow());
  assert.equal(r.mode, 'farm');
  assert.equal(r.hunting, 'giant rat');
});

test('board: a one-sided pairing is visible as partner_ok=false', () => {
  const r = normalizeFleetRow(boardRow());
  assert.equal(r.partner, 'role-b');
  assert.equal(r.partner_ok, false);
});

test('board: purse and banked are separate and are never summed', () => {
  const r = normalizeFleetRow(boardRow());
  assert.equal(r.purse, 731);
  assert.equal(r.banked, 1200);
});

test('board: an unseen bank balance is null, not zero', () => {
  const raw = boardRow();
  raw.banked = null;
  // "nobody has seen this character at a counter" must not render as a balance of zero.
  assert.equal(normalizeFleetRow(raw).banked, null);
});

test('board: stalled:false normalises to null, an object survives', () => {
  assert.equal(normalizeFleetRow(boardRow()).stalled, null);
  const raw = boardRow();
  raw.stalled = { why: 'no progress' };
  assert.deepEqual(normalizeFleetRow(raw).stalled, { why: 'no progress' });
});

test('board: the board carries no keeper policy, and says so', () => {
  const r = normalizeFleetRow(boardRow());
  assert.equal(r.keeper.policy, null);
  assert.equal(r.depth, 'board');
});

test('board: a missing field is null, never zero', () => {
  const r = normalizeFleetRow({ agent: 'x' });
  assert.equal(r.level, null);
  assert.equal(r.purse, null);
  assert.equal(r.room, null);
  // A null level must never satisfy a "below 30" test.
  assert.notEqual(r.level, 0);
});

test('status: merges onto the board row rather than replacing it', () => {
  const base = normalizeFleetRow(boardRow());
  const merged = normalizeStatus(base, {
    where: { num: 88, name: 'somewhere else' },
    vitals: { health: { value: 12, max: 30 } },
    autopilot: { mode: 'farm', policy: { hunt: 'giant rat', bankAbove: 500 } },
  });
  // Taken from status…
  assert.equal(merged.room, 88);
  assert.equal(merged.health.value, 12);
  assert.equal(merged.keeper.policy.bankAbove, 500);
  assert.equal(merged.depth, 'status');
  // …while the board-only fields survive, which is why it is a merge.
  assert.equal(merged.purse, 731);
  assert.equal(merged.kills_30m, 4);
});

test('status: refusals default to an empty list, not to a guess', () => {
  const merged = normalizeStatus(normalizeFleetRow(boardRow()), {});
  assert.deepEqual(merged.refusals, []);
  assert.equal(merged.waiting_on, null);
});
