// THE BOTTOM LAYER: what DUM believes when a doctrine says nothing.
//
// Two things make this file different from the harness's policy defaults, and both
// are deliberate.
//
// FIRST, it is conservative in the direction of DOING NOTHING. The harness's defaults
// are tuned for a character that has to keep playing whether or not anyone is
// watching; DUM's are tuned for a bot that has just been pointed at a fleet by someone
// who has not read the file yet. A DUM that changes nothing on its first tick is
// correct. A DUM that redeploys twenty-one characters because it inherited an opinion
// about prey is not.
//
// SECOND, every number here that duplicates a harness policy field is marked
// `null` — meaning "leave whatever the keeper has". DUM asserting the harness's own
// default back at it is not a no-op: it is a write, it lands in the roster, and it
// silently pins a value that would otherwise have moved when the harness's default
// moved. Sending nothing and sending the same number look identical on the board and
// are not the same act.

export const DEFAULTS = {
  // ---------------------------------------------------------------- identity
  // WHICH FLEET THIS DOCTRINE IS ALLOWED TO TOUCH. There is no default and there
  // must never be one. The harness learned this the expensive way: every fleet tool
  // took --fleet, every one of them was silent about it, and a restart aimed at the
  // wrong roster reported success at every step. A doctrine that does not name a
  // fleet can be planned and cannot be committed.
  fleet: null,
  // A label for the journal, so two doctrines running on different characters can be
  // told apart afterwards.
  name: 'unnamed doctrine',
  why: null,

  // ---------------------------------------------------------------- the link
  link: {
    // Where the broker is. Not where to START one — see CLAUDE.md rule 1.
    control_url: 'http://127.0.0.1:8901',
    // How long to wait on a single harness call. Deliberately generous: `travel` is a
    // multi-hop walk and a resync waits on the server.
    timeout_ms: 30_000,
    // How many harness calls DUM may make per second, across all characters. The
    // server throttles incoming packets at 5/second per character (user.kod), and a
    // fleet-wide bot is the one thing positioned to breach that for twenty-one of
    // them at once.
    calls_per_second: 4,
    // DUM's own loopback control plane. The strategy-game website proxies to this;
    // nothing outside the machine holding the fleet may mutate unit strategies.
    strategy_control_url: 'http://127.0.0.1:8916',
  },

  // ---------------------------------------------------------------- ownership
  // WHICH DECISIONS DUM IS TAKING. See docs/harness-contract.md — today the harness
  // has one all-or-nothing `inert` state, so this is a convention DUM holds and
  // records rather than something the harness enforces. Writing it down anyway is
  // what makes the enforcement, when it lands, a change of mechanism and not a
  // change of meaning.
  claim: {
    // 'keeper' | 'bot' | 'off'
    identity: 'keeper',
    mortality: 'keeper',
    survival: 'keeper',
    recovery: 'keeper',
    work: 'bot',
    movement: 'bot',
    economy: 'bot',
    social: 'keeper',
    // Taking `survival` or `mortality` requires this spelled out in the doctrine.
    // Not theatre: the survival ladder is what keeps a character alive when DUM has
    // crashed, and claiming it quietly means a character that stands still and dies.
    i_accept_the_character_may_die: false,
    // How long a claim is good for without a heartbeat. If DUM dies, the harness
    // should take its faculties back rather than leaving a character unattended;
    // this is the number DUM asks for. The harness's own INERT_MAX_MS exists for the
    // same reason and is the fallback until faculties are real.
    lease_ms: 120_000,
  },

  // ---------------------------------------------------------------- coexistence
  // ORDER FIELDS SOMETHING ELSE OWNS, WHICH DUM MUST NOT WRITE.
  //
  // A fleet may already have a supervisor outside this repository restarting stalled
  // keepers roughly every 60s and reapplying its own `rest_below`, `max_carry` and
  // `roam`. Two things writing the same field on different cadences is not a race to
  // be won — the character's orders oscillate and BOTH writers' logs look correct,
  // which is the worst possible combination for noticing.
  //
  // So this is not a lock and does not pretend to be one. It is a written statement of
  // who owns what, enforced at the one place DUM can enforce it: the write. A yielded
  // field is dropped from the diff and the drop is journalled, so "DUM is not setting
  // max_carry" is visible rather than mysterious.
  //
  //   "yield_to": ["rest_below", "max_carry", "roam"]
  yield_to: [],

  // ---------------------------------------------------------------- cadence
  cadence: {
    // Per-character decision interval. DUM's decisions are directional and change
    // slowly; the keeper is the thing running at one second. Ticking faster than the
    // decisions change just produces churn on the board.
    character_ms: 30_000,
    // Fleet-level decisions — pairing, spread, graduation — are slower still, and
    // every one of them stops keepers and walks characters across the world. The
    // harness's supervisor learned that re-deciding pairings every round produced a
    // reshuffle nobody ever arrived from.
    fleet_ms: 300_000,
    // After an order fails, wait this long before deciding the same thing again.
    // Ordered, not exponential: the failures that matter here are "travel gave up"
    // and "no safe wall", which are conditions rather than transients.
    backoff_ms: 60_000,
  },

  // ---------------------------------------------------------------- doctrine
  // The directional half. Everything below is what a drop-in file is for; the shipped
  // values say "change nothing" so that an unconfigured DUM is inert by construction.
  goals: {
    // WHAT THIS CHARACTER IS TRYING TO BECOME, as an ordered ladder. The first rung
    // whose `until` is not yet met is the active one. Empty means DUM has no opinion
    // and will not choose prey, a room, or a strategy.
    //
    //   [{ id: 'survive-to-30',
    //      until: { kind: 'max_health', at_least: 30 },
    //      orders: { mode: 'farm', strategy: 'wellfed', purpose: 'advance' },
    //      why: 'below 30 max health a character cannot survive the valley' }]
    ladder: [],
    // What to do when the last rung is met. 'hold' leaves the character on the last
    // rung's orders; 'idle' stands it down; 'report' additionally writes a finding.
    on_complete: 'hold',
  },

  prey: {
    // DUM never guesses prey — the harness does not either, and for the same reason:
    // a keeper grinding worthless prey looks EXACTLY like a healthy one. It kills
    // something every pass, so the stall detector never trips, and the board reads
    // `hunting: giant rat` for as long as you leave it.
    //
    // What DUM adds is the check the keeper cannot make: whether what it is killing
    // still pays for what the ladder said it was farming.
    choose: false,
    // Below this, a kill stops advancing the character at all (the game's own rule:
    // advancement needs the creature's level above the character's base max health).
    // Reaching it is a reason to change prey, not a reason to keep counting kills.
    graduate_margin: 0,
    // Never send a character at something whose level exceeds its own by more than
    // this. Mirrors the keeper's maxThreatOver so DUM does not order a fight the
    // keeper will correctly refuse.
    max_threat_over: 6,
    // Percent of max health a unit may fight up to. 150 is the harness default and the
    // same bet at every level; max_threat_over above is kept only so an older doctrine
    // still parses, and no longer decides anything.
    // Either {mode:'percent', value:150} or {mode:'flat', value:25}. Percent by default:
    // a flat band is a different bet at each end of a roster.
    threat_ceiling: { mode: 'percent', value: 150 },
  },

  placement: {
    // Spread characters over rooms rather than stacking them: each room caps its
    // generator, so two parties in one room halve each other's supply while sharing
    // all of the danger. Off by default because it moves characters.
    spread: false,
    // Rooms this doctrine is allowed to send characters to, by room number. Empty
    // means DUM will not relocate anyone.
    rooms: [],
    // Never more than this many characters assigned to one room.
    per_room: 4,
  },

  economy: {
    // All null: leave the keeper's own thresholds alone. A doctrine that wants to
    // move them says so, and the journal records that a doctrine did it.
    bank_above: null,
    walking_money: null,
    max_carry: null,
    sell_loot: null,
    // REPORT WHEN ONE CHARACTER IS HOLDING THIS FRACTION OF EVERYTHING THE FLEET HAS
    // IN ITS POCKETS. A fraction rather than an amount, because the risk is not "a lot
    // of money" — it is how much of the total is riding on one character that can die
    // in the next eight seconds. Reporting only; DUM does not send anyone to a bank.
    // null is off.
    concentration_report_at: null,
  },

  // ---------------------------------------------------------------- weapons
  // THE THROTTLE — the vigor the fleet maintains before it will fight.
  //
  // null leaves fight_above_vigor to the ladder/keeper. Three spellings otherwise, and the
  // third is the one to reach for:
  //
  //   throttle: 0.4                              a fraction of the 200 maximum
  //   throttle: 80                               the same thing said out loud (>1 is absolute)
  //   throttle: { with_food: 180, no_food: 80 }  the floor FOLLOWS THE LARDER
  //
  // A single number is a bet on the larder and it loses in both directions: a high one
  // idle-locks every character that cannot eat its way up to it, a low one throws away the
  // regeneration a fed character has already paid for. The split says what to do in each
  // case. `min_meals` is how many meals aboard count as fed, and the reagents for a casting
  // count too. rules/throttle.mjs carries the measurement behind it.
  throttle: null,

  // The named order is always usable; provisioning is opt-in because casting and
  // handing items between characters are fleet operations, not keeper preferences.
  weapons: {
    preset: 'strongestToWeakest',
    // Named doctrine-local additions. Each value is best-to-worst; a nested list is a
    // tied tier and "*" means every otherwise recognised weapon.
    presets: {},
    provision: {
      enabled: false,
      threshold: null,
      room: null,
      staging_only: true,
      cast_when_mana: true,
      mana_cost: 15,
    },
  },

  // ---------------------------------------------------------------- composable strategies
  // The per-unit file under var/ overrides these. An absent assignment inherits the
  // defaults; once the website changes a unit, its explicit set wins until changed again.
  strategies: {
    enabled: true,
    defaults: ['max-weapons', 'buy-food', 'buy-weapons', 'buy-reagents'],
    // Optional values by strategy id. Catalogue defaults reproduce the historical
    // enabled behaviour; leaving the id out keeps configuration concise.
    settings: {},
  },

  food: {
    min_items: 1,
    mana_cost: 10,
    elderberry_per_cast: 2,
    herbs_per_cast: 2,
  },

  // THE DUKE'S FEAST HALL — free food for the length of an event, instead of bought
  // reagents. See src/decide/rules/feast.mjs for the mechanism and src/decide/feast-hall.mjs
  // for the room, the tables and the kod citations. OFF BY DEFAULT like every other trip:
  // the hall is LOCKED outside the event (a visitor is hustled straight back out), and the
  // walk is eleven hops from where this fleet farms, so it is opted into for the event
  // and must be switched off when the Duke closes the doors.
  feast: {
    on: false,
    // With fewer meals than this aboard, a character NEAR TOS tops up. Six is about one
    // climb from the resting cap to a 140 floor on the hall's 9-vigor dishes.
    min_items: 6,
    // Near Tos, by route distance from the hall (Tos square = 3, its shops = 4)…
    max_hops: 4,
    // …or by name. Empty means distance alone decides.
    near_rooms: [],
    // THE SUPPLY TRIP, REDIRECTED. A character with NO food and no casting's worth of
    // reagents is about to be walked to the Tos apothecary by its keeper; if the hall is
    // within this much walking, it goes to the tables instead. Castle Victoria is about
    // twelve minutes at the fleet's p90, which is what the default admits.
    max_travel_ms: 15 * 60_000,
    // Do not send a hurt character across the world for food.
    min_health: 0.8,
    // How many may be on the road to the hall at once. The road is the only thing that
    // kills this fleet, so a hungry fleet queues rather than stampedes.
    max_in_flight: 3,
    // Which table to take from, first that exists. Pork is the best food on the tables
    // (9 vigor for 20 stomach, 9 weight) and it SPEAKS when taken, which is how the
    // errand counts what it got. See FEAST_DISPENSERS.
    grab_from: ['roast pig', 'cauldron of soup'],
    // Activations per visit, at one item each. The hall refuses when the pack is full and
    // the errand stops on that sentence, so this is a ceiling rather than a target. Sixty
    // slices of pork is 540 weight — about a quarter of a pack — and 540 vigor, or
    // nine climbs from the rest cap to a 140 floor.
    max_grabs: 60,
    // A journey that has not been seen in the hall this long after setting off is given
    // up (its walk cancelled, its memory cleared). Twice the worst walk here.
    max_trip_ms: 30 * 60_000,
    // Per-character windows. A completed visit filled the pack and waits the cooldown; a
    // failed one — a dead walker, a locked hall — waits only the backoff.
    cooldown_ms: 45 * 60_000,
    fail_backoff_ms: 10 * 60_000,
    // Walk back to the assigned room afterwards. See crate.return_after for why leaving a
    // character where an errand put it is the worse choice.
    return_home: true,
    // While the feast is on, the keeper's reagent purchase permission is switched off
    // through the ordinary purchase-strategy-policy rule, so a character that reaches the
    // apothecary for some other reason buys nothing there. The keeper's own supply trip
    // already stands down while it has meals aboard (m59-autopilot.mjs supplyShortfall),
    // which is what stops it walking to the counter in the first place.
    suspend_reagent_buying: true,
  },

  // Walk anyone who is out of position back to their assigned room. Off by default:
  // "lose the goal on death" is the right answer for some fleets and the wrong one for a
  // fleet grinding a single room, so the doctrine has to say which it is.
  station: {
    recall: false,
    rooms: [],      // stations this doctrine claims; empty means every assigned room
    per_pass: 4,    // cap, so a fleet-wide displacement queues instead of stampeding
    // Health fraction required before a recall will walk anybody. 1 = full, matching the
    // harness's own travel_start_health: a character that just died is recovering, not
    // stranded, and the inn it is standing in heals for free.
    min_health: 1,
  },

  castle_victoria: {
    shift: false,
    rooms: { downstairs: 38, upstairs: 39 },
    upstairs_share: 0.67,
    // One quarry for the whole upstairs cohort, retiring the battered-skeleton/zombie
    // rotation. null keeps the mix. Room 39 generates 'battered skeleton' and 'zombie'.
    upstairs_quarry: null,
    // Characters pinned to the zombie upstairs whatever the rotation says — the safety
    // valve for the weakest of the roster. Empty means the rotation decides for everyone.
    zombie_only: [],
    retreat_to: 52,
    rest_below: 0.75,
    flee_below: 0.35,
    fight_above_vigor: 180,
    max_carry: 14,
    bank_above: 2000,
    use_safe_spots: true,
  },

  party: {
    // Pair characters up. Two characters on one monster both advance from it — the
    // advancement flag is per character, not a split pot — but pairing is also the
    // decision most likely to thrash: levels change, a level-sorted pairing
    // reshuffles, and every reshuffle stops two keepers and re-travels two
    // characters. Off by default; when on, an existing mutual pair is never
    // disturbed.
    pair: false,
    keep_working_pairs: true,
  },

  // THE CRATE UNDER CASTLE VICTORIA. See src/decide/rules/crate.mjs for the arithmetic;
  // every number that is not a preference lives there, cited, rather than here.
  //
  // OFF BY DEFAULT, and for a sharper reason than the other opt-ins. Pairing and spread
  // are contested tactics. This one has a MEASURABLE expected value and it is poor: the
  // median item is worth about forty shillings, one find in nine spawns a monster
  // adjacent to the character that just got it, and one of the two possible monsters is
  // a level-120 narthyl worm that nothing in this fleet may fight. It is worth doing at
  // all only because the fleet is standing in the castle anyway.
  // KEEPING A FACTION THE FLEET ALREADY HAS. Not joining one — that is a durable goal an
  // operator sets per unit, and it stays that way.
  //
  // Membership decays on a WALL-CLOCK timer that runs while the character is logged out,
  // and 24 hours after the last service the server revokes it with four hours' notice.
  // That notice is a sentence with no packet behind it; the harness catches it off its
  // own event stream and files it beside the membership, and this switch is what makes
  // DUM look at the file.
  //
  // OFF BY DEFAULT, and not out of caution about the errand — it is that the check costs
  // a read per character per tick and on a fleet of neutrals every one of them returns
  // "owes nothing". Turn it on for a fleet that has joined something.
  factions: {
    keep_membership: false,
  },
  // THE MARION CRYPT SHIFT. Off by default like every other shift: it pins characters to
  // two specific rooms, and a doctrine that has not asked for that must not get it.
  // THE HUNTING SHIFT: which rooms the fleet works, and in what proportion.
  //
  // Off by default like every other shift — it pins characters to specific rooms, and a
  // doctrine that has not asked for that must not get it. A station's `room` must appear
  // in HUNT_ROOMS and its `hunt` must be something that room actually GENERATES, or the
  // station is refused rather than approximated: that guard is what keeps a fleet out of
  // 2602 (thrashers, 150) and 552 (mollusks, 150), and off prey that does not respawn.
  //
  // `share` is a fraction of the units each station can actually take, not of the whole
  // fleet, and the last station takes the remainder so rounding cannot lose anybody.
  shift: {
    on: false,
    stations: [],
    rest_below: 0.75,
    flee_below: 0.35,
    fight_above_vigor: 180,
    use_safe_spots: true,
  },
  crate: {
    // ON BY DEFAULT, WHICH IS THE ONE PLACE THIS BLOCK DIFFERS FROM EVERY OTHER OPT-IN
    // HERE, AND IT IS A DECISION RATHER THAN AN OVERSIGHT.
    //
    // The expected value is poor and stated below; what makes it worth having anyway is
    // that the trip is nearly free WHEN THE FLEET IS ALREADY IN THE CASTLE, which is the
    // only condition under which it fires. It changes nobody's orders, it walks one
    // character one hop and back, and it does nothing at all to a fleet that is hunting
    // anywhere else — which is most of them, most of the time.
    //
    // `survive.jsonc` turns it back off, because that doctrine's whole value is being a
    // CONTROL: a null doctrine that quietly walks a character to a basement is not one.
    check: true,
    // Which rooms count as being at Castle Victoria: 2 Outside, 38 the castle itself,
    // 39 upstairs, 40 the throne room. All four are a hop or two from the basement, which
    // is the whole justification for the behaviour — the trip is nearly free from here
    // and absurd from anywhere else.
    zone: [2, 38, 39, 40],
    // HOW MANY MUST BE THERE, AND WHY THREE RATHER THAN THE TWO THE MECHANIC NEEDS.
    //
    // `poLastFinder` refuses whoever found last, in silence and before the timer is even
    // consulted (dungeon.kod:138), so a rotation needs at least two. That part is the
    // game's rather than a preference, and the loader refuses anything below it.
    //
    // Two is the floor; three is the working number. With exactly two present and one of
    // them the last finder there is exactly ONE eligible character, so the next find locks
    // the fleet out entirely until somebody else wanders in. Three always leaves two.
    // Set it to 2 to take the trip whenever it is possible at all.
    quorum: 3,
    // The Underbasement of Victoria, and the square the rummage happens on. The kod says
    // row 10, col 6; `walk_to` takes col, row.
    room: 41,
    square: { col: 6, row: 10 },
    // How often to probe while the window may be open. The counter cannot be read, so
    // every check is a guess; this is the trade between collecting shortly after it
    // comes up and having a character in a basement rather than in a fight. Thirty
    // minutes is about seventeen probes across the eight-hour uncertainty window.
    probe_every_ms: 30 * 60_000,
    // Do not send a hurt character. One find in nine puts a monster next to it and
    // getting out of that is the keeper's job — which it does better at full health.
    min_health: 0.8,
    // Below 30 base max health the crate does not answer AT ALL: both squares are gated
    // on `PFLAG_PKILL_ENABLE` and `EvaluatePKStatus` sets it at exactly that number.
    // Lowering this sends characters to a basement to be ignored in silence.
    min_level: 30,
    // Walk back to the room it came from afterwards. Two reasons, and the second is the
    // one that is easy to miss: turning this off leaves the character in the basement
    // for its keeper to make perfectly reasonable decisions about a room nobody meant
    // it to be in — AND it leaves the fleet board this pass is still working from
    // describing a character that is no longer where it says. See src/act/errands.mjs.
    return_after: true,
    // travel and walk_to are a character WALKING, not a request. See Broker.call.
    travel_timeout_ms: 180_000,
    walk_timeout_ms: 90_000,
  },

  // THE BARLOQUE SELL CIRCUIT. Off by default like every other opt-in: it walks a character
  // out of its hunting room across town and back, which a doctrine that has not asked for it
  // must not get. When on, a character whose pack is heavy is sent to sell ACROSS the Barloque
  // specialists — the smith (equipment), the jeweler (gems, which refuses a stack over 25), the
  // herbalist (reagents/mushrooms) — rather than to Roq (110), the universal buyer who pays the
  // standard rate from behind an unsafe tunnel. See src/decide/rules/sellrun.mjs.
  sellrun: {
    on: false,
    // The ordered stops. Each names the room, the exact merchant, and any per-offer stack cap
    // (the jeweler, bqmerch.kod:113, refuses a gem stack over 25 wholesale — null means no cap).
    stops: [
      { room: 113, merchant: "Fehr'loi Qan", max_stack: null },   // The Royal Blacksmith: equipment
      { room: 109, merchant: 'Herbutte',      max_stack: 25 },     // Sparkling Stone Shop: gems
      { room: 104, merchant: 'Joguer',        max_stack: null },   // Herbs and Roots: reagents, mushrooms
    ],
    // Never sold. Reagents (create-food stock) and the rares that are worth more kept than the
    // few shillings a merchant pays. Matched as case-insensitive substrings by sell_all's keep.
    keep: ['inky', 'dragon scale', 'angel feather', 'wand', 'scroll', 'signet', 'orb of',
           'potion', 'herb', 'elderberry',
           // The feast hall's dishes: a pack of free food is the larder, not stock.
           'slice of pork', 'bowl of soup', 'spider eye', 'bunch of grapes', 'drumstick'],
    // A sale below this many shillings is cancelled and the item kept — a floor against handing
    // something valuable to a merchant who lowballs it.
    min_price: 1,
    trigger: {
      // Pack item count at or above which the trip is worth taking.
      carry_at: 24,
      // Also go when nearly out of money, if > 0. Off by default: a heavy pack is the trigger.
      broke_under: 0,
      // Do not march a hurt character to town. Below this fraction the keeper's survival ladder
      // is the thing that should be acting, not a sell trip.
      min_health: 0.8,
    },
    // The per-character window that stops the errand re-firing every 30s tick and living in a
    // shop. Twenty minutes is longer than a full circuit takes. A COMPLETED run waits this long
    // (the pack is empty); a FAILED one waits only fail_backoff_ms, so a pack that never got sold
    // is retried soon rather than stranded for the full cooldown.
    cooldown_ms: 20 * 60_000,
    fail_backoff_ms: 5 * 60_000,
    travel_timeout_ms: 240_000,
    return_home: true,
  },

  escalate: {
    // What to do about a keeper that reports it is stuck. DUM's contribution here is
    // to NOT restart the ones that are deliberately waiting — see
    // src/decide/rules/escalate.mjs, which is the honest version of a regex the
    // harness's supervisor currently runs against journal prose.
    unstick: false,
    // How many consecutive ticks of no verified progress before a character is
    // reported. Reporting is not restarting.
    stall_ticks: 4,
  },

  // ---------------------------------------------------------------- recording
  record: {
    // Append-only ndjson, gitignored. One line per tick per character.
    dir: 'var/journal',
    // THE OTHER HALF OF THE RECORD, AND IT IS NOT THE SAME THING. The journal says what
    // happened; this keeps the handful of facts a LATER decision reads — when the crate
    // last paid out, and which character it will now refuse. Neither is on the wire or
    // on the board, so without somewhere to put them the rule that needs them cannot be
    // written at all. Fleet-scoped, gitignored, and see src/record/memory.mjs for why
    // reconstructing it from the journal is not the same.
    memory_dir: 'var/memory',
    // Per-unit strategy selections are operational state and may name roster handles.
    strategy_dir: 'var/strategies',
    // Durable queued/acquiring/completed faction-join goals, likewise fleet-local.
    faction_dir: 'var/factions',
    // Small opt-in outcome records used by the DUM/Harness drill-ins. Each line carries
    // its selected retention; 24h is the catalogue default and dashboards open at 2h.
    strategy_stats_dir: 'var/strategy-stats',
    // Keep the full observation on every line, or only the fields a rule read. Full
    // is large and is what makes an after-the-fact "why did it decide that" possible
    // without re-running anything.
    full_observations: true,
  },
};

/** A structuredClone that also works as documentation of intent: layers never alias. */
export const freshDefaults = () => structuredClone(DEFAULTS);
