# What DUM needs from the harness

This is the interface half of the argument. The reasoning, the phasing, and the
recommendations addressed *to* `m59-harness` live in
[`../../meridian59-dum-bot-fit-report.md`](../../meridian59-dum-bot-fit-report.md);
this file states, tersely, what DUM depends on today and what it is waiting for.

**Rule:** this document is updated by the same commit that starts depending on
something new. A dependency nobody wrote down is how two repositories drift.

---

## What DUM depends on today, and it all exists

| dependency | how DUM uses it |
|---|---|
| `GET /health` → `{fleet, pid, sessions[], root}` | the fleet guard. `--commit` refuses unless `health.fleet` equals the doctrine's fleet |
| `POST /` JSON-RPC `tools/call` | every read and write |
| `tools/list` | `doctor` checks that every tool DUM may call exists on this broker |
| `fleet` | the tick's spine: one call, N characters, with `stalled`, `parked`, `commitment` |
| `status` | per-character vitals, room, keeper policy, keeper mode, commitment |
| `progress`, `prey`, `inventory`, `bank` | fetched only when a loaded rule declared it needs them; opt-in crate outcome logging brackets the crate action with two inventory reads |
| `autopilot` (`action: start`) | the single write surface for orders, including nullable `strategy_stats` settings for keeper-side detail collection |
| `cast` (`create weapon` and `create food` only) | audited self-only maintenance spells; opt-in food outcome logging adds `observe_created:true` so the result carries a positive inventory delta |
| `commitment` on the board | which characters the fleet is already using |
| `travel`, `walk_to` | the two halves of an errand's movement. Both are a character *walking* at roughly a second a square, so a step may raise its own timeout — see `Broker.call` |
| `act` **with `verb: "go"` only** | the only way to work a place-triggered square. `UserGo` (`user.kod:5656`) answers on whatever square the character is standing on, which is the mechanism behind stairs, doors, ladders and the Castle Victoria crate. Every other verb `act` carries reaches into the pack and is refused at the surface |

DUM never calls `leave`, `join`, `reroll`, `godmode`, or `autopilot hard:true`, and
`src/link/surface.mjs` refuses them rather than trusting itself.

### The thing `act verb:"go"` needs that is not in its signature

`go` on an *exit* square takes the exit. So it is only safe where the caller knows
which square it is standing on, which is why the crate errand will not send one
unless its `walk_to` reported `arrived` — rather than sending it hopefully and
reading the silence afterwards as a miss. That is a discipline on DUM's side and not
something the harness enforces: a `go` that landed somewhere unintended is
indistinguishable on the wire from one that landed correctly and found nothing.

---

## Gap 1 — refusals are prose, and something is already parsing it

**The single highest-value change, for DUM and for the LLM bot equally.**

A keeper that refuses to fight in a room with no safe wall, or that is sitting to
accumulate the 15 mana `create weapon` needs, is doing exactly the right thing and
is indistinguishable from a stall from outside. The harness's own supervisor tells
them apart with regular expressions over the keeper's journal prose:

```js
if (/no safe wall|refusing to fight/i.test(reason)) …
if (/needs \d+ to make one|resting for the mana|regain mana|unarmed —/i.test(reason)) …
```

Both regexes exist because of recorded loops. Restarting a keeper that refused a
room discards the record of *which* rooms it refused, so the fresh keeper walks back
in, re-probes, refuses again, and reports a stall again — once a minute, for ever,
with every log line looking like the supervisor working. Eight characters were
caught in it within a minute.

That coupling is to *sentences*, and the sentences belong to the harness. The day
one is reworded, the fleet starts churning again and nothing says so.

**DUM does not reproduce the regex.** `stall-report-only` reports and never acts
when it has no structured reason. That is a deliberate null result and it costs an
idle character rather than a fleet-wide churn loop.

### Asked for

```jsonc
status.refusals: [
  { "code": "NO_SAFE_WALL",          // stable vocabulary, never localised
    "faculty": "work",               // which faculty is blocked
    "blocking": true,                // does it stop the keeper doing its job
    "why": "no wall in this room held under test",
    "remedy": "assign a different room; the keeper relocates itself",
    "retry_after_ms": 600000,
    "since": 1700000000000 }
]

status.waiting_on: { "code": "MANA_FOR_CREATE_WEAPON",
                     "expected_ms": 240000,
                     "why": "unarmed with no donor; 15 mana needed" }
```

`waiting_on` separates *stuck* from *deliberately waiting* — the distinction the
whole supervisor problem turns on. `progress()` already exists internally; this is
its outward-facing half.

Both fields are additive. DUM reads them when present and degrades to reporting when
absent, so shipping them breaks nothing.

---

## Gap 2 — control ownership is all-or-nothing

`goInert()` is the right primitive and the harness's reasoning for it is exactly
right: a *stopped* keeper writes no frames, runs no `observe()`, records no death and
files no post-mortem, so the character keeps playing while the instruments go dark —
which is precisely when they are wanted. `during_keeper_outage` exists on the
post-mortem because deaths kept happening in the windows the harness had chosen to
stop looking.

What is missing is **granularity**. `inert` means "stop driving entirely". There is
no way for a bot to say *I own goal selection and target choice; you keep survival,
resting, Underworld escape and re-arming* — which is the exact split this repository
is built on.

### Asked for

```jsonc
autopilot { "agent": "…", "action": "claim",
            "faculties": ["work", "movement", "economy"],
            "by": "dum/valley-grind@pid-1234",   // who holds it
            "lease_ms": 120000,                  // taken back without a heartbeat
            "why": "a doctrine is driving this character" }

autopilot { "agent": "…", "action": "release", "faculties": [...] }
autopilot { "agent": "…", "action": "heartbeat" }
```

with `status.faculties: { survival: "keeper", work: {owner: "dum/…", expires_in_ms: 91000} }`.

Three properties matter more than the shape:

1. **`inert` is `claim(['work','movement','economy','social'])`.** Existing callers —
   the errands, the supply hold, the pilot claim, the supervisor — keep working
   unchanged.
2. **Leases fail back to the keeper, never open.** If DUM crashes, is `Ctrl-C`'d, or
   never started, the faculty reverts and the character defends itself. The harness's
   existing `INERT_MAX_MS` deadline is the same idea and its note is the right one:
   *an unattended character is worse than a contested one*.
3. **`survival` and `mortality` are refusable at the roster level.** An operator can
   allow a bot to take the survival floor; a bot cannot take it silently.

---

## ~~Gap 3~~ — CLOSED 2026-08-10. A bot can be seen in `commitment`

The harness now carries `held_by` on every commitment (including the null one) and an
`autopilot action: busy | free` that only the claim's holder may use. Both are leased and
fail back to the keeper. `isTakeable(committed)` is the question consumers ask, and
`m59-supervise.mjs` and `m59-reclaim.mjs` both honour it — the supervisor leaves
bot-held characters to their bot for the pair/graduate/deploy rounds while still
unsticking them, and stands off entirely from one mid-operation.

The original text is kept below because the *reasoning* is what made the shape right,
and because the "two facts, not one" distinction is the part that is easy to undo.

---

## Gap 3 (original) — a bot cannot be seen in `commitment`

`describeCommitment()` reports `errand | driven | parked | partner`. A bot holding a
character lands in `driven`, whose label is whatever string was passed, so two bots
and the supervisor cannot tell each other apart — and "only one thing may drive a
character at a time" is the requirement the whole file exists for.

### Asked for

A `bot` kind with an explicit `held_by`, and a read-only *who owns this character
right now* answer — the control-plane equivalent of `m59-which.mjs`, which exists
because the absence of exactly that check was expensive.

### What it looked like before it was closed — errands walked characters nothing could see

`crate-check` walks a character out of the room it was hunting in, stands it on a
square, and walks it back. For the two or three minutes that takes, the harness's
`commitment` says nothing about it: DUM composed the errand from `travel`,
`walk_to` and `act`, none of which registers a claim on the character's behalf.

Inside DUM that is safe by construction — `pass()` runs the fleet tick to
completion before any character tick, so nothing here redirects a character
mid-errand. **The exposure is `m59-supervise.mjs`**, the harness's own supervisor:
it restarts stalled keepers, and a character mid-errand looks stalled by exactly the
measure the harness's notes warn about — `ms_since_moved` is about the *keeper*,
which is inert by design while an errand walks, so it climbs while the character is
moving perfectly well.

The cost of losing that race was small — one abandoned check, and a character left in
a basement its keeper walks out of — which is precisely why the crate was the right
place to find it out rather than a loot run with money on it.

**How it was closed, and the one thing not to undo.** `busy` is a *second* fact, not a
richer version of the claim. The tempting shape is one flag meaning "a bot has this",
and it deadlocks immediately: DUM claims work and movement on every character it
manages, so a single flag greys the whole fleet, refuses every character DUM just
claimed to its own `respect-commitment` rule, and stops the unstick round — which is
the harness's job — on keepers that have genuinely stopped. Ownership is `held_by` and
stays takeable; being mid-operation is `busy` and is not.

---

## Gap 4 — orders are a flat argument list with no concurrency control

`autopilot` takes ~40 flat arguments and applies them by assignment. Two
consequences DUM works around today:

- **No optimistic concurrency.** If the supervisor and DUM both write `max_carry`
  on different cadences, the character's orders oscillate and both writers' logs look
  correct. DUM's mitigation is a diff and a `--yield-to` list, which is a convention,
  not a mechanism.
- **A new default never reaches a live keeper.** The harness records this: each
  keeper's policy is persisted with the roster and restored on restart, so changing a
  default and restarting left every keeper reporting the old value. DUM's mitigation
  is to send `null` — meaning "leave it alone" — rather than asserting a default back.

### Asked for

An orders *document* with a version and an `if_version` precondition, returning the
applied diff:

```jsonc
orders { "agent": "…", "if_version": 7, "set": { "bank_above": 500 } }
  -> { "version": 8, "changed": { "bank_above": [2000, 500] }, "unchanged": [...] }
```

That single change would let DUM, the LLM bot and the supervisor coexist by
construction rather than by agreement.

---

## Gap 5 — the free read stops one field short

`fleet` sends **nothing** to the game server: it reads the client's cached world and
each keeper's in-memory status. `status` sends **four requests per character** —
`stats(1)`, `stats(2)`, the spell list, the skill list — plus a settle. For
twenty-one characters that is 84 requests per tick against 1, and nothing in the two
tool names says so.

The board is already generous: `purse` and `banked` separately (one is lost on death,
the other is not), `kills_30m` from the ledger rather than the keeper, `partner_ok`,
`carrying`, `activity`, `committed`, `parked`, `stalled`. It does **not** carry the
keeper's `policy` — and that single omission forces the expensive call, because any
order has to be diffed against the current policy or it gets written every tick.

DUM's two-phase tick works around it: decide from the free board, and pay for `status`
only when the conclusion is an order. A quiet fleet then costs one call per pass, which
`tests/test-tick.mjs` asserts. The workaround is correct and should not need to exist.

**Asked for:** `policy` on the fleet row — it is in memory already, since the row is
built from `ap.status()` and simply omits it. At minimum: `assigned_room`,
`bank_above`, `walking_money`, `max_carry`, `sell_at_load`, `sell_when_broke`,
`max_bots_per_safe_spot`, `rest_below`, `flee_below`, `use_safe_spots`.

---

## Gap 6 — bots poll because there is nothing to wake them

`wait_for_event` exists. What it does not carry is the things a directional bot
cares about: a faculty transition, a refusal starting or clearing, a commitment
opening or closing, a stall, a death, a rung-relevant advancement.

DUM's ticks are cheap, so this is a nicety here. It is not a nicety for the LLM bot,
where every wake-up costs a model call — and the two bots should be woken by the same
mechanism if they are ever to be compared on equal terms.

---

## Gap 7 — nothing proves the unattended case still works

The whole carve-out is only safe if the harness alone still keeps a character alive.
That property is currently believed rather than tested, and it is exactly the
property that erodes silently as behavior migrates outward.

### Asked for

A `bot: none` contract test in the harness's offline suite: with no bot attached,
every faculty reports `keeper`, and the survival ladder is reachable. It should fail
the day someone moves a survival decision out.
