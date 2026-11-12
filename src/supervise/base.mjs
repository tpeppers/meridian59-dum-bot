// THE SUPERVISOR BASE CLASS: THE PLUMBING EVERY COLLECTIVE-PLAN SCRIPT REWROTE.
//
// A supervisor owns a plan no single character can hold — a singer posted while others
// farm, a courier lap, a desk. The hand-written ones each carried the same few hundred
// lines before their first line of game logic: an rpc helper, a fleet cache, a re-read
// config that had to survive a UTF-8 BOM, an NDJSON log, a stop file, a pid file, and a
// set of per-loop try/catch wrappers. Each copy got a different subset of it wrong.
//
// So a concrete supervisor is:
//
//   import { Supervisor, supervisorMain } from '<dum>/src/supervise/base.mjs';
//   class RoomBuff extends Supervisor {
//     async setup() { ... }
//     loops() { return [{ name: 'sing', fn: () => this.singPass(), everyMs: 5000 }]; }
//   }
//   await supervisorMain(RoomBuff, { id: 'room-buff', entryFile: import.meta.url });
//
// and holds only its specifics. NOTHING HERE IS GAME LOGIC, and nothing assumes it is
// imported from inside this repository — private supervisors import it by path.
//
// THE HEARTBEAT is what makes DUM's registry see this process (src/supervise/registry.mjs,
// docs/supervisors.md). It carries the git commit the entry file was loaded from, so a
// doctrine pinned to a commit can tell a supervisor running yesterday's code from one
// running today's.

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEARTBEAT_SCHEMA, heartbeatFile, stopFile, pidFile, logFile, gitReal } from './registry.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const HEARTBEAT_EVERY_MS = 10_000;
const FLEET_CACHE_MS = 2_000;

const toPath = f => (String(f).startsWith('file:') ? fileURLToPath(f) : resolve(String(f)));

/** The commit `file` was loaded from: {repo, commit, dirty}, all null when not in git. */
export function codeIdentity(file, git = gitReal) {
  const dir = dirname(file);
  const top = git(['rev-parse', '--show-toplevel'], dir);
  if (top.code !== 0 || !top.stdout) return { repo: null, commit: null, dirty: false };
  const repo = resolve(top.stdout);
  const head = git(['rev-parse', 'HEAD'], repo);
  const diff = git(['diff', '--quiet', 'HEAD', '--', file], repo);
  // An untracked entry is dirty too: HEAD does not describe it at all.
  const tracked = git(['ls-files', '--error-unmatch', '--', file], repo).code === 0;
  return { repo, commit: head.code === 0 ? head.stdout : null, dirty: diff.code !== 0 || !tracked };
}

export class Supervisor {
  /**
   * @param {object} o
   * @param {string} o.id          names the files: <id>.log, <id>.stop, <id>.supervisor.json
   * @param {string} o.fleet       the roster this supervisor drives; checked against /health
   * @param {string} [o.control]   broker URL, default http://127.0.0.1:8901
   * @param {string} o.stateDir    where its files live
   * @param {string} [o.configFile] JSON re-read by conf() on every call
   * @param {string} o.entryFile   import.meta.url of the subclass module
   * @param {object} [o.defaults]  conf() values a config file does not set
   */
  constructor({ id, fleet = null, control = 'http://127.0.0.1:8901', stateDir, configFile = null,
                entryFile, defaults = {}, git = gitReal, now = () => Date.now(),
                requestedBy = process.env.M59_SUPERVISOR_REQUESTED_BY ?? null, echo = true,
                checkFleetOnStart = true } = {}) {
    if (!id || !/^[\w.-]+$/.test(id)) throw new Error(`supervisor id "${id}" must be a simple name`);
    if (!stateDir) throw new Error('stateDir is required');
    if (!entryFile) throw new Error('entryFile is required (pass import.meta.url)');
    this.id = id;
    this.fleetName = fleet;   // `fleet()` is the board read
    this.control = String(control).replace(/\/+$/, '');
    this.stateDir = resolve(stateDir);
    this.configFile = configFile ? resolve(configFile) : null;
    this.entry = toPath(entryFile);
    this.defaults = defaults;
    this.git = git;
    this.now = now;
    this.requestedBy = requestedBy;
    this.echo = echo;
    this.checkFleetOnStart = checkFleetOnStart;
    this.busy = new Set();
    this.status_ = 'running';
    this.startedAt = new Date(now()).toISOString();
    this.identity = null;
    this._fleet = { at: 0, rows: null, pending: null };
    this._conf = null;
    this._confError = null;
    this._exclude = [];
    this._rpcId = 0;
    mkdirSync(this.stateDir, { recursive: true });
  }

  // ------------------------------------------------------------------ files
  get logPath() { return logFile(this.stateDir, this.id); }
  get stopPath() { return stopFile(this.stateDir, this.id); }
  get heartbeatPath() { return heartbeatFile(this.stateDir, this.id); }
  get pidPath() { return pidFile(this.stateDir, this.id); }

  /** One NDJSON line: {at, what, ...data}. Never throws. */
  log(what, data = {}) {
    const line = JSON.stringify({ at: new Date(this.now()).toISOString(), what, ...data });
    try { appendFileSync(this.logPath, line + '\n'); } catch { /* a full disk must not stop the loop */ }
    if (this.echo) console.log(line);
  }

  /** The stop file is the off switch; `dum.mjs supervisors stop <id>` writes it. */
  stopped() { return this.status_ === 'stopping' || existsSync(this.stopPath); }
  requestStop(why = 'requested') {
    if (this.status_ !== 'stopping') this.log('stopping', { why });
    this.status_ = 'stopping';
  }

  /** {schema, id, pid, started_at, heartbeat_at, fleet, entry, repo, commit, dirty, status, requested_by?} */
  heartbeat(status = this.status_) {
    this.identity ??= codeIdentity(this.entry, this.git);
    const hb = { schema: HEARTBEAT_SCHEMA, id: this.id, pid: process.pid, started_at: this.startedAt,
      heartbeat_at: new Date(this.now()).toISOString(), fleet: this.fleetName, entry: this.entry,
      repo: this.identity.repo, commit: this.identity.commit, dirty: this.identity.dirty, status,
      ...(this.requestedBy ? { requested_by: this.requestedBy } : {}) };
    const tmp = `${this.heartbeatPath}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(hb, null, 1)); renameSync(tmp, this.heartbeatPath); }
    catch (e) { this.log('heartbeat write failed', { error: e.message }); }
    return hb;
  }

  // ------------------------------------------------------------------ config
  /**
   * The config file, re-read on every call. A BOM is not a broken file. A file that does
   * not parse keeps the LAST GOOD config and says so loudly — falling back to the defaults
   * silently is how a supervisor ends up driving a character it was told to exclude.
   */
  conf() {
    if (!this.configFile) return { ...this.defaults };
    let text;
    try { text = existsSync(this.configFile) ? readFileSync(this.configFile, 'utf8') : null; }
    catch (e) { text = undefined; this._confFail(`unreadable: ${e.message}`); }
    if (text === null) { this._conf ??= { ...this.defaults }; return this._conf; }
    if (text !== undefined) {
      try {
        const parsed = JSON.parse(text.replace(/^﻿/, ''));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a JSON object');
        this._conf = { ...this.defaults, ...parsed };
        if (this._confError) this.log('config readable again', { file: this.configFile });
        this._confError = null;
      } catch (e) { this._confFail(e.message); }
    }
    return this._conf ?? { ...this.defaults };
  }
  _confFail(why) {
    if (this._confError !== why)
      this.log('CONFIG DID NOT PARSE — keeping the last good config', { file: this.configFile, why,
        kept: this._conf ? 'last good' : 'defaults (no good read yet)' });
    this._confError = why;
  }

  excluded(agent) { return [].concat(this.conf().exclude ?? []).includes(agent); }

  // ------------------------------------------------------------------ the broker
  /**
   * One MCP tools/call. Errors THROW — a tool error, an HTTP error, a timeout. A caller that
   * wants null writes `.catch(() => null)` and says so at the call site.
   */
  async rpc(tool, args = {}, timeoutMs = 60_000) {
    const r = await fetch(`${this.control}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this._rpcId, method: 'tools/call',
                             params: { name: tool, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await r.text();
    let j;
    try { j = JSON.parse(raw); }
    catch {
      // An SSE answer: the last `data:` line carries the JSON-RPC envelope.
      const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop();
      try { j = JSON.parse(data); } catch { throw new Error(`${tool}: HTTP ${r.status} ${raw.slice(0, 200)}`); }
    }
    if (!r.ok && !j?.error) throw new Error(`${tool}: HTTP ${r.status}`);
    if (j.error) throw new Error(`${tool}: ${j.error.message ?? JSON.stringify(j.error)}`);
    const text = j.result?.content?.[0]?.text;
    if (j.result?.isError) throw new Error(`${tool}: ${text ?? 'tool error'}`);
    if (typeof text !== 'string') return j.result ?? null;
    try { return JSON.parse(text); } catch { return text; }
  }

  /** The fleet board's rows, cached ~2 s and shared by concurrent callers. */
  async fleet({ fresh = false } = {}) {
    const t = this.now();
    if (!fresh && this._fleet.rows && t - this._fleet.at < FLEET_CACHE_MS) return this._fleet.rows;
    this._fleet.pending ??= this.rpc('fleet', {}, 60_000).then(v => {
      const rows = Array.isArray(v) ? v : Array.isArray(v?.fleet) ? v.fleet
        : Object.values(v ?? {}).filter(Array.isArray).flat();
      this._fleet = { at: this.now(), rows, pending: null };
      return rows;
    }).finally(() => { this._fleet.pending = null; });
    return this._fleet.pending;
  }
  async row(agent) { return (await this.fleet()).find(r => r?.agent === agent) ?? null; }

  /**
   * Is the broker on `control` holding THIS fleet? Throws when it is holding another one:
   * a supervisor pointed at the wrong roster drives characters nobody meant to touch, and
   * every call it makes reports success.
   */
  async checkFleet() {
    if (!this.fleetName) throw new Error('no fleet named');
    const r = await fetch(`${this.control}/health`, { signal: AbortSignal.timeout(8000) });
    const h = await r.json().catch(() => ({}));
    const held = h.fleet ?? h.fleet_name ?? null;
    if (held !== this.fleetName) throw new Error(`broker on ${this.control} holds fleet "${held}", not "${this.fleetName}"`);
    return h;
  }

  status(agent) { return this.rpc('autopilot', { agent, action: 'status' }, 60_000); }

  /** autopilot start with these policy fields. Returns the reply; errors come back as {error}. */
  async order(agent, policy = {}, why = '') {
    return this.rpc('autopilot', { agent, action: 'start', ...policy, why: `${this.id}: ${why}` }, 60_000)
      .catch(e => ({ error: e.message }));
  }
  /** Did an order land? A keeper-backed reply confirms through keeper_push. */
  didOrder(r) {
    return !!r && !r.error && (r.keeper_backed ? r.keeper_push?.confirmed === true : r.started !== false);
  }

  /** May this supervisor touch the body? In game, alive, nobody piloting, nobody holding, not handing over. */
  hands(row) {
    if (!row) return false;
    if (row.in_game === false || row.activity === 'NOT IN GAME') return false;
    if (row.dead === true || row.alive === false || /\bdead\b|underworld/i.test(String(row.activity ?? ''))) return false;
    if (row.piloted || row.human_held) return false;
    if (row.pending_successor || row.successor_pending) return false;
    return !this.excluded(row.agent);
  }

  /** Run fn with `agent` marked busy; null without running when it already is. */
  async withBusy(agent, fn) {
    if (this.busy.has(agent)) return null;
    this.busy.add(agent);
    try { return await fn(); } finally { this.busy.delete(agent); }
  }

  // ------------------------------------------------------------------ the loop
  /** Run fn every everyMs until stopped; an iteration that throws is logged and the loop goes on. */
  async loop(name, fn, everyMs = 10_000) {
    while (!this.stopped()) {
      try { await fn(); }
      catch (e) { this.log(`${name} error`, { error: e.message }); }
      for (let left = everyMs; left > 0 && !this.stopped(); left -= 500) await sleep(Math.min(500, left));
    }
  }

  // Subclass hooks.
  async setup() {}
  loops() { return []; }
  async teardown() {}

  /** Heartbeat, setup, the declared loops, then teardown once stopped. Resolves; does not exit. */
  async run({ installSignals = true } = {}) {
    if (existsSync(this.stopPath)) rmSync(this.stopPath, { force: true });   // a stale stop from last time
    writeFileSync(this.pidPath, String(process.pid));
    this.heartbeat('running');
    this.log('up', { pid: process.pid, fleet: this.fleetName, commit: this.identity?.commit ?? null,
                     dirty: this.identity?.dirty ?? null });
    const onSignal = sig => () => this.requestStop(sig);
    const handlers = installSignals ? [['SIGINT', onSignal('SIGINT')], ['SIGTERM', onSignal('SIGTERM')]] : [];
    for (const [s, h] of handlers) process.on(s, h);
    const beat = setInterval(() => this.heartbeat(), HEARTBEAT_EVERY_MS);
    let failed = null;
    try {
      if (this.checkFleetOnStart) await this.checkFleet();
      await this.setup();
      const loops = (this.loops() ?? []).map(l => this.loop(l.name, l.fn, l.everyMs));
      // Even with no loops, wait for the stop.
      loops.push(this.loop('idle', async () => {}, 1000));
      await Promise.all(loops);
    } catch (e) {
      failed = e;
      this.log('setup failed', { error: e.message });
    } finally {
      this.status_ = 'stopping';
      this.heartbeat('stopping');
      try { await this.teardown(); } catch (e) { this.log('teardown error', { error: e.message }); }
      clearInterval(beat);
      for (const [s, h] of handlers) process.off(s, h);
      this.heartbeat('stopped');
      rmSync(this.pidPath, { force: true });
      this.log('down', { why: failed ? `setup failed: ${failed.message}` : 'stopped' });
    }
    if (failed) throw failed;
  }
}

/** --name value, or the env var, or the default. */
function argOf(argv, name, env, dflt = null) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  if (env && process.env[env]) return process.env[env];
  return dflt;
}

/**
 * The entry point a concrete supervisor ends with. Reads --id, --fleet, --state-dir, --config
 * and --control (or M59_SUPERVISOR_ID, M59_FLEET, M59_SUPERVISOR_STATE_DIR,
 * M59_SUPERVISOR_CONFIG, M59_CONTROL_URL),
 * constructs the subclass, runs it, and exits.
 */
export async function supervisorMain(Ctor, opts = {}, argv = process.argv.slice(2)) {
  // The id names the heartbeat file, so it must be the id the DOCTRINE declared — DUM passes
  // it as M59_SUPERVISOR_ID when it starts one. The subclass's own id is the default.
  const id = argOf(argv, 'id', 'M59_SUPERVISOR_ID', opts.id ?? null);
  const fleet = argOf(argv, 'fleet', 'M59_FLEET', opts.fleet ?? null);
  const stateDir = argOf(argv, 'state-dir', 'M59_SUPERVISOR_STATE_DIR', opts.stateDir ?? null);
  const configFile = argOf(argv, 'config', 'M59_SUPERVISOR_CONFIG', opts.configFile ?? null);
  const control = argOf(argv, 'control', 'M59_CONTROL_URL', opts.control ?? 'http://127.0.0.1:8901');
  if (!fleet) { console.error(`${id}: --fleet (or M59_FLEET) is required`); process.exit(2); }
  if (!stateDir) { console.error(`${id}: --state-dir (or M59_SUPERVISOR_STATE_DIR) is required`); process.exit(2); }
  const sup = new Ctor({ ...opts, id, fleet, control,
    stateDir: isAbsolute(stateDir) ? stateDir : resolve(stateDir),
    configFile: configFile ? resolve(configFile) : null });
  try { await sup.run(); process.exit(0); }
  catch (e) { console.error(`${id}: ${e.message}`); process.exit(1); }
}
