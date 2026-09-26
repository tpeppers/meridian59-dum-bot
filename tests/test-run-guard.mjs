import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { decide, scopeKey, lockPath, acquireRunGuard, pidAlive } from '../src/link/run-guard.mjs';

const test = globalThis.__dumTest;

// ONE DIRECTOR PER FLEET. A second committed run against a directed fleet is the failure that
// gives every character two sets of orders while both journals read correct. Every case here is
// a way the check could wave a second director through.

const alive = (...pids) => pid => pids.includes(pid);
const self = { pid: 200, fleet: 'fleet-a' };

test('run guard: a live lock for the same scope refuses', () => {
  const v = decide({ lock: { pid: 100, fleet: 'fleet-a', scope: 'fleet' }, health: null, self, alive: alive(100) });
  assert.equal(v.ok, false);
  assert.match(v.why, /pid 100/);
});

test('run guard: a lock whose pid is gone is stale and is taken over', () => {
  const v = decide({ lock: { pid: 100, fleet: 'fleet-a', scope: 'fleet' }, health: null, self, alive: alive() });
  assert.equal(v.ok, true);
  assert.match(v.why, /stale/);
});

test('run guard: a director started before the guard existed is caught by its control URL', () => {
  // It wrote no lock, which is exactly the running process on the day this was written.
  const v = decide({ lock: null, health: { ok: true, fleet: 'fleet-a', pid: 100 }, self, alive: alive(100) });
  assert.equal(v.ok, false);
  assert.match(v.why, /control URL/);
});

test('run guard: a control URL answering for a DIFFERENT fleet is not this fleet\'s director', () => {
  const v = decide({ lock: null, health: { ok: true, fleet: 'fleet-b', pid: 100 }, self, alive: alive(100) });
  assert.equal(v.ok, true);
});

test('run guard: our own lock and our own health reply are not a second director', () => {
  assert.equal(decide({ lock: { pid: 200, fleet: 'fleet-a' }, health: { ok: true, fleet: 'fleet-a', pid: 200 },
                        self, alive: alive(200) }).ok, true);
});

test('run guard: nothing there at all starts cleanly', () => {
  assert.deepEqual(decide({ lock: null, health: null, self, alive: alive() }), { ok: true, why: null });
});

test('run guard: the scope is the fleet or the exact agent set, independent of order', () => {
  assert.equal(scopeKey(null), 'fleet');
  assert.equal(scopeKey([]), 'fleet');
  assert.equal(scopeKey(['t2', 't1']), scopeKey(['t1', 't2']));
  // A single-character run (a posted caster the fleet doctrine marks not_ours) must not collide
  // with the fleet director, or the guard would refuse a configuration that is correct today.
  assert.notEqual(lockPath({ fleet: 'fleet-a', only: ['caster-1'], dir: 'd' }), lockPath({ fleet: 'fleet-a', only: null, dir: 'd' }));
});

test('run guard: pidAlive answers for this process and not for a nonsense pid', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(undefined), false);
});

test('run guard: a live lock refuses with exit 3, --force proceeds, and release keeps others\' locks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-guard-'));
  const was = process.env.M59_DUM_LOCK_DIR;
  process.env.M59_DUM_LOCK_DIR = dir;
  try {
    const config = { fleet: 'fleet-a', name: 'test doctrine', link: { strategy_control_url: null } };
    const path = lockPath({ fleet: 'fleet-a', only: null, dir });
    mkdirSync(dir, { recursive: true });
    // `process.ppid` is a live process that is not us: the shell or runner that started this test.
    writeFileSync(path, JSON.stringify({ pid: process.ppid, fleet: 'fleet-a', scope: 'fleet', doctrine: 'other' }));
    await assert.rejects(acquireRunGuard({ config, only: null, log: () => {} }),
                         e => e.exitCode === 3 && /second director/.test(e.message));
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.ppid, 'a refusal must not touch the lock');

    const said = [];
    const release = await acquireRunGuard({ config, only: null, force: true, log: m => said.push(m) });
    assert.ok(said.some(m => /--force/.test(m)), 'forcing past a live director has to say so');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, process.pid);
    release();
    assert.equal(existsSync(path), false, 'our own lock is removed on release');

    writeFileSync(path, JSON.stringify({ pid: process.ppid, fleet: 'fleet-a' }));
    release();
    assert.equal(existsSync(path), true, 'release must never remove a lock another process wrote');
  } finally {
    if (was === undefined) delete process.env.M59_DUM_LOCK_DIR; else process.env.M59_DUM_LOCK_DIR = was;
  }
});
