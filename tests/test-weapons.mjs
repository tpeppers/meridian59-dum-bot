import assert from 'node:assert/strict';
import {
  keeperWeaponPriority, passesWeaponThreshold, planWeaponProvisioning, weaponRank,
} from '../src/decide/weapons.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
import { deny } from '../src/link/surface.mjs';
import { weaponFleetRules } from '../src/decide/rules/weapons.mjs';

const test = globalThis.__dumTest;
const carry = (weight = 1000, bulk = 1000) => ({ room_for: { weight, bulk } });
const row = (agent, items = [], extra = {}) => ({
  agent, items, carry: carry(), mana: { value: 20, max: 20 },
  provides: ['create weapon'], ...extra,
});

test('weapons: generic default follows compendium novice maximum damage', () => {
  const p = keeperWeaponPriority('strongestToWeakest');
  assert.equal(p[0], 'scimitar');
  assert.ok(p.indexOf('axe') < p.indexOf('hammer'));
  assert.ok(p.indexOf('hammer') < p.indexOf('mace'));
  assert.ok(p.indexOf('mace') < p.indexOf('short sword'));
});

test('weapons: vsSkeletons Axe threshold is inclusive', () => {
  for (const name of ['hammer', 'spiritual hammer', 'mace', 'axe'])
    assert.equal(passesWeaponThreshold(name, 'vsSkeletons', 'axe'), true, name);
  for (const name of ['scimitar', 'long sword', null])
    assert.equal(passesWeaponThreshold(name, 'vsSkeletons', 'axe'), false, String(name));
  assert.ok(weaponRank('hammer', 'vsSkeletons') < weaponRank('mace', 'vsSkeletons'));
  assert.ok(weaponRank('mace', 'vsSkeletons') < weaponRank('axe', 'vsSkeletons'));
});

test('weapons: doctrines can add a named, swappable preset with tied tiers', () => {
  const presets = { mine: [['mace', 'hammer'], 'axe', '*'] };
  assert.deepEqual(keeperWeaponPriority('mine', presets), ['mace', 'hammer', 'axe']);
  assert.equal(passesWeaponThreshold('hammer', 'mine', 'axe', presets), true);
  assert.equal(passesWeaponThreshold('long sword', 'mine', 'axe', presets), false);
  assert.equal(weaponRank('long sword', 'mine', presets), 2);
});

test('weapons: exact qualifying spare moves before casting and donor keeps its best', () => {
  const plan = planWeaponProvisioning([
    row('donor', [{ id: 1, name: 'hammer' }, { id: 2, name: 'axe' }]),
    row('one', [{ id: 3, name: 'long sword' }]),
    row('two', []),
  ], { preset: 'vsSkeletons', threshold: 'axe' });
  assert.deepEqual(plan.transfers[0].what, [{ id: 2, amount: 1 }]);
  assert.equal(plan.transfers[0].to, 'one');
  assert.equal(plan.deficit, 1);
  // While a qualifying weapon is still needed, everyone able to cast does so — not
  // merely the unarmed recipient.
  assert.deepEqual(plan.cast.map(x => x.agent), ['donor', 'one', 'two']);
});

test('weapons: enough exact spares stops casting', () => {
  const plan = planWeaponProvisioning([
    row('donor', [{ id: 1, name: 'hammer' }, { id: 2, name: 'mace' }, { id: 3, name: 'axe' }]),
    row('one'), row('two'),
  ], { preset: 'vsSkeletons', threshold: 'axe' });
  assert.equal(plan.transfers.length, 2);
  assert.equal(plan.deficit, 0);
  assert.deepEqual(plan.cast, []);
});

test('weapons: unknown or insufficient pack room is never treated as room', () => {
  const plan = planWeaponProvisioning([
    row('donor', [{ id: 1, name: 'hammer' }, { id: 2, name: 'mace' }]),
    row('full', [], { carry: { room_for: null } }),
  ], { preset: 'vsSkeletons', threshold: 'axe' });
  assert.equal(plan.transfers.length, 0);
  assert.equal(plan.needs_room[0].agent, 'full');
  assert.ok(!plan.cast.some(x => x.agent === 'full'));
});

test('weapons: maintenance operations always resume the keepers they borrow', () => {
  const calls = callsForFleetPlan([
    { do: 'cast-create-weapon', agent: 'a' },
    { do: 'give-weapon', from: 'a', to: 'b', what: [{ id: 7, amount: 1 }] },
    { do: 'equip-best', agent: 'b' },
  ]);
  assert.deepEqual(calls.map(x => x.tool), [
    'cast', 'autopilot',
    'supply', 'autopilot', 'autopilot',
    'equip_best', 'autopilot',
  ]);
  for (const call of calls.filter(x => x.tool === 'autopilot'))
    assert.equal(call.args.action, 'revive');
  assert.equal(deny('cast', { agent: 'a', spell: 'create weapon' }), null);
  assert.match(deny('cast', { agent: 'a', spell: 'fireball' }), /only.*create weapon/i);
});

test('weapons: provisioning is staging-only and cannot interrupt a shift', () => {
  const rule = weaponFleetRules[0];
  const doctrine = { weapons: { preset: 'vsSkeletons', provision: {
    enabled: true, threshold: 'axe', room: 52, cast_when_mana: true, mana_cost: 15,
  } } };
  const one = row('one', [], { in_game: true, room: 52 });
  const fighting = row('two', [], { in_game: true, room: 71 });
  const out = rule.decide({ characters: [one, fighting] }, doctrine);
  assert.equal(out.kind, 'pass');
  assert.match(out.why, /never chases or interrupts fighters/);
});

test('graveyard fleet steps compile to safe keeper orders and an explicit trip home', () => {
  const calls = callsForFleetPlan([
    { do: 'deploy', agent: 'a', to: 71, hunt: 'zombie', max_threat_over: 12,
      flee_below: .35, max_carry: 60, bank_above: null, roam: false,
      use_safe_spots: true, weapon_priority: ['hammer', 'mace', 'axe'] },
    { do: 'stand-down', agent: 'b', assigned_room: 52, moved: true, roam: false },
  ]);
  assert.deepEqual(calls.map(x => x.tool), ['autopilot', 'autopilot', 'travel']);
  assert.equal(calls[0].args.assigned_room, 71);
  assert.equal(calls[0].args.use_safe_spots, true);
  assert.equal(calls[1].args.mode, 'idle');
  assert.equal(calls[2].args.to, 52);
});
