# The posted caster — one character, one room, one enchantment kept up

Added 2026-09-23. The operator asked for Alfa to stand in Castle Victoria casting
`forces of light` from a safe spot, and — when the reagents run out — to rescue, buy more (or
be given them by the fleet), and run back.

| | where |
|---|---|
| the rules | `src/decide/rules/roomcaster.mjs` — `caster-post`, `caster-rescue-to-shop`, `caster-resupply`, `caster-return-to-post` |
| the orders they may send | `room_enchant` and `accept_donations` in `ORDER_FIELDS` (`src/act/orders.mjs`) |
| the buy binding | `bindBuyLines` in `src/act/errands.mjs` |
| the doctrine | `doctrines/local/` — gitignored, because it names a character |
| the tests | `tests/test-roomcaster.mjs`, offline |
| the one-off placement | `tools/fleetscripts/loial-forces-of-light.mjs` in the harness, and the `post()` step it uses |

## The one thing to know before editing any of it

**The keeper does the casting, and it will only do it while NOBODY ELSE holds work or
movement.** `Autopilot.maintainRoomEnchantPost` takes the safe spot, renews the enchantment
off its own one-second clock and rests for mana between throws; `Autopilot.isRoomEnchantPost`
gates all of that on `!facultyHeld('work') && !facultyHeld('movement')`.

So this doctrine claims **`economy` and nothing else**. A doctrine that claimed either of the
other two would switch the post off with every log on both sides reading correct — the claim
succeeds, the rules converge, and the room is simply never lit. `validate()` in
`src/config/schema.mjs` refuses that configuration rather than trusting anyone to remember it.

DUM still takes the body when it needs it: an errand declares `busy`, which is what makes the
keeper hand over everything directional, and `declareBusy` requires a claim on *some* faculty,
not on those two.

## What each rule is for

- **`caster-post`** — the standing orders: `mode: idle`, the assigned room, `roam: false`,
  `use_safe_spots: true`, the enchantment, donations accepted, reagents protected. It converges
  (`agreesOn`), which is load-bearing: it sits above the other three and a maintenance rule
  that cannot agree starves everything below it.
- **`caster-rescue-to-shop`** — one `cast rescue` and nothing else. The landing is 15–25
  seconds away and the reply says nothing useful, so a `travel` in the same errand would set
  off walking and be teleported out of its own journey. Same two-phase shape as the feast
  hall's outbound/grab.
- **`caster-resupply`** — lift the confinement, visit **both** counters, read the pack back,
  walk home, put the confinement back. The two halves of `forces of light` are not sold by the
  same merchant, so a trip to one of them comes home able to cast exactly as often as it left.
- **`caster-return-to-post`** — the walk back, for anything that left him out of position and
  is not one of the two above.

## Three traps this cost, written down so the next one is cheaper

**A FRACTION IS NOT AN INTEGER.** The first draft of `agreesOn` floored numbers to mirror the
broker's normalisation. `rest_below` and `flee_below` are fractions of max health, so flooring
made 0.85 and 0.5 the same number and the rule reported converged against a caster still
holding a farmer's flee line. Caught against the live fleet within a minute.

**A FIELD THE OPERATOR HAS PINNED IS NOT YOURS.** `filterCall` strips pinned keys at the
sending end, which is after first-match-wins — so a rule that keeps an opinion about a pinned
field fires for ever against a keeper that can never be made to agree. `unpinned()` drops them
from what is emitted *and* from what is checked, exactly as `unyielded()` does for `yield_to`.

**A ROOM LOCK LOCKS THE DOOR FROM THE OUTSIDE TOO.** The live case, and the reason this
character did nothing for four hours with 124 castings in his pack: the operator overlay had
`room_lock: true` with `confine_rooms: [38]` while he was standing in room 101. `humanIntent`
refuses every errand for an agent with a room-lock pin and `filterCall` throws
`operator room lock owns movement` on every `travel` — so he was locked to a room nothing was
permitted to walk him to, and nothing anywhere reported it as a problem. Releasing the lock
(`POST /controls {patch: {room_lock: false}}` to the DUM process that owns the overlay) is what
let the first walk happen. **A confinement and a posting are different orders**: the post now
owns confinement itself, and lifts it for the length of a supply trip.

## A harness finding, not acted on here

`Autopilot.rescueShopping` is a documented, broker-validated keeper policy and
`Autopilot.rescueToShop` implements it — **and nothing calls it.** It is dead in the keeper.
That is why the rescue lives in DUM as an errand instead, which is also where the boundary
table puts it: a shopping trip is an economy decision on a minutes clock. Either wire it up
harness-side or drop the policy; leaving it is a setting that reads as configured and does
nothing.

## Running it

```bash
# check it first — plan sends nothing, and DUM re-asserts the whole posture every pass
node bin/dum.mjs plan --doctrine doctrines/local/<the local doctrine> --agent <handle>
node bin/dum.mjs run  --doctrine doctrines/local/<the local doctrine> --agent <handle> --commit
```

It contends with nothing: the fleet-wide doctrine carries this character in its `not_ours`, so
a second single-character invocation is not a second driver on one body.

To place the caster WITHOUT DUM — to bootstrap one, or to put it back after something took it
off the post — the harness has the one-off:

```
> loial-forces-of-light agents=<handle> room=38            # in node tools/m59-fleet-repl.mjs
> dry loial-forces-of-light agents=<handle> room=38        # compile the steps, send nothing
> loial-forces-of-light agents=<handle> room=38 buy=false  # already carrying enough
```

Both are idempotent against each other: the script sets the same posture the doctrine asserts,
and `caster-post` agrees with it on the first pass.
