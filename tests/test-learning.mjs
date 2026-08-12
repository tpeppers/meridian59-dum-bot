import assert from 'node:assert/strict';
import { learningFleetRules } from '../src/decide/rules/learning.mjs';
import { STRATEGY_IDS } from '../src/strategies/catalog.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
import { normalizeFleetRow } from '../src/sense/normalize.mjs';
import { deny } from '../src/link/surface.mjs';
import { fleetRules } from '../src/decide/index.mjs';

const test = globalThis.__dumTest;

const doctrine = {
  strategies: { enabled: true, defaults: [], settings: {} },
};

function row(agent, extra = {}) {
  return {
    agent, character: `unit-${agent}`, in_game: true,
    health: { pct: 1 }, commitment: null, parked: null, piloted: null,
    learning: { planned: { active_stage: 2,
      active: [{ name: 'dodge' }], next: {
        name: 'dodge', kind: 'skill', level: 2, expected_buyable: true,
      } } },
    ...extra,
  };
}

test('learning: the free fleet row preserves the harness learning view', () => {
  const learning = { planned: { active_stage: 3, next: { name: 'fencing' } } };
  assert.deepEqual(normalizeFleetRow({ agent: 'a', learning }).learning, learning);
});

test('learning: strategy starts a bounded errand only for convenient, ready units', () => {
  const id = STRATEGY_IDS.AUTO_LEVEL_PLANNED;
  const obs = {
    characters: [row('a'), row('b'), row('c'),
      row('busy', { commitment: { kind: 'errand', takeable: false } }),
      row('blocked', { learning: { planned: { next: null } } })],
    strategies: {
      agents: Object.fromEntries(['a', 'b', 'c', 'busy', 'blocked'].map(a => [a, [id]])),
      settings: {},
    },
  };
  const intent = learningFleetRules[0].decide(obs, doctrine);
  assert.equal(intent.kind, 'act');
  assert.deepEqual(intent.plan, [
    { do: 'buy-next-planned', agent: 'a' },
    { do: 'buy-next-planned', agent: 'b' },
  ]);
  assert.equal(intent.evidence.waiting_ready, 1);
});

test('learning: selection is breadth-first across queue stages and characters', () => {
  const id = STRATEGY_IDS.AUTO_LEVEL_PLANNED;
  const atStage = (stage, remaining) => ({ learning: { planned: {
    active_stage: stage,
    active: Array.from({ length: remaining }, (_, i) => ({ name: `skill-${i}` })),
    next: { name: 'dodge', kind: 'skill', level: stage + 1, expected_buyable: true },
  } } });
  const obs = {
    characters: [
      row('advanced', atStage(2, 4)),
      row('nearly-done', atStage(1, 1)),
      row('fresh-a', atStage(1, 3)),
      row('fresh-b', atStage(1, 3)),
    ],
    strategies: {
      agents: Object.fromEntries(
        ['advanced', 'nearly-done', 'fresh-a', 'fresh-b'].map(agent => [agent, [id]])),
      settings: {},
    },
  };
  const intent = learningFleetRules[0].decide(obs, doctrine);
  assert.deepEqual(intent.plan, [
    { do: 'buy-next-planned', agent: 'fresh-a' },
    { do: 'buy-next-planned', agent: 'fresh-b' },
  ]);
});

test('learning: the plan interpreter calls only the bounded harness purchase surface', () => {
  const calls = callsForFleetPlan([{ do: 'buy-next-planned', agent: 'a' }], 'planned');
  assert.deepEqual(calls.map(c => ({ tool: c.tool, args: c.args })), [
    { tool: 'buy_next_planned_skills', args: { agents: ['a'] } },
  ]);
  assert.equal(deny('buy_next_planned_skills', { agents: ['a'] }), null);
});

test('learning: finite acquisition queues cannot be starved by standing maintenance', () => {
  const ids = fleetRules.rules.map(rule => rule.id);
  const learning = ids.indexOf('auto-level-next-planned-school');
  assert.ok(learning > ids.indexOf('crate-check'));
  assert.ok(learning > ids.indexOf('complete-faction-join'));
  assert.ok(learning > ids.indexOf('castle-victoria-undead-shift'));
  assert.ok(ids.indexOf('castle-victoria-undead-shift') < ids.indexOf('request-faction-join'));
  assert.ok(learning < ids.indexOf('create-food-to-keep-fed'));
  assert.ok(learning < ids.indexOf('maintain-qualifying-weapons'));
});
