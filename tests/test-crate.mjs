// THE CRATE UNDER CASTLE VICTORIA — offline, no broker, no server, no clock.
//
// Every one of these is a fixture and an injected `now`, which is only possible because
// the rule is pure and the past arrives in the observation. That property is the reason
// the timing half can be tested at all: the window it turns on is eight hours wide and
// nothing in the world reports it.
//
// What is pinned here, in order of how expensive being wrong would be:
//
//   * the last finder is never sent — the server refuses it in SILENCE, so getting this
//     wrong produces a fleet that checks for ever and never collects again;
//   * the cooling window is respected — inside it the counter cannot be negative, so
//     every trip is guaranteed to pay nothing;
//   * an unknown history means GO, not stay — losing the memory file must cost one walk
//     rather than the feature;
//   * a check that reached nothing is distinguishable from a check that missed;
//   * the surface still refuses every `act` verb except `go`.

const test = globalThis.__dumTest;

import { crateFleetRules, crateWindow, eligibleCheckers, readCrateTranscript,
         recordCrateCheck, EARLIEST_MS, LATEST_MS, GAME_HOUR_MS } from '../src/decide/rules/crate.mjs';
import { decide } from '../src/decide/engine.mjs';
import { fleetRules } from '../src/decide/index.mjs';
import { deny } from '../src/link/surface.mjs';
import { loadDoctrine } from '../src/config/load.mjs';
import { runErrand, readErrand, estimateFor } from '../src/act/errands.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const NOW = 1_700_000_000_000;

/** A character standing in Castle Victoria, healthy, big enough for the PK gate. */
const inCastle = (agent, over = {}) => ({
  agent, character: agent.toUpperCase(), in_game: true,
  level: 50, max_health: 50,
  health: { value: 50, max: 50, pct: 1 },
  room: 38, room_name: 'Castle Victoria',
  commitment: null, stalled: null, parked: null,
  ...over,
});

const fleetObs = (rows, memory = {}, at = NOW) => ({
  at, source: 'fleet', characters: rows, in_game: rows.length, stalled: 0, parking: 0,
  memory, depth: 'board',
});

/** The doctrine as a doctrine actually arrives — layered over the real defaults. */
const doctrineWith = (crate = {}) => loadDoctrine({
  file: null,
  overrides: {
    'fleet': 'test-fleet',
    'claim.work': 'bot',
    'crate.check': true,
    ...Object.fromEntries(Object.entries(crate).map(([k, v]) => [`crate.${k}`, v])),
  },
}).config;

// ---------------------------------------------------------------- the window

test('crate: nothing remembered means go and look', () => {
  const w = crateWindow({}, NOW, 30 * 60_000);
  eq(w.ready, true, 'an unknown history is a reason to check');
  eq(w.state, 'unknown', 'state');
  // The direction matters more than the value: losing var/memory must cost one walk,
  // not the whole behaviour, and it must never be silently reinterpreted as "recent".
  ok(/may already be below zero/.test(w.why), 'says why');
});

test('crate: inside the cooling window it refuses, and the refusal is arithmetic', () => {
  // The counter resets to 50..150 game hours and the payout test is `< 0`, so 51 hours
  // is the soonest it can pay. Anything inside that is a guaranteed empty trip.
  const w = crateWindow({ last_find: NOW - (40 * GAME_HOUR_MS), last_check: NOW - 3_600_000 },
                        NOW, 30 * 60_000);
  eq(w.ready, false, 'must not send anyone');
  eq(w.state, 'cooling', 'state');
  ok(/at least 51 game hours/.test(w.why), 'cites the reset floor');
});

test('crate: just past the floor it is worth a look, and past the ceiling it is overdue', () => {
  const near = crateWindow({ last_find: NOW - EARLIEST_MS - 1 }, NOW, 30 * 60_000);
  eq(near.ready, true, 'past 51 game hours the counter may be negative');
  eq(near.state, 'possible', 'state');

  const old = crateWindow({ last_find: NOW - LATEST_MS - 1 }, NOW, 30 * 60_000);
  eq(old.ready, true, 'past the ceiling');
  eq(old.state, 'overdue', 'state');
  // Overdue is NOT certainty. Another player's find resets a clock we cannot see, which
  // is exactly why this stays a probe rather than becoming a promise.
  ok(/another player reset the clock/.test(old.why), 'is honest about the shared server');
});

test('crate: the probe interval beats everything, because the fleet tick is five minutes', () => {
  // Window wide open, checked four minutes ago. Without this the rule fires on every
  // fleet tick and the character lives in the basement.
  const w = crateWindow({ last_find: NOW - LATEST_MS - 1, last_check: NOW - 4 * 60_000 },
                        NOW, 30 * 60_000);
  eq(w.ready, false, 'a recent check suppresses the next one');
  eq(w.state, 'just-checked', 'state');
});

// ---------------------------------------------------------------- who goes

test('crate: the last finder is never sent — the server refuses it in silence', () => {
  const rows = [inCastle('role-a'), inCastle('role-b')];
  const got = eligibleCheckers(rows, { last_finder: 'role-a' });
  eq(got.length, 1, 'one eligible');
  eq(got[0].agent, 'role-b', 'not the one poLastFinder holds');
});

test('crate: under 30 max health is excluded, because the room does not answer at all', () => {
  const rows = [inCastle('small', { level: 29, max_health: 29 }), inCastle('big')];
  const got = eligibleCheckers(rows, {});
  eq(got.length, 1, 'only the one past PKILL_ENABLE_HP');
  eq(got[0].agent, 'big', 'which one');
});

test('crate: hurt and committed characters are left alone', () => {
  const rows = [
    inCastle('hurt', { health: { value: 20, max: 50, pct: 0.4 } }),
    inCastle('busy', { commitment: { kind: 'errand', label: 'loot run' } }),
    // Even `partner`, which every other rule in DUM treats as the weak kind: this one
    // walks the character out of the room its partner is standing in.
    inCastle('paired', { commitment: { kind: 'partner' } }),
    inCastle('free'),
  ];
  const got = eligibleCheckers(rows, {});
  eq(got.map(r => r.agent).join(','), 'free', 'only the unencumbered one');
});

test('crate: a row with no health reading is not eligible, because the floor means having looked', () => {
  const rows = [inCastle('unknown', { health: { value: null, max: null, pct: null } })];
  eq(eligibleCheckers(rows, {}).length, 0, 'null is not "fine"');
});

test('crate: the order is by turns, so the fleet rotates through the lockout on its own', () => {
  const rows = [inCastle('been-recently'), inCastle('been-a-while'), inCastle('never-been')];
  const got = eligibleCheckers(rows, {
    checked_by: { 'been-recently': NOW - 60_000, 'been-a-while': NOW - 86_400_000 },
  });
  eq(got.map(r => r.agent).join(','), 'never-been,been-a-while,been-recently', 'oldest first, never-been first of all');
});

// ---------------------------------------------------------------- the rule

test('crate: one character in the castle is not enough, and it says so rather than going quiet', () => {
  const { intent, considered } = decide(fleetRules, fleetObs([inCastle('alone')]), doctrineWith());
  eq(intent, null, 'nobody is sent');
  const v = considered.find(x => x.rule === 'crate-check');
  eq(v.verdict, 'no', 'declined');
  ok(/refuses whoever found last/.test(v.why), `the reason survives: ${v.why}`);
});

test('crate: ON by default, because the trip is nearly free from inside the castle', () => {
  // Changed deliberately: this used to assert the opposite. The expected value is poor
  // and unchanged — what makes it worth having is that it fires ONLY when the fleet is
  // already at Castle Victoria, and does nothing at all to a fleet hunting elsewhere.
  const plain = loadDoctrine({ file: null, overrides: { 'fleet': 'f', 'claim.work': 'bot' } }).config;
  eq(plain.crate.check, true, 'on in the defaults');
  eq(plain.crate.quorum, 3, 'and three is the working number, not the mechanic floor of two');
  ok(plain.crate.zone.includes(2), 'Outside Castle Victoria counts');
  const { considered } = decide(fleetRules, fleetObs([inCastle('a'), inCastle('b')]), plain);
  const v = considered.find(x => x.rule === 'crate-check');
  eq(v.verdict, 'no', 'and it runs — declining here only because two is short of the quorum');
});

test('crate: the null doctrine turns it back off, because a control that acts is not a control', () => {
  const { config } = loadDoctrine({ file: 'doctrines/survive.jsonc' });
  eq(config.crate.check, false, 'survive.jsonc overrides the default');
});

test('crate: a quorum in the castle and an open window produces the errand, in order', () => {
  const obs = fleetObs([inCastle('role-a'), inCastle('role-b'), inCastle('role-c')],
                       { crate: { last_finder: 'role-a' } });
  const { intent } = decide(fleetRules, obs, doctrineWith());
  ok(intent, 'fired');
  eq(intent.kind, 'errand', 'not a policy write');
  eq(intent.agent, 'role-b', 'the one the room has not just refused');
  eq(intent.orders.errand, 'crate-check', 'errand kind');

  const steps = intent.orders.steps;
  eq(steps.map(s => s.tool).join(','), 'travel,walk_to,act,travel', 'there, onto the square, go, back');
  eq(steps[0].args.to, 41, 'the Underbasement');
  // walk_to takes col first. The kod says row 10, col 6, and transposing them lands on a
  // real square that does nothing at all.
  eq(steps[1].args.col, 6, 'col');
  eq(steps[1].args.row, 10, 'row');
  eq(steps[1].expect, 'arrived', 'the go must not run unless the walk arrived');
  eq(steps[2].args.verb, 'go', 'BP_REQ_GO is the mechanic');
  eq(steps[3].args.to, 38, 'back to where it was hunting');
  eq(steps[3].always, true, 'the return leg runs even after a failure');
});

test('crate: a quorum with nobody eligible reports why instead of looking like success', () => {
  // Both in the castle, one is the last finder and one is too small. The window is open.
  const obs = fleetObs([inCastle('role-a'), inCastle('tiny', { level: 20, max_health: 20 }),
                        inCastle('alsotiny', { level: 21, max_health: 21 })],
                       { crate: { last_finder: 'role-a' } });
  const { intent, considered } = decide(fleetRules, obs, doctrineWith());
  eq(intent, null, 'nobody goes');
  const v = considered.find(x => x.rule === 'crate-check');
  ok(/found last and is refused/.test(v.why), `names the lockout: ${v.why}`);
});

test('crate: declining does not consume the fleet tick — the rules below it still run', () => {
  // `kind: 'pass'` exists for exactly this. A `none` intent would have stopped the table
  // and quietly disabled pairing for as long as the crate was cooling.
  const obs = fleetObs([inCastle('role-a'), inCastle('role-b'), inCastle('role-c')],
                       { crate: { last_find: NOW - 1000 } });
  const d = doctrineWith();
  d.party.pair = true;
  const { intent, considered } = decide(fleetRules, obs, d);
  eq(considered.find(x => x.rule === 'crate-check').verdict, 'no', 'crate declined');
  ok(intent && intent.rule === 'pair-the-unpaired', 'and pairing still got its turn');
});

// ---------------------------------------------------------------- reading it back

test('crate: a find, a miss and a silence are three different outcomes', () => {
  const found = readCrateTranscript(['You rummage around in an open crate.',
                                     'You find something of interest!']);
  ok(found.reached && found.found, 'found');

  const miss = readCrateTranscript(['You rummage around in an open crate.']);
  ok(miss.reached && !miss.found, 'reached the crate, counter was not below zero');

  // The one that matters: on the wire this is IDENTICAL to a miss. Both are silence.
  const nothing = readCrateTranscript([]);
  eq(nothing.reached, false, 'never reached the mechanic');
  ok(/under 30 base max health/.test(nothing.why), 'names the likeliest cause');
});

test('crate: a miss moves the check clock and touches nothing it has no evidence for', () => {
  const { patch } = recordCrateCheck({
    agent: 'role-b', at: NOW, transcript: ['You rummage around in an open crate.'],
    was: { last_find: 123, last_finder: 'role-a', checked_by: { 'role-a': 1 } },
  });
  eq(patch.last_check, NOW, 'the probe interval advances');
  eq(patch.last_find, undefined, 'a miss says nothing about the server counter');
  eq(patch.last_finder, undefined, 'and nothing about who is locked out');
  eq(patch.checked_by['role-a'], 1, 'the other characters keep their timestamps');
  eq(patch.checked_by['role-b'], NOW, 'and this one is recorded');
});

test('crate: a find moves the lockout onto the character that got it', () => {
  const { patch, read } = recordCrateCheck({
    agent: 'role-b', at: NOW,
    transcript: ['You rummage around in an open crate.', 'You find something of interest!'],
    was: { last_finder: 'role-a' },
  });
  ok(read.found, 'read as a find');
  eq(patch.last_find, NOW, 'the room timer just reset');
  eq(patch.last_finder, 'role-b', 'and this one is now the one it will refuse');
});

// ---------------------------------------------------------------- the write path

test('crate: an errand announces itself busy before walking, and frees the character after', async () => {
  // THE HALF THAT IS ABOUT THE OTHER PROCESSES. An errand makes a character look stalled
  // to everything watching it — the keeper is inert by design, and `ms_since_moved`
  // measures the keeper — so without this the harness's own supervisor restarts the
  // keeper mid-errand and both logs report success.
  const seen = [];
  const broker = {
    call: async (tool, args) => {
      if (tool === 'autopilot') { seen.push(args.action); return {}; }
      return tool === 'act' ? { messages: ['You rummage around in an open crate.'] } : { arrived: true };
    },
    write: async () => ({ dry_run: true }),
  };
  const intent = { rule: 'crate-check', kind: 'errand', why: 'x', orders: {
    errand: 'crate-check', agent: 'role-b', steps: [
      { tool: 'travel', args: { agent: 'role-b', to: 41 }, expect: 'arrived' },
      { tool: 'act', args: { agent: 'role-b', verb: 'go' }, collect: 'messages' },
    ] } };
  await runErrand(broker, intent, { commit: true, holder: 'dum/test@pid-1' });
  // busy, then an EXTENSION before the second step, then free. See estimateFor().
  eq(seen.join(','), 'busy,busy,free', 'announced, extended as it went, then handed back');
});

test('crate: the busy window is an ESTIMATE, padded, and it shrinks as the errand runs', async () => {
  // THE FIX FOR "THE SUPERVISOR BUTTS IN MID-ERRAND". A flat lease is wrong in both
  // directions: too short and a supervisor round walks in halfway through a trip across
  // the world, too long and a thirty-second errand blocks the unstick round for ten
  // minutes. So the errand asks for what its REMAINING steps expect, doubled.
  const leases = [];
  const broker = {
    call: async (tool, args) => {
      if (tool === 'autopilot' && args.action === 'busy') leases.push(args.lease_ms);
      return tool === 'act' ? { messages: [] } : { arrived: true };
    },
    write: async () => ({ dry_run: true }),
  };
  const steps = [
    { tool: 'travel', args: { agent: 'a', to: 41 }, estimate_ms: 90_000, expect: 'arrived' },
    { tool: 'walk_to', args: { agent: 'a', col: 6, row: 10 }, estimate_ms: 30_000, expect: 'arrived' },
    { tool: 'act', args: { agent: 'a', verb: 'go' }, estimate_ms: 5_000, collect: 'messages' },
    { tool: 'travel', args: { agent: 'a', to: 38 }, estimate_ms: 90_000, always: true },
  ];
  eq(estimateFor(steps), 430_000, 'the whole errand, doubled');
  eq(estimateFor([{ tool: 'act', estimate_ms: 1_000 }]), 90_000,
     'and floored, because a leg that goes SLIGHTLY wrong is the ordinary case and is ' +
     'exactly when being interrupted costs the errand');

  await runErrand(broker, { rule: 'crate-check', kind: 'errand', why: 'x',
                            orders: { errand: 'crate-check', agent: 'a', steps } },
                  { commit: true, holder: 'dum/test@pid-1' });

  ok(leases.length >= 2, `asked more than once: ${leases.join(',')}`);
  eq(leases[0], 430_000, 'the first ask covers the whole errand');
  // EACH LATER ASK IS SMALLER, which is what releases the character early instead of
  // holding a window it stopped needing.
  ok(leases.every((v, i) => i === 0 || v <= leases[i - 1]),
     `each extension asks for less than the last: ${leases.join(',')}`);
});

test('crate: the character is freed even when a step failed', async () => {
  // The lease heals a forgotten `busy`, but "heals in ten minutes" is ten minutes of a
  // genuinely stuck character that every stall detector politely steps over.
  const seen = [];
  const broker = {
    call: async (tool, args) => {
      if (tool === 'autopilot') { seen.push(args.action); return {}; }
      return { arrived: false, reason: 'no route' };
    },
    write: async () => ({ dry_run: true }),
  };
  const intent = { rule: 'crate-check', kind: 'errand', why: 'x', orders: {
    errand: 'crate-check', agent: 'role-b', steps: [
      { tool: 'travel', args: { agent: 'role-b', to: 41 }, expect: 'arrived' },
    ] } };
  const applied = await runErrand(broker, intent, { commit: true, holder: 'dum/test@pid-1' });
  ok(applied.stopped, 'the errand failed');
  eq(seen.includes('free'), true, 'and the character was still handed back');
});

test('crate: a dry run announces nothing — a plan must not change what the fleet believes', async () => {
  const seen = [];
  const broker = {
    call: async (tool, args) => { seen.push(`${tool}:${args.action ?? ''}`); return {}; },
    write: async () => ({ dry_run: true }),
  };
  const intent = { rule: 'crate-check', kind: 'errand', why: 'x', orders: {
    errand: 'crate-check', agent: 'a', steps: [{ tool: 'travel', args: { agent: 'a', to: 41 } }] } };
  await runErrand(broker, intent, { commit: false, holder: 'dum/test@pid-1' });
  eq(seen.length, 0, 'nothing was sent, including the busy marker');
});

test('crate: the errand runs in order and stops when a step did not arrive', async () => {
  const calls = [];
  const broker = {
    call: async (tool, args) => {
      calls.push(tool);
      if (tool === 'travel' && args.to === 41) return { arrived: true };
      if (tool === 'walk_to') return { arrived: false, reason: 'no route through the geometry' };
      if (tool === 'travel') return { arrived: true };
      return {};
    },
    write: async () => ({ dry_run: true }),
  };
  const intent = { rule: 'crate-check', kind: 'errand', why: 'x', orders: {
    errand: 'crate-check', agent: 'role-b', steps: [
      { tool: 'travel', args: { agent: 'role-b', to: 41 }, expect: 'arrived' },
      { tool: 'walk_to', args: { agent: 'role-b', col: 6, row: 10 }, expect: 'arrived' },
      { tool: 'act', args: { agent: 'role-b', verb: 'go' }, collect: 'messages' },
      { tool: 'travel', args: { agent: 'role-b', to: 38 }, always: true },
    ] } };
  const applied = await runErrand(broker, intent, { commit: true });
  // A `go` after a failed walk is not a weaker check, it is a different action somewhere
  // else — and on an exit square it takes the exit.
  ok(!calls.includes('act'), 'the go was not sent after the walk failed');
  eq(calls.filter(t => t === 'travel').length, 2, 'but the return leg still ran');
  ok(/did not arrive/.test(applied.stopped), 'and it says what stopped it');
});

test('crate: a dry run describes every step and sends nothing', async () => {
  const sent = [], described = [];
  const broker = {
    call: async t => { sent.push(t); return {}; },
    write: async t => { described.push(t); return { dry_run: true }; },
  };
  const intent = { rule: 'crate-check', kind: 'errand', why: 'x', orders: {
    errand: 'crate-check', agent: 'a', steps: [
      { tool: 'travel', args: { agent: 'a', to: 41 }, expect: 'arrived' },
      { tool: 'act', args: { agent: 'a', verb: 'go' }, collect: 'messages' },
    ] } };
  const applied = await runErrand(broker, intent, { commit: false });
  eq(sent.length, 0, 'nothing was sent');
  eq(described.length, 2, 'both steps described');
  eq(applied.acted, false, 'and it does not claim to have acted');
  // A plan describes the walk it would take. It must not invent what the crate would
  // have said — which is why nothing is collected and nothing is remembered.
  eq(readErrand(applied, { at: NOW, memory: {} }), null, 'a dry run remembers nothing');
});

test('crate: the interpreter takes its topic from the registry, not from the caller', async () => {
  const broker = {
    call: async (tool) => tool === 'act'
      ? { messages: ['You rummage around in an open crate.', 'You find something of interest!'] }
      : { arrived: true },
    write: async () => ({ dry_run: true }),
  };
  const intent = { rule: 'crate-check', kind: 'errand', why: 'x', orders: {
    errand: 'crate-check', agent: 'role-b', steps: [
      { tool: 'act', args: { agent: 'role-b', verb: 'go' }, collect: 'messages' },
    ] } };
  const applied = await runErrand(broker, intent, { commit: true });
  const learned = readErrand(applied, { at: NOW, memory: { crate: { checked_by: { 'role-a': 1 } } } });
  eq(learned.topic, 'crate', 'filed under the errand kind\'s own topic');
  eq(learned.patch.last_finder, 'role-b', 'the find moved the lockout');
  eq(learned.patch.checked_by['role-a'], 1, 'and the pre-errand snapshot was merged, not replaced');
});

test('crate: an errand kind nothing can interpret is refused rather than walked', async () => {
  let threw = null;
  try {
    await runErrand({}, { rule: 'x', kind: 'errand', orders: { errand: 'invented', steps: [] } }, {});
  } catch (e) { threw = e.message; }
  ok(threw && /not in ERRANDS/.test(threw), `loud: ${threw}`);
});

// ---------------------------------------------------------------- the surface

test('crate: act is allowed for go and refused for everything that reaches into the pack', () => {
  eq(deny('act', { verb: 'go' }), null, 'go acts on the square underfoot');
  for (const verb of ['use', 'unuse', 'get', 'drop', 'activate', 'eat']) {
    ok(deny('act', { verb }), `${verb} must be refused`);
    ok(/reaches into the character's pack/.test(deny('act', { verb })), `${verb} says why`);
  }
  ok(deny('act', {}), 'and a call with no verb at all is refused');
});

// ---------------------------------------------------------------- the doctrine

/** loadDoctrine REFUSES rather than warns, which is the behaviour being pinned. */
const refusal = overrides => {
  try {
    loadDoctrine({ file: null, overrides: { fleet: 'f', 'claim.work': 'bot',
                                            'crate.check': true, ...overrides } });
  } catch (e) { return e.message; }
  return null;
};

test('crate: a quorum of one will not load, because it is a mechanic and not a taste', () => {
  const why = refusal({ 'crate.quorum': 1 });
  ok(why && /crate.quorum/.test(why), `refused: ${why}`);
  // A doctrine that is subtly wrong and runs anyway is the failure schema.mjs exists for:
  // a quorum of 1 collects exactly one item and then reports normal misses for ever.
  ok(/refuses whoever found last/.test(why), 'and the refusal explains the mechanic');
});

test('crate: a min_level under 30 will not load, because the room answers such a character with nothing', () => {
  const why = refusal({ 'crate.min_level': 20 });
  ok(why && /crate.min_level/.test(why), `refused: ${why}`);
  ok(/PFLAG_PKILL_ENABLE/.test(why), 'and cites the gate it would be walking into');
});

test('crate: a transposed square will not load — walk_to takes col first', () => {
  const why = refusal({ 'crate.square': { col: 6 } });
  ok(why && /crate.square/.test(why), `refused: ${why}`);
});
