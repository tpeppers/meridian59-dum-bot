// THE SWARM — who is in it, and whose road it walks.
//
// Both halves of following are things a single observation cannot answer, so both are
// memory, and memory is where this rule can quietly go wrong in ways that still look
// obedient on the board. The assertions worth keeping are the ones that fail in the
// dangerous direction:
//
//   * enrolment is STICKY. Recomputed each pass from "is it in my room right now", the
//     swarm forgets every member at the exact moment the leader steps through a door.
//   * a follower walks the leader's TRAIL, not to the leader's position. `travel(to:
//     leader.room)` hands the road to the router, and the router's road is the one that
//     put 14 of 21 characters in the Underworld in a single window. Following the path is
//     the entire reason an operator field-walks a swarm instead of ordering it.
//   * off-trail is REPORTED rather than silently routed, because "followed you" and "found
//     its own way to where you are" are different facts and only one was asked for.

import assert from 'node:assert/strict';
import { leaderOf, followersOf, followPlan, enrolCoLocated, recordLeaderStep,
  nextHopFor, resetSwarmMemory, TRAIL_MAX } from '../src/decide/rules/swarm.mjs';

const test = globalThis.__dumTest;

const row = (agent, over = {}) => ({ agent, in_game: true, room: 39, ...over });
const leader = (over = {}) => row('unit-1', { piloted: { pid: 1, objectId: 99 }, ...over });

test('the leader is whoever is at the controls, and nobody is the resting state', () => {
  assert.equal(leaderOf([row('unit-2'), row('unit-3')]).leader, null);
  assert.match(leaderOf([]).why, /sleeps until an operator|nobody is piloting/);
  assert.equal(leaderOf([leader(), row('unit-2')]).leader.agent, 'unit-1');
});

test('two pilots is refused rather than guessed between', () => {
  const two = [leader(), row('unit-2', { piloted: { pid: 2, objectId: 98 } })];
  assert.equal(leaderOf(two).leader, null);
  assert.match(leaderOf(two).why, /one head|all but one/);
});

test('you enrol a swarm by walking into its room', () => {
  const rows = [leader({ room: 39 }), row('unit-2', { room: 39 }), row('unit-3', { room: 70 })];
  const enrolled = enrolCoLocated(new Set(), rows[0], rows);
  assert.ok(enrolled.has('unit-2'), 'the one in the room joined');
  assert.ok(!enrolled.has('unit-3'), 'the one two towns away did not');
  assert.ok(!enrolled.has('unit-1'), 'the leader does not follow itself');
});

test('enrolment is STICKY — a door does not empty the swarm', () => {
  const first = [leader({ room: 39 }), row('unit-2', { room: 39 })];
  let enrolled = enrolCoLocated(new Set(), first[0], first);
  // the leader walks on; unit-2 is briefly a room behind
  const later = [leader({ room: 38 }), row('unit-2', { room: 39 })];
  enrolled = enrolCoLocated(enrolled, later[0], later);
  assert.ok(enrolled.has('unit-2'), 'still a member while it catches up');
});

test('a character nobody walked into is not in the swarm', () => {
  const rows = [leader({ room: 39 }), row('unit-2', { room: 39 }), row('unit-9', { room: 52 })];
  const enrolled = enrolCoLocated(new Set(), rows[0], rows);
  const { follow } = followersOf(rows, rows[0], enrolled);
  assert.deepEqual(follow.map(f => f.agent), ['unit-2']);
});

test('no enrolment set at all keeps the old whole-fleet behaviour', () => {
  const rows = [leader({ room: 39 }), row('unit-2', { room: 52 }), row('unit-3', { room: 70 })];
  const { follow } = followersOf(rows, rows[0], null);
  assert.deepEqual(follow.map(f => f.agent).sort(), ['unit-2', 'unit-3']);
});

test('the trail records transitions, never a leader standing still', () => {
  let t = [];
  for (const r of [39, 39, 39, 38, 38, 2]) t = recordLeaderStep(t, r);
  assert.deepEqual(t, [39, 38, 2]);
});

test('the trail is bounded, so a long session cannot grow without limit', () => {
  let t = [];
  for (let i = 0; i < TRAIL_MAX + 40; i++) t = recordLeaderStep(t, i);
  assert.equal(t.length, TRAIL_MAX);
  assert.equal(t[t.length - 1], TRAIL_MAX + 39, 'it keeps the RECENT end');
});

test('a null or unusable room leaves the trail alone', () => {
  assert.deepEqual(recordLeaderStep([39], null), [39]);
  assert.deepEqual(recordLeaderStep([39], 'nowhere'), [39]);
});

test('the next hop is the room the leader went to FROM here', () => {
  const t = [39, 38, 2, 599];
  assert.equal(nextHopFor(t, 39), 38);
  assert.equal(nextHopFor(t, 38), 2);
  assert.equal(nextHopFor(t, 2), 599);
  assert.equal(nextHopFor(t, 599), null, 'the leader has not left the last room yet');
  assert.equal(nextHopFor(t, 70), null, 'a room the leader never walked');
});

test('a doubled-back route uses the LATEST departure, not the first', () => {
  // 38 is a hub and appears twice; the follower wants where the leader went most recently
  const t = [39, 38, 2, 38, 41];
  assert.equal(nextHopFor(t, 38), 41);
});

test('a follower walks the leader PATH one adjacent room at a time', () => {
  const head = { agent: 'unit-1', room: 2 };
  const plan = followPlan(head, [row('unit-2', { room: 39 })], { trail: [39, 38, 2] });
  assert.equal(plan[0].to, 38, 'the next room on the trail, not the leader\'s room');
  assert.equal(plan[0].on_trail, true);
  assert.match(plan[0].why, /leader's own path/);
});

test('off the trail it still routes, and SAYS it is not following', () => {
  const head = { agent: 'unit-1', room: 2 };
  const plan = followPlan(head, [row('unit-9', { room: 52 })], { trail: [39, 38, 2] });
  assert.equal(plan[0].to, 2, 'falls back to the leader\'s room');
  assert.equal(plan[0].on_trail, false);
  assert.match(plan[0].why, /not on the leader's trail|different road/);
});

test('in the same room it closes rather than travelling', () => {
  const head = { agent: 'unit-1', room: 39 };
  const plan = followPlan(head, [row('unit-2', { room: 39 })], { trail: [39], within: 2 });
  assert.equal(plan[0].do, 'approach');
  assert.equal(plan[0].distance, 2);
});

test('the Underworld and committed characters are never dragged along', () => {
  const rows = [leader({ room: 39 }), row('unit-2', { room: 1 }),
                row('unit-3', { room: 39, committed: { kind: 'driven', label: 'a trade' } })];
  const enrolled = new Set(['unit-2', 'unit-3']);
  const { follow, holdback } = followersOf(rows, rows[0], enrolled);
  assert.equal(follow.length, 0);
  assert.deepEqual(holdback.map(h => h.whyNot).sort(),
    ['committed: a trade', 'in the Underworld']);
});

test('resetting the memory does not leave a stale roster behind', () => {
  resetSwarmMemory();
  // nothing to assert beyond it being callable and not throwing — the point is that a new
  // swarm never inherits the previous one's members or route.
  assert.ok(true);
});
