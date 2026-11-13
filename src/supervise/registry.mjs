// WHICH SUPERVISORS A DOCTRINE DEPENDS ON, WHETHER THEY ARE UP, AND WHETHER THEY ARE THE
// CODE THE DOCTRINE WAS WRITTEN AGAINST.
//
// A supervisor is a separate long-running process that owns a COLLECTIVE plan: one
// character singing a room buff while others farm, a courier lapping between a farm and
// town, a desk enchanting other characters' weapons. DUM owns per-character strategy; a
// station whose orders only make sense while such a process is running has to be able to
// say so, or DUM sends a character to a room whose buff nobody is singing and every board
// reads healthy.
//
// So a doctrine DECLARES them (`supervisors: {<id>: {...}}`) and this file answers, per id:
//
//   running       a heartbeat younger than 60 s from a live pid, at a commit the pin accepts
//   started       not running, `must`, and this call launched it (or did inside the backoff)
//   missing       not running and not started — optional, `start: false`, or backing off
//   pin_mismatch  running at a commit the pin refuses, or the tree on disk would be refused
//   start_failed  the launch itself failed
//   disabled      `enabled: false` in the doctrine
//
// EVERYTHING WITH A SIDE EFFECT IS INJECTED — the clock, git, pid checks, the launcher, the
// stop file, the log. That is what makes the backoff and the pin rules testable offline, and
// it keeps the decision ("should this be started?") separate from the doing.
//
// THE HEARTBEAT IS THE CONTRACT, NOT THE BASE CLASS. A supervisor is "running" because it
// writes `<state_dir>/<id>.supervisor.json` every few seconds with a live pid in it. Older
// private scripts that are not built on src/supervise/base.mjs satisfy this registry by
// writing that file themselves. See docs/supervisors.md.

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, isAbsolute, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEARTBEAT_SCHEMA = 1;
/** A heartbeat older than this is a dead supervisor, whatever its pid says. */
export const HEARTBEAT_STALE_MS = 60_000;
/** At most one start attempt per id inside this window. */
export const START_BACKOFF_MS = 60_000;
/** An optional supervisor's absence is said at most this often. */
export const OPTIONAL_WARN_MS = 10 * 60_000;
/** A must supervisor's trouble is said at most this often. */
export const MUST_WARN_MS = 60_000;

export const NEEDS = ['must', 'optional'];
export const PIN_MODES = ['exact', 'at_least'];
export const STATES = ['running', 'started', 'missing', 'pin_mismatch', 'start_failed', 'disabled'];
/** The states a `must` dependency is allowed to be in for its dependents to be sent. */
export const UP_STATES = new Set(['running', 'started']);

/** This repository's root, the built-in `dum:` supervisor root. */
export const DUM_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const heartbeatFile = (stateDir, id) => join(stateDir, `${id}.supervisor.json`);
export const stopFile = (stateDir, id) => join(stateDir, `${id}.stop`);
export const pidFile = (stateDir, id) => join(stateDir, `${id}.pid`);
export const logFile = (stateDir, id) => join(stateDir, `${id}.log`);

const stripBom = s => String(s).replace(/^﻿/, '');

/** The heartbeat, or null when there is none or it does not parse. */
export function readHeartbeat(stateDir, id, { read = p => readFileSync(p, 'utf8') } = {}) {
  try {
    const hb = JSON.parse(stripBom(read(heartbeatFile(stateDir, id))));
    return hb && typeof hb === 'object' ? hb : null;
  } catch { return null; }
}

/** process.kill(pid, 0): true when the pid exists (EPERM also means it exists). */
export function pidAliveReal(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

/** A heartbeat is a running supervisor only with a live pid AND a fresh timestamp. */
export function isRunning(hb, { now = Date.now(), pidAlive = pidAliveReal } = {}) {
  if (!hb || hb.status === 'stopped') return false;
  const at = Date.parse(hb.heartbeat_at);
  if (!Number.isFinite(at) || now - at > HEARTBEAT_STALE_MS) return false;
  return pidAlive(hb.pid) === true;
}

/** git, for real: `{code, stdout}` and never a throw. */
export function gitReal(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return { code: r.status ?? 1, stdout: String(r.stdout ?? '').trim(), stderr: String(r.stderr ?? '').trim() };
}

/** The git toplevel holding `file`, or null. */
export function repoOf(file, git = gitReal) {
  const r = git(['rev-parse', '--show-toplevel'], dirname(file));
  return r.code === 0 && r.stdout ? resolve(r.stdout) : null;
}

const relPath = (repo, p) => {
  const abs = isAbsolute(p) ? p : resolve(repo, p);
  return relative(repo, abs).replace(/\\/g, '/') || '.';
};

/**
 * Does the code at `repo` satisfy the pin?
 *
 *   exact     HEAD is the pin (and the paths are clean), OR every pinned path is
 *             byte-identical between the pin and the working tree
 *   at_least  the pin is an ancestor of HEAD AND every pinned path is clean in the tree
 *
 * `head` overrides HEAD — for a RUNNING supervisor it is the commit its heartbeat reported,
 * which is what is actually executing. The pinned paths are the entry plus `pinPaths`.
 *
 * @returns {{ok: boolean, why: string, head: string|null, pin: string|null}}
 */
export function pinSatisfied({ repo, entry, pin, pinMode = 'at_least', pinPaths = [], head = null }, git = gitReal) {
  if (!pin) return { ok: true, why: 'no pin', head, pin: null };
  if (!repo) return { ok: false, why: 'not in a git repository, so no pin can be checked', head, pin };
  const p = git(['rev-parse', '--verify', '--quiet', `${pin}^{commit}`], repo);
  if (p.code !== 0 || !p.stdout) return { ok: false, why: `pin ${pin} is not a commit in ${repo}`, head, pin };
  const pinSha = p.stdout;
  let h = head;
  if (!h) {
    const r = git(['rev-parse', 'HEAD'], repo);
    if (r.code !== 0) return { ok: false, why: 'cannot read HEAD', head: null, pin: pinSha };
    h = r.stdout;
  } else {
    const r = git(['rev-parse', '--verify', '--quiet', `${h}^{commit}`], repo);
    if (r.code !== 0) return { ok: false, why: `running commit ${h} is not in ${repo}`, head: h, pin: pinSha };
    h = r.stdout;
  }
  const paths = [entry, ...[].concat(pinPaths ?? [])].filter(Boolean).map(x => relPath(repo, x));
  // `git diff` is silent about an UNTRACKED file, so an entry nobody committed would read as
  // clean at every commit. `status` names it with `??`.
  const untracked = () => {
    const st = git(['status', '--porcelain', '--untracked-files=all', '--', ...paths], repo);
    return st.code !== 0 || /^\?\? /m.test(st.stdout ?? '');
  };
  const cleanAgainst = rev => git(['diff', '--quiet', rev, '--', ...paths], repo).code === 0 && !untracked();
  const short = s => String(s).slice(0, 8);

  if (pinMode === 'exact') {
    if (h === pinSha && cleanAgainst(h)) return { ok: true, why: `at ${short(pinSha)}`, head: h, pin: pinSha };
    if (cleanAgainst(pinSha))
      return { ok: true, why: `${paths.join(', ')} identical to ${short(pinSha)}`, head: h, pin: pinSha };
    return { ok: false, why: `exact pin ${short(pinSha)}: ${paths.join(', ')} differ (running ${short(h)})`,
             head: h, pin: pinSha };
  }
  if (pinMode !== 'at_least') return { ok: false, why: `unknown pin_mode ${pinMode}`, head: h, pin: pinSha };
  const anc = git(['merge-base', '--is-ancestor', pinSha, h], repo);
  if (anc.code !== 0)
    return { ok: false, why: `${short(h)} is not ${short(pinSha)} or newer`, head: h, pin: pinSha };
  if (!cleanAgainst(h))
    return { ok: false, why: `${paths.join(', ')} have uncommitted changes against ${short(h)}`, head: h, pin: pinSha };
  return { ok: true, why: `${short(h)} is ${short(pinSha)} or newer`, head: h, pin: pinSha };
}

/**
 * Where a declared entry lives on this machine.
 *
 *   "private:supervisors/x.mjs"  -> supervisor_roots.private + /supervisors/x.mjs
 *   "dum:supervisors/x.mjs"      -> this repository (always available)
 *   "supervisors/x.mjs"          -> this repository too
 *   absolute                     -> as written (local doctrines only; dum-guard refuses
 *                                   machine paths in tracked ones)
 */
export function resolveEntry(entry, roots = {}, dumRoot = DUM_ROOT) {
  const e = String(entry ?? '');
  if (!e) throw new Error('no entry');
  if (isAbsolute(e)) return resolve(e);
  const m = /^([A-Za-z_][\w-]+):(.+)$/.exec(e);      // two+ chars: never a drive letter
  if (m) {
    const [, name, rest] = m;
    const base = name === 'dum' ? dumRoot : roots?.[name];
    if (!base) throw new Error(`supervisor root "${name}" is not configured on this machine ` +
      '(supervisor_roots in dum.local.json, or --supervisor-root name=dir)');
    return resolve(base, rest);
  }
  return resolve(dumRoot, e);
}

export function stateDirFor(def = {}, spec = {}, dumRoot = DUM_ROOT) {
  const d = def.state_dir ?? spec.supervisor_state_dir ?? null;
  if (!d) return resolve(dumRoot, 'var', 'supervisors');
  return isAbsolute(d) ? d : resolve(dumRoot, d);
}

const defaultStop = (stateDir, id) => {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(stopFile(stateDir, id), `requested ${new Date().toISOString()}\n`);
};

/**
 * Check every declared supervisor, start the `must` ones that are down, and say what each is.
 *
 * @param {object} spec   the effective config, or its slice: {supervisors, supervisor_state_dir,
 *                        supervisor_roots, fleet, link}
 * @param {object} deps   {now, start(def) -> {ok, pid?, why?}, git, pidAlive, log(event),
 *                        readHeartbeat(stateDir, id), stop(stateDir, id), memo, allowStart}
 *                        `memo` carries the backoff and warning throttles between calls;
 *                        `allowStart: false` turns every start into a report (plan mode).
 * @returns {Array<{id, need, state, commit, pid, heartbeat_age_ms, pin, why}>}
 */
export function ensureSupervisors(spec = {}, deps = {}) {
  const {
    now = Date.now(), start = null, git = gitReal, pidAlive = pidAliveReal,
    log = () => {}, stop = defaultStop, memo = DEFAULT_MEMO, allowStart = true,
    dumRoot = DUM_ROOT,
  } = deps;
  const readHb = deps.readHeartbeat ?? ((dir, id) => readHeartbeat(dir, id));
  memo.attempts ??= {}; memo.warned ??= {}; memo.restarting ??= {};
  const warn = (id, need, event) => {
    const every = need === 'must' ? MUST_WARN_MS : OPTIONAL_WARN_MS;
    const key = `${id}:${event.state}`;
    if (now - (memo.warned[key] ?? -Infinity) < every) return false;
    memo.warned[key] = now;
    log({ kind: 'supervisor_warning', id, need, ...event });
    return true;
  };

  const out = [];
  for (const [id, raw] of Object.entries(spec.supervisors ?? {})) {
    const def = { ...raw, id };
    const need = def.need === 'must' ? 'must' : 'optional';
    const row = { id, need, state: 'missing', commit: null, pid: null, heartbeat_age_ms: null,
                  pin: def.pin ?? null, pin_mode: def.pin_mode ?? 'at_least', why: null };
    out.push(row);
    if (def.enabled === false) { row.state = 'disabled'; row.why = 'enabled: false in the doctrine'; continue; }

    let entry;
    try { entry = resolveEntry(def.entry, spec.supervisor_roots ?? {}, dumRoot); }
    catch (e) { row.why = `entry: ${e.message}`; warn(id, need, { state: row.state, why: row.why }); continue; }
    const stateDir = stateDirFor(def, spec, dumRoot);
    const repo = def.repo ? resolve(def.repo) : repoOf(entry, git);
    Object.assign(row, { entry, state_dir: stateDir, repo });

    const hb = readHb(stateDir, id);
    if (hb) {
      row.pid = hb.pid ?? null;
      row.commit = hb.commit ?? null;
      const at = Date.parse(hb.heartbeat_at);
      row.heartbeat_age_ms = Number.isFinite(at) ? now - at : null;
    }
    const running = isRunning(hb, { now, pidAlive });
    // THE HEARTBEAT NAMES WHAT IS RUNNING, SO ONLY A RUNNING ONE MAY SAY WHERE THE CODE IS. A stale card's repo and
    // entry describe the process that EXITED; checking a start against them pinned the new launch to the old checkout
    // (2026-11-13: a supervisor moved to a clean worktree was refused because the OLD checkout was not at the pin).
    const live = running && hb;
    const pinArgs = { repo: live && hb.repo ? resolve(hb.repo) : repo, entry: (live && hb.entry) || entry,
      pin: def.pin, pinMode: def.pin_mode ?? 'at_least', pinPaths: def.pin_paths ?? [] };

    if (running) {
      delete memo.attempts[id];
      if (!def.pin) { row.state = 'running'; row.why = 'heartbeat fresh, no pin'; continue; }
      const ps = hb.commit
        ? pinSatisfied({ ...pinArgs, head: hb.commit }, git)
        : { ok: false, why: 'its heartbeat carries no commit, so the pin cannot be checked' };
      if (ps.ok) { row.state = 'running'; row.why = ps.why; delete memo.restarting[id]; continue; }
      row.state = 'pin_mismatch'; row.why = ps.why;
      if (def.restart_on_mismatch === true && allowStart) {
        if (!memo.restarting[id]) {
          try { stop(stateDir, id); memo.restarting[id] = now;
                log({ kind: 'supervisor_restart', id, why: `pin mismatch (${ps.why}); stop file written` }); }
          catch (e) { row.why += `; could not write the stop file: ${e.message}`; }
        } else row.why += '; stop requested, waiting for it to exit';
      } else warn(id, need, { state: row.state, why: row.why });
      continue;
    }

    // ---- not running
    const wantsStart = need === 'must' ? def.start !== false : def.start === true;
    const last = memo.attempts[id];
    if (last && now - last.at < START_BACKOFF_MS) {
      // Inside the backoff: a launch we made that is still alive is "started"; anything
      // else waits for the window to pass rather than spawning again.
      if (last.ok && last.pid && pidAlive(last.pid)) {
        row.state = 'started'; row.pid = last.pid;
        row.why = `started ${Math.round((now - last.at) / 1000)}s ago, waiting for its first heartbeat`;
      } else {
        row.state = last.ok ? 'missing' : 'start_failed';
        row.why = `start attempted ${Math.round((now - last.at) / 1000)}s ago` +
          (last.why ? ` (${last.why})` : '') + '; backing off';
      }
      continue;
    }
    if (!wantsStart || !allowStart || typeof start !== 'function') {
      row.state = 'missing';
      row.why = hb ? `heartbeat ${hb.status === 'stopped' ? 'says stopped' : 'is stale or its pid is gone'}`
                   : 'no heartbeat';
      if (wantsStart && !allowStart) row.why += '; not started (this run may not start supervisors)';
      else if (need === 'must' && !wantsStart) row.why += '; start: false';
      warn(id, need, { state: row.state, why: row.why });
      continue;
    }
    if (def.pin) {
      const ps = pinSatisfied(pinArgs, git);
      if (!ps.ok) {
        row.state = 'pin_mismatch'; row.why = `not started: ${ps.why}`;
        warn(id, need, { state: row.state, why: row.why });
        continue;
      }
    }
    let r;
    try { r = start({ ...def, need, entry, state_dir: stateDir, repo, fleet: spec.fleet ?? null,
                      control: spec.link?.control_url ?? null }) ?? {}; }
    catch (e) { r = { ok: false, why: e.message }; }
    memo.attempts[id] = { at: now, ok: r.ok === true, pid: r.pid ?? null, why: r.why ?? null };
    delete memo.restarting[id];
    if (r.ok === true) {
      row.state = 'started'; row.pid = r.pid ?? null; row.why = `started pid ${r.pid ?? '?'}`;
      log({ kind: 'supervisor_started', id, need, pid: r.pid ?? null, entry });
    } else {
      row.state = 'start_failed'; row.why = r.why ?? 'start failed';
      log({ kind: 'supervisor_start_failed', id, need, why: row.why });
    }
  }
  return out;
}

const DEFAULT_MEMO = {};

/** A by-id map of ensureSupervisors' rows, which is the shape the rules read. */
export const byId = rows => Object.fromEntries((rows ?? []).map(r => [r.id, r]));
