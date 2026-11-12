// THE ONE PLACE DUM STARTS A PROCESS, AND WHAT IT PROMISES ABOUT IT.
//
// Kept apart from registry.mjs so that tests stub it and nothing offline can ever launch
// anything. It starts a SUPERVISOR — never a broker (CLAUDE.md, absolute rule 1): the entry
// is whatever the doctrine declared, and the registry has already checked its pin.
//
// Detached and unref'd, so the supervisor outlives this DUM process: a supervisor is a
// dependency of the fleet's orders, not a child of whoever noticed it was down. Its output
// goes to `<state_dir>/<id>.out`, because a process whose output went to the terminal that
// started it has no output the moment that terminal closes.

import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stopFile } from './registry.mjs';

/**
 * @param {object} def  a resolved declaration: {id, entry, state_dir, fleet, control, cwd, env, args, requested_by}
 * @returns {{ok: boolean, pid?: number, why?: string}}
 */
export function startSupervisor(def) {
  try {
    if (!existsSync(def.entry)) return { ok: false, why: `entry ${def.entry} does not exist` };
    mkdirSync(def.state_dir, { recursive: true });
    // A stop file left by the last run would stop this one on its first look.
    rmSync(stopFile(def.state_dir, def.id), { force: true });
    const args = [def.entry, '--state-dir', def.state_dir];
    if (def.fleet) args.push('--fleet', String(def.fleet));
    if (def.control) args.push('--control', String(def.control));
    args.push(...[].concat(def.args ?? []).map(String));
    const out = openSync(join(def.state_dir, `${def.id}.out`), 'a');
    const child = spawn(process.execPath, args, {
      cwd: def.cwd ?? dirname(def.entry),
      env: { ...process.env, ...(def.env ?? {}),
             ...(def.fleet ? { M59_FLEET: String(def.fleet) } : {}),
             M59_SUPERVISOR_STATE_DIR: def.state_dir,
             M59_SUPERVISOR_ID: def.id,
             M59_SUPERVISOR_REQUESTED_BY: def.requested_by ?? `dum@pid-${process.pid}` },
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    closeSync(out);
    child.unref();
    return { ok: Number.isInteger(child.pid), pid: child.pid, why: child.pid ? null : 'spawn returned no pid' };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}
