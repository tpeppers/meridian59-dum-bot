// SUPERVISORS: the registry's pure rules, the gate, the schema, and the base class.
//
// Offline. git, pid checks, the clock and the launcher are all injected; the base-class
// tests stand up a fake broker on an ephemeral 127.0.0.1 port that this file owns. Nothing
// here talks to a real broker or starts a real supervisor.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { isRunning, readHeartbeat, pinSatisfied, ensureSupervisors, resolveEntry, heartbeatFile,
         stopFile, START_BACKOFF_MS, OPTIONAL_WARN_MS, DUM_ROOT } from '../src/supervise/registry.mjs';
import { SupervisorWatch } from '../src/supervise/watch.mjs';
import { Supervisor } from '../src/supervise/base.mjs';
import { describeSupervisors } from '../src/supervise/cli.mjs';
import { supervisorGate, withheldTargets } from '../src/decide/supervisors.mjs';
import { shiftFleetRules } from '../src/decide/rules/shift.mjs';
import { ladderRules } from '../src/decide/rules/ladder.mjs';
import { loadDoctrine } from '../src/config/load.mjs';
import { validate } from '../src/config/schema.mjs';
import { freshDefaults } from '../src/config/defaults.mjs';

const test = globalThis.__dumTest;
const tmp = () => mkdtempSync(join(tmpdir(), 'dum-sup-'));
const T0 = Date.parse('2026-11-12T12:00:00Z');
const iso = ms => new Date(ms).toISOString();

// ------------------------------------------------------------------ a fake git
//
// commits: {sha: {parent, files: {path: content}}}; work: {path: content}; head: sha.
const REPO = resolve('/fake/repo');
function fakeGit({ commits, head, work, refs = {} }) {
  const isAnc = (a, b) => { for (let c = b; c; c = commits[c]?.parent) if (c === a) return true; return false; };
  const resolveRev = r => { const x = refs[r] ?? r; return x === 'HEAD' ? head : (commits[x] ? x : null); };
  const calls = [];
  const git = (args, cwd) => {
    calls.push(args.join(' '));
    const [cmd, ...rest] = args;
    if (cmd === 'rev-parse' && rest[0] === '--show-toplevel') return { code: 0, stdout: REPO };
    if (cmd === 'rev-parse' && rest[0] === 'HEAD') return { code: 0, stdout: head };
    if (cmd === 'rev-parse' && rest[0] === '--verify') {
      const sha = resolveRev(rest.at(-1).replace(/\^\{commit\}$/, ''));
      return sha ? { code: 0, stdout: sha } : { code: 1, stdout: '' };
    }
    if (cmd === 'merge-base') return { code: isAnc(rest[1], rest[2]) ? 0 : 1, stdout: '' };
    if (cmd === 'diff') {
      const rev = resolveRev(rest[1]);
      const paths = rest.slice(rest.indexOf('--') + 1);
      const same = paths.every(p => (commits[rev]?.files?.[p] ?? null) === (work[p] ?? null));
      return { code: same ? 0 : 1, stdout: '' };
    }
    if (cmd === 'ls-files') return { code: 0, stdout: '' };
    if (cmd === 'status') {
      const paths = rest.slice(rest.indexOf('--') + 1);
      return { code: 0, stdout: paths.filter(p => work[p] != null && commits[head]?.files?.[p] == null)
        .map(p => `?? ${p}`).join('\n') };
    }
    return { code: 1, stdout: '' };
  };
  git.calls = calls;
  return git;
}
// A <- B <- C, where B changed the entry file and C changed only something else.
const HISTORY = {
  A: { parent: null, files: { 'sup.mjs': 'v1', 'lib.mjs': 'l1' } },
  B: { parent: 'A', files: { 'sup.mjs': 'v2', 'lib.mjs': 'l1' } },
  C: { parent: 'B', files: { 'sup.mjs': 'v2', 'lib.mjs': 'l2' } },
};
const gitAt = (head, work = HISTORY[head].files) => fakeGit({ commits: HISTORY, head, work: { ...work } });
const ENTRY = join(REPO, 'sup.mjs');

// ------------------------------------------------------------------ heartbeats

test('supervise: running means a live pid AND a heartbeat under 60s', () => {
  const hb = { pid: 42, heartbeat_at: iso(T0 - 10_000), status: 'running' };
  assert.equal(isRunning(hb, { now: T0, pidAlive: () => true }), true);
  assert.equal(isRunning(hb, { now: T0, pidAlive: () => false }), false, 'dead pid');
  assert.equal(isRunning({ ...hb, heartbeat_at: iso(T0 - 61_000) }, { now: T0, pidAlive: () => true }), false, 'stale');
  assert.equal(isRunning({ ...hb, status: 'stopped' }, { now: T0, pidAlive: () => true }), false, 'stopped');
  assert.equal(isRunning(null, { now: T0, pidAlive: () => true }), false, 'missing');
});

test('supervise: readHeartbeat tolerates a BOM and refuses junk', () => {
  const d = tmp();
  writeFileSync(heartbeatFile(d, 'x'), '\uFEFF' + JSON.stringify({ schema: 1, id: 'x', pid: 1 }));
  assert.equal(readHeartbeat(d, 'x').id, 'x');
  writeFileSync(heartbeatFile(d, 'y'), '{nope');
  assert.equal(readHeartbeat(d, 'y'), null);
  assert.equal(readHeartbeat(d, 'z'), null);
});

// ------------------------------------------------------------------ pins

test('supervise: exact pin — at the pin, or the entry byte-identical to it', () => {
  assert.equal(pinSatisfied({ repo: REPO, entry: ENTRY, pin: 'B', pinMode: 'exact' }, gitAt('B')).ok, true);
  // C changed only lib.mjs, so sup.mjs is identical to B and the exact pin still holds...
  assert.equal(pinSatisfied({ repo: REPO, entry: ENTRY, pin: 'B', pinMode: 'exact' }, gitAt('C')).ok, true);
  // ...unless lib.mjs is pinned too.
  assert.equal(pinSatisfied({ repo: REPO, entry: ENTRY, pin: 'B', pinMode: 'exact', pinPaths: ['lib.mjs'] },
    gitAt('C')).ok, false);
  // A edits the entry: refused.
  assert.equal(pinSatisfied({ repo: REPO, entry: ENTRY, pin: 'B', pinMode: 'exact' }, gitAt('A')).ok, false);
  // At the pin but with a dirty entry: refused.
  assert.equal(pinSatisfied({ repo: REPO, entry: ENTRY, pin: 'B', pinMode: 'exact' },
    gitAt('B', { 'sup.mjs': 'hacked', 'lib.mjs': 'l1' })).ok, false);
});

test('supervise: at_least pin — the pin is an ancestor and the paths are clean', () => {
  const p = (head, work, pin = 'B') => pinSatisfied({ repo: REPO, entry: ENTRY, pin, pinMode: 'at_least' }, gitAt(head, work));
  assert.equal(p('B').ok, true);
  assert.equal(p('C').ok, true, 'newer');
  assert.equal(p('A').ok, false, 'older');
  assert.equal(p('C', { 'sup.mjs': 'hacked', 'lib.mjs': 'l2' }).ok, false, 'dirty');
  assert.equal(pinSatisfied({ repo: REPO, entry: join(REPO, 'new.mjs'), pin: 'B', pinMode: 'at_least' },
    gitAt('C', { ...HISTORY.C.files, 'new.mjs': 'x' })).ok, false, 'an untracked entry is not clean');
  const unknown = p('C', undefined, 'nope');
  assert.equal(unknown.ok, false);
  assert.match(unknown.why, /not a commit/);
  // A RUNNING supervisor is judged by the commit its heartbeat reports, not the tree's HEAD.
  assert.equal(pinSatisfied({ repo: REPO, entry: ENTRY, pin: 'B', pinMode: 'at_least', head: 'A' },
    fakeGit({ commits: HISTORY, head: 'C', work: HISTORY.A.files })).ok, false);
});

test('supervise: entries resolve through named roots, never a drive letter', () => {
  assert.equal(resolveEntry('private:sup/x.mjs', { private: '/p' }), resolve('/p', 'sup/x.mjs'));
  assert.equal(resolveEntry('dum:supervisors/x.mjs', {}), resolve(DUM_ROOT, 'supervisors/x.mjs'));
  assert.equal(resolveEntry('supervisors/x.mjs', {}), resolve(DUM_ROOT, 'supervisors/x.mjs'));
  assert.throws(() => resolveEntry('nowhere:x.mjs', {}), /not configured/);
  if (process.platform === 'win32') assert.equal(resolveEntry('C:\\x\\y.mjs', {}), resolve('C:\\x\\y.mjs'));
});

// ------------------------------------------------------------------ ensureSupervisors

const specOf = (defs, extra = {}) => ({ fleet: 'f', supervisor_state_dir: '/state', supervisors: defs, ...extra });
const MUST = { need: 'must', entry: ENTRY, repo: REPO, pin: 'B', pin_mode: 'at_least' };
function harness({ head = 'C', work, hb = {}, alive = new Set() } = {}) {
  const started = [], logs = [], stops = [];
  return {
    started, logs, stops, alive, hb, memo: {},
    deps(now, over = {}) {
      return { now, git: gitAt(head, work), pidAlive: pid => alive.has(pid), memo: this.memo,
        readHeartbeat: (_d, id) => hb[id] ?? null, log: e => logs.push(e), stop: (_d, id) => stops.push(id),
        start: def => { started.push(def.id); const pid = 1000 + started.length; alive.add(pid); return { ok: true, pid }; },
        ...over };
    },
  };
}

test('supervise: a down `must` is pin-checked, started, and not started twice inside the backoff', () => {
  const h = harness();
  const [r1] = ensureSupervisors(specOf({ s: MUST }), h.deps(T0));
  assert.equal(r1.state, 'started');
  assert.deepEqual(h.started, ['s']);
  const [r2] = ensureSupervisors(specOf({ s: MUST }), h.deps(T0 + 20_000));
  assert.equal(r2.state, 'started', 'still alive, no heartbeat yet');
  assert.deepEqual(h.started, ['s'], 'no second launch inside the backoff');
  // It died without ever heartbeating; after the backoff it is launched again.
  h.alive.clear();
  const [r3] = ensureSupervisors(specOf({ s: MUST }), h.deps(T0 + 30_000));
  assert.equal(r3.state, 'missing');
  assert.match(r3.why, /backing off/);
  const [r4] = ensureSupervisors(specOf({ s: MUST }), h.deps(T0 + START_BACKOFF_MS + 1));
  assert.equal(r4.state, 'started');
  assert.deepEqual(h.started, ['s', 's']);
});

test('supervise: a stale heartbeat from another checkout does not decide where the next start is pinned', () => {
  // 2026-11-13: the supervisor moved to a clean worktree. The OLD process's card still named the old checkout (at A,
  // below the pin); the new entry's repo is at C. The start must be judged by the entry it will launch.
  const OLD = resolve('/old/checkout');
  const atOld = gitAt('A'), atNew = gitAt('C');
  const git = (args, cwd) => (resolve(cwd ?? '') === OLD ? atOld : atNew)(args, cwd);
  const h = harness({ hb: { s: { schema: 1, id: 's', pid: 7, status: 'stopped', heartbeat_at: iso(T0 - 600_000),
    repo: OLD, entry: join(OLD, 'sup.mjs'), commit: 'A' } } });
  const [r] = ensureSupervisors(specOf({ s: MUST }), h.deps(T0, { git }));
  assert.equal(r.state, 'started', r.why);
  assert.deepEqual(h.started, ['s']);
});

test('supervise: a `must` whose tree fails the pin is not started', () => {
  const h = harness({ head: 'A' });
  const [r] = ensureSupervisors(specOf({ s: MUST }), h.deps(T0));
  assert.equal(r.state, 'pin_mismatch');
  assert.deepEqual(h.started, []);
});

test('supervise: a failed start is start_failed and still backs off', () => {
  const h = harness();
  let n = 0;
  const failing = () => { n++; return { ok: false, why: 'boom' }; };
  assert.equal(ensureSupervisors(specOf({ s: MUST }), h.deps(T0, { start: failing }))[0].state, 'start_failed');
  assert.equal(ensureSupervisors(specOf({ s: MUST }), h.deps(T0 + 5000, { start: failing }))[0].state, 'start_failed');
  assert.equal(n, 1);
});

test('supervise: an optional supervisor never starts, and warns once per ten minutes', () => {
  const h = harness();
  const spec = specOf({ o: { need: 'optional', entry: ENTRY, repo: REPO } });
  for (const t of [T0, T0 + 60_000, T0 + 5 * 60_000]) assert.equal(ensureSupervisors(spec, h.deps(t))[0].state, 'missing');
  assert.deepEqual(h.started, []);
  assert.equal(h.logs.filter(e => e.kind === 'supervisor_warning').length, 1);
  ensureSupervisors(spec, h.deps(T0 + OPTIONAL_WARN_MS + 1));
  assert.equal(h.logs.filter(e => e.kind === 'supervisor_warning').length, 2);
  // ...unless it says start: true.
  ensureSupervisors(specOf({ o: { need: 'optional', entry: ENTRY, repo: REPO, start: true } }), h.deps(T0));
  assert.deepEqual(h.started, ['o']);
});

test('supervise: plan mode (allowStart false) and `enabled: false` start nothing', () => {
  const h = harness();
  assert.equal(ensureSupervisors(specOf({ s: MUST }), h.deps(T0, { allowStart: false }))[0].state, 'missing');
  assert.equal(ensureSupervisors(specOf({ s: { ...MUST, enabled: false } }), h.deps(T0))[0].state, 'disabled');
  assert.deepEqual(h.started, []);
});

test('supervise: running at a refused commit warns, and restarts only when asked', () => {
  const hb = { s: { pid: 7, heartbeat_at: iso(T0 - 5000), status: 'running', commit: 'A', repo: REPO, entry: ENTRY } };
  const h = harness({ hb, alive: new Set([7]) });
  const [r] = ensureSupervisors(specOf({ s: MUST }), h.deps(T0));
  assert.equal(r.state, 'pin_mismatch');
  assert.deepEqual(h.stops, []);
  assert.ok(h.logs.some(e => e.kind === 'supervisor_warning'));

  const h2 = harness({ hb: structuredClone(hb), alive: new Set([7]) });
  const restart = { s: { ...MUST, restart_on_mismatch: true } };
  ensureSupervisors(specOf(restart), h2.deps(T0));
  ensureSupervisors(specOf(restart), h2.deps(T0 + 1000));
  assert.deepEqual(h2.stops, ['s'], 'one stop file, not one per pass');
  // It exits; the tree (C) satisfies the pin, so it is started again.
  h2.alive.delete(7); h2.hb.s.status = 'stopped';
  const [after] = ensureSupervisors(specOf(restart), h2.deps(T0 + 2000));
  assert.equal(after.state, 'started');
  // And a supervisor at a good commit is simply running.
  const good = harness({ hb: { s: { ...hb.s, commit: 'C' } }, alive: new Set([7]) });
  assert.equal(ensureSupervisors(specOf({ s: MUST }), good.deps(T0))[0].state, 'running');
});

test('supervise: the watch caches between checks and a plan never starts', () => {
  const started = [];
  const deps = { git: gitAt('C'), pidAlive: () => false, readHeartbeat: () => null,
                 start: () => { started.push(1); return { ok: true, pid: 5 }; } };
  const config = { ...specOf({ s: MUST }), supervisor_check_ms: 30_000 };
  const plan = new SupervisorWatch({ config, commit: false, deps, echo: false });
  assert.equal(plan.check(T0).s.state, 'missing');
  assert.deepEqual(started, []);
  const live = new SupervisorWatch({ config, commit: true, deps, echo: false });
  const a = live.check(T0);
  assert.equal(a.s.state, 'started');
  assert.equal(live.check(T0 + 1000), a, 'cached');
  assert.equal(new SupervisorWatch({ config: specOf({}), deps }).check(T0), null, 'nothing declared');
});

test('supervise: the CLI table reads heartbeats without starting anything', () => {
  const rows = describeSupervisors(specOf({ s: MUST }), { now: T0, git: gitAt('C'), pidAlive: () => true,
    readHb: () => ({ pid: 9, heartbeat_at: iso(T0 - 3000), commit: 'C', repo: REPO, entry: ENTRY }) });
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].pin_ok, true);
  assert.equal(rows[0].heartbeat_age_ms, 3000);
});

// ------------------------------------------------------------------ the gate

const SUPS = { singer: { need: 'must', entry: 'x.mjs', pin: 'B' }, extra: { need: 'optional', entry: 'y.mjs' } };

test('supervise: gate — a down `must` withholds, `started` and optional do not', () => {
  const d = { supervisors: SUPS };
  assert.equal(supervisorGate([], null, d).ok, true);
  assert.equal(supervisorGate(['singer'], { singer: { state: 'running' } }, d).ok, true);
  assert.equal(supervisorGate(['singer'], { singer: { state: 'started' } }, d).ok, true);
  const down = supervisorGate(['singer'], { singer: { state: 'pin_mismatch', why: 'old' } }, d);
  assert.equal(down.ok, false);
  assert.match(down.why, /supervisor_withheld: singer is pin_mismatch/);
  assert.equal(supervisorGate(['singer'], null, d).ok, false, 'unchecked must is down');
  assert.equal(supervisorGate(['extra'], { extra: { state: 'missing' } }, d).ok, true, 'optional never withholds');
});

const shiftDoctrine = () => {
  const d = loadDoctrine({ file: 'doctrines/castle-graveyard.jsonc' }).config;
  d.supervisors = SUPS;
  d.shift.stations = d.shift.stations.filter(st => (st.when ?? 'always') === 'always').slice(0, 1);
  d.shift.stations[0] = { ...d.shift.stations[0], share: 1.0, requires_supervisors: ['singer'] };
  return d;
};
const rows = n => Array.from({ length: n }, (_, i) => ({ agent: `u${i + 1}`, in_game: true, level: 60, room: 2,
  mode: 'idle', policy: {}, commitment: null, parked: null, piloted: null }));

test('supervise: a station whose must supervisor is down sends nothing; up, it deploys', () => {
  const d = shiftDoctrine();
  assert.deepEqual(validate(d), []);
  const rule = shiftFleetRules[0];
  const held = rule.decide({ characters: rows(3), strategies: { agents: {} },
    supervisors: { singer: { state: 'missing', why: 'no heartbeat' } } }, d);
  assert.equal(held.kind, 'pass');
  assert.match(held.why, /withheld — u\d: supervisor_withheld: singer is missing/);
  const sent = rule.decide({ characters: rows(3), strategies: { agents: {} },
    supervisors: { singer: { state: 'running' } } }, d);
  assert.equal(sent.kind, 'act');
  assert.equal(sent.plan.filter(p => p.do === 'deploy').length, 3);
  assert.equal(withheldTargets(d, { singer: { state: 'missing' } })[0].where, 'shift.stations[0]');
});

test('supervise: a ladder rung whose must supervisor is down takes the turn and sends nothing', () => {
  const d = { ...freshDefaults(), supervisors: SUPS };
  d.goals.ladder = [{ id: 'sing', until: { kind: 'max_health', at_least: 100 }, orders: { mode: 'farm' },
                      why: 'farm under the song', requires_supervisors: ['singer'] }];
  const rule = ladderRules[0];
  const out = rule.decide({ agent: 'u1', max_health: 50, supervisors: { singer: { state: 'start_failed' } } }, d);
  assert.equal(out.kind, 'none');
  assert.match(out.why, /withheld/);
  const go = rule.decide({ agent: 'u1', max_health: 50, supervisors: { singer: { state: 'running' } } }, d);
  assert.equal(go.kind, 'orders');
});

// ------------------------------------------------------------------ the schema

test('supervise: schema refuses an undeclared requires_supervisors, a bad need, and a must without a pin', () => {
  const d = freshDefaults();
  d.supervisors = { a: { need: 'sometimes', entry: 'x.mjs' }, b: { need: 'must', entry: 'y.mjs' },
                    c: { need: 'optional', entry: 'z.mjs', pin_mode: 'roughly', bogus: 1 } };
  d.goals.ladder = [{ id: 'r', until: { kind: 'level', at_least: 1 }, why: 'x', requires_supervisors: ['nobody'] }];
  const where = validate(d).map(p => p.where);
  for (const w of ['supervisors.a.need', 'supervisors.b.pin', 'supervisors.c.pin_mode', 'supervisors.c',
                   'goals.ladder[0].requires_supervisors'])
    assert.ok(where.includes(w), `expected a problem at ${w}; got ${where.join(', ')}`);
  const ok = freshDefaults();
  ok.supervisors = { b: { need: 'must', entry: 'dum:supervisors/example-room-buff.mjs', pin: 'abc123' } };
  ok.goals.ladder = [{ id: 'r', until: { kind: 'level', at_least: 1 }, why: 'x', requires_supervisors: ['b'] }];
  assert.deepEqual(validate(ok), []);
});

// ------------------------------------------------------------------ the base class, against a fake broker

async function fakeBroker(handler) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ fleet: 'f' }));
      }
      const j = JSON.parse(body);
      calls.push({ url: req.url, accept: req.headers.accept, ...j.params });
      const out = handler(j.params.name, j.params.arguments);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...(out.rpcError ? { error: out.rpcError }
        : { result: { content: [{ type: 'text', text: typeof out.text === 'string' ? out.text : JSON.stringify(out.text) }],
                      ...(out.isError ? { isError: true } : {}) } }) }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(r => server.close(r)) };
}

test('supervise base: rpc unwraps, errors throw, fleet caches, order carries why', async () => {
  let fleetReads = 0;
  const b = await fakeBroker((name, args) => {
    if (name === 'fleet') { fleetReads++; return { text: { fleet: [{ agent: 'a1', in_game: true }] } }; }
    if (name === 'autopilot') return { text: { started: true, echo: args } };
    if (name === 'boom') return { text: 'it broke', isError: true };
    if (name === 'rpcfail') return { rpcError: { code: -1, message: 'no such tool' } };
    return { text: 'plain words' };
  });
  try {
    const sup = new Supervisor({ id: 't', fleet: 'f', control: b.url, stateDir: tmp(), entryFile: import.meta.url,
      echo: false, git: () => ({ code: 1, stdout: '' }) });
    assert.equal(await sup.rpc('words'), 'plain words');
    assert.equal(b.calls[0].url, '/mcp');
    assert.match(b.calls[0].accept, /text\/event-stream/);
    await assert.rejects(sup.rpc('boom'), /it broke/);
    await assert.rejects(sup.rpc('rpcfail'), /no such tool/);
    await sup.fleet(); await sup.fleet();
    assert.equal(fleetReads, 1, 'cached');
    assert.equal((await sup.row('a1')).agent, 'a1');
    const r = await sup.order('a1', { mode: 'farm' }, 'because');
    assert.equal(r.echo.action, 'start');
    assert.equal(r.echo.mode, 'farm');
    assert.equal(r.echo.why, 't: because');
    assert.equal(sup.didOrder(r), true);
    assert.equal(sup.didOrder({ keeper_backed: true, keeper_push: { confirmed: false } }), false);
    assert.equal(sup.didOrder({ error: 'x' }), false);
    assert.deepEqual(await sup.checkFleet(), { fleet: 'f' });
  } finally { await b.close(); }
});

test('supervise base: hands() refuses piloted, held, dead, out of game, excluded and successor rows', () => {
  const d = tmp();
  writeFileSync(join(d, 'c.json'), JSON.stringify({ exclude: ['x'] }));
  const sup = new Supervisor({ id: 't', stateDir: d, configFile: join(d, 'c.json'), entryFile: import.meta.url, echo: false });
  const ok = { agent: 'a', in_game: true };
  assert.equal(sup.hands(ok), true);
  for (const bad of [{ piloted: { pid: 1 } }, { human_held: true }, { in_game: false }, { dead: true },
                     { pending_successor: true }, { agent: 'x' }])
    assert.equal(sup.hands({ ...ok, ...bad }), false, JSON.stringify(bad));
});

test('supervise base: conf() strips a BOM and keeps the last good config on a bad write', () => {
  const d = tmp(), f = join(d, 'c.json');
  const sup = new Supervisor({ id: 't', stateDir: d, configFile: f, entryFile: import.meta.url, echo: false,
                               defaults: { exclude: [], n: 1 } });
  assert.equal(sup.conf().n, 1, 'missing file -> defaults');
  writeFileSync(f, '\uFEFF{"n": 2, "exclude": ["z"]}');
  assert.equal(sup.conf().n, 2);
  writeFileSync(f, '{"n": 3,');
  assert.equal(sup.conf().n, 2, 'last good kept');
  assert.equal(sup.excluded('z'), true);
  const log = readFileSync(sup.logPath, 'utf8');
  assert.match(log, /CONFIG DID NOT PARSE/);
});

test('supervise base: run() heartbeats, honours the stop file, and marks itself stopped', async () => {
  const b = await fakeBroker(() => ({ text: { fleet: [] } }));
  const d = tmp();
  let ticks = 0, tornDown = false;
  class Tiny extends Supervisor {
    loops() { return [{ name: 'tick', fn: async () => { ticks++; if (ticks === 2) writeFileSync(this.stopPath, 'stop'); }, everyMs: 10 }]; }
    async teardown() { tornDown = true; }
  }
  const sup = new Tiny({ id: 'tiny', fleet: 'f', control: b.url, stateDir: d, entryFile: import.meta.url, echo: false,
    requestedBy: 'test', git: args => args[1] === '--show-toplevel' ? { code: 0, stdout: d }
      : args[0] === 'rev-parse' ? { code: 0, stdout: 'abc' } : { code: 0, stdout: '' } });
  try {
    const running = sup.run({ installSignals: false });
    // The heartbeat is written before setup runs.
    const first = JSON.parse(readFileSync(heartbeatFile(d, 'tiny'), 'utf8'));
    assert.equal(first.schema, 1);
    assert.equal(first.status, 'running');
    assert.equal(first.pid, process.pid);
    assert.equal(first.commit, 'abc');
    assert.equal(first.fleet, 'f');
    assert.equal(first.requested_by, 'test');
    assert.equal(typeof first.dirty, 'boolean');
    assert.ok(existsSync(join(d, 'tiny.pid')), 'legacy pid file');
    await running;
    assert.ok(ticks >= 2);
    assert.equal(tornDown, true);
    const last = JSON.parse(readFileSync(heartbeatFile(d, 'tiny'), 'utf8'));
    assert.equal(last.status, 'stopped');
    assert.equal(existsSync(join(d, 'tiny.pid')), false);
    assert.equal(isRunning(last, { now: Date.now(), pidAlive: () => true }), false);
    assert.ok(existsSync(stopFile(d, 'tiny')));
  } finally { await b.close(); }
});

test('supervise base: run() refuses a broker holding another fleet', async () => {
  const b = await fakeBroker(() => ({ text: {} }));
  const sup = new Supervisor({ id: 'w', fleet: 'other', control: b.url, stateDir: tmp(), entryFile: import.meta.url,
    echo: false, git: () => ({ code: 1, stdout: '' }) });
  try { await assert.rejects(sup.run({ installSignals: false }), /holds fleet "f", not "other"/); }
  finally { await b.close(); }
});

// ------------------------------------------------------------------ through the tick

test('supervise: a pass carries supervisor states to the rules and journals the withholding once', async () => {
  const { pass } = await import('../src/loop/tick.mjs');
  const fx = await import('./fixtures.mjs');
  const config = fx.doctrine({ supervisors: { singer: { need: 'must', entry: 'x.mjs', pin: 'B' } } });
  config.goals.ladder = config.goals.ladder.map(r => ({ ...r, requires_supervisors: ['singer'] }));
  const written = [];
  const calls = [];
  const broker = { url: 'http://127.0.0.1:1', health: async () => ({ fleet: 'test' }),
    call: async (tool, args) => { calls.push(tool); return tool === 'fleet'
      ? { fleet: [{ agent: 'role-a', in_game: true, room_num: 71, health: '20/20', level: 20,
                    autopilot: { mode: 'farm', running: true }, committed: null, parked: null }] } : {}; },
    write: async () => ({ dry_run: true }) };
  let state = 'missing';
  const ctx = { broker, config, commit: false, journal: { write: l => written.push(l), finding() {} },
    supervisors: { check: () => ({ singer: { id: 'singer', need: 'must', state, why: 'no heartbeat' } }) } };
  const r1 = await pass(ctx, { decideFleet: false });
  assert.equal(r1.characters[0].intent.kind, 'none');
  assert.match(r1.characters[0].intent.why, /withheld/);
  assert.deepEqual(calls, ['fleet'], 'a withheld rung pays for no status read');
  await pass(ctx, { decideFleet: false });
  assert.equal(written.filter(l => l.kind === 'supervisor_withheld').length, 1, 'journalled on change, not per pass');
  state = 'running';
  const r3 = await pass(ctx, { decideFleet: false });
  assert.equal(r3.characters[0].intent.kind, 'orders');
  const lines = written.filter(l => l.kind === 'supervisor_withheld');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1].withheld, [], 'the release is journalled too');
});
