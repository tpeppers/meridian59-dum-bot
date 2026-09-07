import assert from 'node:assert/strict';
import { stationRules, strandedRows, isStranded, holdsTheBody } from '../src/decide/rules/station.mjs';
import { characterRules } from '../src/decide/index.mjs';

const test = globalThis.__dumTest;

const doctrine = (over = {}) => ({
  station: { recall: true, rooms: [39], per_pass: 4, ...over },
});
const row = (agent, over = {}) => ({
  agent, in_game: true, room: 100, policy: { assignedRoom: 39 },
  hp: { value: 44, max: 44 },
  commitment: null, parked: null, piloted: null, ...over,
});
const rule = stationRules[0];

test('station: a bare bot claim is not an operation, so a claimed character is recallable', () => {
  // THIS IS THE BUG THAT MADE THE FIRST VERSION VACUOUS. DUM's own claim shows up on the
  // board as a commitment (`kind: "bot"`, takeable), so treating "has a commitment" as "is
  // busy" excluded every character DUM steers — which is all of them. It reported
  // "everybody is at their station" with thirteen of twenty-one scattered across the map.
  assert.equal(holdsTheBody(row('a1', { commitment: { kind: 'bot', takeable: true } })), false);

  // An operation in flight keeps the body. `takeable` is the field that separates them —
  // not the presence of a commitment.
  for (const commitment of [{ kind: 'errand', takeable: false },
                            { kind: 'driven' },
                            { kind: 'partner', takeable: false }])
    assert.equal(holdsTheBody(row('a1', { commitment })), true, `${commitment.kind} holds it`);

  // A person is playing this one. Never recall it, claim or no claim.
  assert.equal(holdsTheBody(row('a1', { piloted: { pid: 1 } })), true);
  assert.equal(holdsTheBody(row('a1', { parked: {} })), true);
});

test('station: only stations the doctrine claims, and only characters away from them', () => {
  assert.equal(isStranded(row('away'), doctrine()), true);
  assert.equal(isStranded(row('home', { room: 39 }), doctrine()), false);
  assert.equal(isStranded(row('elsewhere', { policy: { assignedRoom: 70 } }), doctrine()), false);
  assert.equal(isStranded(row('unassigned', { policy: {} }), doctrine()), false);
  assert.equal(isStranded(row('gone', { in_game: false }), doctrine()), false);

  // An empty room list means every assigned room is ours, which is the documented default.
  assert.equal(isStranded(row('elsewhere', { policy: { assignedRoom: 70 } }),
    doctrine({ rooms: [] })), true);

  // The fleet-level view still answers "who is out of position" for reporting.
  assert.deepEqual(strandedRows({ characters: [row('a'), row('b', { room: 39 })] },
    doctrine()).map(r => r.agent), ['a']);
});

test('station: a stranded character gets a walk home, and a settled one gets nothing', () => {
  const intent = rule.decide(row('a1'), doctrine());
  assert.equal(intent.kind, 'errand');
  assert.equal(intent.orders.errand, 'return-to-station');
  assert.equal(intent.orders.agent, 'a1');
  // One foreground travel to the assigned room, with a budget that suits a walk across
  // most of the map rather than a hop.
  assert.equal(intent.orders.steps.length, 1);
  assert.equal(intent.orders.steps[0].tool, 'travel');
  assert.equal(intent.orders.steps[0].args.to, 39);
  assert.ok(intent.orders.steps[0].timeout_ms >= 300_000);

  // Null, not an intent: a rule that keeps returning something it does not need to do is
  // what starved the Castle patrol when this was fleet-scoped.
  assert.equal(rule.decide(row('a1', { room: 39 }), doctrine()), null);
  assert.equal(rule.decide(row('a1', { commitment: { kind: 'errand', takeable: false } }),
    doctrine()), null);
});

test('station: recall is off unless the doctrine turns it on', () => {
  // "Lose the goal on death" is right for some fleets. This must be a choice, not a default.
  assert.equal(rule.enabled({}), false);
  assert.equal(rule.enabled({ station: { recall: false } }), false);
  assert.equal(rule.enabled(doctrine()), true);
});

test('station: it is a CHARACTER rule, so it cannot starve the fleet table', () => {
  // The whole reason for the rewrite. Fleet-scoped, exactly one intent runs per pass, and
  // this rule is persistently true while anyone is displaced — so above the Castle patrol
  // it starved it completely (3 passes of return-to-station, 0 of the shift, quarry orders
  // never updated, fleet could not fight) and below it never ran at all.
  assert.notEqual(rule.scope, 'fleet');
  assert.ok(characterRules.rules.some(r => r.id === 'return-to-station'),
    'registered on the character table');
  assert.equal(rule.faculty, 'movement');
});

test('station: a hurt character is recovering, not stranded', () => {
  // Measured 2026-09-02. A character died in the mountains, came out of the Underworld, and this rule
  // sent it home from the Marion inn at 1 of 44 health: its own record reads 36 -> 1 over
  // 94 squares across rooms 598, 1, 202, 200, losing 0.46 health a second, with
  // reached_shelter_after_s null. It walked THROUGH the inn that heals for free, because
  // it was technically out of position there.
  //
  // The harness already believes the right thing: travel_start_health defaults to full,
  // and travel_deaths_allowed to 0 — get out of the Underworld, rest at the inn the exit
  // lands in, and do not pick the road back up. A bare travel step walked past both.
  assert.equal(isStranded(row('hurt', { hp: { value: 1, max: 44 } }), doctrine()), false);
  assert.equal(isStranded(row('healed', { hp: { value: 44, max: 44 } }), doctrine()), true);

  // The fleet board renders health as a string, and that is the shape this actually sees.
  assert.equal(isStranded(row('boardhurt', { hp: null, health: '6/44' }), doctrine()), false);
  assert.equal(isStranded(row('boardwell', { hp: null, health: '44/44' }), doctrine()), true);

  // UNKNOWN IS NOT PERMISSION. The case this guard exists for is a character that has
  // just died, so silence must not be read as 'fine'.
  assert.equal(isStranded(row('nohealth', { hp: null }), doctrine()), false);

  // A doctrine may accept less than full; the default is full.
  assert.equal(isStranded(row('half', { hp: { value: 22, max: 44 } }),
    doctrine({ min_health: 0.5 })), true);
  assert.equal(isStranded(row('half', { hp: { value: 22, max: 44 } }), doctrine()), false);

  // And the rule itself, not just the predicate.
  assert.equal(stationRules[0].decide(row('hurt', { hp: { value: 1, max: 44 } }),
    doctrine()), null);
});

test('character recall reads pending town work from its own observation memory', () => {
  const d = { ...doctrine(), sellrun: { on: true, trigger: { food_empty: true } } };
  const obs = { ...row('away'), items: [{ name: 'slice of pork', amount: 20 }],
    memory: { sellrun: { away: { pending: true, ok: false } } } };
  assert.equal(stationRules[0].decide(obs, d), null);
  obs.memory.sellrun.away = { pending: false, ok: true };
  assert.equal(stationRules[0].decide(obs, d)?.orders?.errand, 'return-to-station');
});
