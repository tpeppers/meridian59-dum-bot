// FREE FOOD FROM THE DUKE'S FEAST HALL — while the Duke has it open, the fleet's larder is
// filled from his tables rather than cooked from bought reagents.
//
// WHAT THIS REPLACES. The fleet keeps vigor above the resting cap of 80 by EATING, and
// until now every meal was cast: `create food` at 2 elderberry + 2 herbs, the reagents
// bought at Frisconar's counter in Tos on a supply trip the keeper opens when its loadout
// floor is short. That trip is the same walk as this one — Tos is three hops from the
// hall — and it costs 5,600 shillings a fill and a road that kills. For the length of the
// anniversary event the hall hands out unlimited food to anyone who activates a table,
// so the trip is aimed at the tables instead and the counter is skipped.
//
// The harness's own supply trip then stands down BY ITSELF: `supplyShortfall()` in
// m59-autopilot.mjs answers "still has meals" while there is food aboard, and the
// reagent floor only reopens the trip once the food runs out. So keeping larders stocked
// from the hall is what stops reagent buying, and `feast.suspend_reagent_buying` is the
// belt to that brace — it turns the keeper's purchase permission off through the
// existing `purchase-strategy-policy` rule so that a character that does end up at the
// apothecary for some other reason buys nothing there.
//
// TWO DOORS INTO THE TRIP, AND WHY THEY ARE DIFFERENT.
//
//   * PASSING THROUGH. A character already near Tos — within `max_hops` of the hall, or
//     standing in one of `near_rooms` — with fewer than `min_items` meals aboard tops up.
//     This is "any time they go near Tos": the walk is short and the pack is the only
//     limit, so the door is a larder count and nothing else.
//   * THE SUPPLY TRIP, REDIRECTED. A character with NO meal and no casting's worth of
//     reagents is about to be sent across the world to buy them by its keeper. If the hall
//     is within `max_travel_ms` it is sent to the hall instead. This is the door that
//     actually replaces buying, and it is gated harder — an empty larder, not a thin one —
//     because from Castle Victoria the walk is eleven hops each way.
//
// A JOURNEY, NOT AN ERRAND — AND THE DIFFERENCE IS TWENTY MINUTES OF THE FLEET.
//
// An errand blocks the whole pass while it runs (src/act/errands.mjs, "IT BLOCKS THE
// PASS"). The crate is one hop; the hall is eleven from where this fleet farms, so a single
// blocking errand would stand DUM down for twenty-five minutes per character, and with
// fourteen of twenty-one at the rest cap it would be a feast shuttle until tomorrow. So the
// trip is three SHORT errands, each a few seconds of DUM's time, joined by memory:
//
//   dispatch   `travel` to the hall, non-blocking; memory says `outbound` and where home is
//   grab       the character is seen standing in the hall: activate the table until the
//              pack is full, then `travel` home, non-blocking; memory says `home`
//   abandon    an `outbound` that never arrived in `max_trip_ms` — a dead walker, a locked
//              hall that hustled it back out, a route that failed silently — has its walk
//              cancelled and its memory cleared with a failure backoff, out loud
//
// Between the errands the character is walking under its own keeper's journey, with the
// survival ladder armed (the harness's `goTravelling`), which is exactly what a bought
// reagent trip looks like from the outside. `max_in_flight` bounds how many are on the
// road at once, because the road is the only thing that kills this fleet.
//
// PURE, like every rule here: `now`, the past (obs.memory.feast) and the walk estimate
// (row.travel_to_feast, put on the row by the tick) all arrive on the observation.

import { FEAST_HALL, FEAST_DISPENSERS, FEAST_PACK_FULL, dispenserNamed } from '../feast-hall.mjs';
import { foodAmountOf } from './food.mjs';

const mins = ms => `${Math.round(ms / 60000)}m`;

// HOW LONG TO HOLD A WALKER `busy` FOR A LEG: the estimate, padded for a leg that goes
// slightly wrong (the ordinary case), plus two minutes, never past the journey's own
// give-up time. The runner caps it at its lease ceiling besides. A hold that lapses
// early makes the walker takeable on the road; one that runs long makes every stall
// detector step over a character that is already home — the first is the worse failure.
const holdFor = (ms, maxTripMs) => Math.round(Math.min(maxTripMs, ms * 1.5 + 2 * 60_000));

// Same test `engine.mjs` exports as `takeable`, inlined to stay out of the
// engine<->schema import cycle (crate.mjs and sellrun.mjs do the same).
const isTakeable = row => {
  const c = row?.commitment;
  return !c || !c.kind || c.takeable === true || c.kind === 'partner';
};

// Everything the game calls food that this fleet can eat, plus the hall's own dishes.
// The names in food.mjs are the cooked and bought ones; the hall's are added here so that
// a pack full of pork reads as fed and not as short.
const ANY_FOOD = /inky.?cap|chocolate mint|wheel of cheese|turkey leg|mug of|meat pie|stew|loaf of bread|waterskin|water skin|slice of pork|bowl of soup|spideye|spider eye|bunch of grapes|apple|edible mushroom|drumstick|goblet|fortune cookie/i;

/**
 * How many meals a character has aboard, from whatever the observation carries, or null
 * when nothing does. `items` is the paid inventory read (name + amount); `pack_items` is
 * the same list free off the fleet board; `has_food` is the board's boolean. A null is
 * UNKNOWN and the rule treats it as "not short" — sending somebody across the world on a
 * guess is the wrong direction to fail in, and the board carries pack_items on every
 * live row, so null is rare.
 */
export function mealsAboard(row) {
  const list = Array.isArray(row?.items) ? row.items
             : Array.isArray(row?.pack_items) ? row.pack_items : null;
  if (list) return foodAmountOf(list, ANY_FOOD);
  if (typeof row?.has_food === 'boolean') return row.has_food ? 1 : 0;
  return null;
}

// ---------------------------------------------------------------- the only thing that stops a trip
//
// EVERY CAP IS GONE, AND ONE SAFETY REPLACES THEM. Operator's decision, 2026-09-04: the
// Duke's tables are free and infinite, the fleet's whole ceiling is vigor, and vigor above
// the resting cap of 80 comes ONLY from eating. So everybody tops up every time they pass,
// and none of the old gates survive:
//
//   max_in_flight     a queue for a resource that cannot run out. It was jamming at six
//                     while the fleet starved, mostly on phantom entries.
//   couriers          a named few fetching for everybody, when everybody can fetch.
//   min_items         "already has some food" is not a reason to walk past free food.
//   cooldown          a clock on a thing that costs nothing.
//
// What remains is the one refusal that is about the CHARACTER rather than about the fleet:
// a pack with no room in it. Both halves must be true, because either alone is wrong — a
// pack that is 90% food and half empty should still top up, and a pack that is nearly full
// of LOOT should still be allowed in for food it can actually carry.
//
// Weight rather than item count, because that is what the game refuses on, and because a
// stack of 459 shillings is one line of the pack and no burden at all. Food weight is
// summed from the hall's own table (FEAST_DISPENSERS) with a default for anything bought
// or cooked — an estimate, deliberately, since the alternative is an inventory read per
// character per tick to answer a question that only gates a free walk.
const DEFAULT_FOOD_WEIGHT = 9;      // the pork, the soup and the spider eyes, which is most of it

export function packTooFullForFood(row, { foodShare = 0.5, weightShare = 0.8 } = {}) {
  const carry = row?.carry;
  const max = Number(carry?.weight_max), load = Number(carry?.load?.weight);
  if (!Number.isFinite(max) || !Number.isFinite(load) || max <= 0) return false;  // unknown is not full
  const heavy = load / max > weightShare;
  if (!heavy) return false;                       // room to carry: go, whatever is in there

  const list = Array.isArray(row?.items) ? row.items
             : Array.isArray(row?.pack_items) ? row.pack_items : null;
  if (!list) return false;                        // cannot say what it is carrying: let it go
  let foodWeight = 0;
  for (const it of list) {
    const name = String(it?.name ?? it ?? '');
    if (!ANY_FOOD.test(name)) continue;
    const d = FEAST_DISPENSERS.find(x => new RegExp(x.item, 'i').test(name));
    foodWeight += (Number(it?.amount) || 1) * (d?.weight ?? DEFAULT_FOOD_WEIGHT);
  }
  return foodWeight / load > foodShare;
}

// ---------------------------------------------------------------- murder shuts a room
//
// THE HALL IS SAFE AND THE WALK TO IT IS NOT. duke4.kod:27 gives the Feast Hall
// ROOM_NO_COMBAT | ROOM_SANCTUARY, so nobody can be attacked once inside — but duke1 (the
// Courtyard, 950) and duke2 (Blackstone Keep, 951) declare no such flags, and neither does
// the road from Tos. Those are where somebody would wait for a queue of bots carrying
// nothing but food, and the likeliest ambush is at the moment one walks OUT of the hall.
//
// SO THE BAN IS ON THE ROOM, NOT ON THE FEAST. Operator's call, 2026-09-04: whichever room
// a character was murdered in is shut for an hour plus a random extra up to another hour.
// That is the general fact — somebody is killing us there — and it happens to cover the
// feast road because the feast road is where it will happen. A rule that only knew about
// the hall would have to be written again for the next ambush.
//
// THE RANDOMNESS IS THE POINT. A fixed ban is a schedule, and a schedule is something to
// wait out: a killer who knows it is exactly sixty minutes comes back at minute sixty-one.
// Rolled ONCE when the ban is set and stored, so reading it does not move the deadline.
//
// HOW A MURDER IS RECOGNISED, and the first attempt at this had it wrong. The game does not
// name the killer. system.kod:50 is a dedicated broadcast that names nobody at all:
//
//     system_user_killed_by_pker = "### %q has been murdered in cold blood."
//
// against the ordinary "### %q was just killed by %s%q." for a creature. The harness already
// parses every form and labels them (m59-skills.mjs DEATH_FORMS), so the discriminator is
// the label, not the killer's name — an earlier version of this looked for a bare
// capitalised name after "killed by" and would have missed every real murder there is.
export const PK_BAN_BASE_MS = 60 * 60_000;
export const PK_BAN_EXTRA_MAX_MS = 60 * 60_000;
export const BAN_KEY = '_pk';

// The labels the harness puts on a death another PLAYER caused. `murdered by a player` is
// the cold-blood broadcast; the other two are what the world says when the victim was
// itself flagged — still a player kill, still a room to stay out of.
export const PLAYER_KILL_FORMS = Object.freeze([
  'murdered by a player', 'killed as a murderer', 'killed as an outlaw',
]);

/** Did another player do this? The label decides; the text is the fallback. */
export function killedByPlayer(broadcast) {
  const how = String(broadcast?.how ?? '');
  if (PLAYER_KILL_FORMS.includes(how)) return true;
  // Fallback for a record written before the harness labelled them, or by another tool.
  return /has been murdered in cold blood/i.test(String(broadcast?.text ?? ''));
}

/** The ban this murder earns, or null. `rand` is injected so a test is not a coin flip. */
export function pkBanFrom(broadcast, { at = Date.now(), room = null, rand = Math.random } = {}) {
  if (!killedByPlayer(broadcast)) return null;
  if (!Number.isInteger(room)) return null;      // a ban has to be ON somewhere
  const extra = Math.floor(rand() * PK_BAN_EXTRA_MAX_MS);
  return {
    room, at, until: at + PK_BAN_BASE_MS + extra,
    victim: String(broadcast?.who ?? ''),
    how: String(broadcast?.how ?? 'murdered'),
    why: `${broadcast?.who ?? 'a character'} was murdered in room ${room}; ` +
         'nobody goes back until it has been quiet for a while',
  };
}

/** Is this room shut, and for how much longer? */
export function roomBanned(mem = {}, room, now = Date.now()) {
  const b = mem?.[BAN_KEY]?.rooms?.[String(room)];
  if (!b || !Number.isFinite(b.until) || b.until <= now) return null;
  return { ...b, remaining_ms: b.until - now };
}

/**
 * Is the feast road shut? The hall itself is a sanctuary, but every way in and out of it
 * runs through rooms that are not — so a murder in ANY of them stops the trip.
 */
export function feastBan(mem = {}, now = Date.now()) {
  for (const room of [FEAST_HALL.room, ...FEAST_HALL.approach]) {
    const b = roomBanned(mem, room, now);
    if (b) return b;
  }
  return null;
}

/** Whether the character holds one casting's worth of create-food reagents. */
export function canCook(row, food = {}) {
  const r = row?.reagents ?? {};
  const eb = Number(r.elderberry ?? row?.elderberry ?? 0) || 0;
  const hb = Number(r.herbs ?? row?.herbs ?? 0) || 0;
  return eb >= (food.elderberry_per_cast ?? 2) && hb >= (food.herbs_per_cast ?? 2);
}

/**
 * Per-character gate: is this character allowed another trip yet? Unknown means READY,
 * as it does for the crate and the sell circuit — the cost of being wrong is one walk.
 * A completed visit waits the full cooldown (the pack was filled); a failed one waits the
 * shorter backoff so a hall that was briefly unreachable is retried rather than written
 * off for an hour.
 */
export function feastWindow(mem = {}, agent, now, cooldownMs, failBackoffMs = cooldownMs) {
  const e = mem?.[agent];
  const last = e?.last_visit_at ?? e?.failed_at;
  const since = (typeof last === 'number' && Number.isFinite(last)) ? now - last : null;
  if (since !== null) {
    const failed = e?.ok === false;
    const gate = failed ? failBackoffMs : cooldownMs;
    if (since < gate)
      return { ready: false, why: failed
        ? `${agent}'s last feast trip failed ${mins(since)} ago; retry in ${mins(gate - since)}`
        : `${agent} filled up at the hall ${mins(since)} ago; not again for ${mins(gate - since)}` };
  }
  return { ready: true, why: since === null
    ? `${agent} has no recorded feast trip` : `${mins(since)} since ${agent}'s last trip` };
}

// ---------------------------------------------------------------- counting what it did
//
// The feast is the fleet's only free food and it took a day of wrong diagnoses to get one
// slice of pork out of it, mostly because nothing counted anything: "did a courier take
// food" was answered by reading a keeper's pack by hand. These are the numbers that would
// have answered it in one line.
//
// KEPT IN THE FEAST TOPIC UNDER A KEY NO AGENT CAN HAVE. The memory is `agent -> entry`,
// and a leading underscore is not a legal agent name, so `_stats` cannot collide with one.
// Both loops over the memory below skip it explicitly rather than relying on it having no
// `phase` — that works today and would break silently the day a counter is named `phase`.
export const STATS_KEY = '_stats';

/** A memory patch that adds to the running counters. Merged like any other patch. */
export function bumpFeastStats(mem = {}, delta = {}, at = Date.now()) {
  const now = mem?.[STATS_KEY] ?? {};
  const out = { ...now, since: now.since ?? at, last_at: at };
  for (const [k, v] of Object.entries(delta)) out[k] = (Number(now[k]) || 0) + v;
  return { [STATS_KEY]: out };
}

/** The counters, or an empty set. For the pass report and for `dum explain`. */
export function feastStats(mem = {}) {
  const s = mem?.[STATS_KEY] ?? {};
  return {
    dispatched: s.dispatched || 0,   // journeys started toward the hall
    arrived: s.arrived || 0,         // characters seen standing in it
    taken: s.taken || 0,             // ITEMS of food actually taken from the tables
    packs_filled: s.packs_filled || 0,
    trips_ok: s.trips_ok || 0,       // grabs that came away with something
    trips_empty: s.trips_empty || 0, // grabs that took nothing
    abandoned: s.abandoned || 0,     // journeys given up as stale
    since: s.since ?? null,
    last_at: s.last_at ?? null,
  };
}

/** One line for the pass report. Empty string when nothing has happened yet. */
export function feastStatsLine(mem = {}) {
  const s = feastStats(mem);
  if (!s.dispatched && !s.arrived && !s.taken) return '';
  const per = s.trips_ok ? Math.round(s.taken / s.trips_ok) : 0;
  return `feast: ${s.taken} food taken over ${s.trips_ok} trip(s)` +
         (per ? ` (${per}/trip)` : '') +
         ` | ${s.dispatched} sent, ${s.arrived} arrived` +
         (s.packs_filled ? `, ${s.packs_filled} filled the pack` : '') +
         (s.trips_empty ? `, ${s.trips_empty} took nothing` : '') +
         (s.abandoned ? `, ${s.abandoned} abandoned` : '');
}

/** A journey's memory says it is on the road and has not yet gone stale. */
const outboundEntries = (mem = {}, now, maxTripMs) =>
  Object.entries(mem).filter(([k, e]) => k !== STATS_KEY && e?.phase === 'outbound'
    && typeof e.since === 'number' && now - e.since <= maxTripMs);

const outboundStale = (e, now, maxTripMs) =>
  e?.phase === 'outbound' && (typeof e.since !== 'number' || now - e.since > maxTripMs);

/** The dispenser this doctrine takes from — the first named one the hall actually has. */
export function chosenDispenser(cfg = {}) {
  for (const name of (cfg.grab_from ?? [])) {
    const d = dispenserNamed(name);
    if (d) return d;
  }
  return FEAST_DISPENSERS[0];
}

/** How many activations this trip asks for: the doctrine's cap, bounded by known pack room. */
export function grabsFor(row, cfg = {}, dispenser = FEAST_DISPENSERS[0]) {
  const cap = Math.max(1, Math.floor(cfg.max_grabs ?? 60));
  const carry = row?.carry;
  const room = carry?.room_for;
  if (room && Number.isFinite(room.weight) && Number.isFinite(room.bulk)) {
    const fit = Math.floor(Math.min(room.weight, room.bulk) / dispenser.weight);
    return Math.max(1, Math.min(cap, fit));
  }
  return cap;
}

/** The dispatch errand: one non-blocking travel, and a memory that says where home is. */
function outboundSteps(agent, cfg) {
  return [{
    tool: 'travel',
    args: { agent, to: FEAST_HALL.room, background: true, run_errands: false },
    // No `expect: 'arrived'` on purpose — this errand LAUNCHES the walk and returns. The
    // arrival is read off the board by a later tick, which is what keeps the pass free.
    estimate_ms: 10_000,
    why: `set off for ${FEAST_HALL.name} (${FEAST_HALL.room})`,
  }];
}

/** The grab errand: walk to the table, take from it until the pack is full, then home. */
function grabSteps(agent, cfg, home, row) {
  const d = chosenDispenser(cfg);
  const n = grabsFor(row, cfg, d);
  const steps = [];

  // WALK TO THE TABLE FIRST, WHICH THE SERVER DOES NOT REQUIRE.
  //
  // `UserTryActivate` checks only that the dispenser is in the same ROOM as you
  // (user.kod: GetOwner <> poOwner) — no distance test — so a character can take a roast
  // pig from the far side of the hall and the server allows it. This is therefore not a
  // correctness step; it is an appearance one, and on a SHARED SERVER that matters. The
  // Duke's feast is a public event with human players standing at the same tables, and a
  // character that harvests forty slices of pork from a doorway twenty squares away reads
  // as exactly what it is. Operator's call, 2026-09-04.
  //
  // `distance: 1` is adjacent. Not `always`: if the walk fails the taking should still be
  // attempted, because the food is the point and the manners are not.
  steps.push({
    tool: 'approach', args: { agent, target: d.dispenser, distance: 1 },
    estimate_ms: 12_000, optional: true,
    why: `walk up to the ${d.dispenser} before taking from it — the server does not ` +
         'require it, the people watching do',
  });

  for (let i = 0; i < n; i++) {
    steps.push({
      tool: 'act', args: { agent, verb: 'activate', target: d.dispenser },
      collect: 'messages', estimate_ms: 3_000,
      // The hall says so when the pack is full, and every later grab would be the same
      // refusal — so the first one ends the taking and the walk home runs next.
      stop_when: FEAST_PACK_FULL, skip_when_satisfied: true,
      // Sixty three-second steps do not need sixty lease extensions.
      extend_busy: i === 0,
      why: i === 0 ? `take ${d.item} from the ${d.dispenser} until the pack is full` : undefined,
    });
  }
  // AND SAY SOMETHING, for the same reason as the walk.
  //
  // A silent character that empties a table and leaves is unsettling to stand next to;
  // one that says "Mmm, roast pig!" is a person enjoying a feast. It costs one packet at
  // the end of a two-minute errand. `always` so it still happens when the pack filled
  // early and the taking loop was skipped — that is the ordinary ending, not a failure.
  steps.push({
    tool: 'say', args: { agent, text: `Mmm, ${d.item}!` },
    // One packet and a second: it does not need its own lease extension.
    always: true, estimate_ms: 1_000, extend_busy: false,
    why: "the Duke's feast is a public event and the fleet is a guest at it",
  });

  if (cfg.return_home !== false && Number.isInteger(home))
    steps.push({
      tool: 'travel', args: { agent, to: home, background: true, run_errands: false },
      always: true, estimate_ms: 10_000,
      why: 'back to the room it was working in, non-blocking',
    });
  return steps;
}

export const feastFleetRules = [
  {
    id: 'feast-hall-larder',
    faculty: 'work',
    scope: 'fleet',
    why: "while the Duke's Feast Hall is open its tables hand out unlimited food, so the " +
         'fleet fills its larder there instead of buying create-food reagents in Tos — ' +
         'topping up whenever a character is near Tos, and redirecting the supply trip a ' +
         'keeper would otherwise make for reagents to the tables instead',
    enabled: doctrine => doctrine.feast?.on === true,
    offWhy: 'feast.on is off. The hall is locked outside the event and the trip walks a ' +
            'character across the world, so it is opted into for the event and switched ' +
            'off when the Duke closes the doors',

    decide(obs, doctrine) {
      const cfg = doctrine.feast ?? {};
      const food = doctrine.food ?? {};
      const now = obs.at;
      const mem = obs.memory?.feast ?? {};
      const hall = FEAST_HALL.room;
      // `min_items`, `cooldown_ms`, `fail_backoff_ms`, `max_in_flight` and `couriers` are
      // all read no more — see the note on packTooFullForFood. Left unread rather than
      // deleted from the doctrine schema so an existing local doctrine still loads; the
      // schema warns about a key nothing consumes, which is the right way to find them.
      const minHealth = cfg.min_health ?? 0.8;
      const maxHops = cfg.max_hops ?? 4;
      const maxTravelMs = cfg.max_travel_ms ?? 15 * 60_000;
      const maxTripMs = cfg.max_trip_ms ?? 30 * 60_000;
      const near = new Set(cfg.near_rooms ?? []);
      // COURIERS — THE THIRD DOOR, AND THE ONE THAT IS NOT ABOUT THE WALKER'S OWN LARDER.
      //
      // Both doors below ask what THIS character has to eat, which is right for a fleet
      // feeding itself and useless for a fleet feeding somebody else. Operator request,
      // 2026-09-04: three characters that had outgrown their hunting room were to empty
      // their packs, fill up at the tables and carry the food back to the fifteen at Castle
      // Victoria — eleven of whom were pinned at the resting cap of 80 against a target of
      // 140, with one meat pie between them. Not one of the three qualified: they carried
      // reagents and could cook, so `starving` was false, and they were nowhere near Tos,
      // so `nearby` was false. The rule correctly declined to send anybody, at the moment
      // sending somebody was the entire point.
      //
      // A courier's own larder is therefore not the test. Everything that keeps the trip
      // safe and bounded still is: health, takeability, the in-flight cap, and the
      // per-character cooldown — a courier that has just filled a pack does not turn round
      // and walk straight back for another one.
      //
      // Matched against the agent handle OR the character name, like `castle_victoria.only`.
      const rows = (obs.characters ?? []).filter(r => r.in_game);
      if (!rows.length) return { kind: 'pass', why: 'nobody in game' };

      // 0. SOMEBODY WAS MURDERED ON THE ROAD. Nobody goes, including anyone already in the
      // hall — the hall is safe but they have to walk home through the room it happened in.
      const ban = feastBan(mem, now);
      if (ban)
        return { kind: 'pass',
                 why: `no feast trips for ${mins(ban.remaining_ms)}: ${ban.why}`,
                 evidence: { ban } };

      // 0b. LOOK FOR ONE. A death on the approach is cheap to spot from the board — the
      // room number is right there — but WHO did it costs a read, so the read only happens
      // when somebody has actually died in one of those rooms since we last looked.
      // ANY DEATH IN A ROOM WE ARE NOT ALREADY AVOIDING is worth one read. The board gives
      // the room free; only WHO did it costs a call, so the call happens once per death.
      const seenAt = Number(mem?.[BAN_KEY]?.checked_at) || 0;
      const died = rows.find(r => {
        const d = r.last_death;
        if (!d || !Number.isFinite(d.at) || d.at <= seenAt) return false;
        return Number.isInteger(Number(d.room_num)) && !roomBanned(mem, d.room_num, now);
      });
      if (died)
        return {
          kind: 'errand',
          orders: { errand: 'feast-pk-check', agent: died.agent,
                    label: 'was that a murder?',
                    context: { at: died.last_death.at, room: Number(died.last_death.room_num) },
                    steps: [{ tool: 'post_mortem', args: { agent: died.agent },
                              collect: 'result', estimate_ms: 3_000, always: true,
                              why: 'the broadcast says whether a player did it; it does NOT name them' }] },
          why: `${died.agent} died in ${died.last_death.room_num}; reading the post-mortem to ` +
               'see whether it was murder, which shuts that room for an hour or two',
          evidence: { agent: died.agent, room: died.last_death.room_num },
        };
      const byAgent = new Map(rows.map(r => [r.agent, r]));

      // 1. SOMEBODY IS STANDING IN THE HALL. Serve them first: a character in a sanctuary
      // with an empty pack is doing nothing for anyone, and the dispatch below would only
      // add another walker to the road while this one waits.
      //
      // OUR OWN BUSY IS NOT A REASON TO WAIT. The outbound errand holds the walker `busy`
      // for the length of the walk (hold_busy_ms), precisely so nothing else takes it on
      // the road — and that hold is still on it when it arrives. A `bot` commitment is
      // that hold; anything else (a keeper errand, a pilot, a park) is somebody else's.
      for (const row of rows) {
        if (row.room !== hall) continue;
        if (row.piloted || row.parked) continue;
        if (!isTakeable(row) && row.commitment?.kind !== 'bot') continue;
        const e = mem[row.agent];
        // STANDING IN THE HALL IS ITS OWN REASON. This used to require an outbound journey
        // or a fresh cooldown window; both are gone with the rest of the caps. A character
        // in the room with the free food, whatever brought it there, takes some — unless
        // its pack genuinely has no room, which is the only refusal left.
        if (packTooFullForFood(row)) continue;
        const home = Number.isInteger(e?.from) ? e.from
                   : (row.policy?.assignedRoom ?? row.assigned_room ?? null);
        const d = chosenDispenser(cfg);
        const steps = grabSteps(row.agent, cfg, home, row);
        // The walk home is as long as the walk in; hold the walker for it the same way.
        const homeMs = Number.isFinite(e?.ms) ? e.ms : maxTravelMs;
        return {
          kind: 'errand',
          orders: { errand: 'feast-grab', agent: row.agent,
                    label: `feast hall: fill the pack with ${d.item}`,
                    context: { home, dispenser: d.dispenser, grabs: steps.filter(s => s.tool === 'act').length },
                    hold_busy_ms: Number.isInteger(home) ? holdFor(homeMs, maxTripMs) : 0,
                    steps },
          why: `${row.agent} is standing in ${FEAST_HALL.name}; take ${d.item} from the ` +
               `${d.dispenser} until the pack is full, then walk home to ${home ?? 'wherever it was'}`,
          evidence: { agent: row.agent, phase: e?.phase ?? null, home,
                      meals: mealsAboard(row), pack: row?.carry?.load?.weight ?? null },
        };
      }

      // 2. A JOURNEY THAT WENT STALE. Cancel the walk it may still be on and clear the
      // memory, with a backoff — and say the likeliest cause, because a locked hall looks
      // exactly like a slow road from here.
      for (const [agent, e] of Object.entries(mem)) {
        if (agent === STATS_KEY) continue;         // the counters are not a character
        if (!outboundStale(e, now, maxTripMs)) continue;
        const row = byAgent.get(agent);
        const where = row?.room ?? null;
        const hustled = FEAST_HALL.approach.includes(where);
        return {
          kind: 'errand',
          orders: { errand: 'feast-abandon', agent, label: 'feast hall: give up a stale journey',
                    context: { where, since: e.since ?? null },
                    steps: [{ tool: 'cancel_movement', args: { agent }, estimate_ms: 2_000, always: true,
                              why: 'cancel whatever walk is still dangling from the journey' }] },
          why: `${agent} set off for the feast hall ${mins(now - (e.since ?? now))} ago and is ` +
               `${where == null ? 'nowhere on the board' : `in ${where}`}, not in the hall` +
               (hustled ? ' — standing on the approach, which is what a LOCKED hall does to a ' +
                          'visitor (duke4.kod:38-45): if the event has ended, turn feast.on off'
                        : ''),
          evidence: { agent, where, since: e.since ?? null, hustled },
        };
      }

      // 3. DISPATCH — UNCAPPED. See `packTooFullForFood`: every gate that was about the
      // FLEET is gone (how many are on the road, who is a named courier, whether they
      // already have some food, how recently they went). The tables are free and cannot run
      // dry, so the only question left is whether this particular character has room.
      const candidates = [];
      const skipped = [];
      for (const row of rows) {
        if (row.room === hall) continue;
        if (mem[row.agent]?.phase === 'outbound') continue;   // already walking there
        if (row.piloted || row.parked || !isTakeable(row)) continue;
        // HEALTH IS NOT A CAP, IT IS THE TRAVEL RULE. A journey has a health floor
        // everywhere in this fleet; setting out hurt is how the road kills people.
        if ((row.health?.pct ?? 1) < minHealth) { skipped.push(`${row.agent}: hurt`); continue; }
        // THE ONE REFUSAL LEFT. Both halves: mostly food AND nearly full by weight.
        if (packTooFullForFood(row)) { skipped.push(`${row.agent}: pack full of food`); continue; }
        const meals = mealsAboard(row);
        const est = row.travel_to_feast ?? null;
        const hops = Number.isFinite(est?.hops) ? est.hops : null;
        const ms = Number.isFinite(est?.ms) ? est.ms : null;
        // TWO DOORS NOW, AND NEITHER ASKS WHAT IS IN THE LARDER. Passing through is any
        // character within `max_hops` — the walk is short, so it always pays. Otherwise the
        // hall has to be worth the journey, which is what `max_travel_ms` is for.
        const nearby = near.has(row.room) || (hops !== null && hops <= maxHops);
        const reachable = ms !== null && ms <= maxTravelMs;
        let door = null;
        if (nearby) door = 'passing';
        else if (reachable) door = 'supply';
        else if (ms === null) { skipped.push(`${row.agent}: no walk estimate`); continue; }
        else continue;
        candidates.push({ row, meals: meals ?? 0, hops, ms, door, window: 'uncapped' });
      }
      if (!candidates.length)
        return { kind: 'pass',
                 why: `nobody to send: ${rows.length} checked, none within ${maxHops} hop(s) of the ` +
                      `hall or ${mins(maxTravelMs)} of it` +
                      (skipped.length ? ` (${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? '; …' : ''})` : '') };

      // Nearest first, then hungriest: the short walk is the cheap one, and among equals
      // the character with least food gains most from going.
      candidates.sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99) || a.meals - b.meals);
      const pick = candidates[0];
      const row = pick.row;
      const home = row.policy?.assignedRoom ?? row.assigned_room ?? row.room ?? null;
      return {
        kind: 'errand',
        orders: { errand: 'feast-outbound', agent: row.agent,
                  label: `feast hall: set off (${pick.door === 'passing' ? 'near Tos'
                            : 'worth the walk'})`,
                  context: { home, door: pick.door, hops: pick.hops, ms: pick.ms },
                  // Held `busy` for the walk, so the station recall and every other rule
                  // that reads `takeable` leave it on the road. See errands.mjs.
                  hold_busy_ms: holdFor(pick.ms ?? maxTravelMs, maxTripMs),
                  steps: outboundSteps(row.agent, cfg) },
        // NO "n ALREADY ON THE ROAD" ANY MORE, because nothing is bounded by it. The
        // number that matters now is how many the fleet is sending, which the counters
        // report, and how much food came back.
        why: pick.door === 'passing'
          ? `${row.agent} is ${pick.hops ?? '?'} hop(s) from the feast hall with ${pick.meals} meal(s) ` +
            `aboard; go and fill the pack while it is close`
          : `${row.agent} is ~${mins(pick.ms ?? 0)} from the feast hall (${pick.hops ?? '?'} hop(s)) ` +
            `and the tables are free; send it to fill up rather than buy reagents in Tos`,
        evidence: { agent: row.agent, meals: pick.meals, hops: pick.hops, ms: pick.ms, door: pick.door,
                    home, sending: candidates.length,
                    others: candidates.slice(1, 4).map(c => `${c.row.agent}:${c.door}/${c.hops ?? '?'}h`) },
      };
    },
  },
];

// ---------------------------------------------------------------- what each errand leaves behind

/** Dispatch: the journey is on the road, and this is where it goes back to. */
export function recordFeastOutbound({ agent, at, stopped, context, was = {} }) {
  if (stopped)
    return { patch: { [agent]: { phase: null, failed_at: at, ok: false, why: stopped },
                      ...bumpFeastStats(was, { trips_empty: 1 }, at) },
             read: { ok: false, agent, at, stopped } };
  // `ms` is the walk in, kept so the grab can hold the walker for a walk home of the same length.
  const ms = Number.isFinite(context?.ms) ? context.ms : null;
  return { patch: { [agent]: { phase: 'outbound', since: at, from: context?.home ?? null, ms, ok: null },
                    ...bumpFeastStats(was, { dispatched: 1 }, at) },
           read: { ok: true, agent, at, phase: 'outbound', from: context?.home ?? null, ms } };
}

/** Grab: how much was taken, whether the pack filled, and that the trip is done. */
export function recordFeastGrab({ agent, at, transcript = [], stopped, results = [], context, was = {} }) {
  const lines = (transcript ?? []).map(String);
  const d = dispenserNamed(context?.dispenser) ?? FEAST_DISPENSERS[0];
  const spoken = d.taken ? lines.filter(l => d.taken.test(l)).length : null;
  const full = lines.some(l => FEAST_PACK_FULL.test(l));
  // The activations that ran and were not the refusal: a count for the silent dispensers,
  // and a cross-check for the ones that speak.
  const ran = (results ?? []).filter(r => r.tool === 'act' && !r.skipped && !r.result?.error).length;
  const grabbed = spoken ?? Math.max(0, ran - (full ? 1 : 0));
  const ok = !stopped && grabbed > 0;
  return {
    patch: { [agent]: { phase: 'home', last_visit_at: at, ok, grabbed, pack_full: full,
                        ...(ok ? {} : { failed_at: at, why: stopped ?? 'took nothing' }) },
             ...bumpFeastStats(was, {
               arrived: 1, taken: grabbed,
               ...(full ? { packs_filled: 1 } : {}),
               ...(ok ? { trips_ok: 1 } : { trips_empty: 1 }),
             }, at) },
    read: { ok, agent, at, grabbed, pack_full: full, verified: spoken !== null, stopped: stopped ?? null },
  };
}

/**
 * The PK check: was that death a murder, and if so, shut the room it happened in.
 *
 * `checked_at` is recorded either way, so one death is read once. A monster kill leaves
 * that mark and nothing else — the fleet keeps walking, which is the operator's standing
 * position on road deaths: the herbs are worth it.
 */
export function recordFeastPkCheck({ at, results = [], context, was = {}, rand = Math.random }) {
  const said = results.find(r => r.tool === 'post_mortem')?.result ?? null;
  const record = said?.record ?? said ?? null;
  const broadcast = record?.killed_by_broadcast ?? null;
  const room = Number(context?.room);
  const ban = pkBanFrom(broadcast, { at, room, rand });
  const prior = was?.[BAN_KEY] ?? {};
  const checked = { ...prior, checked_at: Math.max(Number(context?.at) || 0, at) };
  if (!ban)
    return { patch: { [BAN_KEY]: checked },
             read: { ok: true, at, murdered: false, how: broadcast?.how ?? null,
                     why: broadcast ? `${broadcast.how ?? 'killed'} — not a player`
                                    : 'no broadcast on the post-mortem' } };
  return {
    patch: { [BAN_KEY]: { ...checked, rooms: { ...(prior.rooms ?? {}), [String(room)]: ban } },
             ...bumpFeastStats(was, { murders: 1 }, at) },
    read: { ok: true, at, murdered: true, room, until: ban.until, why: ban.why },
  };
}

/** Abandon: the journey is over, and the next attempt waits the failure backoff. */
export function recordFeastAbandon({ agent, at, context, was = {} }) {
  return { patch: { [agent]: { phase: null, failed_at: at, ok: false,
                               why: `never arrived; last seen in ${context?.where ?? '?'}` },
                    ...bumpFeastStats(was, { abandoned: 1 }, at) },
           read: { ok: false, agent, at, abandoned: true, where: context?.where ?? null } };
}
