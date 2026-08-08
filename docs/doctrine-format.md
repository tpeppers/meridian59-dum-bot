# Doctrine format

A doctrine is the drop-in file that says what DUM is for. It is JSONC — JSON plus
`//` and `/* */` comments and **nothing else**: no trailing commas, no single
quotes, no unquoted keys. Each of those is a small convenience bought with a parser
that can disagree with every other JSON reader about what a file means.

Comments are not decoration. A threshold without a reason is how a fleet ends up
grinding worthless prey for an afternoon while the board reads healthy.

## Layers

```
built-in defaults  <-  doctrine file (and anything it extends)  <-  characters.<agent>  <-  --set
```

Later layers win. Arrays **replace**, they do not concatenate — otherwise "fewer
rooms" would be inexpressible. Every effective leaf remembers which layer set it:

```bash
node bin/dum.mjs explain --doctrine doctrines/valley-grind.jsonc
```

That output is the answer to "why is this character banking at 500", and it exists
because a fleet's settings drift by exactly the mechanism of somebody passing a flag
once and nobody being able to say later whether the number was chosen or inherited.

## Top level

| key | type | notes |
|---|---|---|
| `extends` | string | path relative to this file. Resolved innermost-first; cycles are an error |
| `fleet` | string \| null | **required to `--commit`.** No default, ever — see below |
| `name` | string | shown in the journal and in `plan` output |
| `why` | string | what this doctrine is trying to prove |
| `characters` | object | per-agent patches, applied only with `--agent` |

### `fleet` has no default and never will

Every harness fleet tool takes `--fleet` and every one of them used to be silent
about it, which is the whole problem: passing the wrong one, or none, operates on
the wrong fleet and does so quietly. A restart aimed at the wrong roster once
stopped a live 46-session broker and reported success at every step.

So: a doctrine with no fleet can be *planned* against anything and can never be
committed, and `--commit` additionally requires the broker's `/health` to report
that exact fleet.

## `claim` — which decisions DUM takes

```jsonc
"claim": {
  "identity": "keeper", "mortality": "keeper",
  "survival": "keeper", "recovery": "keeper",
  "work": "bot", "movement": "bot", "economy": "bot",
  "social": "keeper",
  "lease_ms": 120000
}
```

Each faculty is `keeper`, `bot`, or `off`. A rule may only fire if its faculty is
`bot`, which is where the whole split is enforced.

**Claiming `survival` or `mortality` requires**
`"i_accept_the_character_may_die": true` spelled out in the file. That is not
theatre. The survival ladder is what keeps a character alive when DUM has crashed,
been `Ctrl-C`'d, or was never started, and the failure mode of claiming it quietly
is a character standing still while something eats it.

`"mortality": "off"` is refused outright: the Underworld has no graph exits, so a
character nothing walks out of stays there for ever.

## `goals.ladder` — what a character is trying to become

An ordered list. **The first rung whose `until` is not met is the active one.**

```jsonc
{
  "id": "reach-30-max-health",
  "until":  { "kind": "max_health", "at_least": 30 },
  "orders": { "mode": "farm", "strategy": "wellfed", "use_safe_spots": true },
  "why": "below 30 max health there is no room to be wrong in a fight"
}
```

That ordering makes the ladder **self-healing with no state anywhere**. A character
that dies back below a threshold falls to the earlier rung automatically, because
the active rung is a pure function of the character's current numbers. Nothing has
to remember where it was, and nothing can disagree about it after a restart.

`until.kind` is one of:

| kind | read from | note |
|---|---|---|
| `max_health` | vitals | the advancement currency here — the game's own rule compares a creature's level against base max health |
| `level` | status | |
| `skill`, `spell` | `progress` (extra read, fetched only if a rung uses it) | needs `name` as well |
| `shillings_banked` | `bank` / `progress` | |
| `kills` | keeper tally | **poor completion test**: a keeper restart resets it, so on a fleet whose keepers restart often it mostly measures uptime |

**Every rung needs an `until` and a `why`, enforced at load.** A rung with no
completion test never completes, so the character farms it for ever while the board
reports steady progress — the same failure the harness records for prey.

Missing evidence is **unanswerable, not incomplete**: if the harness did not report
a skill, DUM says so and does nothing, rather than parking the character on a rung
it may have finished weeks ago.

`goals.on_complete` is `hold` (leave the last rung's orders), `idle` (stand down), or
`report` (write a finding — the character has outgrown its doctrine, and inventing a
new one is an operator decision).

## `orders` — what a rung may set

These are diffed against the keeper's live policy, so a rung that agrees with the
keeper sends nothing.

`mode` `hunt` `strategy` `purpose` `assigned_room` `partner` `rest_below`
`flee_below` `max_carry` `bank_above` `roam` `roam_limit` `weapon_priority`
`drop_junk` `use_safe_spots` `hold_resume_above` `fight_above_vigor` `pull_within`
`decide_ms` `resync_ms` `break_out_via_logoff`

Anything else **throws** rather than being dropped — a doctrine setting that never
takes is the failure that check exists for. To add one, add a row to `ORDER_FIELDS`
in `src/act/orders.mjs` naming the keeper-policy key it maps to.

## `yield_to` — fields something else owns

```jsonc
"yield_to": ["rest_below", "max_carry", "roam"]
```

A fleet may already have a supervisor outside the harness repository restarting
stalled keepers roughly every 60s and reapplying its own `rest_below`, `max_carry`
and `roam`. Two writers on the same field at different cadences is **not a race to be
won** — the character's orders oscillate and *both* writers' logs look correct, which
is the worst possible combination for noticing.

A yielded field is dropped from the diff before it is compared, and the drop is
journalled — so "DUM is not setting `max_carry`" is visible rather than mysterious,
and it stays visible when the other writer changes its mind. Names are checked against
the order-field list at load, because a typo fails in the dangerous direction: the
field would not be yielded and DUM would write it anyway.

Also available as `--yield-to rest_below,max_carry,roam`.

## `prey`, `placement`, `economy`, `party`, `escalate`

See the commented examples in [`../doctrines/`](../doctrines/). Two conventions run
through all of them:

**`null` means "leave the keeper's own value alone", and it is not the same as
writing the harness's default back.** Asserting a default is a *write*: it lands in
the roster and pins a value that would otherwise move when the harness's default
moved.

**Anything that moves characters is off by default.** `placement.spread` and
`party.pair` both stop keepers and walk characters across the world, and both have
recorded thrash failures behind them. They are opted into deliberately, in their own
run, so the result is measurable.

## Per-character overrides

```jsonc
"characters": {
  "role-scout": { "placement": { "rooms": [71] } }
}
```

Applied only with `--agent`, and beating the fleet-wide section of the same file.
Planning a whole fleet with a doctrine that has per-character sections **warns**,
because it silently plans only half the doctrine.

**Keys here are agent names, and agent names identify accounts on a shared server.**
A doctrine that needs them belongs in `doctrines/local/`, which is gitignored.
Everything tracked in this repository addresses characters by role.
