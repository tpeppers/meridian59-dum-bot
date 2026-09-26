// ONE DIRECTOR PER FLEET. A second `dum run --commit` against a fleet that is already directed
// is refused before it claims, ticks or listens — unless it says --force.
//
// WHY. Two DUMs on one fleet each think they own the directional faculties, each re-asserts its
// posture every pass, and each holds leases under its own `dum/<name>@pid-<n>` holder string that
// only it can release. The broker cannot arbitrate between two holders it believes are both
// legitimate, so the characters oscillate between two sets of orders while both journals read
// correct. On 2026-09-25 a restart script started a second fleet DUM because its "is the old one
// still there" check failed on a trailing space in a command line. The duplicate died of
// EADDRINUSE on the control port — AFTER it had loaded the doctrine and opened its journal. That
// was luck, not a guard: a doctrine with a different `link.strategy_control_url` would have run.
//
// TWO CHECKS, BECAUSE EACH COVERS THE OTHER'S BLIND SPOT.
//
//   LOCK FILE  keyed by fleet AND scope — the whole fleet, or the exact `--agent` set — so a
//              single-character run (a posted caster the fleet doctrine marks `not_ours`) can
//              still sit beside the fleet director, while a second copy of either is refused.
//              It lives in a MACHINE-WIDE directory, not this checkout's `var/`: a lock inside a
//              checkout is invisible to a DUM started from another worktree, which is exactly
//              the trap m59-harness's run lock documents ("the lock does not span checkouts").
//   CONTROL    the doctrine's own control URL answering /health for the same fleet with another
//   PROBE      pid. This catches a DUM started before this guard existed (it wrote no lock),
//              and one started from a checkout with a different lock directory.
//
// A STALE LOCK IS NOT A LIVE DIRECTOR. A lock whose pid is gone is taken over silently; pids are
// recycled, so a live pid is only believed when its recorded start time is within a few seconds
// of the process's actual one where the platform can tell us — otherwise it is believed (refusing
// wrongly costs a --force; starting a second director costs the fleet).
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const LOCK_DIR = () => process.env.M59_DUM_LOCK_DIR || join(homedir(), '.m59-dum', 'locks');

/** The scope a run directs: 'fleet', or the sorted agent list it was confined to. */
export function scopeKey(only) {
  return Array.isArray(only) && only.length ? 'agents-' + [...only].map(String).sort().join('+') : 'fleet';
}

export function lockPath({ fleet, only, dir = LOCK_DIR() }) {
  const safe = s => String(s).replace(/[^A-Za-z0-9_+.-]/g, '_');
  return join(dir, `dum-${safe(fleet ?? 'default')}-${safe(scopeKey(only))}.lock`);
}

/** Is this pid a running process? `process.kill(pid, 0)` sends nothing; it only asks. */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // exists, not ours to signal
}

/**
 * The decision, pure given its inputs so every case is testable.
 *   lock    the parsed lock file, or null
 *   health  the control URL's /health reply, or null when nothing answered
 *   self    { pid, fleet }
 *   alive   pid -> boolean
 * Returns { ok, why, other }.
 */
export function decide({ lock, health, self, alive = pidAlive }) {
  if (lock && lock.pid !== self.pid && alive(lock.pid))
    return { ok: false, other: lock,
             why: `a DUM (pid ${lock.pid}, "${lock.doctrine ?? '?'}") already directs ${lock.scope} of fleet ` +
                  `"${lock.fleet}" since ${lock.started_at ?? '?'} — lock ${lock.path ?? ''}` };
  if (health?.ok && health.fleet === self.fleet && Number.isInteger(health.pid) && health.pid !== self.pid
      && alive(health.pid))
    return { ok: false, other: health,
             why: `a DUM (pid ${health.pid}) is answering this doctrine's control URL for fleet ` +
                  `"${health.fleet}" (root ${health.root ?? '?'})` };
  return { ok: true, why: lock && !alive(lock.pid) ? `stale lock from pid ${lock.pid} taken over` : null };
}

async function probe(url, ms = 2500) {
  if (!url) return null;
  try {
    const r = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(ms) });
    return await r.json();
  } catch { return null; }
}

/**
 * Take the director's seat, or throw. Call before anything claims, ticks or listens.
 * Returns a release function; it is also run on process exit.
 */
export async function acquireRunGuard({ config, only, force = false, pid = process.pid, log = console.log }) {
  const fleet = config.fleet;
  const path = lockPath({ fleet, only });
  let lock = null;
  try { lock = existsSync(path) ? { ...JSON.parse(readFileSync(path, 'utf8')), path } : null; } catch { lock = null; }
  const health = await probe(config.link?.strategy_control_url);
  const verdict = decide({ lock, health, self: { pid, fleet } });

  if (!verdict.ok && !force) {
    const e = new Error(`refusing to start a second director: ${verdict.why}.\n` +
      `  Stop that process first (it releases its leases on Ctrl-C), or pass --force if you really ` +
      `mean to run two — the fleet's characters will receive two sets of orders.`);
    e.exitCode = 3;
    throw e;
  }
  if (!verdict.ok && force) log(`WARNING --force: starting anyway. ${verdict.why}`);
  else if (verdict.why) log(verdict.why);

  mkdirSync(LOCK_DIR(), { recursive: true });
  const mine = { pid, fleet, scope: scopeKey(only), doctrine: config.name ?? null,
                 cwd: process.cwd(), url: config.link?.strategy_control_url ?? null,
                 started_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(mine, null, 1) + '\n');
  const release = () => {
    try {
      const now = JSON.parse(readFileSync(path, 'utf8'));
      if (now.pid === pid) rmSync(path, { force: true });   // never remove somebody else's
    } catch { /* already gone */ }
  };
  process.once('exit', release);
  return release;
}
