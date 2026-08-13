// THE MARION CRYPT SHIFT.
//
// The assertions worth keeping are the ones that fail in the dangerous direction if
// somebody inverts them: that 2602 is never a destination, that roaming is off, that the
// engagement ceiling is sized to the ROOM rather than the quarry, and that the statue —
// which is what a reader will reach for, because it is the thing standing in the room —
// is not selectable as a standing quarry.

import assert from 'node:assert/strict';
import { loadDoctrine } from '../src/config/load.mjs';
import { cryptAssignments, cryptFleetRules } from '../src/decide/rules/crypt.mjs';
import { CRYPT_ROOMS, CRYPT_QUARRY_LEVEL, cryptAssignment, STRATEGY_IDS }
  from '../src/strategies/catalog.mjs';
import { weaponFleetRules } from '../src/decide/rules/weapons.mjs';

const test = globalThis.__dumTest;

const doctrine = () => loadDoctrine({ file: 'doctrines/marion-crypt.jsonc' }).config;
const rows = (n = 21, over = {}) => Array.from({ length: n }, (_, i) => ({
  agent: `t${i + 1}`, in_game: true, level: 60, room: 39, mode: 'farm',
  policy: {}, commitment: null, parked: null, piloted: null, ...over,
}));
const obsOf = rows_ => ({ characters: rows_, strategies: { agents: {} } });
const fire = (rows_, d = doctrine()) => cryptFleetRules[0].decide(obsOf(rows_), d);

test('crypt: 2602 is not reachable through this table, at any setting', () => {
  // Thrashers, level 150, rating 870, cap 15, one door from 2601. The fleet's ceiling at
  // 60 max health is 90. Nothing here may route a character into that room.
  assert.equal(CRYPT_ROOMS[2602], undefined);
  assert.deepEqual(Object.keys(CRYPT_ROOMS).sort(), ['2600', '2601']);
  // Even asked for explicitly, an unknown room resolves to nothing rather than to itself.
  assert.equal(cryptAssignment(['skeleton'], [2602], 60), null);
  assert.equal(doctrine().strategies.settings['short-swording'].rooms.includes(2602), false);
});

test('crypt: a statue is never a standing quarry', () => {
  // Room 2601 places 37 statues from `FirstUserEntered`, and `PlaceStatues` returns early
  // while any statue remains (marcryp2.kod:161-168) — so an occupied room never refills.
  // The keeper would never notice: its "this room cannot produce our prey" check reads the
  // spawn table, which lists statues in 2601 for ever.
  assert.equal(CRYPT_QUARRY_LEVEL.statue, undefined);
  assert.equal(cryptAssignment(['statue'], [2601, 2600], 60), null,
    'naming the statue produces no assignment rather than a room to stand in');
  for (const room of Object.values(CRYPT_ROOMS))
    assert.equal(room.generates.includes('statue'), false,
      `${room.room} must not claim to generate something placed once`);
});

test('crypt: the quarry picks the room, so changing it moves the fleet', () => {
  assert.deepEqual(cryptAssignment(['skeleton', 'spectral mummy'], [2601, 2600], 60),
    { quarry: 'skeleton', ...CRYPT_ROOMS[2601] });
  assert.deepEqual(cryptAssignment(['spectral mummy'], [2601, 2600], 60),
    { quarry: 'spectral mummy', ...CRYPT_ROOMS[2600] });
});

test('crypt: a unit too small for the skeleton falls through rather than being stranded', () => {
  // refuseEngagement refuses a creature above round(max_health * 1.5). At 40 max health the
  // ceiling is 60, which admits neither the level-75 skeleton nor the level-75 statue
  // standing in 2600 — so there is nowhere in the crypt for it and that is said, not
  // guessed at. The failure being avoided is a character sent to a room where it refuses
  // everything that appears and stands there looking healthy.
  assert.equal(cryptAssignment(['skeleton', 'spectral mummy'], [2601, 2600], 40), null);
  assert.equal(cryptAssignment(['skeleton', 'spectral mummy'], [2601, 2600], 50).quarry,
    'skeleton', '50 max health gives a ceiling of exactly 75');

  const small = rows(1, { level: 40 });
  const intent = fire(small);
  assert.equal(intent.kind, 'pass');
  assert.match(intent.why, /engagement ceiling/);
});

test('crypt: the shipped doctrine deploys the fleet to 2601 with roaming off', () => {
  const intent = fire(rows());
  assert.equal(intent.kind, 'act');
  assert.equal(intent.plan.length, 21);
  assert.deepEqual([...new Set(intent.plan.map(p => p.to))], [2601]);
  assert.deepEqual([...new Set(intent.plan.map(p => p.hunt))], ['skeleton']);
  // ROAMING OFF IS THE SAFETY PROPERTY. A keeper looking for absent prey is how characters
  // ended up in the Decaying City of Brax; here the next room is worse.
  assert.ok(intent.plan.every(p => p.roam === false));
  // The ceiling is sized to the ROOM's strongest occupant, not the quarry. 2600 generates
  // level-40 mummies and has a level-75 statue in it; a ceiling of 40 there would make the
  // keeper reject its own assigned room.
  assert.ok(intent.plan.every(p => p.max_threat_over === 15));
  // `purpose` without `goals` is not an audit — yieldCheck answers "nothing can be checked"
  // and every row renders as not paying.
  assert.ok(intent.plan.every(p => p.purpose === 'advance' && p.goals?.length));
  assert.ok(intent.plan.every(p => p.weapon_priority?.[0] === 'short sword'));
});

test('crypt: a committed, parked or piloted unit is stepped over', () => {
  for (const block of [{ commitment: { kind: 'errand', takeable: false, label: 'loot run' } },
                       { parked: true }, { piloted: true }]) {
    const intent = fire(rows(1, block));
    assert.equal(intent.kind, 'pass', `${Object.keys(block)[0]} must not be re-deployed`);
  }
  // And a unit already holding its orders is not re-sent every tick.
  const settled = rows(1, { policy: { assignedRoom: 2601, hunt: 'skeleton', roam: false,
    purpose: 'advance' } });
  assert.equal(fire(settled).kind, 'pass');
});

test('crypt: the shift is off unless a doctrine asks, and Castle Victoria is off with it', () => {
  assert.equal(cryptFleetRules[0].enabled({}), false, 'no crypt block means no shift');
  assert.equal(cryptFleetRules[0].enabled({ crypt: { shift: true } }), true);

  // ALL THREE CASTLE EFFORTS HAVE TO BE OFF TOGETHER. Any one left on drags part of the
  // fleet back across the world while the crypt rule sends it the other way, and the two
  // fight every tick.
  const d = doctrine();
  assert.equal(d.castle_victoria.shift, false);
  assert.equal(d.crate.check, false);
  assert.equal(d.placement.spread, false);
  // And the two weapon orders must not both be selected: a unit holding both is a doctrine
  // that cannot say what it wants, even though the tie is broken in code.
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.VS_SKELETONS), false);
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.SHORT_SWORDING), true);
  assert.equal(d.strategies.defaults.includes(STRATEGY_IDS.CHECK_CV_CRATE), false);
});

test('crypt: selecting Short swording actually changes the weapon order', () => {
  // It did not, for as long as the strategy has existed: `shortSwording` was defined in
  // decide/weapons.mjs with an alias for this very id, and nothing read the id.
  const d = doctrine();
  // Create Weapons is selected too, and its provisioning half refuses to plan against an
  // unread pack — so the row carries the three fields it reads. That refusal is correct
  // and is somebody else's test; here it would just hide the weapon policy.
  const live = rows(1, { items: [], carry: { load: 0.1 }, provides: [] });
  const intent = weaponFleetRules[0].decide({ characters: live, strategies: { agents: {} } }, d);
  const priority = (intent.plan ?? []).find(p => p.do === 'weapon-policy')?.priority;
  assert.ok(priority, 'a unit running Short swording is given a weapon policy');
  assert.equal(priority[0], 'short sword', 'the short sword the skill is for comes first');
  assert.ok(priority.length > 1, 'and everything else follows — never an empty hand');
});

test('crypt: DUM\'s own claim does not count as busy', () => {
  // THE `isTakeable` TRAP. DUM claims every character it steers, and the harness marks
  // that claim `takeable: true` with "nothing is mid-flight" spelled out in its detail.
  // A rule testing `row.commitment` for truthiness therefore blocks on its own claim and
  // can never act on anybody — and it reports the whole fleet as mid-errand while doing
  // so, which reads exactly like a retarget that landed. Caught live: the first crypt
  // dry-run said "21 of 21 unit(s) are mid-errand" against a fleet nothing was holding
  // but DUM.
  const claimed = rows(1, { commitment: { kind: 'bot', takeable: true,
    label: 'dum is steering', detail: 'Not an operation — nothing is mid-flight' } });
  assert.equal(fire(claimed).kind, 'act', 'a takeable bot claim is ownership, not an errand');
  // A partner is a standing arrangement, not a journey, and also does not block orders.
  const partnered = rows(1, { commitment: { kind: 'partner', takeable: false } });
  assert.equal(fire(partnered).kind, 'act');
});
