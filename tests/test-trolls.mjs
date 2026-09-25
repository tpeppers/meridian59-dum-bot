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
import { trollFleetRules, trollReadiness, dedicationTarget, planDedication }
  from '../src/decide/rules/trolls.mjs';
import { requirementsMet, shiftFleetRules } from '../src/decide/rules/shift.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
import { STRATEGY_IDS, strategySettings, admits, HUNT_ROOMS, QUARRY_LEVEL }
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
  assert.deepEqual(steps, ['give-reagent', 'give-reagent', 'give-weapon', 'cast-enchant-weapon',
    'give-weapon', 'equip-best']);
  const cast = out.plan.find(p => p.do === 'cast-enchant-weapon');
  assert.equal(cast.target, 22, 'the spare (id 22), not the hammer in hand (21)');
  const back = out.plan.filter(p => p.do === 'give-weapon');
  assert.equal(back[0].from, 'owner'); assert.equal(back[1].to, 'owner');
  const calls = callsForFleetPlan(out.plan);
  const c = calls.find(x => x.tool === 'cast');
  assert.deepEqual([c.args.spell, c.args.target], ['enchant weapon', 22]);
  const r = calls.find(x => x.tool === 'supply' && x.args.what === 'orc tooth');
  assert.equal(r.args.amount, 1);
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
  const units = Array.from({ length: 4 }, (_, i) => row(`t${i + 1}`, { level: 60, max_health: 60, room: 39 }));
  const agents = Object.fromEntries(units.map(u => [u.agent, [ID]]));
  const out = shiftFleetRules[0].decide(obs(units, agents), d);
  const touched = (out.plan ?? []).map(p => p.agent);
  assert.equal(touched.length, 0, `the shift deployed ${touched.join(', ')}`);
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
  const depot = row('depot', { room: 2, max_health: 20, pack_items: [{ name: 'elderberry', amount: 300 }],
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
  const depot = row('depot', { room: 2, max_health: 20, pack_items: [{ name: 'elderberry', amount: 300 }],
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
