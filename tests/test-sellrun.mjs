// THE BARLOQUE SELL CIRCUIT — offline, no broker, no server, no clock.
//
// Like every rule here, `barloque-sell-circuit` is pure: the pack it reads and the `now` it
// gates on both arrive on the observation, so the whole thing is a fixture in and an intent out.
//
// What is pinned, in order of how expensive being wrong would be:
//
//   * the trip re-fires on a per-character cooldown, never every tick — the "character living
//     in a shop" failure the crate rule documents; a broken window empties nobody's pack and
//     parks a character in Barloque for ever;
//   * a hurt character is NOT marched across town — selling is not survival;
//   * the jeweler stop carries the stack cap (25) that stop was written for — without it a gem
//     stack over 25 is refused wholesale and the trip earns nothing there;
//   * the way home is `always`, so a stop that could not be reached does not strand the walker;
//   * the errand is actually registered and reachable through the real fleet table.

const test = globalThis.__dumTest;

import { sellrunFleetRules, sellrunWindow, recordSellrun } from '../src/decide/rules/sellrun.mjs';
import { decide } from '../src/decide/engine.mjs';
import { fleetRules } from '../src/decide/index.mjs';
import { ERRANDS } from '../src/act/errands.mjs';
import { loadDoctrine } from '../src/config/load.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const NOW = 1_700_000_000_000;
const rule = sellrunFleetRules[0];

/** A healthy character with a heavy pack, hunting somewhere. */
const heavy = (agent, over = {}) => ({
  agent, character: agent.toUpperCase(), in_game: true,
  level: 30, max_health: 30,
  health: { value: 30, max: 30, pct: 1 },
  room: 544, room_name: 'Valley of Ileria',
  carrying: 30, purse: 500,
  commitment: null, parked: null, piloted: null,
  ...over,
});

const fleetObs = (rows, memory = {}, at = NOW) => ({
  at, source: 'fleet', characters: rows, in_game: rows.length, memory, depth: 'board',
});

/** The doctrine as it actually arrives — layered over the real defaults, which supply the stops. */
const doctrineWith = (sellrun = {}) => loadDoctrine({
  file: null,
  overrides: {
    'fleet': 'test-fleet',
    'claim.work': 'bot',
    'sellrun.on': true,
    ...Object.fromEntries(Object.entries(sellrun).map(([k, v]) => [`sellrun.${k}`, v])),
  },
}).config;

// ---------------------------------------------------------------- the window

test('sellrun: an unknown history is a reason to go', () => {
  const w = sellrunWindow({}, 'a', NOW, 20 * 60_000);
  eq(w.ready, true, 'no recorded run means ready');
  ok(/no recorded circuit run/.test(w.why), 'says why');
});

test('sellrun: inside the cooldown it refuses, and the refusal is arithmetic', () => {
  const mem = { a: { last_run_at: NOW - 5 * 60_000 } };
  const w = sellrunWindow(mem, 'a', NOW, 20 * 60_000);
  eq(w.ready, false, 'must not send it again yet');
  ok(/not again for 15m/.test(w.why), `arithmetic in the reason: ${w.why}`);
});

test('sellrun: one character\'s recent run does not gate another\'s', () => {
  const mem = { a: { last_run_at: NOW } };
  eq(sellrunWindow(mem, 'b', NOW, 20 * 60_000).ready, true, 'b has never gone');
});

// ---------------------------------------------------------------- the decision

test('sellrun: the vault, the three specialists, the bank, and home', () => {
  // THIS USED TO BE THREE SHOPS AND A WALK HOME, and that circuit had converted a pack into a
  // purse and then carried the purse across the same road the pack came over. Half this
  // fleet's deaths are on that road. The two ends are now the point of the trip: the vault
  // takes what must not be sold at all, and the bank takes what the shops paid.
  const intent = rule.decide(fleetObs([heavy('a')]), doctrineWith());
  ok(intent, 'a heavy character gets a trip');
  eq(intent.kind, 'errand', 'a sequence, not a policy write');
  eq(intent.orders.errand, 'sellrun-circuit', 'errand kind');
  eq(intent.orders.agent, 'a', 'the heavy one');
  const steps = intent.orders.steps;
  eq(steps.map(s => s.tool).join(','),
     'travel,vault,travel,sell_all,travel,sell_all,travel,sell_all,travel,bank,travel',
     'the vault BEFORE the first shop, then the three lanes, then the bank, then home');
  eq(steps[steps.length - 1].always, true, 'the way home runs even after a stop failed');
  eq(steps[steps.length - 1].args.to, 544, 'home is the room it was hunting in');
});

test('sellrun: the jeweler stop carries the stack cap it was written for', () => {
  const intent = rule.decide(fleetObs([heavy('a')]), doctrineWith());
  const jeweler = intent.orders.steps.find(s => s.tool === 'sell_all' && s.args.merchant === 'Herbutte');
  ok(jeweler, 'the jeweler is a stop');
  eq(jeweler.args.max_stack, 25, 'a gem stack over 25 is refused wholesale (bqmerch.kod:113)');
  ok(jeweler.args.keep.includes('elderberry'), 'reagents are kept, never sold');
});

test('sellrun: a light pack is left to hunt', () => {
  eq(rule.decide(fleetObs([heavy('a', { carrying: 5 })]), doctrineWith()), null,
     'nothing to sell, no trip');
});

test('sellrun: a hurt character is not marched to town', () => {
  const hurt = heavy('a', { health: { value: 9, max: 30, pct: 0.3 } });
  eq(rule.decide(fleetObs([hurt]), doctrineWith()), null, 'survival is the keeper\'s, not a sell trip');
});

test('sellrun: a character BUSY with an operation is left alone', () => {
  const busy = heavy('a', { commitment: { kind: 'errand', takeable: false, label: 'a loot run' } });
  eq(rule.decide(fleetObs([busy]), doctrineWith()), null, 'do not interrupt an operation in flight');
});

test('sellrun: DUM\'s own ownership does NOT block the trip', () => {
  // The regression that made the circuit fire once and never again: DUM claims every character
  // it manages, so the row is `committed` — but a takeable `bot` claim is ownership, not an
  // operation, and is exactly who the sell trip is for. Must NOT be skipped like a busy one.
  const owned = heavy('a', {
    commitment: { kind: 'bot', takeable: true, label: 'dum is steering',
                  detail: 'Not an operation — nothing is mid-flight' },
  });
  const intent = rule.decide(fleetObs([owned]), doctrineWith());
  eq(intent?.orders?.errand, 'sellrun-circuit', 'a character DUM owns still gets the circuit');
});

test('sellrun: a run inside the cooldown is skipped', () => {
  // memory arrives keyed by TOPIC first — obs.memory.sellrun[agent] — the same shape recordSellrun writes.
  const mem = { sellrun: { a: { last_run_at: NOW - 60_000 } } };
  eq(rule.decide(fleetObs([heavy('a')], mem), doctrineWith()), null, 'went a minute ago; not again');
});

// ---------------------------------------------------------------- registration + record

test('sellrun: the errand is registered and reachable through the real fleet table', () => {
  ok(ERRANDS['sellrun-circuit'], 'runErrand would otherwise throw on an unregistered kind');
  const { intent } = decide(fleetRules, fleetObs([heavy('a')]), doctrineWith());
  eq(intent?.orders?.errand, 'sellrun-circuit', 'the rule fires in the assembled table, gated on');
});

test('sellrun: the record keyed by agent is what the window reads back', () => {
  const { patch } = recordSellrun({ agent: 'a', at: NOW });
  eq(patch.a.last_run_at, NOW, 'writes when this character last ran');
  // and the window closes on exactly that fact
  eq(sellrunWindow(patch, 'a', NOW + 60_000, 20 * 60_000).ready, false, 'just ran, so not yet');
});

test('sellrun: a completed run cools down fully; a failed one retries after the backoff', () => {
  const ok = recordSellrun({ agent: 'a', at: NOW }).patch;                                    // completed
  const bad = recordSellrun({ agent: 'a', at: NOW, stopped: 'travel did not arrive' }).patch; // failed
  eq(ok.a.ok, true, 'a run with no stop reason completed');
  eq(bad.a.ok, false, 'a run with a stop reason failed');
  const COOL = 20 * 60_000, BACK = 5 * 60_000;
  // Six minutes on: past the 5m fail-backoff but well inside the 20m cooldown.
  eq(sellrunWindow(bad, 'a', NOW + 6 * 60_000, COOL, BACK).ready, true, 'a failed run retries after the backoff');
  eq(sellrunWindow(ok,  'a', NOW + 6 * 60_000, COOL, BACK).ready, false, 'a completed run is still cooling down');
});
