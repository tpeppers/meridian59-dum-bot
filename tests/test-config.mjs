import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripComments, parseJsonc } from '../src/config/jsonc.mjs';
import { loadDoctrine } from '../src/config/load.mjs';
import { validate } from '../src/config/schema.mjs';
import { freshDefaults } from '../src/config/defaults.mjs';

const test = globalThis.__dumTest;
const tmp = () => mkdtempSync(join(tmpdir(), 'dum-'));

test('jsonc: a URL inside a string is not a comment', () => {
  // The bug this exists for: the naive version turned "http://" into a comment and
  // then into a parse error two hundred characters later.
  const src = '{ "why": "see http://example.invalid/x for why", "n": 1 }';
  assert.deepEqual(parseJsonc(src), { why: 'see http://example.invalid/x for why', n: 1 });
});

test('jsonc: comments go, line numbers stay', () => {
  const src = '{\n  // a reason\n  "n": 1\n}';
  assert.equal(stripComments(src).split('\n').length, 4);
  assert.deepEqual(parseJsonc(src), { n: 1 });
});

test('jsonc: block comments keep their newlines', () => {
  const src = '{\n/* one\n   two */\n"n": 1 }';
  assert.equal(stripComments(src).split('\n').length, 4);
});

test('jsonc: a trailing comma is an error, and the message says so', () => {
  assert.throws(() => parseJsonc('{ "n": 1, }', 'x.jsonc'), /no trailing commas/);
});

test('defaults alone validate', () => {
  assert.deepEqual(validate(freshDefaults()), []);
});

test('claiming survival without the acknowledgement is refused, and says why', () => {
  const c = freshDefaults();
  c.claim.survival = 'bot';
  const problems = validate(c);
  assert.equal(problems.length, 1);
  assert.match(problems[0].why, /stands still while something eats it/);
});

test('claiming survival WITH the acknowledgement is allowed', () => {
  const c = freshDefaults();
  c.claim.survival = 'bot';
  c.claim.i_accept_the_character_may_die = true;
  assert.deepEqual(validate(c), []);
});

test('a ladder rung with no completion test is refused', () => {
  const c = freshDefaults();
  c.goals.ladder = [{ id: 'forever', orders: {}, why: 'because' }];
  const problems = validate(c);
  assert.ok(problems.some(p => /never completes/.test(p.why)));
});

test('a ladder rung with no reason is refused', () => {
  const c = freshDefaults();
  c.goals.ladder = [{ id: 'x', until: { kind: 'max_health', at_least: 30 }, orders: {} }];
  assert.ok(validate(c).some(p => p.where.endsWith('.why')));
});

test('yield_to naming a field that is not an order field is refused', () => {
  // A typo here is silent in the dangerous direction: the field is NOT yielded, so DUM
  // writes it against a supervisor that also writes it, and both logs look correct.
  const c = freshDefaults();
  c.yield_to = ['max_carry', 'rest_belwo'];
  assert.ok(validate(c).some(p => p.where === 'yield_to' && /rest_belwo/.test(p.why)));
});

test('yield_to naming real order fields is accepted', () => {
  const c = freshDefaults();
  c.yield_to = ['rest_below', 'max_carry', 'roam'];
  assert.deepEqual(validate(c), []);
});

test('fleet cadence slower than character cadence is refused', () => {
  const c = freshDefaults();
  c.cadence.fleet_ms = 1000;
  c.cadence.character_ms = 30_000;
  assert.ok(validate(c).some(p => p.where === 'cadence.fleet_ms'));
});

test('spreading with nowhere to spread to is refused', () => {
  const c = freshDefaults();
  c.placement.spread = true;
  assert.ok(validate(c).some(p => p.where === 'placement.spread'));
});

test('layering: a doctrine beats the defaults and provenance names the file', () => {
  const dir = tmp();
  const f = join(dir, 'd.jsonc');
  writeFileSync(f, '{ "name": "mine", "economy": { "bank_above": 500 } }');
  const { config, provenance } = loadDoctrine({ file: f });
  assert.equal(config.economy.bank_above, 500);
  assert.equal(provenance.get('economy.bank_above'), f);
  // Untouched leaves still say they came from the defaults, which is the answer to
  // "was this number chosen or inherited".
  assert.equal(provenance.get('economy.max_carry'), 'built-in defaults');
});

test('layering: extends is innermost-first, and the extending file wins', () => {
  const dir = tmp();
  const base = join(dir, 'base.jsonc');
  const top = join(dir, 'top.jsonc');
  writeFileSync(base, '{ "economy": { "bank_above": 200, "max_carry": 14 } }');
  writeFileSync(top, `{ "extends": "base.jsonc", "economy": { "bank_above": 800 } }`);
  const { config, provenance } = loadDoctrine({ file: top });
  assert.equal(config.economy.bank_above, 800);
  assert.equal(config.economy.max_carry, 14);
  assert.equal(provenance.get('economy.bank_above'), top);
  assert.equal(provenance.get('economy.max_carry'), base);
});

test('layering: a per-character section only applies with --agent', () => {
  const dir = tmp();
  const f = join(dir, 'd.jsonc');
  writeFileSync(f, '{ "economy": { "bank_above": 500 }, ' +
                   '"characters": { "role-a": { "economy": { "bank_above": 50 } } } }');
  assert.equal(loadDoctrine({ file: f }).config.economy.bank_above, 500);
  assert.equal(loadDoctrine({ file: f, agent: 'role-a' }).config.economy.bank_above, 50);
  // And planning the fleet with per-character sections warns rather than silently
  // planning half the doctrine.
  assert.ok(loadDoctrine({ file: f }).warnings.some(w => /not applied without --agent/.test(w)));
});

test('layering: arrays replace, they do not concatenate', () => {
  const dir = tmp();
  const base = join(dir, 'base.jsonc');
  const top = join(dir, 'top.jsonc');
  writeFileSync(base, '{ "placement": { "rooms": [1, 2, 3] } }');
  writeFileSync(top, '{ "extends": "base.jsonc", "placement": { "rooms": [9] } }');
  // "fewer rooms" has to be expressible, and a concatenating merge makes it not.
  assert.deepEqual(loadDoctrine({ file: top }).config.placement.rooms, [9]);
});

test('layering: a cycle in extends is an error rather than a hang', () => {
  const dir = tmp();
  const a = join(dir, 'a.jsonc');
  const b = join(dir, 'b.jsonc');
  writeFileSync(a, '{ "extends": "b.jsonc" }');
  writeFileSync(b, '{ "extends": "a.jsonc" }');
  assert.throws(() => loadDoctrine({ file: a }), /cycle/);
});

test('a command-line override is recorded as such', () => {
  const { config, provenance } = loadDoctrine({ overrides: { 'cadence.character_ms': 5000 } });
  assert.equal(config.cadence.character_ms, 5000);
  assert.equal(provenance.get('cadence.character_ms'), 'command line');
});

test('the shipped doctrines all load and validate', () => {
  for (const name of ['survive.jsonc', 'valley-grind.jsonc', 'lowland-starter.jsonc']) {
    const f = new URL(`../doctrines/${name}`, import.meta.url);
    // Throws on any validation problem, which is the assertion.
    loadDoctrine({ file: f.pathname.replace(/^\/([A-Za-z]:)/, '$1') });
  }
});
