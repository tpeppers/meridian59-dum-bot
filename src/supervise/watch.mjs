// DUM'S SIDE OF THE SUPERVISOR REGISTRY: CHECK ON A CLOCK, START ONLY WHEN COMMITTED.
//
// The tick calls `check()` once per fleet pass; the real work runs at most every
// `supervisor_check_ms` (a handful of git calls per declared supervisor) and the cached
// answer is returned in between. A `plan` run reads and reports and never starts anything,
// for the same reason a plan never writes an order: a plan must not change the world.

import { ensureSupervisors, byId } from './registry.mjs';
import { startSupervisor } from './spawn.mjs';

export class SupervisorWatch {
  constructor({ config, commit = false, journal = null, holder = null, deps = {}, echo = true }) {
    this.echo = echo;
    this.config = config;
    this.commit = commit;
    this.journal = journal;
    this.holder = holder;
    this.deps = deps;
    this.memo = {};
    this.last = null;
    this.lastAt = -Infinity;
  }

  get declared() { return Object.keys(this.config.supervisors ?? {}).length > 0; }

  /** {id: row} — the shape `obs.supervisors` carries. Null when the doctrine declares none. */
  check(now = Date.now(), { force = false } = {}) {
    if (!this.declared) return null;
    const every = Number(this.config.supervisor_check_ms ?? 30_000);
    if (!force && this.last && now - this.lastAt < every) return this.last;
    const start = this.deps.start ?? (def => startSupervisor({ ...def, requested_by: this.holder ?? undefined }));
    const rows = ensureSupervisors(this.config, {
      now, start, memo: this.memo, allowStart: this.commit,
      git: this.deps.git, pidAlive: this.deps.pidAlive, readHeartbeat: this.deps.readHeartbeat,
      stop: this.deps.stop,
      log: e => {
        this.journal?.write?.({ ...e, why: e.why ?? e.kind });
        if (this.echo && (e.kind === 'supervisor_warning' || e.kind === 'supervisor_start_failed'))
          process.stderr.write(`supervisor ${e.id} (${e.need}): ${e.state ?? 'start failed'} — ${e.why}\n`);
      },
    });
    this.last = byId(rows);
    this.lastAt = now;
    return this.last;
  }
}
