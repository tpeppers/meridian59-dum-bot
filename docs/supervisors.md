# Supervisors — collective plans DUM depends on

DUM decides **per character**: what each one farms, trains, carries. Some plans are not
per character. One character sings a room enchantment while the others farm under it; a
courier laps between the farm and town; a desk character enchants everybody else's
weapons. Those run as separate long-lived processes — **supervisors** — and until now
they were 100–150 KB hand-written scripts, each re-implementing the same plumbing, and
DUM had no idea whether one was running.

That matters because some stations only make sense with their supervisor up. Send the
farmers to the room whose buff nobody is singing and every board reads healthy while the
farm pays half. So a doctrine can now **declare** the supervisors it depends on, and a
station or ladder rung can **require** one.

## Declaring a supervisor

```jsonc
"supervisors": {
  "room-buff": {
    "need": "must",                                     // or "optional"
    "entry": "private:supervisors/room-buff.mjs",       // see "Where an entry lives"
    "pin": "3f2c9a1",                                   // commit sha or ref
    "pin_mode": "at_least",                             // or "exact" (default at_least)
    "pin_paths": ["supervisors/lib"],                   // optional: also pinned, relative to the repo
    "args": ["--config", "var/supervisors/room-buff.json"],
    "env": { "SOME_KNOB": "1" },
    "start": true,                                      // default: true for must, false for optional
    "restart_on_mismatch": false,
    "enabled": true                                     // false: reported as `disabled`, never started
    // also: "repo", "cwd", "state_dir"
  }
},
"shift": { "stations": [
  { "room": 552, "hunt": "...", "requires_supervisors": ["room-buff"] }
] },
"goals": { "ladder": [
  { "id": "...", "until": {...}, "why": "...", "requires_supervisors": ["room-buff"] }
] }
```

| need | while the supervisor is down |
|---|---|
| `must` | DUM **starts it** (if `start` is not false and the pin is satisfied), and **withholds** every station/rung that requires it until it is `running` or `started` |
| `optional` | a warning, at most once per ten minutes. Never started unless `start: true`. Never withholds |

**Withheld means "leave the character's existing orders alone"**, not "send it somewhere
else". The station keeps its units allocated; the shift just sends them nothing this pass,
and the pass's `why` says so. A withheld ladder rung takes the character's turn with a
`none` intent, so a lower rule cannot re-place a character that is merely waiting. Each
change in the withheld set is journalled once as `kind: "supervisor_withheld"` (including
the release, with an empty list), and every fleet-tick line carries `supervisors` and
`supervisor_withheld`.

The schema refuses: a `requires_supervisors` id that is not declared (an undeclared
dependency gates nothing, silently); a `need` other than the two; a `must` without a
`pin`; unknown keys in a declaration.

## Pins

A pin says which code the doctrine was written against. Two modes:

| mode | satisfied when |
|---|---|
| `exact` | the commit is the pin and the pinned paths are clean — **or** the pinned paths (the entry, plus `pin_paths`) are byte-identical between the pin and the working tree (`git diff --quiet <pin> -- <paths>`) |
| `at_least` | the pin is an ancestor of the commit (`git merge-base --is-ancestor`) **and** the pinned paths are clean in the working tree |

For a supervisor that is **not running**, "the commit" is the repository's HEAD: DUM
checks the tree it is about to launch, and refuses to start it (`pin_mismatch`) if the pin
is not met. For a supervisor that **is running**, "the commit" is the one its heartbeat
reports — what is actually executing. A running supervisor at a refused commit is
`pin_mismatch` and warned about; it is restarted only with `restart_on_mismatch: true`, by
writing its stop file and starting the new code once it has exited.

## States

`dum.mjs supervisors` and `obs.supervisors` report one of:

| state | meaning |
|---|---|
| `running` | live pid, heartbeat under 60 s, pin satisfied |
| `started` | DUM launched it within the last minute and the pid is alive; waiting for its first heartbeat |
| `missing` | not running and not being started (optional, `start: false`, a plan run, or backing off after a launch that died) |
| `pin_mismatch` | running at a refused commit, or the tree on disk fails the pin so it was not started |
| `start_failed` | the launch itself failed |
| `disabled` | `enabled: false` |

A `must` dependency gates its dependents open only in `running` and `started`.

At most one start attempt per id per 60 s. Only a **committed** `run` starts anything;
`plan` reports what it found. DUM consults the registry at most every
`supervisor_check_ms` (30 s default) and reuses the answer in between.

A launched supervisor is `node <entry> --state-dir <dir> --fleet <fleet> --control <url> ...args`,
detached, cwd `cwd` or the entry's directory, with `M59_FLEET`, `M59_SUPERVISOR_ID`,
`M59_SUPERVISOR_STATE_DIR` and `M59_SUPERVISOR_REQUESTED_BY` in its environment and its
output appended to `<state_dir>/<id>.out`. Any stale stop file is removed first.

## The heartbeat contract

A supervisor is "running" because it writes **`<state_dir>/<id>.supervisor.json`** at
start and then at least every 15 s (the base class writes every 10 s):

```json
{
  "schema": 1,
  "id": "room-buff",
  "pid": 12345,
  "started_at": "2026-11-12T12:00:00.000Z",
  "heartbeat_at": "2026-11-12T12:03:10.000Z",
  "fleet": "<fleet name>",
  "entry": "<absolute path of the entry file>",
  "repo": "<git toplevel of the entry, or null>",
  "commit": "<git HEAD sha of that repo at start, or null>",
  "dirty": false,
  "status": "running",
  "requested_by": "dum/<doctrine>@pid-678"
}
```

- `status` is `running`, `stopping` while it tears down, and `stopped` on a clean exit.
- `dirty` is true when the entry file differs from HEAD (or is untracked).
- `requested_by` is optional; DUM sets `M59_SUPERVISOR_REQUESTED_BY` when it starts one.
- The id in the file name is the **declared** id. A supervisor started by DUM reads it from
  `M59_SUPERVISOR_ID`.
- Write it atomically (temp file + rename). Readers strip a UTF-8 BOM.
- The stop file is `<state_dir>/<id>.stop`; a supervisor exits when it appears.
- The legacy `<state_dir>/<id>.pid` is still written by the base class for older tooling.

**A script not built on the base class satisfies the registry by writing this file
itself** — an older private supervisor needs ten lines: write the JSON at start and on a
`setInterval`, with `commit` from `git rev-parse HEAD`, and `status: "stopped"` on exit.
Without a `commit` the registry cannot check a pin, so such a supervisor is reported as
`pin_mismatch` when its declaration has one.

## Where an entry lives

Machine facts — the state directory and the roots — never go in a tracked doctrine. They
come from `dum.local.json`, the environment, or the command line:

```json
{ "supervisor_state_dir": "var/supervisors",
  "supervisor_roots": { "private": "<path to the private checkout>" } }
```

- `"private:supervisors/x.mjs"` resolves against `supervisor_roots.private`. A root that
  is not configured on this machine makes the supervisor `missing`, with that reason.
- `"dum:supervisors/x.mjs"` and a bare relative path resolve against this repository.
- An absolute path is accepted in a **local** doctrine; `tools/dum-guard.mjs` refuses a
  machine path in any tracked doctrine.

`--supervisor-state-dir <dir>` (or `M59_SUPERVISOR_STATE_DIR`) and the repeatable
`--supervisor-root name=dir` override the local file. With nothing set, heartbeats live in
`<dum>/var/supervisors`.

## The command

```bash
node bin/dum.mjs supervisors [--json]     # need, pin, up?, pid, heartbeat age, commit, pin ok?, why
node bin/dum.mjs supervisors start <id>   # start it now; the pin is checked first
node bin/dum.mjs supervisors stop <id>    # write its stop file
```

The table exits non-zero when an enabled `must` supervisor is down or off its pin. It
talks to no broker.

## Deriving a supervisor

`src/supervise/base.mjs` exports `Supervisor` and `supervisorMain`. The base class owns
the plumbing; a subclass owns only its plan:

```js
import { pathToFileURL } from 'node:url';
import { Supervisor, supervisorMain } from '<dum>/src/supervise/base.mjs';

export class Courier extends Supervisor {
  constructor(o) { super({ ...o, defaults: { runner: null, exclude: [] } }); }
  async setup() { /* read state, check prerequisites */ }
  loops() { return [{ name: 'lap', fn: () => this.lap(), everyMs: 20_000 }]; }
  async lap() {
    const c = this.conf();                       // re-read every call
    const row = await this.row(c.runner);        // board row, fleet cached ~2 s
    if (!this.hands(row)) return;                // piloted / held / dead / out of game / excluded
    const r = await this.order(c.runner, { mode: 'farm' }, 'why this order');
    this.log('ordered', { ok: this.didOrder(r) });
  }
  async teardown() { /* leave the bodies in a sane posture */ }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await supervisorMain(Courier, { id: 'courier', entryFile: import.meta.url });
```

What the base class gives you:

| | |
|---|---|
| `rpc(tool, args, timeoutMs)` | MCP `tools/call` to `${control}/mcp`; unwraps `result.content[0].text` as JSON when it parses. **Errors throw** — a tool error, an RPC error, HTTP, a timeout. Write `.catch(() => null)` at the call site if you mean it |
| `fleet()`, `row(agent)`, `status(agent)` | the board (cached ~2 s, shared between concurrent callers), one row, the autopilot status |
| `order(agent, policy, why)`, `didOrder(reply)` | `autopilot start` with the policy fields and `why: "<id>: ..."`; errors come back as `{error}`. `didOrder` reads `keeper_push.confirmed` on a keeper-backed reply |
| `hands(row)`, `excluded(agent)` | may this supervisor touch the body; config `exclude[]` |
| `conf()` | the `--config` JSON, re-read each call, BOM stripped. **A file that does not parse keeps the last good config** and logs `CONFIG DID NOT PARSE` once per distinct error |
| `log(what, data)` | NDJSON `{at, what, ...data}` to `<state_dir>/<id>.log` |
| `stopped()`, `loop(name, fn, everyMs)` | the stop file; a loop that logs and survives a throwing iteration |
| `busy`, `withBusy(agent, fn)` | per-agent mutual exclusion between loops |
| `checkFleet()` | `/health` must report this fleet; `run()` calls it before `setup()` and refuses otherwise |
| `run()` | heartbeat → fleet check → `setup()` → the `loops()` → wait for stop/SIGINT/SIGTERM → `teardown()` → heartbeat `stopped` |

`supervisorMain` reads `--id`, `--fleet`, `--state-dir`, `--config` and `--control`
(or `M59_SUPERVISOR_ID`, `M59_FLEET`, `M59_SUPERVISOR_STATE_DIR`, `M59_SUPERVISOR_CONFIG`,
`M59_CONTROL_URL`). The base class makes no repo-relative assumption, so a private
supervisor imports it by path from another checkout.

`supervisors/example-room-buff.mjs` is the worked example: one configured singer posted
with a keeper `room_enchant` order while at least `min_farmers` of the configured farmers
stand in the room, stood down when they leave. Every agent and room comes from its config.
