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
import { castleVictoriaFleetRules } from '../src/decide/rules/castle-victoria.mjs';
import { presetForQuarry } from '../src/decide/weapons.mjs';

const test = globalThis.__dumTest;

const doctrine = () => loadDoctrine({ file: 'doctrines/castle-graveyard.jsonc' }).config;
const rows = (n = 21, over = {}) => Array.from({ length: n }, (_, i) => ({
  agent: `t${i + 1}`, in_game: true, level: 60, room: 39, mode: 'farm',
  policy: {}, commitment: null, parked: null, piloted: null, ...over,
}));
const obsOf = rows_ => ({ characters: rows_, strategies: { agents: {} } });
const fire = (rows_, d = doctrine()) => shiftFleetRules[0].decide(obsOf(rows_), d);
// A doctrine with the downstairs share pinned OPEN. Several tests below are about the
// sorting MECHANISM — the engagement ceiling, idempotence — and not about how the shipped
// doctrine happens to divide the fleet today. Riding on the shipped share made all three
// fail the moment that number was tuned, which is a test telling you the policy changed
// dressed up as a test telling you the code broke.
const allDownstairs = () => {
  const d = doctrine();
  d.shift.stations.find(st => st.room === 38).share = 1.0;
  return d;
};

test('shift: a level-150 room is unreachable however it is asked for', () => {
  // 2602 is thrashers (150, rating 870) one door from 38. 552 The Great Ocean is the
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
  assert.equal(HUNT_ROOMS[2601], undefined, '2601 is permanently capped by unkillable statues');
  assert.equal(admits(60, 576, 'skeleton'), false, '576 has no skeleton generator');
  assert.equal(admits(60, 38, 'frogman'), false, '38 has no frogman generator');
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
  // THE SPLIT IS THE POLICY, AND THIS IS THE ASSERTION THAT SHOULD MOVE WHEN IT DOES.
  // It used to be { 38: 21 } — everyone downstairs — because station 38 carried share 1.0
  // and a share is a share of the ELIGIBLE. Measured live on 2026-08-14: seventeen
  // characters downstairs returned 2.9 kills each and six deaths in ninety minutes, while
  // four upstairs returned 8.8 each and none. piMonster_count_max is room-wide, so most of
  // a crowd of seventeen is waiting for a generator, not fighting.
  // Retuned to 0.25 after the next window's measurement: room 39 HELD 8.7 kills each at
  // eleven characters (from 8.8 at four), so its generator was never the constraint, while
  // room 38 fell to 1.6 each after being thinned and produced eight of twelve deaths. The
  // quarry was the problem, not the crowd. Level-ordering leaves the largest characters
  // downstairs, which is right: a level-60 battered skeleton stops advancing a character
  // that has reached 60.
  // Room 38 is now SHUT (share 0). At a quarter it held four characters, returned two
  // kills between them and produced three of the fleet's last six deaths, while room 39
  // returned 8.9 per character and killed nobody for the fourth reading running.
  assert.deepEqual(byRoom, { 39: 21 }, 'the whole fleet works the softer quarry');
  // One open station, one quarry.
  assert.deepEqual([...new Set(intent.plan.map(p => p.hunt))], ['battered skeleton']);
  // ROAMING OFF IS THE SAFETY PROPERTY. 41, the Underbasement, is one door below 38 and
  // generates narthyl worms at level 120.
  assert.ok(intent.plan.every(p => p.roam === false));
  // Sized to the ROOM, so the two rooms give two different bands: 38's threat is 75 and
  // 39's is 60, against a fixture level of 60.
  assert.ok(intent.plan.filter(p => p.to === 38).every(p => p.max_threat_over === 15),
            '38 threat 75 against level 60');
  assert.ok(intent.plan.filter(p => p.to === 39).every(p => p.max_threat_over === 0),
            '39 threat 60 against level 60');
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
  // SHARE PINNED OPEN, because this test is about the CEILING doing the sorting and not
  // about how the shipped doctrine currently divides the fleet. With the live share of 0.6
  // some ceiling-90 units are sent upstairs on purpose, which would fail the assertion
  // below while the mechanism it names is working perfectly.
  const assigned = shiftAssignments(mixed, allDownstairs(), obsOf(mixed));
  const at = lvl => assigned.filter(a => a.row.level === lvl);
  assert.ok(at(60).every(a => a.to === 38), 'ceiling 90 takes the level-75 skeleton');
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
  // SHARE PINNED OPEN. `want` is min(capacity, share x eligible), so a station whose share
  // is 0 takes nobody however large its capacity — which is correct, and which makes this
  // test vacuous against the shipped doctrine now that 38 is shut. What is under test is
  // that a CAPACITY overflows into the next station, so the share must not be the binding
  // constraint.
  const d = allDownstairs();
  d.shift.stations.find(st => st.room === 38).max = 5;
  const intent = fire(rows(21), d);
  const byRoom = intent.plan.reduce((m, p) => ({ ...m, [p.to]: (m[p.to] ?? 0) + 1 }), {});
  assert.deepEqual(byRoom, { 38: 5, 39: 16 }, 'the surplus goes to the next station');

  // And the other direction, which is what shutting a station relies on: a share of 0
  // empties it whatever its capacity says.
  const shut = allDownstairs();
  const st38 = shut.shift.stations.find(st => st.room === 38);
  st38.max = 5; st38.share = 0;
  const none = fire(rows(21), shut).plan.filter(p => p.to === 38);
  assert.equal(none.length, 0, 'share 0 shuts a station even with capacity to spare');
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
  // Pinned open too: "already on station" has to be built from the SAME allocation the
  // rule would make, or the fixture is asserting the old policy rather than idempotence.
  // Under the live 0.6 split a fleet standing entirely in 38 is genuinely NOT on station,
  // and being re-sent is correct behaviour rather than the churn this test guards against.
  const settled = rows(21).map(r => ({ ...r, room: 38,
    policy: { assignedRoom: 38, hunt: 'skeleton', roam: false, purpose: 'advance' } }));
  assert.equal(fire(settled, allDownstairs()).kind, 'pass',
               'a fleet already on station is left alone');

  // AND THE SPLIT ITSELF MUST BE IDEMPOTENT, which is the property that actually matters
  // now there are two rooms: feed the rule its own plan back and it must have nothing to
  // do. An unstable split would walk characters up and down the stairs for ever.
  const plan = fire(rows(21)).plan;
  const onStation = rows(21).map(r => {
    const p = plan.find(x => x.agent === r.agent);
    return { ...r, room: p.to,
             policy: { assignedRoom: p.to, hunt: p.hunt, roam: false, purpose: 'advance' } };
  });
  assert.equal(fire(onStation).kind, 'pass', 'the 38/39 split does not re-send itself');

  // ORDERS MATCHING IS NOT BEING THERE. The same orders, standing somewhere else and
  // idle, must produce a walk — this is the case that had eleven characters holding safe
  // walls in a dead room for hours while every signal read healthy.
  const stranded = rows(21).map(r => ({ ...r, room: 71, activity: 'holding a untested safe spot',
    policy: { assignedRoom: 38, hunt: 'skeleton', roam: false, purpose: 'advance' } }));
  // Share pinned open again: what is under test is that ORDERS MATCHING IS NOT BEING
  // THERE, not which of the two castle rooms they are sent to.
  const walk = fire(stranded, allDownstairs());
  assert.equal(walk.kind, 'act');
  assert.ok(walk.plan.every(p => p.do === 'relocate' && p.to === 38));

  // The same property under the LIVE split, stated without naming a room: everybody
  // stranded is walked to a castle station, whichever one the share gives them.
  // RELOCATE AND DEPLOY ARE DIFFERENT VERBS AND THE SPLIT USES BOTH. A unit whose orders
  // already name 38 is RELOCATED to the room its orders name; one the share moves upstairs
  // has its orders changed, which is a DEPLOY. Asserting relocate for all of them was
  // wrong, and wrong in the direction that would have hidden the new verb entirely.
  const split = fire(stranded);
  assert.equal(split.kind, 'act');
  assert.ok(split.plan.every(p => ['relocate', 'deploy'].includes(p.do) && [38, 39].includes(p.to)),
            'a stranded fleet is recalled to the castle under either share');
  // Stated without naming a room, because which rooms are open IS the policy. With 38
  // shut every unit is re-ordered upstairs, so there is no relocate left to find — naming
  // 38 here made this assertion fail the moment the station closed, which is a policy
  // change reading as a code break for the third time in this file.
  assert.ok(split.plan.every(p => p.to === 39),
            'with 38 shut the whole fleet is sent upstairs');
  assert.ok(split.plan.some(p => p.do === 'deploy'),
            'a unit whose orders change is re-ordered, not merely walked');

  // But a keeper already travelling or fighting is making its own progress and must not
  // have a second journey started underneath it.
  for (const activity of ['travelling', 'fighting from a proven safe spot', 'resting']) {
    const busy = rows(21).map(r => ({ ...r, room: 71, activity,
      policy: { assignedRoom: 38, hunt: 'skeleton', roam: false, purpose: 'advance' } }));
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

test('shift: the shipped doctrine leaves the fleet in one room', () => {
  // EVERY ROAD OUT OF CASTLE VICTORIA CROSSES RATING-750 TROLL COUNTRY. Measured
  // 2026-08-14: 38 -> 70 is eight hops through 599/598/597 and back again, and 38 -> 826
  // is six through 599 and 578. So any second station buys its prey with two crossings of
  // the most dangerous rooms the fleet touches, twice per cycle.
  //
  // The numbers that settled it: 210 kills in the half hour the fleet sat in the castle,
  // 39 in the half hour it spent walking to and from the graveyard, three deaths in rooms
  // that are neither station, and two characters of twenty-one actually on station.
  const d = doctrine();
  const live = d.shift.stations.filter(st => String(st.when ?? 'always').toLowerCase() === 'always');
  assert.deepEqual(live.map(st => st.room), [38, 39, 544],
    'castle, its overflow, and the floor for the ground-down — nothing that needs a journey');
  assert.equal(d.shift.stations.some(st => st.room === 70), false,
    'the graveyard is off: its corridor costs more than its window returns');
});

test('shift: the deploy payload and the order diff agree on training style', () => {
  // TWO PLACES COMPUTE THE SAME ORDER AND THEY MUST NOT DISAGREE. `needsOrders` compares
  // what the row already holds against a freshly-built `orders` object; the deploy step a
  // few lines down builds the payload that is actually sent. When the diff used the
  // DOWNGRADED style and the payload used the station's raw one, a character who qualified
  // for the downgrade was found to differ on every single pass — compared as `unarmed`,
  // deployed as `alternate_on_improve`, never converging and never switching.
  //
  // Measured on one character, 2026-09-08: mace fighting 56 and short sword fighting 50 against a
  // level-50 quarry, brawling 5. Nothing armed could advance, so the whole bout should be
  // unarmed, and the board showed `alternate_on_improve` indefinitely.
  const d = doctrine();
  // 544 is the fungus-beast floor: quarry level 50, which is what makes a short sword at
  // exactly 50 dead there. Station 38's skeletons are level 75 and everything still
  // qualifies against them, so the station matters as much as the abilities do.
  for (const s of d.shift.stations) s.share = s.room === 544 ? 1.0 : 0;
  const st = d.shift.stations.find(s => s.room === 544);
  st.training_style = 'alternate_on_improve';

  const capped = { ...rows(1)[0], agent: 'capped', room: 999, hunting: 'fungus beast',
    skills: [{ name: 'mace fighting', ability: 56 },
             { name: 'short sword fighting', ability: 50 },
             { name: 'brawling', ability: 5 }] };
  const open = { ...rows(1)[0], agent: 'open', room: 999, hunting: 'fungus beast',
    skills: [{ name: 'short sword fighting', ability: 50 },
             { name: 'hammer wielding', ability: 7 }] };

  const styleOf = row => {
    const step = (fire([row], d).plan ?? []).find(p => p.do === 'deploy' && p.agent === row.agent);
    assert.ok(step, `${row.agent} was never deployed`);
    return step;
  };

  const g = styleOf(capped);
  assert.equal(g.training_style, 'unarmed',
    'nothing armed can advance, so the armed half is dropped rather than run dead');
  assert.equal(g.training_weapon, undefined, 'and no weapon is named');

  // The downgrade is not a blanket disable: a character who still holds a live armed
  // proficiency keeps the alternation and is handed that weapon.
  const c = styleOf(open);
  assert.equal(c.training_style, 'alternate_on_improve');
  assert.equal(c.training_weapon, 'hammer', 'the highest-level skill still below the cap');
});

test('shift: a tier gated on requirements takes everyone who qualifies', () => {
  // A GRADUATION TIER HAS NO SHARE, AND THAT USED TO MEAN IT TOOK NOBODY.
  //
  // `want` is `round(eligible * share)` for any station that is neither the last nor
  // banded, and a tier written as `requires: [...]` with no share is exactly that — so it
  // computed zero seats, and being not-last it did not absorb the remainder either. Every
  // character that qualified fell through to the floor it had just graduated out of, and
  // nothing looked wrong: the tier was present and its predicate answered true.
  //
  // Measured 2026-09-08: three characters held a level-3 Weaponcraft skill and
  // all three stayed in the valley.
  const d = doctrine();
  d.shift.stations = [
    { room: 39, hunt: ['battered skeleton'],
      requires: [{ skill: ['hammer wielding', 'axe wielding', 'fencing'] }] },
    { room: 544, hunt: ['fungus beast'] },
  ];
  const holder = ab => [{ name: 'short sword fighting', ability: 50 }, ...ab];
  const live = [
    { ...rows(1)[0], agent: 'grad1', skills: holder([{ name: 'axe wielding', ability: 3 }]) },
    { ...rows(1)[0], agent: 'grad2', skills: holder([{ name: 'fencing', ability: null }]) },
    { ...rows(1)[0], agent: 'floor1', skills: holder([]) },
    { ...rows(1)[0], agent: 'floor2', skills: holder([{ name: 'mace fighting', ability: 56 }]) },
  ];
  const at = Object.fromEntries(
    shiftAssignments(live, d, { characters: live, strategies: { agents: {} } })
      .map(a => [a.row.agent, a.to]));

  assert.equal(at.grad1, 39, 'holding a level-3 skill graduates');
  assert.equal(at.grad2, 39, 'even with no ability reading yet — presence is the test');
  assert.equal(at.floor1, 544, 'and everyone else stays on the floor');
  assert.equal(at.floor2, 544);

  // The ladder is not two rungs — it must compose. A third tier in front of the other two
  // takes its own qualifiers and leaves the rest to fall through, first match winning.
  d.shift.stations.unshift({ room: 38, hunt: ['skeleton'],
    requires: [{ skill: 'scimitar wielding' }] });
  live[0].skills.push({ name: 'scimitar wielding', ability: 1 });
  const at3 = Object.fromEntries(
    shiftAssignments(live, d, { characters: live, strategies: { agents: {} } })
      .map(a => [a.row.agent, a.to]));
  assert.equal(at3.grad1, 38, 'the most-graduated tier is written first and wins');
  assert.equal(at3.grad2, 39, 'the tier below still takes its own');
  assert.equal(at3.floor1, 544);
});

test('shift: the weapon priority leads with the weapon the training order names', () => {
  // TWO FIELDS IN ONE ORDER MUST NOT NAME DIFFERENT WEAPONS. `training_weapon` is chosen
  // per character; `weapon_priority` came from TRAINING_PRESET, which maps every armed
  // style to `shortSwording` unconditionally. So an order could say "train with a long
  // sword" and, in the same payload, rank short sword first — and the keeper drew a short
  // sword for every fight that was not a training bout.
  const d = doctrine();
  for (const s of d.shift.stations) s.share = s.room === 544 ? 1.0 : 0;
  d.shift.stations.find(s => s.room === 544).training_style = 'alternate_on_improve';

  const priorityOf = skills => {
    const row = { ...rows(1)[0], agent: 'x', room: 999, skills };
    const step = (fire([row], d).plan ?? []).find(p => p.do === 'deploy');
    return step?.weapon_priority ?? [];
  };

  const hammer = priorityOf([{ name: 'short sword fighting', ability: 50 },
                             { name: 'hammer wielding', ability: 7 }]);
  assert.equal(hammer[0], 'hammer', 'the chosen weapon ranks first');
  assert.equal(hammer.filter(n => n === 'hammer').length, 1, 'and is not left in twice');
  assert.ok(hammer.includes('short sword'), 'the preset still supplies the rest of the ranking');

  // Nothing chosen -> the station's preset, untouched. Every doctrine written before the
  // per-character selector must behave exactly as it did.
  const plain = priorityOf([{ name: 'short sword fighting', ability: 3 }]);
  assert.equal(plain[0], 'short sword');
});

test('shift: stations and the Castle Victoria shift are never both in charge', () => {
  // BOTH RULES SEND `autopilot start` WITH A ROOM. With both enabled they overwrite each
  // other every pass and the winner is decided by table position, which is not a policy.
  //
  // Measured 2026-09-08: the weaponcraft doctrine inherited `castle_victoria.shift: true`
  // and was saved only by `feast-hall-larder` starving it from above. When that stopped,
  // one pass assigned all 21 characters to room 39 at `upstairs_share: 1` — eighteen of
  // them off the fungus beasts their station had put them on.
  const rule = castleVictoriaFleetRules.find(r => r.id === 'castle-victoria-undead-shift');
  assert.equal(rule.enabled({ castle_victoria: { shift: true }, shift: { on: true } }), false,
    'written stations own room assignment');
  assert.equal(rule.enabled({ castle_victoria: { shift: true }, shift: { on: false } }), true);
  assert.equal(rule.enabled({ castle_victoria: { shift: true } }), true,
    'a doctrine that never mentions the shift is unaffected');
  assert.equal(rule.enabled({ castle_victoria: { shift: false }, shift: { on: true } }), false);

  // And the shipped training doctrine is one of the doctrines that would have collided.
  const d = loadDoctrine({ file: 'doctrines/local/prod-weaponcraft-training.jsonc' }).config;
  assert.equal(d.shift.on, true);
  assert.equal(rule.enabled(d), false);
});

test('shift: a weapon the character does not carry is never the training weapon', () => {
  // THE PROFICIENCY AND THE STEEL ARE TWO QUESTIONS. `prepareTrainingStyle` cancels a bout
  // whose weapon it cannot produce rather than substituting one, so naming an absent weapon
  // does not make the training worse — it makes it not happen, silently, while every board
  // still shows the character fighting.
  //
  // Measured 2026-09-08: told to train `short sword`, THREE of twenty-one were carrying one.
  const d = doctrine();
  for (const s of d.shift.stations) s.share = s.room === 544 ? 1.0 : 0;
  d.shift.stations.find(s => s.room === 544).training_style = 'short_sword';

  const skills = [{ name: 'short sword fighting', ability: 20 },
                  { name: 'mace fighting', ability: 44 }];
  const step = extra => {
    const row = { ...rows(1)[0], agent: 'x', room: 999, skills, ...extra };
    return (fire([row], d).plan ?? []).find(p => p.do === 'deploy');
  };

  const armed = step({ pack_items: ['short sword', 'bread'] });
  assert.equal(armed.training_weapon, 'short sword');
  assert.equal(armed.training_style, 'short_sword');

  // A mace is Weaponcraft LEVEL 1 and counts toward nothing the level-3 unlock reads, so a
  // character carrying only a mace is better off with bare hands: brawling is level 2 and
  // has no cap.
  const maceOnly = step({ pack_items: ['mace'] });
  assert.equal(maceOnly.training_style, 'unarmed');
  assert.equal(maceOnly.training_weapon, undefined);

  const empty = step({ pack_items: [] });
  assert.equal(empty.training_style, 'unarmed', 'an empty pack cannot run an armed bout');

  // AN UNREADABLE PACK IS NOT AN EMPTY ONE. `pack_items: null` means nobody looked, and
  // disarming the fleet on a field that failed to load is the failure this codebase keeps
  // recording. Behave exactly as before the filter existed.
  const unknown = step({ pack_items: null });
  assert.equal(unknown.training_weapon, 'short sword');
  assert.equal(unknown.training_style, 'short_sword');

  // What is in HAND counts even when the pack list has not caught up with it.
  const inHand = step({ pack_items: [], wielding: 'short sword' });
  assert.equal(inHand.training_weapon, 'short sword');
});

// NAMING CHARACTERS ON A STATION. The role that does not fit a tier: a buff caster
// qualifies for the graduated room on skills and is wanted with the characters it buffs,
// because a personal enchantment only reaches somebody in the same room.
test('a station with `only` takes that character and nobody else', () => {
  const st = [
    { room: 544, only: ['Ada'], hunt: ['fungus beast'], training_style: 'short_sword' },
    { room: 39, hunt: ['battered skeleton'], training_style: 'short_sword' },
  ];
  const d = doctrine();
  d.shift = { ...d.shift, on: true, stations: st };
  const rs = rows(4).map((r, i) => ({ ...r, character: ['Ada', 'Bea', 'Cyd', 'Dee'][i] }));
  const got = shiftAssignments(rs, d);
  const byName = Object.fromEntries(got.filter(Boolean).map(a => [a.row.character, a.to]));
  assert.equal(byName.Ada, 544, 'the named character takes the named station');
  for (const n of ['Bea', 'Cyd', 'Dee'])
    assert.equal(byName[n], 39, `${n} is not admitted to a station that names somebody else`);
});

// The failure this guards is the one already written up above `takesAll`: a gate with no
// `share` computes want = round(n * 0) = 0, seats nobody, and -- not being the last
// station -- does not absorb the remainder either. The tier bug, in a new coat.
test('a station named for one character is not handed zero seats', () => {
  const d = doctrine();
  d.shift = { ...d.shift, on: true, stations: [
    { room: 544, only: ['Ada'], hunt: ['fungus beast'], training_style: 'short_sword' },
    { room: 39, hunt: ['battered skeleton'], training_style: 'short_sword' },
  ] };
  const rs = rows(3).map((r, i) => ({ ...r, character: ['Ada', 'Bea', 'Cyd'][i] }));
  const a = shiftAssignments(rs, d).find(x => x?.row?.character === 'Ada');
  assert.equal(a.to, 544, 'the named station seated its one character');
});

test('`except` keeps a qualified character out of a station it would otherwise take', () => {
  const d = doctrine();
  d.shift = { ...d.shift, on: true, stations: [
    { room: 39, except: ['Ada'], hunt: ['battered skeleton'], training_style: 'short_sword' },
    { room: 544, hunt: ['fungus beast'], training_style: 'unarmed' },
  ] };
  const rs = rows(2).map((r, i) => ({ ...r, character: ['Ada', 'Bea'][i] }));
  const byName = Object.fromEntries(shiftAssignments(rs, d).filter(Boolean)
    .map(a => [a.row.character, a.to]));
  assert.equal(byName.Ada, 544, 'excluded from 39, so it falls to the floor');
  assert.equal(byName.Bea, 39, 'everybody else is unaffected');
});

test('a station gate matches the agent id as well as the character name', () => {
  const d = doctrine();
  d.shift = { ...d.shift, on: true, stations: [
    { room: 544, only: ['unit-a'], hunt: ['fungus beast'], training_style: 'short_sword' },
    { room: 39, hunt: ['battered skeleton'], training_style: 'short_sword' },
  ] };
  // Agent ids rather than character names, and deliberately not the live fleet's: the ids
  // this fleet uses are also its account passwords, so the guard treats a literal one in a
  // tracked file as a leaked secret. It is right to.
  const rs = rows(2).map((r, i) => ({ ...r, agent: ['unit-a', 'unit-b'][i],
                                      character: ['Ada', 'Bea'][i] }));
  const byId = Object.fromEntries(shiftAssignments(rs, d).filter(Boolean)
    .map(a => [a.row.agent, a.to]));
  assert.equal(byId['unit-a'], 544, 'matched on the agent id');
  assert.equal(byId['unit-b'], 39);
});

test('a station with neither gate is unchanged', () => {
  const d = doctrine();
  d.shift = { ...d.shift, on: true, stations: [
    { room: 39, hunt: ['battered skeleton'], training_style: 'short_sword' },
  ] };
  const rs = rows(3).map((r, i) => ({ ...r, character: ['Ada', 'Bea', 'Cyd'][i] }));
  for (const a of shiftAssignments(rs, d)) assert.equal(a.to, 39);
});

// AN ORDER FIELD IS A FOUR-FILE CHANGE AND SILENCE IS ITS FAILURE MODE.
//
// fleet-plan.mjs says it in its own comment: a field the rule sets and that whitelist omits
// is dropped with no error raised anywhere — the doctrine reads correct, the journal shows
// the rule firing, and the keeper never hears it. These tests walk the whole chain for
// `buff_allies` so a future edit that drops one of the four halves fails here instead.
test('buff_allies survives the station -> intent -> plan chain', () => {
  const d = doctrine();
  const buff = { enabled: true, spells: ['super strength', 'bless'] };
  d.shift = { ...d.shift, on: true, stations: [
    { room: 39, hunt: ['battered skeleton'], training_style: 'short_sword', buff_allies: buff },
  ] };
  const rs = rows(2, { room: 999 });                 // out of position, so it deploys
  const out = fire(rs, d);
  const steps = JSON.stringify(out?.steps ?? out?.intents ?? out);
  assert.ok(steps.includes('buff_allies'),
    'the rule must put buff_allies on the intent, or the plan has nothing to carry');
  assert.ok(steps.includes('super strength'), 'and the spell list must survive with it');
});

test('a station that does not ask for it emits nothing', () => {
  const d = doctrine();
  d.shift = { ...d.shift, on: true, stations: [
    { room: 39, hunt: ['battered skeleton'], training_style: 'short_sword' },
  ] };
  const out = fire(rows(2, { room: 999 }), d);
  const steps = JSON.stringify(out?.steps ?? out?.intents ?? out);
  assert.ok(!steps.includes('buff_allies'),
    'undefined is dropped by the diff, so every doctrine written before this is unchanged');
});

test('the schema refuses a bare true, which the broker would reject at the door', () => {
  // The trap: the harness reports an unrecognised value rather than applying it, and the
  // order diff throws at the END of its loop — so one bad field discards the room, the hunt
  // and the training style in the same intent, and the station silently stops deploying.
  const bad = { shift: { on: true, stations: [{ room: 39, buff_allies: true }] } };
  const said = JSON.stringify(validate(bad));
  assert.match(said, /buff_allies/, 'the schema has to catch it before the broker does');
});

test('the schema refuses an object that does not say enabled', () => {
  const bad = { shift: { on: true, stations: [{ room: 39, buff_allies: { spells: ['bless'] } }] } };
  assert.match(JSON.stringify(validate(bad)), /buff_allies\.enabled/);
});

test('a well-formed buff_allies passes validation', () => {
  const good = { shift: { on: true, stations: [
    { room: 39, hunt: ['battered skeleton'], buff_allies: { enabled: true, spells: ['bless'] } },
  ] } };
  const said = JSON.stringify(validate(good));
  assert.ok(!/buff_allies/.test(said), `unexpected complaint: ${said}`);
});
