// THE HUNTING SHIFT — which rooms the fleet works, and in what proportion.
//
// The assertions worth keeping are the ones that fail in the dangerous direction if
// somebody inverts them: that a level-150 room is unreachable however it is asked for,
// that roaming stays off, that the engagement ceiling is sized to the ROOM rather than the
// quarry, that a quarry a room does not generate is refused rather than approximated, and
// that a share is a share of the units a station can actually take.

import assert from 'node:assert/strict';
import { loadDoctrine } from '../src/config/load.mjs';
import { validate } from '../src/config/schema.mjs';
import { shiftAssignments, shiftFleetRules } from '../src/decide/rules/shift.mjs';
import { HUNT_ROOMS, QUARRY_LEVEL, admits, engagementCeiling, cryptAssignment,
  STRATEGY_IDS } from '../src/strategies/catalog.mjs';
import { weaponFleetRules } from '../src/decide/rules/weapons.mjs';

const test = globalThis.__dumTest;

const doctrine = () => loadDoctrine({ file: 'doctrines/kings-way.jsonc' }).config;
const rows = (n = 21, over = {}) => Array.from({ length: n }, (_, i) => ({
  agent: `t${i + 1}`, in_game: true, level: 60, room: 39, mode: 'farm',
  policy: {}, commitment: null, parked: null, piloted: null, ...over,
}));
const obsOf = rows_ => ({ characters: rows_, strategies: { agents: {} } });
const fire = (rows_, d = doctrine()) => shiftFleetRules[0].decide(obsOf(rows_), d);

test('shift: a level-150 room is unreachable however it is asked for', () => {
  // 2602 is thrashers (150, rating 870) one door from 2601. 552 The Great Ocean is the
  // nastier trap, because it GENERATES FROGMEN — 20%, alongside mollusk creatures at 150
  // and 80% — so it is exactly the room somebody reaches for when told to hunt frogmen.
  // Neither is in the table, and a room that is not in the table cannot be assigned.
  assert.equal(HUNT_ROOMS[2602], undefined);
  assert.equal(HUNT_ROOMS[552], undefined);
  assert.equal(cryptAssignment(['frogman'], [552], 60), null);
  assert.equal(cryptAssignment(['thrasher'], [2602], 60), null);
  assert.equal(admits(60, 552, 'frogman'), false);
  // And 575 is also called "The King's Way" but generates giant rats and baby spiders.
  assert.equal(HUNT_ROOMS[575], undefined);
});

test('shift: a quarry a room does not generate is refused, never approximated', () => {
  // The statue lesson: room 2601 has 37 of them, placed once and never replaced while
  // anybody stands there, and the keeper's own room check reads the spawn table — so a
  // character would hunt nothing and report itself healthy for ever.
  assert.equal(QUARRY_LEVEL.statue, undefined);
  assert.equal(admits(60, 2601, 'statue'), false);
  assert.equal(admits(60, 576, 'skeleton'), false, '576 has no skeleton generator');
  assert.equal(admits(60, 2601, 'frogman'), false, '2601 has no frogman generator');
  for (const room of Object.values(HUNT_ROOMS))
    assert.equal(room.generates.includes('statue'), false);
});

test('shift: the ceiling is the room, not the quarry', () => {
  // refuseEngagement refuses a creature above round(max_health * 1.5), and it gates the
  // WHOLE room. 2600 generates level-40 mummies and has a level-75 statue standing in it,
  // so a unit admitted by the quarry alone would reject its own assigned room.
  assert.equal(engagementCeiling(60), 90);
  assert.equal(engagementCeiling(50), 75);
  assert.equal(admits(50, 2600, 'spectral mummy'), true, 'ceiling 75 admits the room threat 75');
  assert.equal(admits(48, 2600, 'spectral mummy'), false,
    'ceiling 72 admits the level-40 mummy but not the level-75 statue sharing the room');
  // A frogman is 70 and its room's threat is 70, so 47 max health is the floor.
  assert.equal(admits(47, 576, 'frogman'), true);
  assert.equal(admits(46, 576, 'frogman'), false);
});

test('shift: the shipped doctrine splits 75/25 between the King\'s Way and the crypt', () => {
  const intent = fire(rows(21));
  assert.equal(intent.kind, 'act');
  assert.equal(intent.plan.length, 21);
  const byRoom = intent.plan.reduce((m, p) => ({ ...m, [p.to]: (m[p.to] ?? 0) + 1 }), {});
  assert.deepEqual(byRoom, { 576: 16, 38: 5 },
    '75% of 21 rounds to 16; the remaining 5 fit inside the cap of 8, so the valve stays shut');
  assert.deepEqual([...new Set(intent.plan.filter(p => p.to === 576).map(p => p.hunt))], ['frogman']);
  assert.deepEqual([...new Set(intent.plan.filter(p => p.to === 38).map(p => p.hunt))], ['skeleton']);
  // ROAMING OFF IS THE SAFETY PROPERTY, at both stations, always.
  assert.ok(intent.plan.every(p => p.roam === false));
  // Sized per room: 576 threat 70, 2601 threat 75, against level 60.
  assert.ok(intent.plan.filter(p => p.to === 576).every(p => p.max_threat_over === 10));
  assert.ok(intent.plan.filter(p => p.to === 38).every(p => p.max_threat_over === 15));
  // `purpose` without `goals` is not an audit — yieldCheck answers "nothing can be checked".
  assert.ok(intent.plan.every(p => p.purpose === 'advance' && p.goals?.length));
  assert.ok(intent.plan.every(p => p.weapon_priority?.[0] === 'short sword'));
});

test('shift: a share is a share of who can work the station, not of the fleet', () => {
  // Allocating across everybody and filtering afterwards silently shrinks the fleet, and
  // the units that drop out are the small ones — exactly the ones somebody is watching.
  // Here four units are below the frogman floor, so 75% is 75% of the seventeen that
  // qualify, and the four fall through to the one room their ceiling does admit.
  const mixed = [...rows(17), ...rows(4).map((r, i) => ({ ...r, agent: `s${i}`, level: 44 }))];
  const assigned = shiftAssignments(mixed, doctrine(), obsOf(mixed));
  const small = assigned.filter(a => a.row.level === 44);
  assert.equal(small.length, 4);
  // 44 max health is a ceiling of 66: too small for the King's Way (room threat 70) and
  // for Castle Victoria's main room (75), but upstairs is 60 and takes them. THAT IS WHAT
  // AN OVERFLOW ROOM IS FOR — and it is also why upstairs earns its place despite paying
  // a level-60 character nothing: it is the only station a small character can work.
  assert.ok(small.every(a => a.to === 39), 'the small units land upstairs, not nowhere');
  const big = assigned.filter(a => a.row.level === 60);
  assert.equal(big.filter(a => a.to === 576).length, 13, '75% of 17');
  assert.equal(big.filter(a => a.to === 38).length, 4);
});

test('shift: a capacity is what makes overflow mean anything', () => {
  // `max` beats the share, because "fill this room, then use the next" is not something a
  // proportion can express. With the cap lowered below the crypt station's allocation the
  // surplus must appear upstairs rather than being crammed in or dropped.
  const d = doctrine();
  // By room, not by index — the station list grows at the front when a night window is
  // added, and a positional test would silently start capping a different room.
  d.shift.stations.find(st => st.room === 38).max = 2;
  const intent = fire(rows(21), d);
  const byRoom = intent.plan.reduce((m, p) => ({ ...m, [p.to]: (m[p.to] ?? 0) + 1 }), {});
  assert.deepEqual(byRoom, { 576: 16, 38: 2, 39: 3 }, 'three overflow upstairs');
  // And nobody is lost or duplicated by the overflow.
  assert.equal(intent.plan.length, 21);
  assert.equal(new Set(intent.plan.map(p => p.agent)).size, 21);
});

test('shift: the assignment is stable, so nobody is walked across the world by a level-up', () => {
  const before = shiftAssignments(rows(21), doctrine(), obsOf(rows(21)));
  const after = shiftAssignments(rows(21), doctrine(), obsOf(rows(21)));
  assert.deepEqual(before.map(a => [a.row.agent, a.to]), after.map(a => [a.row.agent, a.to]));
});

test('shift: a committed, parked or piloted unit is stepped over', () => {
  const d = doctrine();
  for (const block of [{ commitment: { kind: 'errand', takeable: false, label: 'loot run' } },
                       { parked: true }, { piloted: true }]) {
    const all = rows(21).map((r, i) => i === 0 ? { ...r, ...block } : r);
    const intent = fire(all, d);
    const moved = new Set((intent.plan ?? []).map(p => p.agent));
    assert.equal(moved.has(all[0].agent), false,
      `${Object.keys(block)[0]} must not be re-deployed`);
  }
});

test('shift: DUM\'s own claim does not count as busy', () => {
  // THE `isTakeable` TRAP. DUM claims every character it steers, and the harness marks the
  // claim `takeable: true` with "nothing is mid-flight" spelled out. A rule testing the
  // field for truthiness blocks on its own claim and can never act — while reporting the
  // whole fleet as mid-errand, which reads exactly like a retarget that landed. Caught
  // live: the first dry-run said "21 of 21 unit(s) are mid-errand".
  const claimed = rows(1, { commitment: { kind: 'bot', takeable: true,
    label: 'dum is steering', detail: 'Not an operation — nothing is mid-flight' } });
  assert.equal(fire(claimed).kind, 'act', 'a takeable bot claim is ownership, not an errand');
  const partnered = rows(1, { commitment: { kind: 'partner', takeable: false } });
  assert.equal(fire(partnered).kind, 'act');
});

test('shift: a unit already holding its orders is not re-sent every tick', () => {
  const settled = rows(21).map(r => ({ ...r,
    policy: { assignedRoom: 576, hunt: 'frogman', roam: false, purpose: 'advance' } }));
  const intent = fire(settled);
  // The crypt quarter still needs moving, so this is an act — but the sixteen already at
  // the King's Way must not be in it.
  const moved = new Set((intent.plan ?? []).map(p => p.agent));
  assert.equal([...moved].length, 5, 'only the crypt station is re-tasked');
});

test('shift: it is off unless a doctrine asks, and Castle Victoria is off with it', () => {
  assert.equal(shiftFleetRules[0].enabled({}), false, 'no shift block means no shift');
  assert.equal(shiftFleetRules[0].enabled({ shift: { on: true } }), true);

  // ALL THREE CASTLE EFFORTS OFF TOGETHER. Any one left on drags part of the fleet back
  // across the world while this rule sends it the other way, and the two fight every tick.
  const d = doctrine();
  assert.equal(d.castle_victoria.shift, false);
  assert.equal(d.crate.check, false);
  assert.equal(d.placement.spread, false);
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.VS_SKELETONS), false);
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.SHORT_SWORDING), true);
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.CHECK_CV_CRATE), false);
});

test('shift: selecting Short swording actually changes the weapon order', () => {
  // It did not, for as long as the strategy existed: `shortSwording` was defined in
  // decide/weapons.mjs with an alias for this very id, and nothing read the id.
  const live = rows(1, { items: [], carry: { load: 0.1 }, provides: [] });
  const intent = weaponFleetRules[0].decide({ characters: live, strategies: { agents: {} } },
    doctrine());
  const priority = (intent.plan ?? []).find(p => p.do === 'weapon-policy')?.priority;
  assert.ok(priority, 'a unit running Short swording is given a weapon policy');
  assert.equal(priority[0], 'short sword');
  assert.ok(priority.length > 1, 'and everything else follows — never an empty hand');
});

// ---------------------------------------------------------------------------
// THE NIGHT WINDOW — a station that exists for 35 minutes in every 120.
// ---------------------------------------------------------------------------

const atNight = rows_ => ({ characters: rows_, strategies: { agents: {} },
  world_clock: { night: true, closes_in_ms: 20 * 60_000, cycle: 36 } });
const byDay = rows_ => ({ characters: rows_, strategies: { agents: {} },
  world_clock: { night: false, opens_in_ms: 40 * 60_000, cycle: 36 } });

test('shift: the graveyard station appears at night and vanishes by day', () => {
  const d = doctrine();
  const night = shiftFleetRules[0].decide(atNight(rows(21)), d);
  const inGraveyard = night.plan.filter(p => p.to === 70);
  assert.equal(inGraveyard.length, 7, '35% of 21');
  assert.ok(inGraveyard.every(p => p.hunt === 'skeleton'),
    'the zombie is 85% of that room and level 55 — it advances nobody here');

  // By day the station is not in the list at all, so those units are allocated to the
  // King's Way instead. Nothing has to be un-done at the edge: the station simply is not
  // there, and the ordinary allocation runs over what remains.
  const day = shiftFleetRules[0].decide(byDay(rows(21)), d);
  assert.equal(day.plan.filter(p => p.to === 70).length, 0);
  assert.ok(day.plan.filter(p => p.to === 576).length > night.plan.filter(p => p.to === 576).length,
    'the King\'s Way gets them back when the window closes');
  // ORDER IS WHO GIVES THE UNITS UP. The window draws from the King's Way, not from
  // Castle Victoria — the castle keeps its quarter through the night, which is what
  // "some of the frogman hunters switch" means. Listed the other way round, the castle
  // emptied for the whole window instead.
  assert.equal(night.plan.filter(p => p.to === 38).length,
               day.plan.filter(p => p.to === 38).length,
               'the castle station is untouched by the night window');
  assert.equal(day.plan.length, 21);
  assert.equal(night.plan.length, 21, 'nobody is lost at either edge');
});

test('shift: a night station is SHUT when the clock is unknown, not open', () => {
  // `world_clock` is null until an operator has watched a window begin and written the
  // anchor down. That is a different fact from "it is daytime", and guessing would park a
  // shift in an empty graveyard on a schedule nobody verified. Failing shut costs one
  // window; failing open costs however long it takes somebody to notice a fleet killing
  // nothing — and the fleet board would report it hunting perfectly happily throughout.
  const d = doctrine();
  for (const clock of [null, undefined]) {
    const obs = { characters: rows(21), strategies: { agents: {} }, world_clock: clock };
    const intent = shiftFleetRules[0].decide(obs, d);
    assert.equal(intent.plan.filter(p => p.to === 70).length, 0,
      'no anchor means no night station');
  }
});

test('shift: a night-only room is refused a station that does not gate on the window', () => {
  // The expensive mistake, caught at doctrine load rather than in the field.
  const d = doctrine();
  d.shift.stations = [{ room: 70, hunt: 'skeleton', share: 1 }];
  const bad = validate(d);
  assert.ok(bad.some(b => /35-minute window/.test(b.why)),
    'a graveyard station without `when: night` is refused');

  // And the other two silent ones: a room nobody has rated, and a quarry the room does
  // not generate.
  assert.ok(validate({ ...d, shift: { on: true, stations: [{ room: 2602, hunt: 'thrasher' }] } })
    .some(b => /HUNT_ROOMS/.test(b.why)));
  assert.ok(validate({ ...d, shift: { on: true, stations: [{ room: 576, hunt: 'skeleton' }] } })
    .some(b => /does not generate/.test(b.why)));
  // The shipped doctrine passes its own guard.
  assert.deepEqual(validate(doctrine()).filter(b => b.where.startsWith('shift')), []);
});
