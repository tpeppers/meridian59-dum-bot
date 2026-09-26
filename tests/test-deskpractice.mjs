// PRACTICE AT THE SERVICE DESK — the directional half, offline.
//
// The rule keeps the keeper's `practiceSpells` policy equal to the doctrine and returns null once
// it is. What is pinned: it touches only the named desk characters, it settles (a matching policy
// in any key order is not a redeploy), switching it off reaches the keeper, the diff in
// orders.mjs sends it, and the schema refuses what the broker would refuse — including a
// hand-set mana reserve, which is the harness's to derive from the desk menu.
import assert from 'node:assert/strict';
import { validate } from '../src/config/schema.mjs';
import { DEFAULTS } from '../src/config/defaults.mjs';
import { planOrders } from '../src/act/orders.mjs';
import { characterRules } from '../src/decide/index.mjs';
import { deskPracticeRules, samePractice, wantedPractice } from '../src/decide/rules/deskpractice.mjs';

const test = globalThis.__dumTest;
const rule = deskPracticeRules[0];
const SPELLS = ['holy symbol', { name: 'purify', target: 'none' }];
const doctrine = (dp = {}) => ({ desk_practice: { on: true, agents: ['desk-1'], spells: SPELLS, reserve_casts: 2, ...dp } });
const obs = (policy = {}, extra = {}) => ({ agent: 'desk-1', character: 'Deskkeeper', in_game: true,
  keeper: { policy: { practiceSpells: null, ...policy }, mode: 'idle' }, ...extra });

test('desk practice: a desk character without the policy is sent it', () => {
  const out = rule.decide(obs(), doctrine());
  assert.equal(out?.kind, 'orders');
  assert.deepEqual(out.orders.practice_spells, { enabled: true, spells: SPELLS, reserve_casts: 2 });
  assert.match(out.why, /2 casts of its dearest service/);
});

test('desk practice: the doctrine carries no mana number — the harness derives it', () => {
  const w = wantedPractice(doctrine());
  assert.ok(!('mana' in w) && !('reserve' in w) && !('mana_reserve' in w));
  assert.ok(!('agents' in w) && !('on' in w), 'doctrine-only keys never reach the broker, which would refuse them');
});

test('desk practice: a matching policy settles, in any key order', () => {
  const live = { reserve_casts: 2, spells: [{ target: 'none', name: 'purify' }, 'holy symbol'].reverse(), enabled: true };
  assert.ok(samePractice(live, wantedPractice(doctrine())));
  assert.equal(rule.decide(obs({ practiceSpells: live }), doctrine()), null);
});

test('desk practice: nobody but the named desk characters is touched', () => {
  assert.equal(rule.decide(obs({}, { agent: 'farmer-7', character: 'Somebody' }), doctrine()), null);
  assert.ok(rule.decide(obs({}, { agent: 'x', character: 'deskkeeper' }), doctrine({ agents: ['Deskkeeper'] })),
    'by character name too, case-insensitively');
  assert.equal(rule.decide(obs(), doctrine({ agents: [] })), null, 'an empty list names nobody');
});

test('desk practice: switching it off reaches the keeper', () => {
  const off = doctrine({ on: false });
  const out = rule.decide(obs({ practiceSpells: { enabled: true, spells: ['purify'] } }), off);
  assert.equal(out?.orders?.practice_spells, null);
  assert.equal(rule.decide(obs(), off), null, 'and once it is off, nothing more is sent');
});

test('desk practice: the defaults name nobody and change nothing', () => {
  assert.equal(DEFAULTS.desk_practice.on, false);
  assert.deepEqual(DEFAULTS.desk_practice.agents, []);
  assert.equal(DEFAULTS.desk_practice.reserve_casts, 2, 'the operator\'s number');
  assert.equal(rule.decide(obs(), DEFAULTS), null);
});

test('desk practice: orders.mjs sends the field and settles on it', () => {
  const intent = { agent: 'desk-1', kind: 'orders', orders: { action: 'start', practice_spells: wantedPractice(doctrine()) } };
  const fresh = planOrders(intent, obs());
  assert.ok('practice_spells' in (fresh.send ?? {}), `must be sent: ${JSON.stringify(fresh)}`);
  const held = planOrders(intent, obs({ practiceSpells: { spells: SPELLS, enabled: true, reserve_casts: 2 } }));
  assert.ok(!('practice_spells' in (held.send ?? {})), `must settle: ${JSON.stringify(held)}`);
});

test('desk practice: the rule is registered in the character table, ahead of the ladder', () => {
  const ids = characterRules.rules.map(r => r.id);
  assert.ok(ids.includes('desk-practice-policy'));
  const ladder = ids.findIndex(id => /ladder/.test(id));
  assert.ok(ladder < 0 || ids.indexOf('desk-practice-policy') < ladder);
});

test('desk practice: the schema refuses what the broker would refuse', () => {
  const said = (dp) => JSON.stringify(validate({ ...DEFAULTS, desk_practice: dp }).filter(p => /desk_practice/.test(p.where)));
  assert.equal(said({ on: true, agents: ['desk-1'], spells: SPELLS }), '[]', 'a well-formed one passes');
  assert.equal(said({ on: false, agents: [], spells: [] }), '[]', 'an off one needs nothing');
  assert.match(said({ on: true, agents: [], spells: SPELLS }), /desk_practice\.agents/);
  assert.match(said({ on: true, agents: ['desk-1'], spells: [] }), /desk_practice\.spells/);
  assert.match(said({ on: true, agents: ['desk-1'], spells: [{ name: 'purify', target: 'them' }] }), /desk_practice\.spells/);
  assert.match(said({ on: true, agents: ['desk-1'], spells: SPELLS, gap_ms: 5 }), /desk_practice\.gap_ms/);
  const hand = said({ on: true, agents: ['desk-1'], spells: SPELLS, mana_reserve: 60 });
  assert.match(hand, /desk_practice\.mana_reserve/);
  assert.match(hand, /derived by the harness/, 'and says where the reserve actually comes from');
});
