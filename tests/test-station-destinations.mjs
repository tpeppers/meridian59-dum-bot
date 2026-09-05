import assert from 'node:assert/strict';
import { isStranded, isDoctrineDestination, onAJourney } from '../src/decide/rules/station.mjs';

const test = globalThis.__dumTest;

// A ROOM THIS DOCTRINE SENDS PEOPLE TO IS NOT A ROOM THEY ARE STRANDED IN.
//
// 2026-09-04, and it cost the fleet its entire food supply for a day. The feast errand
// walks a courier eleven hops to the Duke's Feast Hall; `return-to-station` then read 953
// as "out of position" and walked it straight back out, about thirty seconds after it
// arrived, every time.
//
// One was watched doing it: in the hall at r15c24, and back in Blackstone Keep at
// r12c9 a minute later. Activating a table from there answered "You can't activate the
// roast pig; it is no longer accessible" — which is the server's own same-room check
// (user.kod UserTryActivate: GetOwner <> poOwner) refusing. Right object, wrong room.
//
// In one log: 724 travel-to-39 orders against 20 travel-to-953. Not one slice of pork was
// ever taken by any character, on any run, all day. Everything upstream of this — the
// door bake, the courier hold, the dispatcher — was working by then.

const at = room => ({ in_game: true, room, policy: { assignedRoom: 39 },
                      health: { value: 50, max: 50 } });
const ON = { station: { recall: true, min_health: 0.8 }, feast: { on: true } };
const OFF = { station: { recall: true, min_health: 0.8 }, feast: { on: false } };

test('station: the feast hall is not a stranding while the feast is on', () => {
  assert.equal(isStranded(at(953), ON), false, 'the hall itself');
});

test('station: but the APPROACH is still recallable, or the way home is stranded', () => {
  // The first version exempted these too. The `busy` hold already covers a courier walking
  // IN — 30 minutes against an 11-minute walk — and exempting them strands the walk OUT: a
  // courier that filled its pack and is heading home sits in Blackstone Keep for ever,
  // because its errand has ended and nothing recalls it. One was found holding 128
  // slices of pork in 951 with no reason left to move, minutes after it shipped.
  assert.equal(isStranded(at(951), ON), true, 'Blackstone Keep');
  assert.equal(isStranded(at(950), ON), true, 'the Courtyard');
  assert.equal(isStranded(at(50), ON), true, 'Tos');
});

test('station: but everywhere else is still a stranding', () => {
  // Exempting the world is the failure on the other side. This rule exists because with
  // roam off a character idles wherever a death or an errand left it, for ever.
  assert.equal(isStranded(at(108), ON), true, 'the Sewers of Barloque');
  assert.equal(isStranded(at(599), ON), true, 'Ukgoth');
  assert.equal(isStranded(at(39), ON), false, 'except its own station');
});

test('station: with the feast off, the hall is an ordinary room again', () => {
  // The exemption belongs to a rule that is RUNNING. Switch the feast off and nothing
  // sends anybody to 953, so a character standing there is exactly what the recall is for.
  assert.equal(isStranded(at(953), OFF), true);
  assert.equal(isStranded(at(951), OFF), true);
  assert.equal(isDoctrineDestination(953, OFF), false);
});

test('station: the destination set is data, and says what it covers', () => {
  assert.equal(isDoctrineDestination(953, ON), true);
  assert.equal(isDoctrineDestination(108, ON), false);
  // An operator can name more without editing code — the same shape as every other
  // doctrine knob here.
  const extra = { ...ON, station: { ...ON.station, also_allowed: [104] } };
  assert.equal(isDoctrineDestination(104, extra), true);
  assert.equal(isDoctrineDestination(104, ON), false);
  // Nonsense in, false out: a missing or non-integer room is not a destination.
  assert.equal(isDoctrineDestination(null, ON), false);
  assert.equal(isDoctrineDestination('953', ON), false);
});

// ------------------------------------------- the eleven hops BEFORE the destination
//
// THE ROOM-BASED EXEMPTION ABOVE ASKS WHERE THE CHARACTER IS, and that is the right question
// only once it has arrived. For the walk itself it answers nothing: the Duke's hall is eleven
// hops from where this fleet farms, and every room in between is somewhere the character is
// "not supposed to be". In one watch that produced 28 recalls against zero food taken, with
// the dispatch and the recall issued for the same character in the same pass.

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const FEAST_ON = { feast: { on: true }, station: { recall: true, room: 39, min_health: 0.5 } };
// `assignedRoom` is on the character, not in the doctrine — stationFor reads
// `row.policy.assignedRoom`, and without it there is no home to be away from and every
// question below answers "not stranded" for the wrong reason.
const walking = (agent, room, since, at = NOW) => ({
  agent, in_game: true, room, at, health: { value: 44, max: 44 },
  policy: { assignedRoom: 39 },
  memory: { feast: { [agent]: { phase: 'outbound', since } } },
});

test('station: a character walking to the hall is not stranded on the way', () => {
  // Room 52 is on the road and is not the hall, not the approach, and not home.
  const row = walking('a', 52, NOW - 3 * MIN);
  assert.equal(onAJourney(row, FEAST_ON, null), true);
  assert.equal(isStranded(row, FEAST_ON, null), false, 'and so it is left to walk');
});

test('station: but only until the journey is stale', () => {
  // THE SAME DEADLINE THE FEAST RULE USES TO GIVE UP. Two different numbers for "this walk
  // has failed" is how a character ends up exempt from being rescued by one rule and
  // abandoned by the other — alone in a room on the far side of the world, for ever.
  const dead = walking('a', 52, NOW - 31 * MIN);
  assert.equal(onAJourney(dead, FEAST_ON, null), false, 'past 30 minutes it is not a journey');
  assert.equal(isStranded(dead, FEAST_ON, null), true, 'and the recall is exactly right');
  const custom = { ...FEAST_ON, feast: { on: true, max_trip_ms: 5 * MIN } };
  assert.equal(onAJourney(walking('a', 52, NOW - 6 * MIN), custom, null), false,
               'a doctrine that sets its own deadline is obeyed');
});

test('station: the exemption needs an actual journey, not just a feast doctrine', () => {
  // The failure mode to avoid is a blanket "the feast is on, so nobody is ever recalled".
  const idle = { agent: 'a', in_game: true, room: 52, at: NOW, health: { value: 44, max: 44 },
                 policy: { assignedRoom: 39 }, memory: {} };
  assert.equal(onAJourney(idle, FEAST_ON, null), false);
  assert.equal(isStranded(idle, FEAST_ON, null), true, 'an idle character IS out of position');
  const arrived = walking('a', 52, NOW - MIN);
  arrived.memory.feast.a.phase = 'home';
  assert.equal(onAJourney(arrived, FEAST_ON, null), false, 'a finished journey exempts nothing');
});

test('station: an entry with no start time is stale, not an indefinite pass', () => {
  // A memory written by an older version, or half-written. The safe reading is that the
  // journey cannot be reasoned about — not that the character is exempt for ever.
  const row = walking('a', 52, undefined);
  assert.equal(onAJourney(row, FEAST_ON, null), false);
});

test('station: with the feast off, the journey memory means nothing', () => {
  // Leftover memory from a doctrine that has since been switched off must not keep a
  // character out of position indefinitely.
  const row = walking('a', 52, NOW - MIN);
  assert.equal(onAJourney(row, { feast: { on: false }, ...{} }, null), false);
});
