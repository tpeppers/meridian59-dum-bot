import assert from 'node:assert/strict';
import { RuleSet, decide } from '../src/decide/engine.mjs';
import { shiftFleetRules } from '../src/decide/rules/shift.mjs';
import { freshDefaults } from '../src/config/defaults.mjs';

const test = globalThis.__dumTest;
const food = {
  id: 'prepare-food', faculty: 'economy', scope: 'fleet', why: 'prepare one meal',
  decide: () => ({ kind: 'act', plan: [{ do: 'cast-create-food', agent: 'cook' }] }),
};
const row = (agent, level) => ({ agent, level, in_game: true, mode: 'farm', room: 544,
  activity: 'hunting', policy: { assignedRoom: 544, hunt: 'fungus beast', purpose: 'advance', roam: false } });
const doctrine = () => {
  const d = freshDefaults();
  d.shift.on = true;
  d.shift.stations = [
    { room: 38, hunt: 'skeleton', max_health: { at_least: 61 } },
    { room: 39, hunt: ['zombie', 'battered skeleton'], max_health: { at_least: 50, below: 61 } },
    { room: 544, hunt: 'fungus beast', max_health: { below: 50 } },
  ];
  return d;
};

test('station scheduling: a cooking bot does not block farming assignments for other bots', () => {
  const observation = { characters: [row('cook', 50), row('upstairs-farmer', 60),
    row('castle-farmer', 61), row('valley-farmer', 49)] };
  const before = structuredClone(observation);
  const result = decide(new RuleSet('fleet', [food, ...shiftFleetRules]), observation, doctrine(), { max: 32 });
  assert.deepEqual(result.intents.map(i => i.rule), ['prepare-food', 'hunt-shift']);
  assert.deepEqual(result.intents[1].plan.map(p => ({ agent: p.agent, room: p.to, hunt: p.hunt })), [
    { agent: 'upstairs-farmer', room: 39, hunt: ['zombie', 'battered skeleton'] },
    { agent: 'castle-farmer', room: 38, hunt: 'skeleton' },
  ]);
  assert.deepEqual(observation, before, 'planning must preserve the original fleet observation');
});

test('station scheduling: later rules still cannot write a reserved bot through another field', () => {
  const bad = { id: 'overlapping-plan', faculty: 'work', scope: 'fleet', why: 'stale target',
    decide: () => ({ kind: 'act', plan: [{ do: 'deploy', agent: 'cook', to: 39 }] }) };
  const result = decide(new RuleSet('fleet', [food, bad]),
    { characters: [row('cook', 50), row('other-farmer', 50)] }, doctrine(), { max: 32 });
  assert.deepEqual(result.intents.map(i => i.rule), ['prepare-food']);
  assert.match(result.considered.find(r => r.rule === bad.id).why, /already decided this pass/);
});

test('station scheduling: an active shopping journey remains deferred', () => {
  const shopper = { ...row('shopper', 50), activity: 'travelling to a shop',
    commitment: { takeable: false, kind: 'driven' } };
  const result = decide(new RuleSet('fleet', [food, ...shiftFleetRules]),
    { characters: [row('cook', 50), shopper, row('ready-farmer', 50)] }, doctrine(), { max: 32 });
  assert.deepEqual(result.intents.map(i => i.rule), ['prepare-food', 'hunt-shift']);
  assert.deepEqual(result.intents[1].plan.map(p => p.agent), ['ready-farmer']);
});
