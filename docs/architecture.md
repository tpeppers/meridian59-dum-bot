# Architecture

## The one idea

An agent driving a Meridian 59 character makes two kinds of decision, and they
run on different clocks.

**Clock-bound decisions** have one right answer and have to be made every second.
Rest when hurt and safe. Break off when losing. Get out of the Underworld. Re-wield
a weapon after dying. Re-log in when a `save game` renumbered your object id. These
are already in the harness's keeper, they run at one second, and they are what
keeps an unattended character alive.

**Directional decisions** have no right answer at all. What is this character
trying to become? What should it be killing this week? Which room, with whom, how
much money may it carry, when has it outgrown its prey? Nothing bad happens if
these are re-decided every few minutes instead of every second.

DUM takes the second kind and nothing else. That single boundary explains every
other choice in this repository.

## The pipeline

```
   fleet board (1 call)                     one call for N characters
        |
   sense ────────► Observation              plain object, no MCP envelopes
        |
   decide ───────► Intent | null            pure. no clock, no network, no randomness
        |
   act ──────────► diff, then send          unchanged fields are never written
        |
   verify ───────► fresh read agrees?       a failure is a finding, not a retry
        |
   record ───────► one ndjson line          including every rule that DECLINED
```

Each stage is a module so a wrong answer is attributable to one of them. "The bot
did the wrong thing" is not a diagnosis; "the observation had a null level, so the
ladder rung was unanswerable, so `ladder-active-rung` reported instead of ordering"
is.

### sense — decide cheap, confirm expensive

The two reads a bot lives on cost wildly different amounts, and the difference is
invisible in their signatures:

| call | cost |
|---|---|
| `fleet` | **nothing.** Reads the client's cached world and each keeper's in-memory status. One call, N characters |
| `status` | **four server requests per character** — `stats(1)`, `stats(2)`, the spell list, the skill list — through the pacer, plus a settle |

For twenty-one characters, polling `status` every tick is eighty-four requests a
tick. The harness says the same thing in its own words: *deciding is free, asking is
not* — and asking is not passive either, since a room-contents resync counts as an
action and calls `NotifyMonstersOfPresence`, which is why the keeper forbids it while
playing dead.

So the tick is two phases:

1. **Decide from the board.** Free. Most ticks end here, because most of what a
   directional bot concludes is "leave this alone".
2. **Only if that produced an order** — something that must be diffed against the
   keeper's live policy, which is *not* on the board — pay for `status` and decide
   again on the fuller observation.

Re-deciding costs nothing because rules are pure, and the second answer may
legitimately differ from the first: a rule that could not see the keeper's policy may
now find the keeper already has these orders. That is the design working. On a quiet
fleet a pass costs one call; `tests/test-tick.mjs` asserts it.

An observation that was never deepened carries `policy: null`, and `planOrders`
**throws** rather than diffing against `{}` — falling back would make every field read
as different, so the bot would write every setting every tick and report success each
time.

`src/sense/normalize.mjs` names every field the rules read, exactly once. A harness
response shape change then breaks one file loudly instead of making four rules
quietly stop firing — a rule reading `r.level` and getting `undefined` does not
throw, it just never matches, and a bot that never matches looks exactly like a bot
with nothing to do.

**Absent is `null`, never `0`.** "The harness did not report a level" and "the level
is zero" are opposite facts, and the second must never satisfy a *below 30* test.

Two naming traps live there and nowhere else: on the fleet board `room` is the room's
*name* and `room_num` is its number, and the board says `committed` where `status`
says `commitment`. Reading the wrong one of the second pair sees no commitments at
all — which means happily redirecting characters that are halfway through an errand.

### decide

An ordered table, first match wins, exactly like the keeper's own `pass()`. What
differs is where DUM's table *starts*:

| | keeper | DUM |
|---|---|---|
| 0 identity | ✔ | — |
| 1 mortality | ✔ | — |
| 2 survival | ✔ | — |
| 3 recovery | ✔ | — |
| 4 work / movement / economy | ✔ (defaults) | ✔ (doctrine) |

DUM has no rule about being attacked, and adding one would make the character
*worse*: DUM ticks every thirty seconds, so a survival rule here would be acting on
information that is on average fifteen seconds old, against a keeper that has better
information and is already acting on it.

Rules are pure functions — no clock, no randomness, no network. That is what makes
a decision reproducible from a single journal line six hours later, and it is why
`tests/` can be fixtures rather than a live server.

Three properties are enforced at load time, not by convention:

- a rule with no `why` does not load;
- a rule claiming a faculty that does not exist does not load;
- a rule may only fire if the doctrine claimed its faculty as `bot`.

The third is the enforcement point for the whole split. A doctrine that leaves
`survival` with the keeper cannot have a survival rule fire, however it was written.

### act

The diff is the interesting part. An intent states *desired* state;
`src/act/orders.mjs` compares it with the keeper's live policy and sends only the
fields that differ. A DUM re-asserting the same policy every thirty seconds would
look identical to one that was working, and would be harmful twice over: every write
lands in the persisted roster, and a value written explicitly stops tracking the
harness's own default for ever. The harness records exactly that trap — a default it
changed, restarted, and found every live keeper still reporting the old value.

It also owns the one translation nothing else should know about: the MCP argument is
`bank_above` and the keeper's policy key is `bankAbove`. Getting that wrong is silent
in the worst direction — a diff against a key that does not exist reads as "always
different", so the bot writes every tick and reports success.

A field the table has never heard of **throws**. A rule that believes it is
configuring something and is not is worse than a crash.

### verify

An action is not complete because the call returned 200. It is complete when a fresh
read agrees. This is copied deliberately from `meridian59-llm-bot`, and it matches
the harness's own evidence model — a safe spot "works" because a character stood in
it and was not hit, not because the geometry said it should.

**A failed order is not retried.** A retry loop makes a failing order look like a
working one: twenty writes a minute, all reporting success, and the policy never
changing. The failures that actually occur are conditions rather than transients, and
every one of them wants a human or a different rule. The one exception — a call that
never reached the broker — is `retriable` on the error and handled by the loop's
backoff.

### record

One ndjson line per tick, gitignored, carrying the observation, **every rule and its
verdict including the ones that declined**, the intent, what was sent, and whether it
verified.

The declined rules are the part everyone leaves out and the part that matters. Most
ticks decide nothing, which is correct — and "nothing happened" is precisely the
answer that cannot be debugged after the fact. A silent bot and a wedged bot look
identical on a board; they look nothing alike in that file.

It is also the substrate for the comparison this repository exists for. A DUM run and
an LLM run over the same doctrine produce comparable lines: same observation shape,
same verified delta, one with a model in the loop and one without.

## Faculties

DUM addresses the split by name rather than by "the keeper is off":

| faculty | what it decides | default owner |
|---|---|---|
| `identity` | am I still the object the server thinks I am | keeper |
| `mortality` | am I dead, and how do I get out of the Underworld | keeper |
| `survival` | something is hitting me — withdraw, take a wall, log off | keeper |
| `recovery` | I am hurt and safe — sit down, eat, heal | keeper |
| `work` | what am I hunting, and has it stopped paying | **bot** |
| `movement` | which room am I supposed to be standing in | **bot** |
| `economy` | banking, carrying, selling | **bot** |
| `social` | what do I say to people | keeper |

Today the harness has one all-or-nothing `inert` state, so this is a convention DUM
holds and records rather than something the harness checks. Writing it down anyway
means that when enforcement lands it is a change of mechanism, not a change of
meaning. See [`harness-contract.md`](harness-contract.md).

## What is deliberately not here

- **No language model.** If a decision needs one it belongs in
  `meridian59-llm-bot`, and *which decision it was* is the interesting result.
- **No protocol, geometry, or safe-spot code.** That is the harness's, it is hard,
  and a copy here would rot. This repository reads no harness file.
- **No speech.** The harness's conversation boundary — deterministic
  acknowledgements, broadcast deduplication, a commitment classifier, an outbound
  leak detector — is stronger than anything this repository would grow, and a
  deterministic bot has nothing to say worth reopening that surface for.
- **No broker lifecycle.** Attach or fail.
