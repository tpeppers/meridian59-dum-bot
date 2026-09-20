import assert from 'node:assert/strict';
import { TacticalHandoff } from '../src/link/tactical-handoff.mjs';
let now = 1000, released = 0, forgotten = 0;
const create = overrides => new TacticalHandoff({ fleet: 'fixture', pid: 17,
  health: async () => ({ fleet: 'fixture', pid: 23 }),
  yieldAgent: async () => { released++; }, forgetAgent: () => { forgotten++; },
  now: () => now, ...overrides });
const body = { action: 'yield', order_id: '1'.repeat(32), dum_pid: 17,
  binding: { fleet: 'fixture', broker_pid: 23, agent: 'unit-test', character: 'Example' } };
const gate = create();
const old = gate.ticket('autopilot', { agent: 'unit-test' });
assert.equal((await gate.request(body)).yielded, true);
assert.equal(released, 1);
assert.throws(() => gate.enter(old), /reserved|predates/);
assert.throws(() => gate.enter(gate.ticket('travel', { agent: 'unit-test' })), /reserved/);
assert.throws(() => gate.enter(gate.ticket('spread', {})), /fleet-wide/);
gate.enter(gate.ticket('travel', { agent: 'unrelated' }))();
gate.enter(gate.ticket('fleet', {}))();
assert.equal((await gate.request({ ...body, action: 'heartbeat' })).yielded, true);
assert.equal(released, 1, 'heartbeat never reacquires/yields');
await assert.rejects(gate.request({ ...body, order_id: '2'.repeat(32) }), /reserved/);
assert.equal((await gate.request({ ...body, action: 'release' })).released, true);
assert.throws(() => gate.enter(old), /predates/);
gate.enter(gate.ticket('travel', { agent: 'unit-test' }))();
await assert.rejects(gate.request({ ...body, action: 'heartbeat' }), /expired/);
await gate.request(body);
now += 45001;
assert.equal(gate.reserved('unit-test'), false);
await assert.rejects(gate.request({ ...body, action: 'heartbeat' }), /expired/);
const busy = create();
const finish = busy.enter(busy.ticket('travel', { agent: 'unit-test' }));
await assert.rejects(busy.request(body), /in-flight/);
finish();
await assert.rejects(busy.request(body), /not confirmed/);
await busy.request({ ...body, action: 'release' });
await busy.request(body);
const uncertain = create({ yieldAgent: async () => { throw Error('timeout'); } });
await assert.rejects(uncertain.request(body), /timeout/);
assert.equal(uncertain.reserved('unit-test'), true);
await assert.rejects(uncertain.request(body), /not confirmed/);
const wrong = create({ health: async () => ({ fleet: 'fixture', pid: 99 }) });
await assert.rejects(wrong.request(body), /broker identity/);
gate.close();
await assert.rejects(gate.request(body), /identity/);
assert.ok(forgotten > 0);
console.log('PASS tactical DUM reservations: no policy writes, dispatch race, busy refusal, expiry and no reacquisition');
