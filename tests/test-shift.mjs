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
import { presetForQuarry } from '../src/decide/weapons.mjs';

const test = globalThis.__dumTest;

const doctrine = () => loadDoctrine({ file: 'doctrines/castle-graveyard.jsonc' }).config;
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

test('shift: the shipped doctrine puts the whole fleet in Castle Victoria', () => {
  const intent = fire(rows(21));
  assert.equal(intent.kind, 'act');
  assert.equal(intent.plan.length, 21);
  const byRoom = intent.plan.reduce((m, p) => ({ ...m, [p.to]: (m[p.to] ?? 0) + 1 }), {});
  assert.deepEqual(byRoom, { 2601: 21 }, 'the densest skeleton generator takes the fleet');
  assert.deepEqual([...new Set(intent.plan.map(p => p.hunt))], ['skeleton']);
  // ROAMING OFF IS THE SAFETY PROPERTY. 41, the Underbasement, is one door below 38 and
  // generates narthyl worms at level 120.
  assert.ok(intent.plan.every(p => p.roam === false));
  assert.ok(intent.plan.every(p => p.max_threat_over === 15), '2601 threat 75 against level 60');
  assert.ok(intent.plan.every(p => p.purpose === 'advance' && p.goals?.length));
  // THE SHIFT DOES NOT SET A WEAPON ORDER. `maintain-qualifying-weapons` owns that, and
  // the shift carrying its own copy is how a stale preset gets reimposed on a fleet that
  // has changed weapon doctrine.
  assert.equal(intent.plan.every(p => p.weapon_priority === undefined), true);
});

test('shift: the engagement ceiling sorts the fleet, with no health threshold written down', () => {
  // `refuseEngagement` refuses a creature above round(max_health * 1.5) and it gates the
  // WHOLE room. That one rule does the sorting without a number in the doctrine — and a
  // number would be a second answer to a question the keeper already answers.
  const mixed = [...rows(14),
    ...rows(4).map((r, i) => ({ ...r, agent: `m${i}`, level: 45 })),   // ceiling 68
    ...rows(3).map((r, i) => ({ ...r, agent: `s${i}`, level: 36 }))];  // ceiling 54
  const assigned = shiftAssignments(mixed, doctrine(), obsOf(mixed));
  const at = lvl => assigned.filter(a => a.row.level === lvl);
  assert.ok(at(60).every(a => a.to === 2601), 'ceiling 90 takes the level-75 skeleton');
  assert.ok(at(45).every(a => a.to === 39), 'ceiling 68 falls through to the battered skeleton');
  // UNDER 40 MAX HEALTH THERE IS NOTHING IN THE CASTLE — 39's own threat is 60 and its
  // zombie is 55, both above a ceiling of 54 — so those fall to the floor station rather
  // than being left unplaced to wander. A fungus beast is rating 210, the softest fight in
  // the game, and still level 50, so it advances a decayed character back up.
  assert.ok(at(36).every(a => a.to === 544));
  assert.ok(at(36).every(a => a.hunt === 'fungus beast'));
  // The floor is LAST: nobody who can work the castle is sent to it.
  assert.equal(assigned.filter(a => a.to === 544).length, 3, 'only the three that need it');
});

test('shift: a capacity is what makes overflow mean anything', () => {
  // `max` beats the share, because "fill this room, then use the next" is not something a
  // proportion can express.
  const d = doctrine();
  d.shift.stations.find(st => st.room === 2601).max = 5;
  const intent = fire(rows(21), d);
  const byRoom = intent.plan.reduce((m, p) => ({ ...m, [p.to]: (m[p.to] ?? 0) + 1 }), {});
  assert.deepEqual(byRoom, { 2601: 5, 38: 16 }, 'the surplus goes to the next station');
  assert.equal(intent.plan.length, 21);
  assert.equal(new Set(intent.plan.map(p => p.agent)).size, 21, 'nobody lost or duplicated');
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
  // Holding the orders AND standing in the room: nothing to do.
  const settled = rows(21).map(r => ({ ...r, room: 2601,
    policy: { assignedRoom: 2601, hunt: 'skeleton', roam: false, purpose: 'advance' } }));
  assert.equal(fire(settled).kind, 'pass', 'a fleet already on station is left alone');

  // ORDERS MATCHING IS NOT BEING THERE. The same orders, standing somewhere else and
  // idle, must produce a walk — this is the case that had eleven characters holding safe
  // walls in a dead room for hours while every signal read healthy.
  const stranded = rows(21).map(r => ({ ...r, room: 71, activity: 'holding a untested safe spot',
    policy: { assignedRoom: 2601, hunt: 'skeleton', roam: false, purpose: 'advance' } }));
  const walk = fire(stranded);
  assert.equal(walk.kind, 'act');
  assert.ok(walk.plan.every(p => p.do === 'relocate' && p.to === 2601));

  // But a keeper already travelling or fighting is making its own progress and must not
  // have a second journey started underneath it.
  for (const activity of ['travelling', 'fighting from a proven safe spot', 'resting']) {
    const busy = rows(21).map(r => ({ ...r, room: 71, activity,
      policy: { assignedRoom: 2601, hunt: 'skeleton', roam: false, purpose: 'advance' } }));
    assert.equal(fire(busy).kind, 'pass', `${activity} is left alone`);
  }
});

test('shift: it is off unless a doctrine asks, and the old shifts stay off', () => {
  assert.equal(shiftFleetRules[0].enabled({}), false, 'no shift block means no shift');
  assert.equal(shiftFleetRules[0].enabled({ shift: { on: true } }), true);

  const d = doctrine();
  // The BESPOKE Castle Victoria rule stays off — this shift owns the castle now, and two
  // rules assigning rooms 38/39 on different clocks would fight every tick.
  assert.equal(d.castle_victoria.shift, false);
  assert.equal(d.crate.check, false);
  assert.equal(d.placement.spread, false);
  // ONE WEAPON ORDER, NOT TWO. vsSkeletons is back and short-swording is gone: a unit
  // holding both is a doctrine that cannot say what it wants, even though code breaks
  // the tie.
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.VS_SKELETONS), true);
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.SHORT_SWORDING), false);
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.CHECK_CV_CRATE), false);
});

test('shift: the fleet draws blunt weapons first again', () => {
  // A skeleton resists edged weapons, which is what vsSkeletons is for. Short swording
  // was the crypt's order and went with the crypt.
  const live = rows(1, { items: [], carry: { load: 0.1 }, provides: [] });
  const intent = weaponFleetRules[0].decide({ characters: live, strategies: { agents: {} } },
    doctrine());
  const priority = (intent.plan ?? []).find(p => p.do === 'weapon-policy')?.priority;
  assert.ok(priority, 'a unit in the shift is given a weapon policy');
  assert.equal(priority[0], 'hammer');
  assert.ok(priority.includes('mace') && priority.includes('axe'));
  assert.ok(priority.length > 3, 'and everything else follows — never an empty hand');
});

// ---------------------------------------------------------------------------
// THE WEAPON FOLLOWS THE QUARRY, from the monsters' own resistance tables.
// ---------------------------------------------------------------------------

test('weapons: the quarry picks the damage type, and the zombie is the only sword case', () => {
  // A weapon's damage TYPE is what a monster resists, not its name. Short sword, long
  // sword, mystic sword and gold sword are all ATCK_WEAP_THRUST (shrtswrd.kod:56);
  // axe and scimitar are SLASH; hammer and mace are BLUDGEON.
  assert.equal(presetForQuarry('skeleton'), 'vsSkeletons');
  assert.equal(presetForQuarry('battered skeleton'), 'vsSkeletons',
    'BatteredSkeleton is Skeleton and declares no resistances of its own');
  assert.equal(presetForQuarry('fungus beast'), 'vsSkeletons', 'PIERCE 60, THRUST 60');
  assert.equal(presetForQuarry('groundworm larva'), 'vsSkeletons',
    'BLUDGEON -30 — it is VULNERABLE to hammers, not merely unprotected');

  // THE ZOMBIE RESISTS NO WEAPON TYPE (zombie.kod:74 lists only spell resistances), so a
  // short sword is not better against one — it is merely not worse. What that buys is
  // free proficiency, which is the whole reason to do it.
  assert.equal(presetForQuarry('zombie'), 'shortSwording');

  // AN UNKNOWN QUARRY GETS NO OPINION, so a creature nobody has looked up cannot silently
  // inherit the zombie treatment and be fought with the one weapon type most things resist.
  assert.equal(presetForQuarry('narthyl worm'), null);
  assert.equal(presetForQuarry(null), null);
  assert.equal(presetForQuarry(''), null);
});

test('weapons: the same unit swaps order when its quarry changes, with no doctrine edit', () => {
  const d = doctrine();
  const order = hunting => {
    const live = [{ ...rows(1)[0], hunting, items: [], carry: { load: 0.1 }, provides: [] }];
    const intent = weaponFleetRules[0].decide(
      { characters: live, strategies: { agents: {} } }, d);
    return (intent.plan ?? []).find(p => p.do === 'weapon-policy')?.priority ?? [];
  };
  assert.equal(order('skeleton')[0], 'hammer', 'a skeleton takes 120% from bludgeon');
  assert.equal(order('zombie')[0], 'short sword', 'and a zombie resists nothing');
  // The strategy is vsSkeletons for both — only the quarry differs, which is the point.
  assert.equal(order('battered skeleton')[0], 'hammer');
  // Unknown quarry falls back to the unit's strategy rather than to the sword.
  assert.equal(order('narthyl worm')[0], 'hammer');
});
