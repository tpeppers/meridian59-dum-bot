// `dum.mjs supervisors` — the declared supervisors, read-only by default.
//
//   supervisors [--json]     need, pin, running?, pid, heartbeat age, running commit, pin ok?, why
//   supervisors start <id>   start it now (the pin is checked first; a running one is left alone)
//   supervisors stop <id>    write its stop file; it exits at its next look
//
// Talks to no broker. It reads heartbeat files and git, and `start` spawns the declared
// entry exactly as a committed DUM run would.

import { mkdirSync, writeFileSync } from 'node:fs';
import { readHeartbeat, isRunning, pinSatisfied, resolveEntry, stateDirFor, repoOf, stopFile,
         ensureSupervisors } from './registry.mjs';
import { startSupervisor } from './spawn.mjs';

/** One row per declared supervisor, without starting anything. */
export function describeSupervisors(config, { now = Date.now(), git, pidAlive, readHb = readHeartbeat } = {}) {
  return Object.entries(config.supervisors ?? {}).map(([id, def]) => {
    const row = { id, need: def.need, pin: def.pin ?? null, pin_mode: def.pin_mode ?? 'at_least',
      enabled: def.enabled !== false, running: false, pid: null, heartbeat_age_ms: null, commit: null,
      dirty: null, pin_ok: null, why: null };
    let entry;
    try { entry = resolveEntry(def.entry, config.supervisor_roots ?? {}); }
    catch (e) { row.why = `entry: ${e.message}`; return row; }
    const stateDir = stateDirFor(def, config);
    const hb = readHb(stateDir, id);
    row.entry = entry; row.state_dir = stateDir;
    row.running = isRunning(hb, { now, ...(pidAlive ? { pidAlive } : {}) });
    if (hb) {
      row.pid = hb.pid ?? null; row.commit = hb.commit ?? null; row.dirty = hb.dirty ?? null;
      const at = Date.parse(hb.heartbeat_at);
      row.heartbeat_age_ms = Number.isFinite(at) ? now - at : null;
    }
    if (def.pin) {
      // Only a RUNNING heartbeat may name the repo and entry (see ensureSupervisors).
      const live = row.running && hb;
      const repo = (live && hb.repo) || (def.repo ?? repoOf(entry, git));
      const ps = pinSatisfied({ repo, entry: (live && hb.entry) || entry, pin: def.pin, pinMode: def.pin_mode ?? 'at_least',
        pinPaths: def.pin_paths ?? [], head: row.running ? hb.commit : null }, git);
      row.pin_ok = ps.ok; row.why = ps.why;
    } else row.why = 'no pin';
    if (!row.running) row.why = `${hb ? 'heartbeat stale or pid gone' : 'no heartbeat'}; ${row.why}`;
    return row;
  });
}

const age = ms => ms == null ? '-' : ms < 120_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;

export async function supervisorsCommand(config, { action = 'list', id = null, json = false, holder = null,
                                                   c = { ok: s => s, bad: s => s, warn: s => s, dim: s => s, b: s => s } } = {}) {
  const declared = config.supervisors ?? {};
  if (action === 'list') {
    const rows = describeSupervisors(config);
    if (json) { console.log(JSON.stringify(rows, null, 1)); return 0; }
    if (!rows.length) { console.log(c.dim('this doctrine declares no supervisors')); return 0; }
    console.log(c.b('id'.padEnd(22) + 'need'.padEnd(10) + 'pin'.padEnd(20) + 'up'.padEnd(5) + 'pid'.padEnd(8) +
      'age'.padEnd(6) + 'commit'.padEnd(10) + 'pin ok  why'));
    for (const r of rows) {
      const up = r.running ? c.ok('yes') : (r.need === 'must' ? c.bad('NO ') : c.warn('no '));
      const pin = r.pin ? `${String(r.pin).slice(0, 10)} ${r.pin_mode === 'exact' ? '=' : '>='}` : '-';
      const ok = r.pin_ok == null ? '-' : r.pin_ok ? c.ok('yes') : c.bad('NO ');
      console.log(`${r.id.padEnd(22)}${String(r.need).padEnd(10)}${pin.padEnd(20)}${up}  ` +
        `${String(r.pid ?? '-').padEnd(8)}${age(r.heartbeat_age_ms).padEnd(6)}` +
        `${(r.commit ? r.commit.slice(0, 8) + (r.dirty ? '*' : '') : '-').padEnd(10)}${ok}     ${c.dim(r.why ?? '')}`);
    }
    return rows.some(r => r.need === 'must' && r.enabled && (!r.running || r.pin_ok === false)) ? 1 : 0;
  }
  if (!id || !declared[id]) {
    console.log(c.bad(`no supervisor "${id ?? ''}" is declared. Declared: ${Object.keys(declared).join(', ') || '(none)'}`));
    return 2;
  }
  if (action === 'stop') {
    const dir = stateDirFor(declared[id], config);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stopFile(dir, id), `requested by ${holder ?? 'dum'} ${new Date().toISOString()}\n`);
    console.log(`wrote ${stopFile(dir, id)} — ${id} exits at its next look`);
    return 0;
  }
  if (action === 'start') {
    // The same path a committed run takes, for this one id, ignoring `start: false` and need:
    // the operator asked by name.
    const one = { ...config, supervisors: { [id]: { ...declared[id], need: 'must', start: true } } };
    const [row] = ensureSupervisors(one, { start: def => startSupervisor({ ...def, need: declared[id].need,
      requested_by: holder ?? undefined }), memo: {}, allowStart: true });
    console.log(`${id}: ${row.state} — ${row.why}`);
    return ['running', 'started'].includes(row.state) ? 0 : 1;
  }
  console.log(c.bad(`unknown action "${action}" — list, start <id> or stop <id>`));
  return 2;
}
