# meridian59-dum-bot — instructions for an agent working in this repository

## What this is

The **if-then-else half** of a Meridian 59 character's mind, carved out of
`m59-harness` so that it can be replaced. There is no language model in this
repository and there must never be one. If a decision here needs a model, it
belongs in `meridian59-llm-bot` instead, and the interesting fact is *which*
decision it was.

The bet: most of what a model is currently asked to decide for a grinding
character is a table with a `why` column. This repository is that table. Its
value is that it makes the model's contribution measurable — same fleet, same
doctrine, one driven by DUM and one by the LLM bot.

## Absolute rules

1. **Never start a broker.** DUM attaches to the one already holding the fleet.
   Starting a second one gets refused the lock, comes up healthy and *empty*, and
   answers every question about a fleet of nobody. `src/link/broker.mjs` has no
   spawn path and must not grow one.
2. **Never call the harness's `leave` tool.** It drops the roster, and the roster
   files are the only record of the account passwords. `src/link/surface.mjs`
   holds the allow-list; `leave`, `join` and `reroll` are on the deny side of it.
3. **`--dry-run` is the default.** Acting requires `--commit`, and `--commit`
   requires that the broker's `/health` reports the fleet the doctrine names. The
   mismatch check is not optional and not a warning — it exits non-zero.
4. **Nothing identifying the fleet goes in a tracked file** — not a character
   name, not an account handle, not a password, not the server address, not the
   fleet's own name. Doctrines in `doctrines/` address characters by *role*,
   never by name; anything that must name one goes in `doctrines/local/`, which
   is gitignored. This is `m59-bard`'s rule and for the same reason: the
   repository is public and the accounts are on a shared server.

   **`tools/dum-guard.mjs` enforces it rather than trusting it.** Run it before
   every push:

   ```bash
   npm run preflight          # the offline tests, then the guard
   node tools/dum-guard.mjs --staged --verbose
   ```

   It builds the forbidden set from the harness's rosters, the bard's snapshots
   and DUM's own journal — all of which are gitignored in their own repositories
   — and greps everything git is tracking. It exits non-zero on a hit and names
   the file and line. **It also exits non-zero when it finds no roster at all**,
   because a check with nothing to check against reports zero hits and that
   reading is indistinguishable from a real pass.

   On its first run it caught three things, one of them in its own source: a
   README example naming a live character, two doctrines naming the live fleet,
   and a comment in the guard itself that illustrated "short account handles"
   with two real ones — which on this fleet are two real passwords. Quoting,
   illustrating, and "it's already public elsewhere" are exactly the
   reasonable-sounding exceptions this check exists so that nobody has to weigh.
5. **The survival floor is the keeper's.** DUM does not claim `survival` or
   `mortality` unless a doctrine spells out
   `"i_accept_the_character_may_die": true`. An unattended character — one whose
   bot has crashed, been `Ctrl-C`'d, or simply never started — must still run
   from a fight it is losing. Everything about the split is downstream of that.

## The boundary, in one table

**The split is by CLOCK, not by importance.** The same table is in the harness's
`CLAUDE.md` and neither copy is the summary of the other — if you change one, change both.

| | decides at | owner | examples |
|---|---|---|---|
| identity, mortality, survival, recovery | **1s** | **the harness, always** | am I dead; something is hitting me; sit down while hurt and safe; get out of the Underworld |
| unstick a stalled keeper | 60s | **the harness** (`m59-supervise.mjs`) | telling a deliberate refusal from a stall needs keeper internals, and it runs on characters DUM holds too |
| work, movement, economy, social | minutes | **DUM** | what to hunt; which room; which errands to stop for; when to bank |

DUM ticks at thirty seconds. A survival rule here would be acting on information that is
on average fifteen seconds old, against a keeper that has better information and is
already acting on it. That is the whole argument, and everything else follows from it.

### Claiming is not being busy, and the difference is load-bearing

DUM claims `work`/`movement` on every character it manages, for its whole run. That is
**ownership** — the board shows `held_by`, and the character stays *takeable*. If mere
ownership read as a commitment, `respect-commitment` would refuse every character DUM
just claimed, the fleet board would grey every row, and the harness's unstick round would
step over keepers that had genuinely stopped.

`busy` is the other half: the holder saying an operation is *in flight*. `runErrand`
declares it before the first step and frees it after the last one **including after a
failure** — the lease heals a forgotten one, but ten minutes of every stall detector
politely stepping over a genuinely stuck character is not a good outcome. A dry run
declares nothing at all, because a plan must not change what the fleet believes.

## Where the fleet actually is

This repository holds no roster, no credentials and no server address. It reads
all three from the running broker, and it must be *told* which fleet it is
allowed to act on by the doctrine's `fleet:` field. Before doing anything else in
a session:

```bash
node ../m59-harness/tools/m59-which.mjs      # who is holding what, right now
node bin/dum.mjs doctor                      # and does DUM agree
```

`doctor` exits non-zero on a mismatch. That check is the reason it exists.

## Layout

```
bin/dum.mjs          the only entry point
src/link/            everything that touches the harness. Nothing else may fetch()
src/sense/           harness responses -> a normalised Observation
src/decide/          the rule table. Pure functions. No I/O, no clock, no randomness
src/act/             Intent -> harness orders, diffed, then verified
src/loop/            cadence and the per-character / per-fleet ticks
src/record/          append-only journal, the keyed memory, and the trace exporter
src/config/          layered doctrine loading
doctrines/           worked examples, no character names
tests/               offline. No broker, no server, no network
```

**`src/decide/` must stay pure.** Every rule is `(observation, doctrine) =>
Intent | null`, deterministic, with no `Date.now()`, no `Math.random()`, no
network. That is what makes the tests fixture-driven and what makes a bad
decision reproducible from its journal entry alone. If a rule needs the time,
the time arrives in the observation.

**And if a rule needs the PAST, that arrives in the observation too.** Some
decisions are not answerable from any read of the world — the crate under Castle
Victoria is the worked case: its timer has no packet, and the character it will
silently refuse is server-side state that produces no error, only a missing item.
`src/record/memory.mjs` is where those facts live. The tick reads it once and puts
it on the observation, exactly as it does the clock; a rule that opened the file
itself would break purity for the same reason `Date.now()` would.

Two things about it that read backwards, both in that file's own comments:
**unknown is not zero** — a missing memory must resolve to "go and look", so losing
it costs one walk rather than the behaviour — and **an errand is the one write with
nothing to diff against**, so what stops it re-firing every tick is the emitting
rule's memory and nothing else. A rule that emits an errand off a condition alone
produces a character that lives in a basement.

## Working here

- Zero dependencies, Node ESM, same as the harness's `tools/`. If something here
  needs a package, that is a signal the thing belongs elsewhere.
- `node tests/run.mjs` is offline and safe at any time.
- A rule without a `why` is not finished. The `why` ends up in the journal and in
  `plan` output, and it is the entire user interface for "the fleet is doing
  something strange."
- Changing a default threshold changes what twenty-one live characters do. Say so
  in the commit message, and prefer changing the doctrine over changing the
  default.

## Do not carry the harness's code over here

If a fix belongs to perception, geometry, safe spots, pacing, or the survival
ladder, it belongs *in* `m59-harness`, not in a copy here. This repository holds
no harness source and reads no harness file. The one thing it is allowed to know
about the harness is its control surface, and that is written down in
[`docs/harness-contract.md`](docs/harness-contract.md) — a document that should
be updated by the same commit that starts depending on something new.
