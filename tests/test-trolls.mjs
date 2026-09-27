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
import { trollFleetRules, trollReadiness, dedicationTarget, planDedication, planGear }
  from '../src/decide/rules/trolls.mjs';
import { requirementsMet, shiftFleetRules } from '../src/decide/rules/shift.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
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
    threatCeiling: { mode: 'percent', value: 170 } };
  const d = guardianDoctrine({ rest_below: 0.55 });
  const staying = [0, 1, 2, 3].map(i => inRoom(`g${i}`, { policy: member,
    ...(i === 0 ? { health: { value: 45, max: 75, pct: 0.6 } } : {}) }));
  assert.equal(fire(staying, all(4), d).kind === 'act'
    && deploysOf(fire(staying, all(4), d)).length > 0, false, 'a member at 60% stays: nothing re-sent');
});

test('guardians: when the group breaks, the ceiling goes back to the default', () => {
  const member = { assignedRoom: 599, hunt: ['guardian of zjiria', 'troll'], roam: false,
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.85, trainingStyle: 'normal',
    threatCeiling: { mode: 'percent', value: 170 } };
  const rows = [0, 1, 2].map(i => inRoom(`g${i}`, { policy: member }));
  const deps = deploysOf(fire(rows, all(3), guardianDoctrine()));
  assert.equal(deps.length, 3);
  for (const dep of deps) {
    assert.deepEqual(dep.hunt, ['troll']);
    assert.deepEqual(dep.threat_ceiling, { mode: 'percent', value: 150 });
  }
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
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.85 } });
  assert.equal(fire([settled], { a: [ID] }).kind, 'pass', 'diffed: already there sends nothing');
  // 2026-09-27: the keeper reports a one-name hunt as a STRING, and an array-only compare re-sent
  // the whole deploy to every ready hunter every pass.
  const asKeeperSaysIt = row('a', { policy: { assignedRoom: 599, hunt: 'troll', roam: false,
    preferMagicWeapon: true, fleeBelow: 0.45, restBelow: 0.85 } });
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
    fleeBelow: 0.45, restBelow: 0.85 };
  const practising = row('a', { policy: { ...settled, trainingStyle: 'short_sword' } });
  assert.ok(fire([practising], { a: [ID] }).plan.some(p => p.do === 'deploy'),
    'a unit in 599 still practising with a hammer is sent the order again');
  const plain = row('a', { policy: { ...settled, trainingStyle: 'normal' } });
  assert.equal(fire([plain], { a: [ID] }).kind, 'pass');
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
    policy: { assignedRoom: 2, roam: false, preferMagicWeapon: true }, mode: 'idle' });
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

test('trolls: a magic AXE is no spare to a hammer trainee (the tie-break never wields it)', () => {
  const r = hammerer('h', [W(1, 'hammer', true, { wielded: true }), W(2, 'axe', true)]);
  assert.equal(familyMagicSpares(r), 0);
  assert.equal(trollReadiness(r, settings(doctrine())).ready, false);
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

test('trolls: the courier sells only REAL surplus, after its cooldown, and walks back', () => {
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
