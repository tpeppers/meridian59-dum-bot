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

/** A journey's memory says it is on the road and has not yet gone stale. */
const outboundEntries = (mem = {}, now, maxTripMs) =>
  Object.entries(mem).filter(([, e]) => e?.phase === 'outbound'
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

/** The grab errand: activate the table until the pack is full, then walk home. */
function grabSteps(agent, cfg, home, row) {
  const d = chosenDispenser(cfg);
  const n = grabsFor(row, cfg, d);
  const steps = [];
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
      const minItems = cfg.min_items ?? 6;
      const minHealth = cfg.min_health ?? 0.8;
      const maxHops = cfg.max_hops ?? 4;
      const maxTravelMs = cfg.max_travel_ms ?? 15 * 60_000;
      const maxTripMs = cfg.max_trip_ms ?? 30 * 60_000;
      const cooldownMs = cfg.cooldown_ms ?? 45 * 60_000;
      const failBackoffMs = cfg.fail_backoff_ms ?? 10 * 60_000;
      const maxInFlight = cfg.max_in_flight ?? 3;
      const near = new Set(cfg.near_rooms ?? []);
      const rows = (obs.characters ?? []).filter(r => r.in_game);
      if (!rows.length) return { kind: 'pass', why: 'nobody in game' };
      const byAgent = new Map(rows.map(r => [r.agent, r]));

      // 1. SOMEBODY IS STANDING IN THE HALL. Serve them first: a character in a sanctuary
      // with an empty pack is doing nothing for anyone, and the dispatch below would only
      // add another walker to the road while this one waits.
      for (const row of rows) {
        if (row.room !== hall) continue;
        if (row.piloted || row.parked || !isTakeable(row)) continue;
        const e = mem[row.agent];
        // Arrived under our journey, or simply there for its own reasons — either way, if
        // it is not freshly fed, fill the pack.
        const win = feastWindow(mem, row.agent, now, cooldownMs, failBackoffMs);
        if (e?.phase !== 'outbound' && !win.ready) continue;
        const home = Number.isInteger(e?.from) ? e.from
                   : (row.policy?.assignedRoom ?? row.assigned_room ?? null);
        const d = chosenDispenser(cfg);
        const steps = grabSteps(row.agent, cfg, home, row);
        return {
          kind: 'errand',
          orders: { errand: 'feast-grab', agent: row.agent,
                    label: `feast hall: fill the pack with ${d.item}`,
                    context: { home, dispenser: d.dispenser, grabs: steps.filter(s => s.tool === 'act').length },
                    steps },
          why: `${row.agent} is standing in ${FEAST_HALL.name}; take ${d.item} from the ` +
               `${d.dispenser} until the pack is full, then walk home to ${home ?? 'wherever it was'}`,
          evidence: { agent: row.agent, phase: e?.phase ?? null, home,
                      meals: mealsAboard(row), window: win.why },
        };
      }

      // 2. A JOURNEY THAT WENT STALE. Cancel the walk it may still be on and clear the
      // memory, with a backoff — and say the likeliest cause, because a locked hall looks
      // exactly like a slow road from here.
      for (const [agent, e] of Object.entries(mem)) {
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

      // 3. DISPATCH. Bounded by how many are already on the road.
      const inFlight = outboundEntries(mem, now, maxTripMs).length;
      if (inFlight >= maxInFlight)
        return { kind: 'pass', why: `${inFlight} already on the road to the hall (max_in_flight ${maxInFlight})` };

      const candidates = [];
      const skipped = [];
      for (const row of rows) {
        if (row.room === hall) continue;
        if (mem[row.agent]?.phase === 'outbound') continue;
        if (row.piloted || row.parked || !isTakeable(row)) continue;
        if ((row.health?.pct ?? 1) < minHealth) { skipped.push(`${row.agent}: hurt`); continue; }
        const meals = mealsAboard(row);
        if (meals === null) { skipped.push(`${row.agent}: larder unreadable`); continue; }
        if (meals >= minItems) continue;
        const est = row.travel_to_feast ?? null;
        const hops = Number.isFinite(est?.hops) ? est.hops : null;
        const ms = Number.isFinite(est?.ms) ? est.ms : null;
        const nearby = near.has(row.room) || (hops !== null && hops <= maxHops);
        const starving = meals === 0 && !canCook(row, food);
        const reachable = ms !== null && ms <= maxTravelMs;
        let door = null;
        if (nearby) door = 'passing';
        else if (starving && reachable) door = 'supply';
        else if (starving && ms === null) { skipped.push(`${row.agent}: no walk estimate`); continue; }
        else continue;
        const win = feastWindow(mem, row.agent, now, cooldownMs, failBackoffMs);
        if (!win.ready) { skipped.push(win.why); continue; }
        candidates.push({ row, meals, hops, ms, door, window: win.why });
      }
      if (!candidates.length)
        return { kind: 'pass',
                 why: `nobody to send: ${rows.length} checked, none near Tos with under ${minItems} ` +
                      `meals or out of food and reagents within ${mins(maxTravelMs)} of the hall` +
                      (skipped.length ? ` (${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? '; …' : ''})` : '') };

      // Nearest first, then hungriest: the short walk is the cheap one.
      candidates.sort((a, b) => (a.hops ?? 99) - (b.hops ?? 99) || a.meals - b.meals);
      const pick = candidates[0];
      const row = pick.row;
      const home = row.policy?.assignedRoom ?? row.assigned_room ?? row.room ?? null;
      return {
        kind: 'errand',
        orders: { errand: 'feast-outbound', agent: row.agent,
                  label: `feast hall: set off (${pick.door === 'passing' ? 'near Tos' : 'supply trip, redirected'})`,
                  context: { home, door: pick.door, hops: pick.hops, ms: pick.ms },
                  steps: outboundSteps(row.agent, cfg) },
        why: pick.door === 'passing'
          ? `${row.agent} is ${pick.hops ?? '?'} hop(s) from the feast hall with ${pick.meals} meal(s) aboard; ` +
            `go and fill the pack while it is close (${inFlight} already on the road)`
          : `${row.agent} has no food and cannot cast create food (reagents ` +
            `${JSON.stringify(row.reagents ?? {})}); its keeper would buy reagents in Tos next, ` +
            `so send it to the feast hall instead, ${pick.hops ?? '?'} hop(s) / ~${mins(pick.ms ?? 0)} away ` +
            `(${inFlight} already on the road)`,
        evidence: { agent: row.agent, meals: pick.meals, hops: pick.hops, ms: pick.ms, door: pick.door,
                    home, window: pick.window, in_flight: inFlight,
                    others: candidates.slice(1, 4).map(c => `${c.row.agent}:${c.door}/${c.hops ?? '?'}h`) },
      };
    },
  },
];

// ---------------------------------------------------------------- what each errand leaves behind

/** Dispatch: the journey is on the road, and this is where it goes back to. */
export function recordFeastOutbound({ agent, at, stopped, context }) {
  if (stopped)
    return { patch: { [agent]: { phase: null, failed_at: at, ok: false, why: stopped } },
             read: { ok: false, agent, at, stopped } };
  return { patch: { [agent]: { phase: 'outbound', since: at, from: context?.home ?? null, ok: null } },
           read: { ok: true, agent, at, phase: 'outbound', from: context?.home ?? null } };
}

/** Grab: how much was taken, whether the pack filled, and that the trip is done. */
export function recordFeastGrab({ agent, at, transcript = [], stopped, results = [], context }) {
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
                        ...(ok ? {} : { failed_at: at, why: stopped ?? 'took nothing' }) } },
    read: { ok, agent, at, grabbed, pack_full: full, verified: spoken !== null, stopped: stopped ?? null },
  };
}

/** Abandon: the journey is over, and the next attempt waits the failure backoff. */
export function recordFeastAbandon({ agent, at, context }) {
  return { patch: { [agent]: { phase: null, failed_at: at, ok: false,
                               why: `never arrived; last seen in ${context?.where ?? '?'}` } },
           read: { ok: false, agent, at, abandoned: true, where: context?.where ?? null } };
}
