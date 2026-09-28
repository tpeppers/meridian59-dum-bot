// UKGOTH TROLLS — the assertions that fail in the dangerous direction if inverted:
//
//   - a unit whose weapon nobody has READ is never sent to the trolls (unknown is refused)
//   - a mundane weapon is never sent either, whatever the unit's size
//   - the deploy turns the magic tie-break ON and roaming OFF, and is diffed
//   - a dedication hands over a SPARE, never the weapon in hand, and the weapon always comes back
//   - the other shifts step over a troll hunter (one owner per body)

import assert from 'node:assert/strict';
import { loadDoctrine } from '../src/config/load.mjs';
import { validate } from '../src/config/schema.mjs';
import { trollFleetRules, trollReadiness, dedicationTarget, planDedication, planGear, planFood }
  from '../src/decide/rules/trolls.mjs';
import { requirementsMet, shiftFleetRules } from '../src/decide/rules/shift.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
import { throttleRules } from '../src/decide/rules/throttle.mjs';
import { CircuitJobs } from '../src/loop/circuits.mjs';
import { BACKGROUND_FLEET_ERRANDS } from '../src/loop/tick.mjs';
import { STRATEGY_IDS, strategySettings, admits, HUNT_ROOMS, QUARRY_LEVEL, trollOwned }
  from '../src/strategies/catalog.mjs';

const test = globalThis.__dumTest;
const ID = STRATEGY_IDS.UKGOTH_TROLLS;

const doctrine = () => {
  const d = loadDoctrine({ file: 'doctrines/castle-graveyard.jsonc' }).config;
  d.strategies = { ...(d.strategies ?? {}), enabled: true };
  return d;
};
const magic = (over = {}) => ({
  wielded: { name: 'hammer', class: 'enchanted', bypasses_nonmagic: true, made: false },
  magic_spares: 1, unknown: 0,
  weapons: [{ id: 11, name: 'hammer', class: 'enchanted', bypasses_nonmagic: true, made: false, wielded: true },
            { id: 12, name: 'hammer', class: 'enchanted', bypasses_nonmagic: true, made: false, wielded: false }],
  ...over,
});
const mundane = () => ({
  wielded: { name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false },
  magic_spares: 0, unknown: 0,
  weapons: [{ id: 21, name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false, wielded: true },
            { id: 22, name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false, wielded: false }],
});
const row = (agent, over = {}) => ({ agent, in_game: true, max_health: 75, level: 75, room: 38,
  mode: 'farm', policy: {}, commitment: null, parked: null, piloted: null, provides: [],
  pack_items: [], mana: { value: 0, max: 40 }, weapon_magic: magic(), ...over });
// The troll crew's vigor band as a settled keeper reports it (operator, 2026-09-27: 160+).
const VIG = { fightAboveVigor: 160, vigorCeiling: 200, noFoodVigorFloor: 60 };
const obs = (rows, agents) => ({ characters: rows, strategies: { agents } });
const settings = d => strategySettings(obs([], {}), d, 'x', ID);
const fire = (rows, agents, d = doctrine()) => trollFleetRules[0].decide(obs(rows, agents), d);

// ---- the Guardians of Zjiria (operator, 2026-09-27): killable by a group in armour and shields
const guardianDoctrine = (over = {}) => {
  const d = doctrine();
  d.strategies.settings = { ...(d.strategies.settings ?? {}),
    [ID]: { ...(d.strategies.settings?.[ID] ?? {}), guardians: true, ...over } };
  return d;
};
const inRoom = (agent, over = {}) => row(agent, { room: 599,
  health: { value: 75, max: 75, pct: 1 }, worn: ['leather armor', 'small round shield'], ...over });
const all = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, [ID]]));
const deploysOf = out => (out.plan ?? []).filter(p => p.do === 'deploy');

test('guardians: off by default — nobody hunts one, and the ceiling is the default', () => {
  const rows = [0, 1, 2, 3].map(i => inRoom(`g${i}`));
  for (const dep of deploysOf(fire(rows, all(4)))) {
    assert.deepEqual(dep.hunt, ['troll']);
    assert.deepEqual(dep.threat_ceiling, { mode: 'percent', value: 150 });
  }
});

test('guardians: four armoured, shielded, healthy units in the room hunt the Guardian first', () => {
  const rows = [0, 1, 2, 3].map(i => inRoom(`g${i}`));
  const deps = deploysOf(fire(rows, all(4), guardianDoctrine()));
  assert.equal(deps.length, 4);
  for (const dep of deps) {
    assert.deepEqual(dep.hunt, ['guardian of zjiria', 'troll'], 'Guardian first, trolls still');
    assert.deepEqual(dep.threat_ceiling, { mode: 'percent', value: 170 });
  }
  const calls = callsForFleetPlan([deps[0]]);
  assert.deepEqual(calls[0].args.threat_ceiling, { mode: 'percent', value: 170 }, 'the deploy whitelist carries it');
});

test('guardians: three is not a group, and nobody fights one alone', () => {
  const rows = [0, 1, 2].map(i => inRoom(`g${i}`));
  for (const dep of deploysOf(fire(rows, all(3), guardianDoctrine())))
    assert.deepEqual(dep.hunt, ['troll']);
});

test('guardians: no armour or no shield keeps a unit out, and can break the group', () => {
  const rows = [inRoom('g0'), inRoom('g1'), inRoom('g2'),
    inRoom('g3', { worn: ['small round shield'] }), inRoom('g4', { worn: ['leather armor'] })];
  for (const dep of deploysOf(fire(rows, all(5), guardianDoctrine())))
    assert.deepEqual(dep.hunt, ['troll'], `${dep.agent} would face a Guardian with three`);
  const unknown = [0, 1, 2, 3].map(i => inRoom(`g${i}`, i === 0 ? { worn: undefined } : {}));
  for (const dep of deploysOf(fire(unknown, all(4), guardianDoctrine())))
    assert.deepEqual(dep.hunt, ['troll'], 'unknown gear is not gear');
});

test('guardians: joining needs 90% health, staying needs only to be clear of the flee line', () => {
  const hurt = [0, 1, 2, 3].map(i => inRoom(`g${i}`, i === 0 ? { health: { value: 60, max: 75, pct: 0.8 } } : {}));
  for (const dep of deploysOf(fire(hurt, all(4), guardianDoctrine())))
    assert.deepEqual(dep.hunt, ['troll'], 'an 80% unit does not JOIN');
  const member = { assignedRoom: 599, hunt: ['guardian of zjiria', 'troll'], roam: false,
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.55, trainingStyle: 'normal',
    threatCeiling: { mode: 'percent', value: 170 }, ...VIG };
  const d = guardianDoctrine({ rest_below: 0.55 });
  const staying = [0, 1, 2, 3].map(i => inRoom(`g${i}`, { policy: member,
    ...(i === 0 ? { health: { value: 45, max: 75, pct: 0.6 } } : {}) }));
  assert.equal(fire(staying, all(4), d).kind === 'act'
    && deploysOf(fire(staying, all(4), d)).length > 0, false, 'a member at 60% stays: nothing re-sent');
});

test('guardians: a unit whose keeper reports hunt as a string does not crash the rule', () => {
  const rows = [0, 1, 2, 3].map(i => inRoom(`g${i}`, { policy: { assignedRoom: 599, hunt: 'troll', roam: false,
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.85 } }));
  const out = fire(rows, all(4), guardianDoctrine());
  assert.notEqual(out.kind, 'error');
  assert.ok(deploysOf(out).every(d => d.hunt[0] === 'guardian of zjiria'), JSON.stringify(out).slice(0, 300));
});

test('guardians: when the group breaks, the ceiling goes back to the default', () => {
  const member = { assignedRoom: 599, hunt: ['guardian of zjiria', 'troll'], roam: false,
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.85, trainingStyle: 'normal',
    threatCeiling: { mode: 'percent', value: 170 }, ...VIG };
  const rows = [0, 1, 2].map(i => inRoom(`g${i}`, { policy: member }));
  const deps = deploysOf(fire(rows, all(3), guardianDoctrine()));
  assert.equal(deps.length, 3);
  for (const dep of deps) {
    assert.deepEqual(dep.hunt, ['troll']);
    assert.deepEqual(dep.threat_ceiling, { mode: 'percent', value: 150 });
  }
});

// Operator, 2026-09-27: troll hunters keep 160+ vigor, fed. The band rides every deploy and
// stand-down, and the fleet throttle steps over the crew instead of resetting it to 40.
test('trolls: the vigor band rides the deploy, and the throttle leaves the crew alone', () => {
  const dep = fire([row('a')], { a: [ID] }).plan.find(p => p.do === 'deploy');
  assert.equal(dep.fight_above_vigor, 160);
  assert.equal(dep.vigor_ceiling, 200);
  assert.equal(dep.no_food_vigor_floor, 60);
  const args = callsForFleetPlan([dep])[0].args;
  assert.equal(args.vigor_ceiling, 200, 'the deploy whitelist carries the ceiling');
  assert.equal(args.no_food_vigor_floor, 60, 'and the empty-larder floor');
  const d = doctrine(); d.throttle = { with_food: 40, no_food: 40, min_meals: 1 };
  // A per-character observation, as the tick hands it: the row itself plus the strategy map.
  const own = { ...row('a', { level: 75, max_health: 75 }), strategies: { agents: { a: [ID] } } };
  const t = throttleRules[0].decide(own, d);
  assert.equal(t?.kind, 'pass', JSON.stringify(t));
  const other = throttleRules[0].decide({ ...row('b', { level: 75, max_health: 75 }), strategies: { agents: {} },
    policy: { fightAboveVigor: 160 } }, d);
  assert.equal(other?.kind, 'orders', 'everyone else is still throttled');
});

test('trolls: the catalogue admits a level-90 troll from 60 and names no Guardian', () => {
  assert.equal(QUARRY_LEVEL.troll, 90);
  assert.deepEqual([...HUNT_ROOMS[599].generates], ['troll']);
  assert.equal(admits(60, 599, 'troll'), true);
  assert.equal(admits(59, 599, 'troll'), false);
});

test('trolls: unknown weapon magic is refused, never assumed', () => {
  const s = settings(doctrine());
  assert.equal(trollReadiness(row('a', { weapon_magic: null }), s).ready, false);
  const unread = magic({ wielded: { name: 'hammer', class: 'unknown', bypasses_nonmagic: null } });
  assert.equal(trollReadiness(row('a', { weapon_magic: unread }), s).ready, false);
  assert.equal(trollReadiness(row('a', { weapon_magic: mundane() }), s).ready, false);
  assert.equal(trollReadiness(row('a'), s).ready, true);
  assert.equal(trollReadiness(row('a', { weapon_magic: magic({ magic_spares: 0, weapons: [magic().weapons[0]] }) }), s).ready, false,
    'the default demands one magic spare');
  assert.equal(trollReadiness(row('a', { max_health: 65 }), s).ready, false, 'default floor is 70');
});

test('trolls: a ready unit is deployed with magic on and roaming off, once', () => {
  const r = row('a');
  const out = fire([r], { a: [ID] });
  const dep = out.plan.find(p => p.do === 'deploy');
  assert.equal(dep.to, 599);
  assert.deepEqual(dep.hunt, ['troll']);
  assert.equal(dep.roam, false);
  assert.equal(dep.prefer_magic_weapon, true);
  const calls = callsForFleetPlan([dep]);
  assert.equal(calls[0].args.prefer_magic_weapon, true, 'the deploy whitelist carries it');
  const settled = row('a', { policy: { assignedRoom: 599, hunt: ['troll'], roam: false,
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.85, ...VIG } });
  assert.equal(fire([settled], { a: [ID] }).kind, 'pass', 'diffed: already there sends nothing');
  // 2026-09-27: the keeper reports a one-name hunt as a STRING, and an array-only compare re-sent
  // the whole deploy to every ready hunter every pass.
  const asKeeperSaysIt = row('a', { policy: { assignedRoom: 599, hunt: 'troll', roam: false,
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.85, ...VIG } });
  assert.equal(fire([asKeeperSaysIt], { a: [ID] }).kind, 'pass', 'hunt: "troll" is hunt: ["troll"]');
});

// 2026-09-27: a troll hunter deployed with a hammer training style from his old shift, and in 599 the
// keeper tried to take the magic long sword off for a bout, then walked out to rest up mana for
// Create Weapon. A deploy turns practice off, and a unit still practising is not "deployed".
test('trolls: a deploy turns weapon practice off, and a practising unit is re-deployed', () => {
  const dep = fire([row('a')], { a: [ID] }).plan.find(p => p.do === 'deploy');
  assert.equal(dep.training_style, 'normal');
  assert.equal(callsForFleetPlan([dep])[0].args.training_style, 'normal', 'the deploy whitelist carries it');
  const settled = { assignedRoom: 599, hunt: ['troll'], roam: false, preferMagicWeapon: true,
    fleeBelow: 0.45, restBelow: 0.85, ...VIG };
  const practising = row('a', { policy: { ...settled, trainingStyle: 'short_sword' } });
  assert.ok(fire([practising], { a: [ID] }).plan.some(p => p.do === 'deploy'),
    'a unit in 599 still practising with a hammer is sent the order again');
  const plain = row('a', { policy: { ...settled, trainingStyle: 'normal' } });
  assert.equal(fire([plain], { a: [ID] }).kind, 'pass');
});

// 2026-09-27: a dedicated hammer shattered, still read enchanted, and was ordered wielded 17 passes.
test('trolls: a SHATTERED enchanted spare is not a spare, and nobody is told to wield it', () => {
  const wm = { wielded: { name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false },
    magic_spares: 0, unknown: 0,
    weapons: [{ id: 31, name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false, wielded: true },
              { id: 32, name: 'hammer', class: 'enchanted', bypasses_nonmagic: true, made: false, wielded: false, broken: true }] };
  const out = fire([row('a', { weapon_magic: wm })], { a: [ID] });
  assert.ok(!(out.plan ?? []).some(p => p.do === 'equip-best'), JSON.stringify(out.plan));
  assert.equal(dedicationTarget(row('a', { weapon_magic: wm })), null, 'nor dedicated again');
});

test('trolls: a unit holding an enchanted spare of its family is told to wield it', () => {
  const wm = { wielded: { name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false },
    magic_spares: 1, unknown: 0,
    weapons: [{ id: 31, name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: false, wielded: true },
              { id: 32, name: 'hammer', class: 'enchanted', bypasses_nonmagic: true, made: false, wielded: false }] };
  const out = fire([row('a', { weapon_magic: wm })], { a: [ID] });
  assert.ok(out.plan.some(p => p.do === 'equip-best' && p.agent === 'a'), JSON.stringify(out.plan));
  const none = fire([row('b', { weapon_magic: mundane() })], { b: [ID] });
  assert.ok(!none.plan.some(p => p.do === 'equip-best'), 'no magic spare, no equip');
});

// 2026-09-27: an enchanted scimitar sat in the pack of a unit whose ban list names scimitar. The
// keeper will never wield it, so it is not "one equip from ready", it is surplus for the depot.
test('trolls: an enchanted weapon the unit has banned is not of its family', () => {
  const wm = { wielded: { name: 'axe', class: 'mundane', bypasses_nonmagic: false, made: true },
    magic_spares: 1, unknown: 0,
    weapons: [{ id: 51, name: 'axe', class: 'mundane', bypasses_nonmagic: false, made: true, wielded: true },
              { id: 52, name: 'scimitar', class: 'enchanted', bypasses_nonmagic: true, made: false, wielded: false }] };
  const policy = { assignedRoom: 2, roam: false, preferMagicWeapon: true, ...VIG,
    weaponPriority: ['hammer', 'axe', 'scimitar'], bannedWeapons: ['scimitar'] };
  const out = fire([row('a', { room: 2, weapon_magic: wm, policy, mode: 'idle' })], { a: [ID] });
  assert.ok(!(out.plan ?? []).some(p => p.do === 'equip-best' && p.agent === 'a'), JSON.stringify(out.plan));
  const unbanned = fire([row('b', { room: 2, weapon_magic: { ...wm, wielded: { ...wm.wielded, name: 'short sword' },
      weapons: [{ ...wm.weapons[0], name: 'short sword' }, wm.weapons[1]] },
    policy: { ...policy, weaponPriority: ['scimitar', 'short sword'], bannedWeapons: [] }, mode: 'idle' })], { b: [ID] });
  assert.ok(unbanned.plan.some(p => p.do === 'equip-best' && p.agent === 'b'), 'the same spare, unbanned, is wielded');
});

// 2026-09-27: one unit's keeper kept re-wielding its conjured twin, the equip was re-queued every
// pass, and because it rode with the placements the pass returned before any dedication for an hour.
test('trolls: a pending equip does not hold up the dedications', () => {
  const wm = { wielded: { name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: true },
    magic_spares: 1, unknown: 0,
    weapons: [{ id: 41, name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: true, wielded: true },
              { id: 42, name: 'hammer', class: 'enchanted', bypasses_nonmagic: true, made: false, wielded: false }] };
  const staged = { assignedRoom: 2, roam: false, preferMagicWeapon: true, ...VIG };
  const swapper = row('swapper', { room: 2, weapon_magic: wm, policy: staged, mode: 'idle' });
  const owner = row('owner', { room: 2, weapon_magic: mundane(), policy: staged, mode: 'idle' });
  const ded = row('ded', { room: 2, provides: ['enchant weapon'], mana: { value: 30, max: 40 },
    pack_items: [{ name: 'elderberry', amount: 30 }, { name: 'orc tooth', amount: 5 }], weapon_magic: null });
  const out = fire([swapper, owner, ded], { swapper: [ID], owner: [ID] });
  assert.equal(out.kind, 'act');
  assert.ok(out.plan.some(p => p.do === 'equip-best' && p.agent === 'swapper'), JSON.stringify(out.plan));
  assert.ok(out.plan.some(p => p.do === 'cast-enchant-weapon'), 'the dedication still runs');
});

// 2026-09-27: every pass that sent one unit in returned before the stage room's work, and a crew
// of a dozen nearly always has one to send in. Both now happen in the same pass.
test('trolls: a deploy and a dedication happen in the same pass', () => {
  const staged = { assignedRoom: 2, roam: false, preferMagicWeapon: true, ...VIG };
  const ready = row('ready', { room: 2 });
  const owner = row('owner', { room: 2, weapon_magic: mundane(), policy: staged, mode: 'idle' });
  const ded = row('ded', { room: 2, provides: ['enchant weapon'], mana: { value: 30, max: 40 },
    pack_items: [{ name: 'elderberry', amount: 30 }, { name: 'orc tooth', amount: 5 }], weapon_magic: null });
  const out = fire([ready, owner, ded], { ready: [ID], owner: [ID] });
  assert.ok(out.plan.some(p => p.do === 'deploy' && p.agent === 'ready'), JSON.stringify(out.plan));
  assert.ok(out.plan.some(p => p.do === 'cast-enchant-weapon'), 'the dedication runs beside the deploy');
  assert.ok(!out.plan.some(p => p.do !== 'deploy' && (p.agent === 'ready' || p.from === 'ready' || p.to === 'ready')),
    'the unit being deployed is left out of the stage room work');
});

test('trolls: a mundane unit is staged, not deployed, and gets the tie-break early', () => {
  const out = fire([row('a', { weapon_magic: mundane() })], { a: [ID] });
  assert.equal(out.plan.some(p => p.do === 'deploy'), false);
  const sd = out.plan.find(p => p.do === 'stand-down');
  assert.equal(sd.assigned_room, 2);
  assert.equal(sd.moved, true);
  assert.ok(out.plan.some(p => p.do === 'magic-policy'));
});

test('trolls: a unit without the strategy is not touched, and a busy one is stepped over', () => {
  assert.equal(fire([row('a', { weapon_magic: mundane() })], {}).kind, 'pass');
  const busy = row('a', { weapon_magic: mundane(), commitment: { kind: 'errand', takeable: false } });
  assert.equal(fire([busy], { a: [ID] }).kind, 'pass');
});

test('trolls: a dedication hands over a SPARE, casts at its id, and always hands it back', () => {
  const owner = row('owner', { room: 2, weapon_magic: mundane(),
    policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true, ...VIG }, mode: 'idle' });
  const ded = row('ded', { room: 2, provides: ['enchant weapon'], mana: { value: 30, max: 40 },
    pack_items: [], weapon_magic: null });
  const depot = row('depot', { room: 2, max_health: 20, weapon_magic: null,
    pack_items: [{ name: 'elderberry', amount: 339 }, { name: 'orc tooth', amount: 4 }] });
  const out = fire([owner, ded, depot], { owner: [ID] });
  const steps = out.plan.map(p => p.do);
  assert.deepEqual(steps, ['inert-keeper', 'give-reagent', 'give-reagent', 'give-weapon',
    'cast-enchant-weapon', 'give-weapon', 'equip-best']);
  const cast = out.plan.find(p => p.do === 'cast-enchant-weapon');
  assert.equal(cast.target, 22, 'the spare (id 22), not the hammer in hand (21)');
  const back = out.plan.filter(p => p.do === 'give-weapon');
  assert.equal(back[0].from, 'owner'); assert.equal(back[1].to, 'owner');
  const calls = callsForFleetPlan(out.plan);
  const c = calls.find(x => x.tool === 'cast');
  assert.deepEqual([c.args.spell, c.args.target], ['enchant weapon', 22]);
  const r = calls.find(x => x.tool === 'supply' && x.args.what === 'orc tooth');
  assert.equal(r.args.amount, 1);
  // THE ROUND THAT FAILED LIVE (2026-09-26): the dedicator was revived after the hand-over,
  // wielded the weapon, and the hand-back came six seconds into a 30-second trance.
  const seq = calls.map(x => x.tool === 'autopilot' ? `${x.args.action}:${x.args.agent}` : x.tool);
  const castAt = seq.indexOf('cast');
  assert.equal(seq[0], 'inert:ded', 'the dedicator is held before anything is handed to it');
  assert.ok(!seq.slice(0, castAt).includes('revive:ded'), 'and nothing wakes it before the cast');
  assert.equal(seq[castAt + 1], 'wait', 'the trance is waited out right after the cast');
  assert.ok(calls[castAt + 1].ms >= 30_000);
  const backAt = seq.lastIndexOf('supply');
  assert.ok(backAt > castAt + 1 && seq.slice(backAt).includes('revive:ded'),
    'the hand-back after the wait is what wakes the dedicator');
});

test('trolls: the most able dedicator is chosen over the one with more mana', () => {
  const owner = row('owner', { room: 2, weapon_magic: mundane(), mode: 'idle',
    policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true } });
  const reag = [{ name: 'elderberry', amount: 10 }, { name: 'orc tooth', amount: 5 }];
  const novice = row('novice', { room: 2, provides: ['enchant weapon'], mana: { value: 40, max: 40 },
    provides_ability: { 'enchant weapon': 5 }, pack_items: reag });
  const adept = row('adept', { room: 2, provides: ['enchant weapon'], mana: { value: 20, max: 25 },
    provides_ability: { 'enchant weapon': 20 }, pack_items: reag });
  const res = planDedication([{ row: owner, s: settings(doctrine()) }], [owner, novice, adept]);
  assert.equal(res.plan.find(p => p.do === 'cast-enchant-weapon')?.agent, 'adept', JSON.stringify(res));
  const c = callsForFleetPlan(res.plan).find(x => x.tool === 'cast');
  assert.ok(c.args.holdMs > 30_000, 'the keeper is told to hold still past the 30-second trance');
});

// Several rounds a pass (2026-09-27): one per free dedicator, best first, each owner once.
test('trolls: two dedicators enchant two owners in one pass, and max caps it', () => {
  const reag = [{ name: 'elderberry', amount: 10 }, { name: 'orc tooth', amount: 5 }];
  const own = a => row(a, { room: 2, weapon_magic: mundane(), mode: 'idle',
    policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true } });
  const o1 = own('o1'), o2 = own('o2'), o3 = own('o3');
  const adept = row('adept', { room: 2, provides: ['enchant weapon'], mana: { value: 25, max: 25 },
    provides_ability: { 'enchant weapon': 20 }, pack_items: reag });
  const novice = row('novice', { room: 2, provides: ['enchant weapon'], mana: { value: 40, max: 40 },
    provides_ability: { 'enchant weapon': 5 }, pack_items: reag });
  const needers = [o1, o2, o3].map(r => ({ row: r, s: settings(doctrine()) }));
  const rows = [o1, o2, o3, adept, novice];
  const casts = res => res.plan.filter(p => p.do === 'cast-enchant-weapon').map(p => p.agent);
  const two = planDedication(needers, rows, { max: 3 });
  assert.deepEqual(casts(two), ['adept', 'novice'], 'each dedicator once, the most able first');
  const owners = two.plan.filter(p => p.do === 'give-weapon' && p.to !== p.from && ['adept', 'novice'].includes(p.to)).map(p => p.from);
  assert.equal(new Set(owners).size, 2, 'two different owners');
  assert.deepEqual(casts(planDedication(needers, rows, { max: 1 })), ['adept'], 'max 1 is the old behaviour');
  assert.deepEqual(casts(planDedication(needers, rows)), ['adept'], 'and the default');
});

// Armour and a shield for every hunter, from spares already in the stage room (2026-09-27).
test('trolls: a bare hunter is handed a spare armour and shield and puts them on', () => {
  const st = settings(doctrine());
  const bare = row('bare', { room: 2, worn: ['Amulet of Shadows'] });
  const donor = row('donor', { room: 2, worn: ['leather armor', 'small round shield'],
    pack_items: [{ name: 'leather armor', amount: 2 }, { name: 'small round shield', amount: 3 }] });
  const res = planGear([{ row: bare, s: st }], [bare, donor]);
  const gives = res.plan.filter(p => p.do === 'give-gear');
  assert.deepEqual(gives.map(g => g.item).sort(), ['leather armor', 'small round shield']);
  assert.ok(gives.every(g => g.from === 'donor' && g.to === 'bare'));
  assert.equal(res.plan.at(-1).do, 'wear-best');
  const calls = callsForFleetPlan(res.plan);
  assert.ok(calls.some(c => c.tool === 'supply' && c.args.what === 'leather armor' && c.args.amount === 1));
  assert.ok(calls.some(c => c.tool === 'wear_best' && c.args.agent === 'bare'));
});

test('trolls: a unit carrying its own unworn shield wears it, and is not a donor for it', () => {
  const st = settings(doctrine());
  const own = row('own', { room: 2, worn: ['leather armor'],
    pack_items: [{ name: 'leather armor', amount: 1 }, { name: 'small round shield', amount: 1 }] });
  const bare = row('bare', { room: 2, worn: ['leather armor'], pack_items: [{ name: 'leather armor', amount: 1 }] });
  const res = planGear([{ row: own, s: st }, { row: bare, s: st }], [own, bare]);
  assert.ok(!res.plan.some(p => p.do === 'give-gear'), 'the shield is not lent away: ' + JSON.stringify(res.plan));
  assert.ok(res.plan.some(p => p.do === 'wear-best' && p.agent === 'own'));
});

test('trolls: magic-grade armour is never handed out as a spare', () => {
  const st = settings(doctrine());
  const bare = row('bare', { room: 2, worn: [] });
  const donor = row('donor', { room: 2, worn: [],
    pack_items: [{ name: 'scale armor', amount: 1, rarity: 1 }, { name: 'gold round shield', amount: 1, rarity: 100 }] });
  assert.equal(planGear([{ row: bare, s: st }], [bare, donor]).plan.filter(p => p.do === 'give-gear').length, 0);
});

// Operator, 2026-09-27: hunters keep 160+ vigor fed off inky-caps, meat pies and bread.
test('trolls: a hungry hunter under its floor is fed from a well-stocked neighbour, inky-caps first', () => {
  const st = settings(doctrine());
  const hungry = row('hungry', { room: 2, vigor: { value: 80, max: 200 }, pack_items: [{ name: 'loaf of bread', amount: 1 }] });
  const fed = row('fed', { room: 2, vigor: { value: 200, max: 200 },
    pack_items: [{ name: 'Inky-cap mushroom', amount: 20 }, { name: 'loaf of bread', amount: 10 }] });
  const res = planFood([{ row: hungry, s: st }], [hungry, fed]);
  const g = res.plan.filter(p => p.to === 'hungry');
  assert.equal(g[0]?.item, 'Inky-cap mushroom');
  assert.equal(g.reduce((n, p) => n + p.amount * (p.item === 'Inky-cap mushroom' ? 50 : 20), 0) >= 280, true, JSON.stringify(g));
  const full = row('full', { room: 2, vigor: { value: 170, max: 200 }, pack_items: [] });
  assert.equal(planFood([{ row: full, s: st }], [full, fed]).plan.length, 0, 'above the floor: nothing');
  const poorDonor = row('poor', { room: 2, pack_items: [{ name: 'loaf of bread', amount: 10 }] });
  assert.equal(planFood([{ row: hungry, s: st }], [hungry, poorDonor]).plan.length, 0, 'a donor keeps its own 300');
});

test('trolls: with the courier away, a full hunter stashes loot with the named stage-room holder', async () => {
  const { unloadDue, stashDepot } = await import('../src/decide/rules/trolls.mjs');
  const base = settings(doctrine());
  const st = { ...base, courier_agent: ['Courier'], stash_at_stage: true, stash_agent: ['Holder'],
               stash_ceiling: 0.6, unload_items: ['sapphire', 'relic of Qor'], unload_at: 0.8 };
  const hunter = row('h', { character: 'Hunter', room: 2, pack: { percent: 90 },
    pack_items: [{ name: 'sapphire', amount: 12 }, { name: 'relic of Qor', amount: 1 }] });
  const raph = row('d1', { character: 'Holder', room: 2, mode: 'survive', policy: { assignedRoom: 2 }, pack: { percent: 30 } });
  const marcoAway = row('c1', { character: 'Courier', room: 578, pack: { percent: 10 } });
  const staged = row('s', { character: 'Staged', room: 2, mode: 'idle', policy: { assignedRoom: 2 }, pack: { percent: 5 } });
  const rows = [hunter, raph, marcoAway, staged];
  assert.equal(stashDepot(rows, st)?.agent, 'd1', 'the NAMED holder first, while it has room');
  const fullRaph = { ...raph, pack: { percent: 70 } };
  assert.equal(stashDepot([hunter, fullRaph, marcoAway, staged], st)?.agent, 's',
    'holder full: a hunter standing down with ample room takes it (operator, 2026-09-28)');
  assert.equal(stashDepot([hunter, fullRaph, marcoAway, { ...staged, pack: { percent: 55 } }], st), null,
    'but not one without ample room');
  assert.equal(stashDepot([hunter, fullRaph, marcoAway, staged], st, { exclude: 's' }), null, 'and never the unloading hunter itself');
  assert.equal(stashDepot([hunter, fullRaph, marcoAway, staged], { ...st, stash_on_staged: false }), null, 'stash_on_staged:false keeps it to the named holder');
  assert.equal(unloadDue(hunter, st, rows), true, 'a full hunter is due to unload with the courier away');
  assert.equal(stashDepot(rows, { ...st, stash_at_stage: false }), null, 'off by default');
  assert.equal(stashDepot([hunter, { ...raph, pack: { percent: 70 } }, marcoAway], st), null, 'a holder over the stash ceiling takes nothing');
  assert.equal(unloadDue(hunter, { ...st, stash_at_stage: false }, rows), false, 'without the stash and without a courier: no unload (the old behaviour)');
  assert.equal(unloadDue(hunter, { ...st, stash_at_stage: false, wait_for_courier: true }, rows), true,
    'wait_for_courier: with neither courier nor stash, the full hunter stands down and waits');
});

test('trolls: hold_for_courier reaches the keeper — the act layer is a whitelist', () => {
  const plan = [{ do: 'stand-down', agent: 'g0', assigned_room: 2, roam: false, sell_at_load: 0.97, hold_for_courier: true },
                { do: 'deploy', agent: 'g1', to: 599, hunt: ['troll'], hold_for_courier: true }];
  const calls = callsForFleetPlan(plan, 'test');
  const ap = calls.filter(c => c.tool === 'autopilot');
  assert.equal(ap.length, 2);
  assert.equal(ap.every(c => c.args.hold_for_courier === true), true, JSON.stringify(ap.map(c => c.args)));
});

test('trolls: food has a band — above food_keep_max it goes to the courier, below food_keep_min it is never given', async () => {
  const { unloadable } = await import('../src/decide/rules/trolls.mjs');
  const st = { ...settings(doctrine()), unload_food: ['meat pie'], food_keep_min: 4, food_keep_max: 10 };
  const pies = n => [{ name: 'meat pie', amount: n }];
  const u = unloadable(row('h', { room: 2, pack_items: pies(16) }), st);
  assert.deepEqual(u.loot.find(x => x.name === 'meat pie'), { name: 'meat pie', n: 6 }, 'sixteen held, ten kept, six unloaded');
  assert.equal(unloadable(row('h', { room: 2, pack_items: pies(10) }), st).loot.some(x => x.name === 'meat pie'), false,
    'at the max: nothing to unload');
  assert.equal(unloadable(row('h', { room: 2, pack_items: pies(16) }), settings(doctrine())).loot.some(x => x.name === 'meat pie'),
    false, 'with no unload_food, food is never unloaded (the old behaviour)');
  const hungry = row('hungry', { room: 2, vigor: { value: 80, max: 200 }, pack_items: [] });
  const donor = row('donor', { room: 2, vigor: { value: 200, max: 200 }, pack_items: pies(14) });
  const given = planFood([{ row: hungry, s: { ...st } }], [hungry, donor], { keep: 0 }).plan
    .filter(p => p.item === 'meat pie').reduce((n, p) => n + p.amount, 0);
  assert.equal(given <= 10, true, `a donor keeps its min of 4 pies (gave ${given} of 14)`);
});

test('trolls: the only armour a donor has is the one it wears, so nothing is handed', () => {
  const st = settings(doctrine());
  const bare = row('bare', { room: 2, worn: [] });
  const donor = row('donor', { room: 2, worn: ['leather armor', 'small round shield'],
    pack_items: [{ name: 'leather armor', amount: 1 }, { name: 'small round shield', amount: 1 }] });
  assert.equal(planGear([{ row: bare, s: st }], [bare, donor]).plan.length, 0);
  const unknown = row('u', { room: 2 });                       // worn unknown: ask next pass
  const rich = row('rich', { room: 2, worn: [], pack_items: [{ name: 'leather armor', amount: 5 }] });
  assert.equal(planGear([{ row: unknown, s: st }], [unknown, rich]).plan.length, 0);
});

test('trolls: no dedicator with mana, or only the weapon in hand, plans nothing and says why', () => {
  const owner = row('owner', { room: 2, weapon_magic: mundane(), mode: 'idle',
    policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true } });
  const tired = row('ded', { room: 2, provides: ['enchant weapon'], mana: { value: 5, max: 40 } });
  const res = planDedication([{ row: owner, s: settings(doctrine()) }], [owner, tired]);
  assert.equal(res.plan.length, 0);
  assert.match(res.why, /17 mana/);
  const single = { ...mundane(), weapons: [mundane().weapons[0]] };
  assert.equal(dedicationTarget(row('a', { weapon_magic: single })), null,
    'never the weapon in hand');
  const conjuredOnly = { ...mundane(), weapons: [mundane().weapons[0],
    { id: 30, name: 'hammer', class: 'mundane', bypasses_nonmagic: false, made: true, wielded: false }] };
  assert.equal(dedicationTarget(row('a', { weapon_magic: conjuredOnly })).id, 30,
    'a conjured spare only when nothing real is to hand');
});

test('trolls: the hunt shift steps over a troll hunter', () => {
  const d = doctrine();
  const units = Array.from({ length: 4 }, (_, i) => row(`t${i + 1}`, { level: 75, max_health: 75, room: 39 }));
  const agents = Object.fromEntries(units.map(u => [u.agent, [ID]]));
  const out = shiftFleetRules[0].decide(obs(units, agents), d);
  const touched = (out.plan ?? []).map(p => p.agent);
  assert.equal(touched.length, 0, `the shift deployed ${touched.join(', ')}`);
});

// SIZE DECIDES OWNERSHIP (2026-09-26): the strategy is enabled for everybody and "everyone at
// 75+" hunts trolls. A unit under the line must stay with its shift, or enabling the strategy
// fleet-wide would strand every smaller character while the troll rule ignores it.
test('trolls: a unit under the minimum is NOT troll-owned, so its shift keeps placing it', () => {
  const d = doctrine();
  const small = row('sm', { level: 60, max_health: 60, room: 39 });
  const big = row('bg', { level: 75, max_health: 75, room: 39 });
  const o = obs([small, big], { sm: [ID], bg: [ID] });
  assert.equal(trollOwned(o, d, 'sm'), false, 'a 60-max-health unit is not a troll hunter');
  assert.equal(trollOwned(o, d, 'bg'), true, 'a 75-max-health unit is');
  assert.equal(trollOwned(o, d, 'nobody'), false, 'an unknown unit is owned by nothing');
});

// AN EXCEPTION TAKES A BIG UNIT OFF THE CREW, and every rule has to agree on it: the troll rule
// selects with strategyRows and the shift rules ask trollOwned, so honouring it in only one of
// them leaves a body both sides think the other one owns.
test('trolls: `except` leaves a 75 out of the crew, by agent or by character name', () => {
  const d = doctrine();
  d.strategies.settings = { ...(d.strategies.settings ?? {}), [ID]: { except: ['Some Healer', 'c2'] } };
  const byName = row('c3', { character: 'Some Healer', weapon_magic: mundane() });
  const byAgent = row('c2', { character: 'Other', weapon_magic: mundane() });
  const crew = row('c1', { character: 'Crewman', weapon_magic: mundane() });
  const o = obs([byName, byAgent, crew], { c1: [ID], c2: [ID], c3: [ID] });
  assert.equal(trollOwned(o, d, 'c3'), false, 'excepted by character name, case-insensitively');
  assert.equal(trollOwned(o, d, 'c2'), false, 'excepted by agent');
  assert.equal(trollOwned(o, d, 'c1'), true, 'the rest of the crew is untouched');
  const out = trollFleetRules[0].decide(o, d);
  const touched = new Set((out.plan ?? []).map(p => p.agent));
  assert.ok(touched.has('c1') && !touched.has('c2') && !touched.has('c3'),
    `the troll rule stages only the crew (touched ${[...touched]})`);
  assert.deepEqual(strategySettings(o, d, 'c1', ID).except, ['Some Healer', 'c2'], 'the setting validates');
});

test('trolls: a station may require a magic weapon, and the schema checks the clause', () => {
  const st = { requires: [{ magic_weapon: { wielded: true, spares: 1 } }] };
  assert.equal(requirementsMet(st, row('a')), true);
  assert.equal(requirementsMet(st, row('a', { weapon_magic: mundane() })), false);
  assert.equal(requirementsMet(st, row('a', { weapon_magic: null })), false);
  const d = doctrine();
  d.shift.stations[0].requires = [{ magic_weapon: { wielded: true, spares: 1 } }];
  d.shift.stations.push({ ...d.shift.stations[0], requires: undefined });
  delete d.shift.stations[d.shift.stations.length - 1].requires;
  const ok = validate(d);
  assert.equal((ok.errors ?? ok).filter?.(e => /magic_weapon/.test(JSON.stringify(e))).length ?? 0, 0);
  d.shift.stations[0].requires = [{ magic_weapon: { wielded: 'yes', colour: 'red' } }];
  const bad = JSON.stringify(validate(d));
  assert.match(bad, /magic_weapon/);
});

test('trolls: the surface admits enchant weapon at an item id and at nothing else', async () => {
  const { deny } = await import('../src/link/surface.mjs');
  assert.equal(deny('cast', { agent: 'a', spell: 'enchant weapon', target: 22 }), null);
  assert.match(deny('cast', { agent: 'a', spell: 'enchant weapon', target: 'troll' }), /object id/);
  assert.match(deny('cast', { agent: 'a', spell: 'fireball', target: 5 }), /refused/);
  assert.equal(deny('cast', { agent: 'a', spell: 'create weapon' }), null);
});

// ---- the supply line --------------------------------------------------------------------

import { familyMagicSpares, surplusWeapons, planSupply, planCourier, recordTrollCourier,
  WEAPON_BUYERS } from '../src/decide/rules/trolls.mjs';

const W = (id, name, magic, over = {}) => ({ id, name, class: magic ? 'enchanted' : 'mundane',
  bypasses_nonmagic: magic, made: false, wielded: false, ...over });
const wm = (weapons) => ({ wielded: (() => { const w = weapons.find(x => x.wielded);
    return w ? { name: w.name, class: w.class, bypasses_nonmagic: w.bypasses_nonmagic, made: w.made } : null; })(),
  magic_spares: weapons.filter(w => !w.wielded && w.bypasses_nonmagic).length, unknown: 0, weapons });
const hammerer = (agent, weapons, over = {}) => row(agent, { room: 2, mode: 'idle',
  policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true, weaponPriority: ['hammer', 'axe'] },
  weapon_magic: wm(weapons), ...over });

// REVERSED 2026-09-27 by the operator: troll fights are "always enchanted & only enchanted", and the
// keeper now ranks magic ahead of its priority, so an unbanned magic axe IS a hammer trainee's spare.
test('trolls: a magic AXE is a spare to a hammer trainee, unless the trainee bans axes', () => {
  const r = hammerer('h', [W(1, 'hammer', true, { wielded: true }), W(2, 'axe', true)]);
  assert.equal(familyMagicSpares(r), 1);
  const banned = { ...r, policy: { ...r.policy, bannedWeapons: ['axe'] } };
  assert.equal(familyMagicSpares(banned), 0, 'a banned magic weapon is still nobody\'s spare');
  const ok2 = hammerer('h', [W(1, 'hammer', true, { wielded: true }), W(3, 'hammer', true)]);
  assert.equal(trollReadiness(ok2, settings(doctrine())).ready, true);
});

test('trolls: surplus goes UP to the depot — other families and real extras, never conjured', () => {
  const r = hammerer('h', [W(1, 'hammer', true, { wielded: true }), W(2, 'hammer', true), W(3, 'hammer', false),
    W(4, 'hammer', false), W(5, 'long sword', false), W(6, 'axe', false, { made: true })]);
  const out = surplusWeapons(r, 2).map(w => w.id).sort();
  assert.deepEqual(out, [4, 5], 'keeps 2 family spares (magic first); the extra hammer and the sword go; the conjured axe stays');
});

test('trolls: the depot hands DOWN a family weapon, and Create Weapon is the fallback', () => {
  const s = settings(doctrine());
  const bare = hammerer('h', [W(1, 'hammer', false, { wielded: true })], {
    provides: ['create weapon'], mana: { value: 30, max: 40 } });
  const depot = row('depot', { room: 2, max_health: 20, policy: { assignedRoom: 2 }, pack_items: [{ name: 'elderberry', amount: 300 }],
    weapon_magic: wm([W(9, 'long sword', false), W(8, 'hammer', false)]) });
  const fighters = new Set(['h']);
  const down = planSupply([{ row: bare, s, ready: false }], [bare, depot], fighters);
  const give = down.plan.find(p => p.do === 'give-weapon' && p.from === 'depot');
  assert.equal(give?.what?.[0]?.id, 8, 'the depot hammer, not the long sword');
  const emptyDepot = { ...depot, weapon_magic: wm([W(9, 'long sword', false)]) };
  const conj = planSupply([{ row: bare, s, ready: false }], [bare, emptyDepot], fighters);
  assert.ok(conj.plan.some(p => p.do === 'cast-create-weapon' && p.agent === 'h'));
});

// 2026-09-27: with magic_spares 0 (one enchanted weapon is enough to hunt) the hand-down read
// `0 >= 0` for every unit, and seven units waited with one weapon each beside a depot of swords.
test('trolls: magic_spares 0 still hands a lone-weapon unit a spare to dedicate', () => {
  const s = { ...settings(doctrine()), magic_spares: 0 };
  const bare = hammerer('h', [W(1, 'hammer', false, { wielded: true })]);
  const depot = row('depot', { room: 2, max_health: 20, policy: { assignedRoom: 2 }, pack_items: [{ name: 'elderberry', amount: 300 }],
    weapon_magic: wm([W(8, 'hammer', false)]) });
  const down = planSupply([{ row: bare, s, ready: false }], [bare, depot], new Set(['h']));
  assert.equal(down.plan.find(p => p.do === 'give-weapon' && p.from === 'depot')?.what?.[0]?.id, 8,
    JSON.stringify(down.plan));
});

// 2026-09-27: the courier ran inline and held the fleet pass for its half-hour walk (11:52 -> 12:22,
// both enchanters at full mana). It now runs beside the pass, and its cooldown starts at dispatch so
// the next pass does not send a second courier for the same depot.
test('trolls: the depot run goes in the background with its cooldown stamped at dispatch', async () => {
  assert.ok(BACKGROUND_FLEET_ERRANDS.includes('troll-courier'));
  const memory = {};
  const ctx = { commit: true, journal: { write() {}, finding() {} },
    memory: { read: () => memory, patch: (t, p) => { memory[t] = { ...memory[t], ...p }; } } };
  const jobs = new CircuitJobs(ctx, { now: () => 5_000, execute: () => new Promise(() => {}) });
  assert.equal(await jobs.start({ orders: { errand: 'troll-courier', agent: 'c' } }), true);
  assert.equal(memory.trolls?.courier_last_at, 5_000, JSON.stringify(memory));
});

test('trolls: the depot run sells only REAL surplus, after its cooldown, and walks back', () => {
  const s = settings(doctrine());
  const depot = row('depot', { room: 2, max_health: 20, policy: { assignedRoom: 2 }, pack_items: [{ name: 'elderberry', amount: 300 }],
    weapon_magic: wm([...Array.from({ length: 9 }, (_, i) => W(100 + i, 'long sword', false)),
      W(200, 'long sword', false, { made: true })]) });
  const c = hammerer('c', [W(1, 'hammer', true, { wielded: true }), W(2, 'hammer', true)],
    { health: { value: 75, max: 75, pct: 1 } });
  const fighters = new Set(['c']);
  const out = planCourier([{ row: c, s, ready: true }], [c, depot], fighters, s, {}, 1_000_000);
  assert.equal(out.errand?.orders?.errand, 'troll-courier');
  const ids = out.errand.orders.context.ids;
  assert.equal(ids.length, 7, 'nine real long swords less the depot stock of two');
  assert.ok(!ids.includes(200), 'the conjured one is never carried');
  const steps = out.errand.orders.steps.map(x => x.tool);
  assert.deepEqual(steps, ['supply', 'travel', 'sell', 'travel']);
  assert.equal(out.errand.orders.steps[2].args.to, WEAPON_BUYERS[374]);
  assert.equal(out.errand.orders.steps[3].always, true, 'the walk back runs whatever happened');
  const cooling = planCourier([{ row: c, s, ready: true }], [c, depot], fighters, s,
    { courier_last_at: 1_000_000 }, 1_000_000 + 10 * 60_000);
  assert.match(cooling.why, /cooldown/);
  const hurt = { ...c, health: { value: 50, max: 75, pct: 0.66 } };
  assert.match(planCourier([{ row: hurt, s, ready: true }], [hurt, depot], fighters, s, {}, 1).why, /health/);
  assert.equal(recordTrollCourier({ agent: 'c', at: 5, stopped: null }).patch.courier_last_at, 5);
});

// CREW EXCHANGE (2026-09-26): "everyone at 75+ runs this, so they may need to coordinate
// exchanging enchanted weapons". With the whole crew above the line there is no non-fighter depot,
// so a fighter at the stage room lends from its SURPLUS to a crew mate short of spares.
const axer = (agent, weapons, over = {}) => row(agent, { room: 2, mode: 'idle',
  policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true, weaponPriority: ['axe', 'hammer'] },
  weapon_magic: wm(weapons), ...over });

test('trolls: with no depot, a crew mate lends a MAGIC family weapon from its surplus', () => {
  const s = settings(doctrine());
  const needy = hammerer('h', [W(1, 'hammer', false, { wielded: true })]);
  // An axe trainee carrying a looted magic hammer it will never wield for the trolls.
  const lender = axer('a', [W(10, 'axe', true, { wielded: true }), W(11, 'axe', true), W(12, 'axe', true),
                            W(13, 'hammer', true)]);
  const out = planSupply([{ row: needy, s, ready: false }, { row: lender, s, ready: false }],
                         [needy, lender], new Set(['h', 'a']));
  const give = out.plan.find(p => p.do === 'give-weapon' && p.to === 'h');
  assert.equal(give?.from, 'a', JSON.stringify(out));
  assert.equal(give?.what?.[0]?.id, 13, "the magic hammer, from the axe trainee's surplus");
});

test('trolls: a lender never gives what it keeps for itself', () => {
  const s = settings(doctrine());
  const needy = hammerer('h', [W(1, 'hammer', false, { wielded: true })]);
  // Exactly magic_spares + 1 of its own family and nothing else: nothing to spare.
  const lender = hammerer('b', [W(20, 'hammer', true, { wielded: true }), W(21, 'hammer', true), W(22, 'hammer', true)]);
  const out = planSupply([{ row: needy, s, ready: false }, { row: lender, s, ready: false }],
                         [needy, lender], new Set(['h', 'b']));
  assert.ok(!out.plan.some(p => p.do === 'give-weapon' && p.from === 'b'), JSON.stringify(out.plan));
});

test('trolls: a unit with a mundane spare to dedicate takes only a MAGIC hand-down', () => {
  const s = settings(doctrine());
  const withSpare = hammerer('h', [W(1, 'hammer', false, { wielded: true }), W(2, 'hammer', false)]);
  const mundaneLender = axer('a', [W(10, 'axe', true, { wielded: true }), W(11, 'axe', true), W(12, 'axe', true),
                                   W(13, 'hammer', false)]);
  const out = planSupply([{ row: withSpare, s, ready: false }, { row: mundaneLender, s, ready: false }],
                         [withSpare, mundaneLender], new Set(['h', 'a']));
  assert.ok(!out.plan.some(p => p.do === 'give-weapon' && p.to === 'h'),
            'another mundane hammer would only queue a second dedication');
  const magicLender = axer('m', [W(30, 'axe', true, { wielded: true }), W(31, 'axe', true), W(32, 'axe', true),
                                 W(33, 'hammer', true)]);
  const out2 = planSupply([{ row: withSpare, s, ready: false }, { row: magicLender, s, ready: false }],
                          [withSpare, magicLender], new Set(['h', 'm']));
  assert.equal(out2.plan.find(p => p.to === 'h')?.what?.[0]?.id, 33, 'a magic one saves the dedication');
});

// THE 2026-09-26 STALL: a passing castle farmer with a full pack was the depot, every pass
// handed it scimitars the server refused, and the refused hand-ups used the whole budget.
import { depotIn, refusedPairs, SUPPLY_REFUSAL_MS } from '../src/decide/rules/trolls.mjs';
import { refusedSupplies } from '../src/act/fleet-plan.mjs';

test('trolls: a depot is stationed at the stage room and has pack room', () => {
  const passer = row('cliff', { room: 2, max_health: 72, policy: { assignedRoom: 38 } });
  assert.equal(depotIn([passer], 2, new Set()), null, 'a character passing through is not the depot');
  const full = row('full', { room: 2, max_health: 25, policy: { assignedRoom: 2 }, pack: { percent: 97 } });
  assert.equal(depotIn([full], 2, new Set()), null, 'a full pack cannot take a hand-up');
  const ok = row('raph', { room: 2, max_health: 25, policy: { assignedRoom: 2 }, pack: { percent: 30 } });
  assert.equal(depotIn([passer, full, ok], 2, new Set())?.agent, 'raph');
});

test('trolls: arming comes before tidying — a conjure is planned even with surplus to hand up', () => {
  const s = settings(doctrine());
  const depot = row('depot', { room: 2, max_health: 20, policy: { assignedRoom: 2 },
    weapon_magic: wm([]) });
  const junk = Array.from({ length: 6 }, (_, i) => W(50 + i, 'long sword', false));
  const hoarder = hammerer('g', [W(1, 'hammer', false, { wielded: true }), ...junk]);
  const bare = hammerer('p', [W(2, 'hammer', false, { wielded: true })],
    { provides: ['create weapon'], mana: { value: 30, max: 40 } });
  const out = planSupply([{ row: hoarder, s, ready: false }, { row: bare, s, ready: false }],
                         [hoarder, bare, depot], new Set(['g', 'p']));
  assert.ok(out.plan.some(p => p.do === 'cast-create-weapon' && p.agent === 'p'), JSON.stringify(out.plan));
  assert.ok(out.plan.length <= 4);
});

test('trolls: a refused pair is skipped until the cooldown runs, and the tick records it', () => {
  const s = settings(doctrine());
  const depot = row('depot', { room: 2, max_health: 20, policy: { assignedRoom: 2 }, weapon_magic: wm([]) });
  const h = hammerer('h', [W(1, 'hammer', false, { wielded: true }), W(5, 'long sword', false)]);
  const applied = { refused: [{ from: 'h', to: 'depot', what: [{ id: 5, amount: 1 }], reason_code: 'receiver_full' }] };
  const learned = refusedSupplies(applied, 1000);
  assert.equal(learned.topic, 'supply');
  assert.equal(learned.patch['h>depot'].reason_code, 'receiver_full');
  const fresh = refusedPairs(learned.patch, 1000 + 60_000);
  const out = planSupply([{ row: h, s, ready: false }], [h, depot], new Set(['h']), { refused: fresh });
  assert.ok(!out.plan.some(p => p.from === 'h' && p.to === 'depot'), JSON.stringify(out.plan));
  const later = refusedPairs(learned.patch, 1000 + SUPPLY_REFUSAL_MS + 1);
  const again = planSupply([{ row: h, s, ready: false }], [h, depot], new Set(['h']), { refused: later });
  assert.ok(again.plan.some(p => p.from === 'h' && p.to === 'depot'));
  assert.equal(refusedSupplies({}, 1), null);
});

// ---- the stage-room courier (operator, 2026-09-27) ------------------------------------------
// "The troll crew should also donate their spare equipment to anyone in room2 who is lacking before
// doing traditional sell runs ... use [a courier] for buying / delivering equipment ... to prevent
// our troll hunters from having to leave their stations while they're running successfully".

import { courierIn, unloadDue, unloadable, planUnload } from '../src/decide/rules/trolls.mjs';
import { normalizeFleetRow } from '../src/sense/normalize.mjs';

const courierDoctrine = (over = {}) => {
  const d = doctrine();
  d.strategies.settings = { ...(d.strategies.settings ?? {}),
    [ID]: { ...(d.strategies.settings?.[ID] ?? {}), courier_agent: ['courier'], ...over } };
  return d;
};
const cs = (over = {}) => ({ ...settings(courierDoctrine()), ...over });
// Posted the way the rule posts it: sells at its loot ceiling (0.8) with the crew's stack limit.
const POSTED = { assignedRoom: 2, roam: false, sellAtLoad: 0.7, maxCarry: 60 };
const courierAt = (room, over = {}) => row('courier', { room, max_health: 21, level: 21, mode: 'idle',
  policy: POSTED, pack: { percent: 20 },
  health: { value: 21, max: 21, pct: 1 }, weapon_magic: wm([]), ...over });
// A hunter deployed in the troll room exactly as the rule would leave it, with the courier's triggers.
const onStation = { assignedRoom: 599, hunt: 'troll', roam: false, preferMagicWeapon: true,
  fleeBelow: 0.45, restBelow: 0.85, trainingStyle: 'normal', ...VIG, sellAtLoad: 0.97, maxCarry: 60 };
const fullHunter = (agent, over = {}) => inRoom(agent, { mode: 'farm', policy: onStation,
  pack: { percent: 88 }, pack_items: [{ name: 'emerald', amount: 300, rarity: 0 }], ...over });
const standDownOf = (out, agent) => (out.plan ?? []).find(p => p.do === 'stand-down' && p.agent === agent);

test('courier: without one named, the crew keeps its own sell triggers — nothing is sent', () => {
  const dep = deploysOf(fire([inRoom('g0')], all(1)))[0];
  assert.equal(dep.sell_at_load, undefined);
  assert.equal(dep.max_carry, undefined);
});

test('courier: named, every deploy raises the keeper\'s own sell run to the fallback', () => {
  const dep = deploysOf(fire([inRoom('g0'), courierAt(2)], all(1), courierDoctrine()))[0];
  assert.equal(dep.sell_at_load, 0.97);
  assert.equal(dep.max_carry, 60);
  const args = callsForFleetPlan([dep])[0].args;
  assert.equal(args.sell_at_load, 0.97, 'the deploy whitelist carries it');
  assert.equal(args.max_carry, 60);
  const sd = callsForFleetPlan([{ do: 'stand-down', agent: 'g0', assigned_room: 2, roam: false,
    sell_at_load: 0.97, max_carry: 60 }])[0].args;
  assert.equal(sd.sell_at_load, 0.97, 'and so does the stand-down');
  assert.equal(sd.max_carry, 60);
});

test('courier: a full hunter comes to the stage room to unload, not to town', () => {
  const out = fire([fullHunter('g0'), courierAt(2)], all(1), courierDoctrine());
  const sd = standDownOf(out, 'g0');
  assert.ok(sd, JSON.stringify(out.plan));
  assert.equal(sd.assigned_room, 2);
  assert.equal(sd.moved, true);
  assert.match(sd.why, /unload/);
  assert.ok(!deploysOf(out).some(p => p.agent === 'g0'));
});

test('courier: no hunter is pulled off station to wait — away, full, or refused means stay', () => {
  const d = courierDoctrine();
  assert.ok(!standDownOf(fire([fullHunter('g0'), courierAt(714)], all(1), d), 'g0'), 'courier in town');
  assert.ok(!standDownOf(fire([fullHunter('g0'), courierAt(2, { pack: { percent: 85 } })], all(1), d), 'g0'),
    'courier full');
  assert.ok(!standDownOf(fire([fullHunter('g0'), courierAt(2, { pack: undefined })], all(1), d), 'g0'),
    'an unknown courier pack is no room');
  const refused = new Set(['g0>courier']);
  assert.equal(unloadDue(fullHunter('g0'), cs(), [courierAt(2)], refused), false, 'a refused pair');
});

test('courier: a pack full of nothing the courier takes is not a reason to leave', () => {
  const h = fullHunter('g0', { pack_items: [{ name: 'orc tooth', amount: 400 }, { name: 'meat pie', amount: 30 }] });
  assert.equal(unloadDue(h, cs(), [courierAt(2)]), false);
  assert.ok(!standDownOf(fire([h, courierAt(2)], all(1), courierDoctrine()), 'g0'));
});

test('courier: at the stage room the loot goes to the courier, and the hunter redeploys after', () => {
  const s = cs();
  const at = fullHunter('g0', { room: 2, mode: 'idle', policy: { assignedRoom: 2, roam: false,
    preferMagicWeapon: true, ...VIG, sellAtLoad: 0.97, maxCarry: 60 } });
  const out = planUnload([{ row: at, s, ready: true }], [at, courierAt(2)], new Set(['g0']), s);
  const give = out.plan.find(p => p.do === 'give-reagent');
  assert.deepEqual([give?.from, give?.to, give?.item, give?.amount], ['g0', 'courier', 'emerald', 300]);
  const empty = { ...at, pack: { percent: 30 }, pack_items: [] };
  assert.equal(unloadDue(empty, s, [courierAt(2)]), false, 'nothing left: back to the troll room');
});

test('courier: spare armour and shields go to whoever here lacks one first, the courier after', () => {
  const s = cs();
  const giver = fullHunter('g0', { room: 2, worn: ['leather armor', 'small round shield'],
    pack_items: [{ name: 'small round shield', amount: 2, rarity: 0 }] });
  const bare = inRoom('g1', { room: 2, worn: ['leather armor'] });
  const c = courierAt(2);
  const held = planUnload([{ row: giver, s, ready: true }, { row: bare, s, ready: true }],
    [giver, bare, c], new Set(['g0', 'g1']), s);
  assert.ok(!held.plan.some(p => p.do === 'give-gear'), 'g1 has no shield, so the spare stays in the room');
  const gear = planGear([{ row: giver, s }, { row: bare, s }], [giver, bare, c]);
  assert.ok(gear.plan.some(p => p.do === 'give-gear' && p.to === 'g1'), 'and planGear hands it to g1');
  const sold = planUnload([{ row: giver, s, ready: true }], [giver, c], new Set(['g0']), s);
  assert.ok(sold.plan.some(p => p.do === 'give-gear' && p.to === 'courier' && p.item === 'small round shield'),
    JSON.stringify(sold.plan));
});

test('courier: never the depot, and the depot\'s surplus goes to it rather than a hunter\'s walk', () => {
  const s = cs();
  const c = courierAt(2);
  assert.equal(depotIn([c], 2, new Set(), c), null, 'the only non-fighter here is the courier');
  const depot = row('depot', { room: 2, max_health: 25, policy: { assignedRoom: 2 }, pack: { percent: 50 },
    pack_items: [{ name: 'elderberry', amount: 80 }],
    weapon_magic: wm(Array.from({ length: 5 }, (_, i) => W(300 + i, 'long sword', false))) });
  const h = hammerer('g0', [W(1, 'hammer', true, { wielded: true }), W(2, 'hammer', true)],
    { health: { value: 75, max: 75, pct: 1 } });
  assert.equal(planCourier([{ row: h, s, ready: true }], [h, depot, c], new Set(['g0']), s, {}, 1).errand,
    undefined, 'no hunter walks the depot to town');
  const out = planUnload([{ row: h, s, ready: true }], [h, depot, c], new Set(['g0']), s);
  const ids = out.plan.filter(p => p.from === 'depot' && p.to === 'courier').flatMap(p => p.what.map(w => w.id));
  assert.deepEqual(ids, [302, 303, 304], 'five long swords less the depot stock of two');
});

// 2026-09-27: the stage caster filled to 96% with 17 surplus long swords and stopped being the depot,
// so nothing could drain it. A FULL depot still gives: its surplus to the courier, spares down to the
// crew. It only stops receiving.
test('courier: a depot over its pack ceiling still gives, and only stops receiving', () => {
  const s = cs();
  const c = courierAt(2);
  const full = row('depot', { room: 2, max_health: 25, policy: { assignedRoom: 2 }, pack: { percent: 96 },
    pack_items: [{ name: 'elderberry', amount: 80 }],
    weapon_magic: wm(Array.from({ length: 5 }, (_, i) => W(400 + i, 'long sword', false))) });
  assert.equal(depotIn([full, c], 2, new Set(), c), null, 'too full to RECEIVE');
  assert.equal(depotIn([full, c], 2, new Set(), c, { giving: true })?.agent, 'depot', 'but it can still GIVE');
  const h = hammerer('g0', [W(1, 'hammer', true, { wielded: true }), W(2, 'hammer', true)],
    { health: { value: 75, max: 75, pct: 1 } });
  const out = planUnload([{ row: h, s, ready: true }], [h, full, c], new Set(['g0']), s);
  const ids = out.plan.filter(p => p.from === 'depot' && p.to === 'courier').flatMap(p => p.what.map(w => w.id));
  assert.deepEqual(ids, [402, 403, 404], 'the full depot drains its surplus to the courier');
  const lone = row('lone', { room: 2, weapon_magic: wm([W(9, 'long sword', false, { wielded: true })]),
    policy: { assignedRoom: 2, weaponPriority: ['long sword'] }, mode: 'idle' });
  const down = planSupply([{ row: lone, s, ready: false }], [lone, full, c], new Set(['lone']));
  assert.ok(down.plan.some(p => p.do === 'give-weapon' && p.from === 'depot' && p.to === 'lone'),
    'and hands a spare DOWN: ' + JSON.stringify(down.plan));
});

test('courier: the road in is gated on the crew fighting in the troll room and its own health', () => {
  const d = courierDoctrine();
  const staged2 = inRoom('g0', { room: 2, mode: 'idle', weapon_magic: mundane(),
    policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true, ...VIG, sellAtLoad: 0.97, maxCarry: 60 } });
  const away = courierAt(370, { policy: { ...POSTED, assignedRoom: 370 } });
  assert.ok(!standDownOf(fire([staged2, away], all(1), d), 'courier'), 'nobody in the troll room: it holds');
  const open = standDownOf(fire([inRoom('g0'), away], all(1), d), 'courier');
  assert.deepEqual([open?.assigned_room, open?.moved], [2, true], JSON.stringify(open));
  // Posted at the stage room but standing elsewhere, hurt: the post moves to where it stands, so the
  // station recall does not walk it through the troll room either.
  const hurt = standDownOf(fire([inRoom('g0'), courierAt(370, { health: { value: 10, max: 21, pct: 0.48 } })],
    all(1), d), 'courier');
  assert.deepEqual([hurt?.assigned_room, hurt?.moved], [370, false], 'hurt: its post is where it stands');
});

test('courier: its pack is known and under the ceiling, or it takes nothing', () => {
  const s = cs();
  assert.equal(courierIn([courierAt(2)], s)?.agent, 'courier');
  // 2026-09-27: normalizeFleetRow dropped `pack`, so on a live board the courier's pack was always
  // unknown, courierIn was always null, and the courier received nothing all evening.
  const live = normalizeFleetRow({ agent: 'courier', character: 'Courier', in_game: true, room_num: 2,
    health: '21/21', pack: { percent: 70, exact: true }, policy: { assignedRoom: 2, roam: false } });
  assert.equal(live.pack?.percent, 70, 'the board\'s pack reading survives normalisation');
  assert.equal(courierIn([courierAt(2, { pack: { percent: 80 } })], s), null);
  assert.equal(unloadable(fullHunter('g0'), s).loot[0]?.name, 'emerald');
});

test('courier: a deploy read back as policy is a deployed hunter — no re-send every pass', () => {
  const d = courierDoctrine();
  const dep = deploysOf(fire([inRoom('g0'), courierAt(2)], all(1), d))[0];
  const a = callsForFleetPlan([dep])[0].args;
  // The keeper's policy as the autopilot tool writes it from exactly those arguments.
  const policy = { assignedRoom: a.assigned_room, hunt: a.hunt, roam: a.roam,
    preferMagicWeapon: a.prefer_magic_weapon, fleeBelow: a.flee_below, restBelow: a.rest_below,
    trainingStyle: a.training_style, threatCeiling: a.threat_ceiling, fightAboveVigor: a.fight_above_vigor,
    vigorCeiling: a.vigor_ceiling, noFoodVigorFloor: a.no_food_vigor_floor,
    sellAtLoad: a.sell_at_load, maxCarry: a.max_carry };
  assert.equal(policy.maxCarry, 60, 'the deploy call carries max_carry');
  const again = fire([inRoom('g0', { mode: 'farm', policy }), courierAt(2)], all(1), d);
  assert.ok(!deploysOf(again).some(p => p.agent === 'g0'), JSON.stringify(again.plan));
});

test('courier: mid-trip it is left alone — a shop room is not its new post', () => {
  const trip = courierAt(113, { commitment: { kind: 'errand', label: 'selling and restocking' },
    policy: POSTED });
  const out = fire([inRoom('g0'), trip], all(1), courierDoctrine());
  assert.ok(!standDownOf(out, 'courier'), JSON.stringify(out.plan));
});

test('courier: it sets out to sell BEFORE it stops taking — no stall at the ceiling', () => {
  const fresh = courierAt(2, { policy: { assignedRoom: 2, roam: false } });
  const sd = standDownOf(fire([inRoom('g0'), fresh], all(1), courierDoctrine()), 'courier');
  assert.equal(sd?.sell_at_load, 0.7);
  assert.ok(sd.sell_at_load < cs().courier_pack_ceiling, 'below the loot ceiling');
  const high = standDownOf(fire([inRoom('g0'), fresh], all(1), courierDoctrine({ courier_sell_at: 0.9 })), 'courier');
  assert.ok(high?.sell_at_load < cs().courier_pack_ceiling, 'a doctrine above the ceiling is clamped under it');
  assert.equal(sd?.max_carry, 60);
  assert.equal(callsForFleetPlan([sd])[0].args.sell_at_load, 0.7);
});

test('courier: its bought hammers go to a depot short of depot_keep, and no further', () => {
  const s = cs();
  const buyer = courierAt(2, { weapon_magic: wm([W(401, 'hammer', false), W(402, 'hammer', false),
    W(403, 'hammer', false), W(404, 'axe', false)]) });
  const depot = row('depot', { room: 2, max_health: 25, policy: { assignedRoom: 2 }, pack: { percent: 50 },
    pack_items: [{ name: 'elderberry', amount: 80 }],
    weapon_magic: wm([W(300, 'hammer', false), W(301, 'axe', false), W(302, 'axe', false)]) });
  // No hunter in the stage room: the delivery still happens.
  const out = planUnload([], [buyer, depot], new Set(), s);
  const down = out.plan.filter(p => p.from === 'courier' && p.to === 'depot');
  assert.deepEqual(down.map(p => p.what[0].id), [401],
    'depot_keep is 2: one hammer short, and its two axes are enough');
  assert.match(out.summary, /deliver/);
  const full = { ...depot, weapon_magic: wm([W(300, 'hammer', false), W(305, 'hammer', false),
    W(301, 'axe', false), W(302, 'axe', false)]) };
  assert.equal(planUnload([], [buyer, full], new Set(), s).plan.filter(p => p.from === 'courier').length, 0,
    'a stocked depot takes nothing: the courier keeps its floor and sells nothing it bought');
  const refused = new Set(['courier>depot']);
  assert.equal(planUnload([], [buyer, depot], new Set(), s, { refused }).plan
    .filter(p => p.from === 'courier').length, 0, 'a refused pair waits out its cooldown');
});

test('courier: with the road gate off it walks in whoever is fighting and however hurt', () => {
  const d = courierDoctrine({ courier_road_gate: false });
  const staged2 = inRoom('g0', { room: 2, mode: 'idle', weapon_magic: mundane(),
    policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true, ...VIG, sellAtLoad: 0.97, maxCarry: 60 } });
  const hurtAway = courierAt(370, { policy: { ...POSTED, assignedRoom: 370 },
    health: { value: 10, max: 21, pct: 0.48 } });
  const sd = standDownOf(fire([staged2, hurtAway], all(1), d), 'courier');
  assert.deepEqual([sd?.assigned_room, sd?.moved], [2, true], JSON.stringify(sd));
});

test('courier: it tops a depot under its elderberry floor up to the target, and no more', () => {
  const s = cs();
  const c = courierAt(2, { pack_items: [{ name: 'elderberry', amount: 150 }] });
  const low = row('depot', { room: 2, max_health: 25, policy: { assignedRoom: 2 }, pack: { percent: 50 },
    pack_items: [{ name: 'elderberry', amount: 16 }], weapon_magic: wm([]) });
  const give = planUnload([], [c, low], new Set(), s).plan.find(p => p.item === 'elderberry');
  assert.deepEqual([give?.from, give?.to, give?.amount], ['courier', 'depot', 144], 'to 160');
  const stocked = { ...low, pack_items: [{ name: 'elderberry', amount: 120 }] };
  assert.ok(!planUnload([], [c, stocked], new Set(), s).plan.some(p => p.item === 'elderberry'),
    'above the floor: nothing');
  const full = { ...low, pack: { percent: 90 } };
  assert.ok(!planUnload([], [c, full], new Set(), s).plan.some(p => p.item === 'elderberry'),
    'a depot too full to receive is skipped');
  const off = cs({ depot_elderberry: 0 });
  assert.ok(!planUnload([], [c, low], new Set(), off).plan.some(p => p.item === 'elderberry'), '0 is off');
});

// ---- hungry crew farm food (operator, 2026-09-27: "Upstairs castle Victoria can be farmed by
// 80vigor bots for inky caps if they can't yet troll hunt")
import { inkyDue, inkyOrders } from '../src/decide/rules/trolls.mjs';
test('trolls: a hungry unit with nothing to eat farms inky caps, and comes back when it can eat', () => {
  const s = settings(doctrine());
  const hungry = row('h', { room: 2, vigor: { value: 80, max: 200 }, pack_items: [], mode: 'idle',
    weapon_magic: mundane(), policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true } });
  assert.equal(inkyDue(hungry, s, 0), true, 'vigor 80, no food, nothing spare in the stage room');
  const out = fire([hungry], { h: [ID] });
  const dep = out.plan.find(p => p.do === 'deploy' && p.agent === 'h');
  assert.equal(dep?.to, s.inky_room, JSON.stringify(out.plan));
  assert.ok(dep.fight_above_vigor < 80, 'a floor it can actually fight at, under the resting cap');
  const fed = { ...hungry, pack_items: [{ name: 'Inky-cap mushroom', amount: 2 }] };
  assert.equal(inkyDue(fed, s, 0), false, 'two inky caps lift it 80 -> 180: eat, do not farm');
  assert.equal(inkyDue(hungry, s, 200), false, 'the stage room can spare enough: pooling feeds it');
  assert.equal(inkyDue({ ...hungry, vigor: { value: 170, max: 200 } }, s, 0), false, 'over the floor');
  assert.equal(inkyDue({ ...hungry, vigor: null }, s, 0), false, 'an unknown vigor is never sent');
  assert.equal(inkyDue(hungry, { ...s, inky_room: 0 }, 0), false, '0 turns it off');
  assert.ok(inkyOrders(s).hunt.length > 0);
});

// 2026-09-28: the crew hands excess shillings to the chalice desk, so no hunter walks off to bank.
test('trolls: crew_bank_above rides on every deploy and recall, and is compared', () => {
  const d = doctrine();
  d.strategies.settings = { ...(d.strategies.settings ?? {}),
    [ID]: { ...(d.strategies.settings?.[ID] ?? {}), crew_bank_above: 1000000 } };
  const dep = fire([row('a')], { a: [ID] }, d).plan.find(p => p.do === 'deploy');
  assert.equal(dep?.bank_above, 1000000, JSON.stringify(dep));
  assert.equal(callsForFleetPlan([dep])[0].args.bank_above, 1000000, 'the deploy call carries it');
  const down = fire([row('b', { weapon_magic: mundane() })], { b: [ID] }, d).plan.find(p => p.do === 'stand-down');
  assert.equal(callsForFleetPlan([down])[0].args.bank_above, 1000000, 'and so does a recall');
  const off = fire([row('c')], { c: [ID] }).plan.find(p => p.do === 'deploy');
  assert.equal(off?.bank_above, undefined, 'unset: each keeper keeps its own threshold');
});
