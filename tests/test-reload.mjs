import assert from 'node:assert/strict';
import { planReload, applyReload, LIVE_RELOADABLE, RESTART_ONLY } from '../src/link/reload.mjs';

const test = globalThis.__dumTest;

// A doctrine reload is a WRITE to a running bot's orders, so the interesting assertions are
// about what it declines to do. The one that matters most is the last: the live config object
// must be MUTATED rather than replaced, because two readers hold it and only one of them
// re-reads it.

const live = () => ({
  name: 'prod bands', fleet: 'prod',
  not_ours: ['Marco Polo'],
  yield_to: [], cadence: { fleet_ms: 9000 }, shift: { stations: [{ room: 544 }] },
  claim: { lease_ms: 120000 }, record: { dir: 'var' }, link: { strategy_control_url: 'http://127.0.0.1:8917' },
  strategies: { enabled: true },
});

test('a changed not_ours is applied, and an unchanged key is not', () => {
  const now = live(), next = { ...live(), not_ours: ['Marco Polo', 'BravoTwo'] };
  const plan = planReload(now, next);
  assert.ok(plan.applied.includes('not_ours'), JSON.stringify(plan));
  assert.ok(plan.unchanged.includes('shift'), 'a key that did not move must not be reported as applied');
  assert.equal(plan.restart_required.length, 0);
});

// THE VIGOR GATE, 2026-09-20. `throttle` was in neither list, so a reload REPORTED it under
// `unclassified` and deliberately left the live value alone — correct behaviour that reads, to
// somebody who has just edited a doctrine and posted a reload, exactly like an edit that took.
// It is read off ctx.config every pass (tick.mjs:39 -> :53 -> throttle.mjs:203/:209/:211/:217),
// so it belongs in LIVE_RELOADABLE. This pins that it stays there: the failure it guards against
// is silent in both directions, since an unclassified key is not an error either.
test('a changed throttle is applied, not reported as unclassified', () => {
  const now = { ...live(), throttle: { with_food: 60, no_food: 60, min_meals: 1 } };
  const next = { ...live(), throttle: { with_food: 40, no_food: 40, min_meals: 1 } };
  const plan = planReload(now, next);
  assert.ok(LIVE_RELOADABLE.includes('throttle'), 'throttle must be classified as live-reloadable');
  assert.ok(plan.applied.includes('throttle'), JSON.stringify(plan));
  assert.equal(plan.unclassified.length, 0, 'an unclassified throttle is the bug this pins');
  const cfg = { ...now };
  applyReload(cfg, next);
  assert.equal(cfg.throttle.with_food, 40, 'the live config must carry the new floor');
});

test('planReload is pure — asking must not change the running bot', () => {
  const now = live();
  planReload(now, { ...live(), not_ours: ['Marco Polo', 'BravoTwo'] });
  assert.deepEqual(now.not_ours, ['Marco Polo'], 'a preview that mutates is not a preview');
});

test('THE LIVE CONFIG IS MUTATED IN PLACE, NOT REPLACED', () => {
  // src/loop/run.mjs:82 destructures `config` ONCE and still reads `config.cadence.fleet_ms`
  // in its loop; src/loop/tick.mjs:39 re-destructures it every call. They hold the SAME
  // object. Replacing it would update the tick and leave the run loop on the old one for
  // ever — a half-applied reload, and nothing would say so. This is that invariant: the
  // reference a caller captured before the reload must see the new value after it.
  const now = live();
  const captured = now;                       // what run.mjs is holding
  applyReload(now, { ...live(), not_ours: ['Marco Polo', 'BravoTwo'], cadence: { fleet_ms: 3000 } });
  assert.deepEqual(captured.not_ours, ['Marco Polo', 'BravoTwo'], 'the captured reference must see it');
  assert.equal(captured.cadence.fleet_ms, 3000);
  assert.equal(captured, now, 'the object identity must not change');
});

test('a restart-only key is REPORTED and left alone, never half-applied', () => {
  // Writing these would change the config and not the behaviour: the holder string, the
  // journal's open directory and the claim's lease are all read once at startup. A reload
  // that wrote them would read back as applied and do nothing, which is the exact failure
  // mode this repository keeps paying for.
  const now = live();
  const next = { ...live(), name: 'something else', claim: { lease_ms: 30000 },
                 record: { dir: 'elsewhere' } };
  const plan = applyReload(now, next);
  const keys = plan.restart_required.map(r => r.key);
  for (const k of ['name', 'claim', 'record']) assert.ok(keys.includes(k), `${k} must be reported`);
  assert.equal(now.name, 'prod bands', 'the live value must be untouched');
  assert.equal(now.claim.lease_ms, 120000);
  assert.equal(now.record.dir, 'var');
  // And every one has to say WHY, or an operator cannot tell a real blocker from a bug.
  for (const row of plan.restart_required) assert.ok(row.why?.length > 20, `${row.key} needs a reason`);
});

test('strategies is restart-only because applying it would be HALF applying it', () => {
  // `strategies.enabled` is read per pass, but the strategy STORE is built at startup from
  // defaults and settings. Applying this key would flip the flag and leave the strategies
  // themselves stale — worse than refusing, because it would report success.
  assert.ok(Object.hasOwn(RESTART_ONLY, 'strategies'));
  assert.ok(!LIVE_RELOADABLE.includes('strategies'));
  const now = live();
  applyReload(now, { ...live(), strategies: { enabled: false } });
  assert.equal(now.strategies.enabled, true, 'it must not be applied');
});

test('a key in neither list is reported rather than applied or dropped', () => {
  // An unclassified key that silently did nothing is how a setting gets believed in for a
  // year without ever having been read. It is named so somebody can classify it.
  const now = live();
  const plan = applyReload(now, { ...live(), some_new_feature: { on: true } });
  assert.deepEqual(plan.unclassified, ['some_new_feature']);
  assert.equal(now.some_new_feature, undefined, 'and it is NOT applied on a guess');
});

test('the two lists never overlap', () => {
  // A key in both would be applied and reported as needing a restart in the same breath.
  const both = LIVE_RELOADABLE.filter(k => Object.hasOwn(RESTART_ONLY, k));
  assert.deepEqual(both, [], 'a key cannot be both live-reloadable and restart-only');
});

test('a reload with nothing to do changes nothing and says so', () => {
  const now = live();
  const plan = applyReload(now, live());
  assert.deepEqual(plan.applied, []);
  assert.deepEqual(plan.restart_required, []);
  assert.deepEqual(plan.unclassified, []);
  assert.equal(plan.unchanged.length, LIVE_RELOADABLE.length);
});
