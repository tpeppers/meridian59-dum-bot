// THE THROTTLE — the target vigor the fleet maintains, as a fraction of 200.
//
// Offline: the rule is pure (obs + doctrine in, an order or null out), so the mapping and the
// converge-when-the-keeper-agrees contract are both fixtures.

const test = globalThis.__dumTest;

import { throttleRules, floorForThrottle } from '../src/decide/rules/throttle.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const rule = throttleRules.find(r => r.id === 'throttle-vigor');
const obsWith = (throttle, keeperFloor) => ({ agent: 'a', keeper: { policy: { fightAboveVigor: keeperFloor } } });

test('throttle: the mapping is a fraction of the 200-vigor maximum', () => {
  eq(floorForThrottle(1.0), 200, 'full throttle is ~max vigor');
  eq(floorForThrottle(0.9), 180, 'the fleet default floor');
  eq(floorForThrottle(0.4), 80, 'the rest cap');
  eq(floorForThrottle(0), 0, 'zero');
  eq(floorForThrottle(2), 200, 'clamped above 1');
  eq(floorForThrottle(-1), 0, 'clamped below 0');
});

test('throttle: off unless the doctrine sets one', () => {
  eq(rule.enabled({}), false, 'no throttle key');
  eq(rule.enabled({ throttle: null }), false, 'explicit null is off');
  eq(rule.enabled({ throttle: 1.0 }), true, 'a number turns it on');
  eq(rule.enabled({ throttle: 0 }), true, 'zero is a real throttle, not "off"');
});

test('throttle: sets fight_above_vigor when the keeper does not hold the target', () => {
  const intent = rule.decide(obsWith(1.0, 180), { throttle: 1.0 });
  ok(intent, 'full throttle over a keeper at 180 emits an order');
  eq(intent.kind, 'orders', 'a policy write');
  eq(intent.orders.action, 'start', 'an autopilot start');
  eq(intent.orders.fight_above_vigor, 200, 'to the full-throttle floor');
  ok(/throttle 100% -> fight_above_vigor=200/.test(intent.why), `readable why: ${intent.why}`);
});

test('throttle: returns null once the keeper already holds the floor', () => {
  eq(rule.decide(obsWith(0.9, 180), { throttle: 0.9 }), null, 'converged, so no order');
});

test('throttle: reads obs.policy when there is no keeper snapshot', () => {
  const intent = rule.decide({ agent: 'a', policy: { fightAboveVigor: 80 } }, { throttle: 0.9 });
  eq(intent?.orders?.fight_above_vigor, 180, 'raises the floor from 80 to 180');
});
