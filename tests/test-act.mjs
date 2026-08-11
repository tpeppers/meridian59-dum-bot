import assert from 'node:assert/strict';
import { planOrders, apply, ORDER_FIELDS } from '../src/act/orders.mjs';
import { verify } from '../src/act/verify.mjs';
import { deny, ALLOWED, NOT_YET } from '../src/link/surface.mjs';
import { checkFleet, FleetMismatch } from '../src/link/guard.mjs';
import * as fx from './fixtures.mjs';

const test = globalThis.__dumTest;

// ---------------------------------------------------------------- the diff

test('orders: an intent the keeper already satisfies sends nothing', () => {
  // The whole reason the diff exists. Re-asserting the same policy every thirty seconds
  // looks identical to working, lands in the persisted roster, and pins a value that
  // would otherwise track the harness's own default.
  const intent = { rule: 'r', agent: 'role-a', orders: { action: 'start', mode: 'farm', bank_above: 500 } };
  const { send, unchanged } = planOrders(intent, fx.working());
  assert.equal(send, null);
  assert.deepEqual(unchanged, { mode: 'farm', bank_above: 500 });
});

test('orders: only the fields that differ are sent', () => {
  const intent = { rule: 'r', agent: 'role-a',
                   orders: { action: 'start', mode: 'farm', strategy: 'trader', bank_above: 500 } };
  const { send } = planOrders(intent, fx.working());
  assert.deepEqual(send, { agent: 'role-a', action: 'start', strategy: 'trader' });
});

test('orders: snake_case argument maps to the keeper\'s camelCase policy key', () => {
  // Getting this wrong is silent in the worst direction: a diff against a key that does
  // not exist reads as "always different", so the bot writes every tick and reports
  // success.
  const o = fx.working();
  o.keeper.policy.assignedRoom = 71;
  const { send } = planOrders({ rule: 'r', agent: 'role-a', orders: { assigned_room: 71 } }, o);
  assert.equal(send, null);
  const moved = planOrders({ rule: 'r', agent: 'role-a', orders: { assigned_room: 88 } }, o);
  assert.deepEqual(moved.send, { agent: 'role-a', action: 'start', assigned_room: 88 });
});

test('orders: every ORDER_FIELDS entry names a policy key, or says why it does not', () => {
  for (const [k, spec] of Object.entries(ORDER_FIELDS))
    assert.ok(spec.policy !== undefined, `${k} has no policy mapping and no note`);
  assert.equal(ORDER_FIELDS.mode.policy, null);
  assert.ok(ORDER_FIELDS.mode.note);
});

test('verify: policy writes are re-read from autopilot status, not generic character status', async () => {
  const calls = [];
  const broker = { call: async (tool, args) => {
    calls.push({ tool, args });
    return { mode: 'farm', policy: { farmCleanup: {
      enabled: true, max_floor_items: 12, keep_free_stacks: 1 } } };
  } };
  const wanted = { enabled: true, max_floor_items: 12, keep_free_stacks: 1 };
  const result = await verify(broker, { acted: true, kind: 'orders', sent: {
    agent: 'role-a', action: 'start', mode: 'farm', farm_cleanup: wanted } });
  assert.equal(result.verified, true);
  assert.deepEqual(calls, [{ tool: 'autopilot', args: { agent: 'role-a', action: 'status' } }]);
});

test('orders: a field ORDER_FIELDS has never heard of throws rather than being dropped', () => {
  // A rule that believes it is configuring something and is not is the failure this
  // catches. Silence here would be a doctrine setting that never takes.
  assert.throws(
    () => planOrders({ rule: 'r', agent: 'role-a', orders: { invented_field: 1 } }, fx.working()),
    /not in ORDER_FIELDS/);
});

test('orders: a board-only observation cannot be diffed, and is refused rather than defaulted', () => {
  // The fleet board is free but carries no keeper policy. Falling back to {} would make
  // every field read as "different", so the bot would write every setting every tick and
  // report success each time — the exact silent failure the diff exists to prevent.
  const boardOnly = { ...fx.working(), depth: 'board', keeper: { policy: null } };
  assert.throws(
    () => planOrders({ rule: 'r', agent: 'role-a', orders: { strategy: 'trader' } }, boardOnly),
    /depth=board/);
});

test('orders: a yielded field is dropped and reported, not sent', () => {
  // The supervisor outside this repository reapplies max_carry every ~60s. Two writers
  // on different cadences make the character's orders oscillate while both logs look
  // correct, so the fix is a written statement of who owns what, enforced at the write.
  const intent = { rule: 'r', agent: 'role-a',
                   orders: { action: 'start', strategy: 'trader', max_carry: 99 } };
  const { send, yielded } = planOrders(intent, fx.working(), { yieldTo: ['max_carry'] });
  assert.deepEqual(send, { agent: 'role-a', action: 'start', strategy: 'trader' });
  assert.deepEqual(yielded, { max_carry: 99 });
});

test('orders: yielding everything leaves nothing to send, and says which fields', () => {
  const intent = { rule: 'r', agent: 'role-a', orders: { action: 'start', max_carry: 99 } };
  const { send, why } = planOrders(intent, fx.working(), { yieldTo: ['max_carry'] });
  assert.equal(send, null);
  assert.match(why, /max_carry is yielded/);
});

test('orders: a yielded field is recorded as yielded, not as agreeing by coincidence', () => {
  // Different facts: one stays true when the other writer changes its mind.
  const intent = { rule: 'r', agent: 'role-a', orders: { action: 'start', bank_above: 500 } };
  const { yielded, unchanged } = planOrders(intent, fx.working(), { yieldTo: ['bank_above'] });
  assert.deepEqual(yielded, { bank_above: 500 });
  assert.deepEqual(unchanged, {});
});

test('orders: weapon_priority compares as a list, not by identity', () => {
  const o = fx.working();
  o.keeper.policy.weaponPriority = ['axe', 'mace'];
  const { send } = planOrders({ rule: 'r', agent: 'role-a',
                                orders: { weapon_priority: ['axe', 'mace'] } }, o);
  assert.equal(send, null);
});

test('orders: a report intent never sends', async () => {
  const calls = [];
  const fake = { write: (...a) => { calls.push(a); return { ok: true }; },
                 call: (...a) => { calls.push(a); return { ok: true }; } };
  const out = await apply(fake, { kind: 'report', why: 'look at this', evidence: {} }, fx.working());
  assert.equal(out.acted, false);
  assert.equal(calls.length, 0);
});

test('orders: a "none" intent never sends', async () => {
  const calls = [];
  const fake = { write: () => { calls.push(1); }, call: () => { calls.push(1); } };
  await apply(fake, { kind: 'none', why: 'leave it alone' }, fx.working());
  assert.equal(calls.length, 0);
});

test('orders: without --commit, even a real difference only reaches the dry-run path', async () => {
  const sent = [];
  const fake = {
    write: async (tool, args) => { sent.push(['write', tool, args]); return { dry_run: true }; },
    call: async () => { throw new Error('call() must not be reached without commit'); },
  };
  const out = await apply(fake,
    { rule: 'r', agent: 'role-a', kind: 'orders', orders: { action: 'start', strategy: 'trader' }, why: 'w' },
    fx.working(), { commit: false });
  assert.equal(out.acted, false);
  assert.equal(out.kind, 'dry-run');
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------- the surface

test('surface: leave is refused, and the refusal says why', () => {
  assert.match(deny('leave', {}), /only record of the account passwords/);
});

test('surface: reroll and join are refused', () => {
  assert.ok(deny('reroll', {}));
  assert.ok(deny('join', {}));
});

test('surface: autopilot is allowed but autopilot hard:true is not', () => {
  assert.equal(deny('autopilot', { agent: 'a', action: 'start' }), null);
  assert.match(deny('autopilot', { agent: 'a', action: 'stop', hard: true }), /instruments go dark/);
});

test('surface: DUM does not talk', () => {
  for (const t of ['say', 'chat', 'converse', 'inbox']) assert.ok(deny(t, {}), `${t} should be refused`);
});

test('surface: a tool nobody has heard of is refused with a pointer to the file', () => {
  assert.match(deny('teleport', {}), /src\/link\/surface\.mjs/);
});

test('surface: the allow-list and the not-yet list do not overlap', () => {
  for (const t of NOT_YET) assert.ok(!ALLOWED.has(t), `${t} is on both lists`);
});

// ---------------------------------------------------------------- the guard

const brokerHolding = (fleet, sessions = 21) => ({
  url: 'http://127.0.0.1:8901',
  health: async () => ({ fleet, pid: 123, sessions: Array(sessions).fill(0), root: '/x/m59-harness' }),
});

test('guard: committing against a broker holding another fleet throws', async () => {
  await assert.rejects(
    () => checkFleet(brokerHolding('other'), fx.doctrine(), { commit: true }),
    FleetMismatch);
});

test('guard: planning against another fleet only warns', async () => {
  const g = await checkFleet(brokerHolding('other'), fx.doctrine(), { commit: false });
  assert.equal(g.ok, false);
  assert.ok(g.notes.some(n => /targets the wrong fleet/.test(n)));
});

test('guard: a doctrine with no fleet can be planned and cannot be committed', async () => {
  const d = fx.doctrine({ fleet: null });
  const g = await checkFleet(brokerHolding('prod'), d, { commit: false });
  assert.equal(g.ok, true);
  await assert.rejects(() => checkFleet(brokerHolding('prod'), d, { commit: true }), /names no fleet/);
});

test('guard: a healthy broker holding zero sessions is called out', async () => {
  // The exact shape of the second-broker failure: it is refused the roster lock, comes
  // up healthy and EMPTY, and answers every question about a fleet of nobody.
  const g = await checkFleet(brokerHolding('test', 0), fx.doctrine(), { commit: false });
  assert.ok(g.notes.some(n => /fleet of nobody/.test(n)));
});

test('guard: no broker at all is an ordinary answer with a remedy, not a stack trace', async () => {
  const dead = { url: 'http://127.0.0.1:8901', health: async () => { throw new Error('fetch failed'); } };
  const g = await checkFleet(dead, fx.doctrine(), { commit: false });
  assert.equal(g.ok, false);
  assert.match(g.notes[0], /never starts one/);
});
