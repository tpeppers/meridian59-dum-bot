import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StrategyStore } from '../src/record/strategies.mjs';
import { STRATEGY_CATALOG, STRATEGY_IDS } from '../src/strategies/catalog.mjs';
import { foodFleetRules } from '../src/decide/rules/food.mjs';
import { castleAssignments, castleDeploymentDiffers } from '../src/decide/rules/castle-victoria.mjs';
import { loadDoctrine } from '../src/config/load.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';

const test = globalThis.__dumTest;

test('strategies: catalogue contains the four independently selectable behaviours', () => {
  assert.deepEqual(STRATEGY_CATALOG.map(s => s.id), [
    STRATEGY_IDS.CREATE_WEAPONS, STRATEGY_IDS.CREATE_FOOD,
    STRATEGY_IDS.VS_SKELETONS, STRATEGY_IDS.CHECK_CV_CRATE,
  ]);
  assert.equal(STRATEGY_CATALOG.filter(s => s.group === 'Kraanan upkeep').length, 2);
});

test('strategies: a multi-unit toggle changes only the named behaviour', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-strategies-'));
  try {
    const store = new StrategyStore({ dir, fleet: 'fixture', enabled: true,
      defaults: Object.values(STRATEGY_IDS) });
    assert.equal(store.states(['a', 'b']).states[STRATEGY_IDS.CREATE_FOOD].state, 'all');
    store.update(['a'], { [STRATEGY_IDS.CREATE_FOOD]: false });
    const states = store.states(['a', 'b']).states;
    assert.equal(states[STRATEGY_IDS.CREATE_FOOD].state, 'some');
    assert.equal(states[STRATEGY_IDS.CREATE_WEAPONS].state, 'all');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strategies: Create Food fires only for selected units with spell, mana, and reagents', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const row = agent => ({ agent, in_game: true, items: [
    { name: 'elderberry', amount: 2 }, { name: 'herb', amount: 2 },
  ], provides: ['create food'], mana: { value: 10 } });
  const obs = { characters: [row('cook'), row('off')], strategies: { agents: {
    cook: [STRATEGY_IDS.CREATE_FOOD], off: [],
  } } };
  const result = foodFleetRules[0].decide(obs, doctrine);
  assert.equal(result.kind, 'act');
  assert.deepEqual(result.plan.map(p => p.agent), ['cook']);
  assert.equal(result.plan[0].do, 'cast-create-food');
  assert.deepEqual(callsForFleetPlan(result.plan).map(x => x.tool), ['cast', 'autopilot']);
});

test('strategies: Castle Victoria assigns all requested undead and weights upstairs', () => {
  const doctrine = loadDoctrine({ file: 'doctrines/castle-victoria.jsonc' }).config;
  const rows = Array.from({ length: 21 }, (_, i) => ({ agent: `a${i + 1}`, in_game: true,
    level: 43 + (i % 9), policy: {}, mode: 'farm' }));
  const assigned = castleAssignments(rows, doctrine);
  assert.equal(assigned.filter(a => a.to === 39).length, 14);
  assert.equal(assigned.filter(a => a.to === 38).length, 7);
  assert.deepEqual(new Set(assigned.map(a => a.hunt)),
    new Set(['zombie', 'battered skeleton', 'skeleton']));
  const skeleton = assigned.find(a => a.hunt === 'skeleton');
  assert.equal(skeleton.row.level + skeleton.max_threat_over, 75);
});

test('strategies: Castle policy diff includes live maintenance fields', () => {
  const orders = { to: 39, hunt: 'battered skeleton', max_threat_over: 10,
    flee_below: .35, rest_below: .75, max_carry: 14, bank_above: 2000,
    use_safe_spots: true, strategy: 'wellfed', fight_above_vigor: 180,
    hold_resume_above: .9, purpose: 'advance', weapon_priority: ['hammer'] };
  const row = { mode: 'farm', policy: { assignedRoom: 39, hunt: 'battered skeleton',
    maxThreatOver: 10, fleeBelow: .35, restBelow: .75, maxCarry: 14,
    bankAbove: 2000, roam: false, useSafeSpots: true, strategy: 'wellfed',
    fightAboveVigor: 180, holdResumeAbove: .9, purpose: 'advance',
    weaponPriority: ['hammer'] } };
  assert.equal(castleDeploymentDiffers(row, orders), false);
  row.commitment = { kind: 'driven' };
  assert.equal(castleDeploymentDiffers(row, orders), true);
  row.commitment = null;
  row.policy.weaponPriority = ['sword'];
  assert.equal(castleDeploymentDiffers(row, orders), true);
});
