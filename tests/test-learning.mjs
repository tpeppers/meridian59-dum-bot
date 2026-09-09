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
  assert.ok(learning > ids.indexOf('castle-victoria-undead-shift'),
    'the patrol baseline a learning errand returns to is established first, and travels ' +
    'with this rule wherever it moves');
  assert.ok(ids.indexOf('castle-victoria-undead-shift') < ids.indexOf('request-faction-join'));
  assert.ok(learning < ids.indexOf('create-food-to-keep-fed'));
  assert.ok(learning < ids.indexOf('maintain-qualifying-weapons'));

  // AND ABOVE THE TWO RULES THAT ALWAYS HAVE SOMETHING TO SAY. First-match-wins means a
  // rule below a constantly-firing one never runs at all, which is not a delay, it is an
  // outage. The feast fired 491 times in one day; learning recorded 99 consecutive "no
  // candidate" verdicts underneath it while three characters stood ready and funded.
  // Safe only because the rule is finite — see the funding gate in learning.mjs.
  assert.ok(learning < ids.indexOf('feast-hall-larder'),
    'the feast is reached on nearly every pass and would starve a finite queue');
  assert.ok(learning < ids.indexOf('barloque-sell-circuit'));
});

test('learning: a character that cannot pay is named, not dispatched', () => {
  // `expected_buyable` IS NOT "CAN AFFORD IT". It is PlayerCanLearn plus "does not hold it
  // yet" — entirely about earning the ability and silent about money. Without a funding
  // check DUM walks the character to Cor Noth, fails to pay, walks it home, and finds it
  // uncommitted and ready again on the very next pass. Since this rule sits above the
  // feast, that loop would starve the fleet of FOOD, not just of skills.
  //
  // Measured 2026-09-08: two characters were ready for all three level-3 proficiencies
  // at 2000 each, carrying 800 and 780.
  const id = STRATEGY_IDS.AUTO_LEVEL_PLANNED;
  const priced = (price, extra) => row('x', { learning: { planned: { active_stage: 3,
    active: [{ name: 'axe wielding' }],
    next: { name: 'axe wielding', kind: 'skill', level: 3, expected_buyable: true, price },
  } }, ...extra });

  const obs = {
    characters: [
      { ...priced(2000, { purse: 800, banked: null }), agent: 'broke', character: 'Ada' },
      { ...priced(2000, { purse: 3773, banked: null }), agent: 'rich', character: 'Bea' },
      // The two purses are summed for THIS question only: the errand's first step is a
      // bank withdrawal when the pack is short, so what matters is the total it can reach.
      { ...priced(2000, { purse: 500, banked: 1500 }), agent: 'banked', character: 'Cyd' },
    ],
    strategies: { agents: Object.fromEntries(['broke', 'rich', 'banked'].map(a => [a, [id]])),
                  settings: {} },
  };
  const intent = learningFleetRules[0].decide(obs, doctrine);
  assert.equal(intent.kind, 'act');
  assert.deepEqual(intent.plan.map(p => p.agent).sort(), ['banked', 'rich'],
    'exactly the characters that can reach the price');

  // AND WHEN NOBODY CAN PAY, THE PASS SAYS SO. "no candidate" and "three characters are
  // ready and short by 1200" are different facts and only one of them is actionable.
  const poor = { ...obs, characters: [obs.characters[0]],
    strategies: { agents: { broke: [id] }, settings: {} } };
  const out = learningFleetRules[0].decide(poor, doctrine);
  assert.equal(out.kind, 'pass');
  assert.match(out.why, /Ada needs 1200 more for axe wielding/);
  assert.equal(out.evidence.unfunded.length, 1);

  // A queue entry that states no price is not blocked — the gate only applies to a real
  // number, so every doctrine written before this behaves exactly as it did.
  const unpriced = { characters: [{ ...row('u'), purse: 0, banked: null }],
                     strategies: { agents: { u: [id] }, settings: {} } };
  assert.equal(learningFleetRules[0].decide(unpriced, doctrine).kind, 'act');
});

test('learning: a bank balance survives normalisation in every shape the board sends', () => {
  // THE FUNDING GATE IS ONLY AS GOOD AS THE FIELD IT READS. The broker puts `bankKnown()`
  // on the row verbatim — `{balance, account, at, observed}` — and the normaliser read
  // `.value`, so the object fell through to `num(object)` and became null. Null is reserved
  // to mean "nobody has ever seen this character at a counter", so a fleet holding tens of
  // thousands was indistinguishable from a fleet that had never banked a shilling.
  assert.equal(normalizeFleetRow({ agent: 'a', banked: { balance: 21625 } }).banked, 21625);
  assert.equal(normalizeFleetRow({ agent: 'a', banked: { value: 900 } }).banked, 900,
    'the older shape still reads');
  assert.equal(normalizeFleetRow({ agent: 'a', banked: 750 }).banked, 750);
  assert.equal(normalizeFleetRow({ agent: 'a' }).banked, null,
    'unseen stays null and must never render as a balance of zero');
  assert.equal(normalizeFleetRow({ agent: 'a', banked: false }).banked, null);

  // And end to end: the row the broker actually sends funds a 2000-shilling purchase.
  const id = STRATEGY_IDS.AUTO_LEVEL_PLANNED;
  const learner = { ...normalizeFleetRow({
    agent: 'b', character: 'Ada', purse: 881,
    banked: { balance: 21625, account: 'jasper-tos-barloque', observed: true },
    health: '56/56',
    learning: { planned: { active_stage: 3, active: [{ name: 'axe wielding' }], next: {
      name: 'axe wielding', kind: 'skill', level: 3, expected_buyable: true, price: 2000 } } },
  }), in_game: true };
  const intent = learningFleetRules[0].decide(
    { characters: [learner], strategies: { agents: { b: [id] }, settings: {} } }, doctrine);
  assert.equal(intent.kind, 'act');
  assert.deepEqual(intent.plan, [{ do: 'buy-next-planned', agent: 'b' }]);
});
