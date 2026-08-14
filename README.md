# meridian59-dum-bot

**DUM — a Deterministic Unattended Manager.**

A bot that plays a Meridian 59 character, or a fleet of them, with **no language
model anywhere in it**. Everything it decides comes from an observation of the
live game and a **doctrine file** you drop in.

It is the deliberate sibling of
[`meridian59-llm-bot`](https://github.com/cpappas213/meridian59-llm-bot): the same
seat, the same harness underneath, the same one-action-at-a-time discipline — and
a decision procedure you can read in an afternoon and diff in a pull request.

```
              a decision about what this character is FOR
                                  |
   +------------------+   +----------------+   +-----------------+
   |  a human at a    |   | meridian59-    |   | meridian59-     |
   |  terminal        |   | llm-bot        |   | DUM-bot  (here) |
   +------------------+   +----------------+   +-----------------+
              \                  |                     /
               \                 |                    /
                +--------- the harness's control surface --------+
                                  |
                        m59-harness: the keeper
              perception, geometry, safe spots, pacing, and a
              survival floor that holds when nobody is driving
                                  |
                          Meridian 59, a real server
```

## Why this exists

An agent driving a character makes two very different kinds of decision, and they
have been living in one place.

*Mechanical* decisions have one right answer and have to be made every second:
rest when hurt and safe, break off when losing, get out of the Underworld, re-wield
a weapon after dying. Those belong in the harness's keeper, they are already there,
and they are what keeps an unattended character alive.

*Directional* decisions have no right answer at all: what is this character
trying to become, what should it be killing this week, which room, with whom, how
much money is it allowed to carry, when has it outgrown its prey. Those are the
ones a model gets asked about — and they are also, almost entirely, **if-then-else
over numbers the harness already reports**.

This repository is the second kind, written out. Its claim is that most of what an
LLM is currently being paid to decide for a grinding character is a lookup table
with a `why` column, and that having the table makes the model's contribution
measurable for the first time: run the same fleet under DUM and under the LLM
bot against the same doctrine and see which one is ahead.

## What it is not

- **Not a Meridian client.** It never speaks the game protocol. Everything goes
  through a running `m59-harness` broker, over the same JSON-RPC surface the
  harness's own supervisor uses.
- **Not a broker.** It attaches to the one that is already holding the fleet and
  refuses to run if that is not the fleet it was pointed at. It will never start,
  stop, or take the lock on a roster.
- **Not a replacement for the keeper.** The keeper stays. DUM claims the
  faculties it wants and leaves the survival floor alone unless a doctrine says
  otherwise in writing.
- **Not safe to point at a shared server yet.** See *Status*.

## Status

**Skeleton.** The link, the configuration loader, the rule engine, the journal
and the offline tests are real. The doctrine rule sets are deliberately thin —
one or two live rules each, and honest `TODO` markers everywhere else — because
the point of the first commit is the *shape*, and the shape is what has to be
argued about before any of it drives a character.

Nothing here has driven a live character. `--dry-run` is the default; making it
act requires `--commit` and a doctrine that names a fleet.

## Quick start

```bash
node bin/dum.mjs doctor                    # can I see a broker, and whose fleet is it?
node bin/dum.mjs plan --doctrine doctrines/survive.jsonc
node bin/dum.mjs plan --doctrine doctrines/valley-grind.jsonc --agent <one-agent>
node tests/run.mjs                         # offline, no broker, no server
npm run preflight                          # the tests, then the publication guard
```

`plan` reads the fleet, runs the doctrine, and prints every rule that fired with
its reason and the order it would have sent. It sends nothing. That is the only
mode that exists until `--commit` is passed, and `--commit` additionally requires
the broker to be holding the fleet the doctrine names.

## How a decision is made

One tick per character, in five stages, each of which is a separate module so that
a wrong answer can be attributed to one of them:

| stage | module | what it does |
|---|---|---|
| **sense** | `src/sense/` | one read of the harness per tick, normalised into an `Observation` — a plain object with no harness envelopes in it |
| **decide** | `src/decide/` | the ordered rule table. Each rule is a pure function of the observation and the doctrine, and returns an `Intent` or nothing |
| **act** | `src/act/` | turns intents into harness orders, **diffed against what is already set** so an unchanged doctrine sends nothing |
| **verify** | `src/act/verify.mjs` | re-reads and confirms the order took. An order that did not take is a finding, not a retry |
| **record** | `src/record/` | append-only journal: the observation, the rule, its reason, the order, and whether it verified — plus the small keyed **memory** holding the handful of facts a *later* decision reads |

The rule table is ordered and the first match wins, exactly like the keeper's own
`pass()`. What differs is that DUM's table starts *below* the keeper's: it has no
opinion about being attacked.

### Errands, and the one thing they change about all of the above

Almost everything DUM writes is **desired state**: an intent says what the keeper's
policy should be, `act` diffs it against what it already is, and sends the
difference. That is why DUM is safe to run every thirty seconds — re-deciding the
same thing produces no traffic at all.

An **errand** is the exception. It is a sequence that happens once — walk there,
stand on that square, do the thing, come back — and there is nothing to diff it
against. So the property that keeps the policy path honest is replaced by a
different one: *an errand is only ever emitted by a rule that knows when it last
ran*. That is what `src/record/memory.mjs` is for, and it is not optional. A rule
that emits an errand off a condition alone re-emits it on every tick.

The first one is [`crate-check`](src/decide/rules/crate.mjs), and it is the honest
test of the idea, because **not one of its three inputs is observable**. Whether the
crate under Castle Victoria is ready is a server-side counter with no packet; who it
will silently refuse is server-side state that produces no error, only a missing
item; and when we last looked is our own past. A bot that cannot hold that decision
cannot hold any decision about a world that does not narrate itself.

## Doctrine files

A doctrine is JSONC (JSON with `//` comments, because a threshold without a reason
is how a fleet ends up grinding worthless prey for an afternoon). It layers:

```
built-in defaults  <-  doctrine file  <-  per-character overrides  <-  CLI flags
```

Every layer is recorded in the journal, so "why is this character banking at 500"
resolves to a file and a line rather than to an argument.

See [`docs/doctrine-format.md`](docs/doctrine-format.md) and the worked examples
in [`doctrines/`](doctrines/).

## What DUM claims, and what it never does

DUM asks the harness for the faculties it wants and leaves the rest alone. The
default claim is:

| faculty | owner by default | why |
|---|---|---|
| identity, mortality | **keeper** | a character that has died, or whose object id was renumbered by a save, has to be recovered before anything else can be true. DUM has nothing to add |
| survival, recovery | **keeper** | this is the whole point of the split. An unattended character must still run, still withdraw, still rest — and it must do so when DUM is not running, is wedged, or has been killed by a `Ctrl-C` |
| work, movement, economy | **DUM** | prey, room, pairing, banking, selling, escalation |
| social | **keeper** | the harness's conversation boundary is stronger than anything here. DUM does not talk |

A doctrine can move a faculty, and moving `survival` requires
`"i_accept_the_character_may_die": true` spelled out in the file. That is not
theatre: the harness's survival ladder is the single most load-bearing thing in
the fleet, and the failure mode of quietly claiming it is a character that stands
still while something eats it.

See [`docs/harness-contract.md`](docs/harness-contract.md) for what the harness
would have to expose for this to be enforced rather than merely observed — today
the harness has one all-or-nothing `inert` state, so DUM's claim is a convention
it holds and a thing it records, not a thing the harness checks.

## Sharing a fleet with something else

A fleet may already have a supervisor restarting stalled keepers and reapplying its
own `rest_below`, `max_carry` and `roam`. Two writers on the same field at different
cadences is **not a race to be won** — the character's orders oscillate and *both*
writers' logs look correct, which is the worst possible combination for noticing.

```jsonc
"yield_to": ["rest_below", "max_carry", "roam"]
```

Yielded fields are dropped from the diff before comparison and the drop is
journalled, so "DUM is not setting `max_carry`" is visible rather than mysterious.
Names are checked at load, because a typo fails in the dangerous direction — the
field would not be yielded and DUM would write it anyway.

## Nothing here identifies a fleet

This repository is public and the fleet it drives is on a shared server, so no
tracked file carries a character name, an account handle, a password, a server
address, or a fleet name. Doctrines address characters by **role**; anything that
must name one lives in `doctrines/local/`, which is gitignored.

`tools/dum-guard.mjs` enforces that rather than trusting it — it builds the
forbidden set from whatever rosters, snapshots and journals exist beside this
checkout and greps everything git is tracking:

```bash
node tools/dum-guard.mjs --staged --verbose
```

It exits non-zero on a hit, and **also** on finding no roster to check against,
because a check with nothing to compare reports zero hits and that reading is
indistinguishable from a real pass. On its first run it found a live character
name in this README, a live fleet name in two doctrines, and — in its own source
— a comment illustrating "short account handles" with two real ones, which on
this fleet are two real passwords.

Wire it into pushes once per clone:

```bash
git config core.hooksPath .githooks
```

## Relationship to the other maps

- [`m59-harness`](https://github.com/tpeppers/m59-harness) — the seat. DUM
  depends on its control surface and on nothing else in it. No harness source is
  copied here.
- [`meridian59-llm-bot`](https://github.com/cpappas213/meridian59-llm-bot) — the
  same seat with a model in it. DUM is built to be swappable with it, which is
  the only way either can be evaluated.
- `m59-bard` — reads both and writes to neither.

## Documentation

- [Architecture](docs/architecture.md)
- [Doctrine format](docs/doctrine-format.md)
- [What DUM needs from the harness](docs/harness-contract.md)

## License

MIT. No harness or game source is vendored here.
