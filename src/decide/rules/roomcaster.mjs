// A POSTED CASTER — one character standing in one room keeping a room enchantment up,
// and the supply line that keeps it able to.
//
// Operator, 2026-09-23: put Alfa in Castle Victoria casting `forces of light` from a safe
// spot; when he runs out of reagents he should rescue, buy more (or be given them by the
// fleet), and run back to Castle Victoria to carry on.
//
// WHAT THIS IS WORTH. `forces of light` is a ROOM enchantment (forceslt.kod): it adds
// 50-150 to the hit roll of every good-karma player in the room and covers whoever walks
// in next. One posted caster therefore raises the earning rate of every farmer standing
// with it, including the ones who arrive after the cast. It costs 2 elderberry AND 1
// emerald a throw (forceslt.kod:57-58) and lasts `6 * (power/3 + 1)` seconds, up to about
// three minutes — so this is a renewal loop on a one-minute clock, not an errand.
//
// ---------------------------------------------------------------- the load-bearing fact
//
// EVERY RULE HERE IS `faculty: 'economy'`, INCLUDING THE TWO THAT WALK, AND THAT IS NOT A
// FUDGE.
//
// The keeper is what actually casts. `Autopilot.maintainRoomEnchantPost` takes a safe spot
// ("stationary room caster needs shelter"), renews the enchantment off its own one-second
// clock, rests for mana between throws, accepts donated reagents and stops when they run
// out. DUM cannot do that half and must not try: safe spots, pacing and the survival ladder
// belong to the harness (CLAUDE.md, "Do not carry the harness's code over here").
//
// And `Autopilot.isRoomEnchantPost` runs that loop only while
// `!facultyHeld('work') && !facultyHeld('movement')` — that is, only while NOBODY ELSE is
// steering. So a doctrine that claimed work or movement for this character would switch off
// the exact behaviour it was written to arrange. Nothing would error. The board would show
// a healthy bot holding a healthy character, the journal would show these rules firing, and
// the room would simply never be lit.
//
// `src/config/schema.mjs` refuses that doctrine rather than trusting anyone to remember it.
//
// So DUM's contribution to a posted caster is the SUPPLY, on the minutes clock where it
// belongs: which room he is posted in, what the keeper's standing orders are, and where the
// next hundred elderberries come from. The walking in this file is a shopping trip and the
// way back from one, which is the journey `economy` has always paid for.
//
// ---------------------------------------------------------------- why the trip is two errands
//
// `rescue` lands 15-25 SECONDS AFTER THE CAST and its reply says nothing useful — the
// harness measured exactly this and polls the room rather than believing the call
// (`Autopilot.rescueToShop`). A `travel` issued in the same errand would therefore set off
// walking and be teleported out of its own journey. So the rescue is its own errand that
// ends the moment it is cast, and the shopping errand runs on a LATER tick from wherever the
// character actually ended up. Same two-phase shape as the feast hall's outbound/grab, and
// for the same reason: DUM's own thirty-second cadence is the wait.
//
// It also means the trip degrades correctly. Rescue picks its own destination — a guild hall
// in the same region first, then Ko'catan, then the Pool of Vigor, and only then the home
// room (rescue.kod:124-163) — so where it lands is a fact to be read afterwards, never
// predicted. Phase two starts with a `travel` to the counter from wherever that was, which
// is the same step whether the rescue saved the walk, shortened it, or did nothing at all.
import { holdsTheBody } from './body.mjs';

// WHAT A CAST COSTS, FROM THE KOD AND NOT FROM MEMORY. forceslt.kod:54-61 —
// `Cons([&Elderberry,2])`, `Cons([&Emerald,1])`. The pair is UNBALANCED in practice and the
// scarce half is not the one anybody watches: the field refills elderberries for nothing and
// emeralds have to be bought, so a caster reads as well stocked right up to the throw that
// finds no gem.
export const FORCES_OF_LIGHT = Object.freeze({
  spell: 'forces of light',
  mana: 12,
  // `match` is the pattern the pack and the merchant's shelf are searched with. The game
  // spells it "ElderBerry" in the kod, "elderberry" on the wire and "Elder Berry" in at
  // least one shop list, which is why this is a pattern and not a name.
  lines: Object.freeze([
    Object.freeze({ item: 'elderberry', match: 'elder\\s?berr', per_cast: 2, room: 104, seller: 'Joguer' }),
    Object.freeze({ item: 'emerald', match: 'emerald', per_cast: 1, room: 109, seller: 'Herbutte' }),
  ]),
});

// `rescue` is Shal'ille level 3, 16 mana, ONE emerald (rescue.kod:40-58) — the same gem the
// enchantment burns, which is why the reserve below is expressed in emeralds and not in
// casts. Spending the last one to go and buy more is the one way this trip cannot work.
export const RESCUE = Object.freeze({ spell: 'rescue', mana: 16, emeralds: 1 });

export const ROOM_CASTER_TOPIC = 'room_caster';

const cfg = (doctrine) => doctrine?.room_caster ?? {};
const on = (doctrine) => cfg(doctrine).on === true;
const casterRoom = (doctrine) => Number(cfg(doctrine).room);
const lines = (doctrine) => {
  const given = cfg(doctrine).reagents;
  return Array.isArray(given) && given.length ? given : FORCES_OF_LIGHT.lines;
};

/**
 * Is the character this tick is about the one this doctrine posts?
 *
 * `agent` is optional because a single-character invocation (`--agent acct08`) has already
 * answered the question. It is honoured when present for the same reason the service desk
 * honours it: the scope flag is a thing a person types and forgets, and this file must be
 * harmless when they do.
 */
export function isTheCaster(obs, doctrine) {
  if (!on(doctrine)) return false;
  const want = cfg(doctrine).agent;
  return want ? String(obs?.agent) === String(want) : true;
}

// THE PACK, FROM THE FREE BOARD. `pack_items` is the keeper's own cached inventory carried
// on the fleet row, so counting reagents costs nothing — which matters because an errand
// intent is decided in phase one, before DUM has paid for `status` (src/loop/tick.mjs).
const packOf = (row) => Array.isArray(row?.pack_items) ? row.pack_items
                      : Array.isArray(row?.items) ? row.items : null;

const countIn = (pack, re) => (pack || [])
  .filter(i => re.test(String(i?.name ?? '')))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

/**
 * How many more times this character can cast, and which reagent is the one that runs out.
 *
 * UNKNOWN IS NOT ZERO. A board that did not carry the pack must resolve to "go and look",
 * never to "he is out" — the memory module's own rule, and the stakes here are a shopping
 * trip across the world triggered by a field an older broker does not send.
 *
 * @returns {{known: boolean, casts: number|null, have: object, binding: string[]}}
 */
export function castsOnHand(row, reagents = FORCES_OF_LIGHT.lines) {
  const pack = packOf(row);
  if (!pack) return { known: false, casts: null, have: {}, binding: [] };
  const have = {};
  for (const l of reagents) have[l.item] = countIn(pack, new RegExp(l.match, 'i'));
  const per = reagents.map(l => Math.floor(have[l.item] / Math.max(1, Number(l.per_cast) || 1)));
  const casts = per.length ? Math.min(...per) : 0;
  return { known: true, casts, have,
           // WHICH HALF IS BINDING, because "3 elderberry / 94 emerald" is ONE cast and
           // reads as well stocked to anything that sums. The harness makes the same point
           // about its own castings column.
           binding: reagents.filter((l, i) => per[i] === casts).map(l => l.item) };
}

/**
 * IS THERE SOMETHING IN THIS PACK THAT MUST NOT LEAVE THE POST?
 *
 * A posted caster can be holding something the FLEET depends on being at that spot. On this
 * fleet it is the Chalice of the Rain: every farmer's town trip rides it home instead of
 * walking, so the holder walking off with it does not merely pause a service, it puts the
 * whole fleet back on the road that kills it.
 *
 * The harness already arranges the hand-over — the holder gives the cup to an ALTERNATE just
 * above this rule's own restock floor — and DUM's supply trip is the thing it is racing.
 * Measured on prod 2026-09-24: the relief ticket was raised at 17:23:20Z, nothing claimed it,
 * it timed out, and nine minutes later this rule walked the caster out of the castle with the
 * cup in his pack. Two triggers two castings apart, and no gate between them.
 *
 * So the gate is here, on the one fact DUM can see for itself: the item is still in the pack.
 * No cross-repo coupling, nothing read from another process's file, and it stays a pure
 * function of the observation.
 *
 * @returns {{holding: boolean, item: string|null, known: boolean}}
 */
export function stillHoldingHandOff(row, doctrine) {
  const want = cfg(doctrine).hand_off_item;
  if (!want) return { holding: false, item: null, known: true };
  const pack = packOf(row);
  // UNKNOWN IS NOT "HE PUT IT DOWN". A board row with no pack must not be read as permission
  // to leave with the fleet's only chalice; it is a reason to look again next tick.
  if (!pack) return { holding: true, item: String(want), known: false };
  return { holding: countIn(pack, new RegExp(String(want), 'i')) > 0,
           item: String(want), known: true };
}

/**
 * Why this supply trip must wait, or null if it may go.
 *
 * THE GRACE IS COUNTED IN CASTINGS, NOT IN SECONDS, and that is what makes it pure — no clock
 * on the observation, no new memory topic, and it cannot get stuck: every casting spends the
 * thing the trip exists to replace, so the window closes on its own.
 *
 * AND IT DOES NOT WAIT FOR EVER. A caster holding the cup and unable to cast serves the fleet
 * exactly as little as a caster who has walked off with it, so below `hand_off_floor_casts`
 * the trip goes anyway and the reason is recorded. Waiting past that trades a service the
 * fleet notices for one it does not.
 */
export function handOffBlocking(row, doctrine, casts) {
  const held = stillHoldingHandOff(row, doctrine);
  if (!held.holding) return null;
  const floor = Math.max(0, Number(cfg(doctrine).hand_off_floor_casts ?? 2));
  if (Number.isFinite(casts) && casts <= floor)
    // Said out loud rather than silently: the fleet is about to lose its chalice for the
    // length of a shopping trip, and the operator should be able to find out why from the
    // journal rather than from the board.
    return null;
  return !held.known
    ? `still carrying ${held.item} as far as anyone can tell — this board row had no pack, ` +
      'and an unread pack is not permission to leave with it'
    : `still carrying ${held.item}: the alternate has not taken it yet, and a supply trip ` +
      `that leaves with it puts the whole fleet back on the road. Going anyway below ` +
      `${floor} cast(s), because a caster that cannot cast serves nobody either`;
}

/** Emeralds this character may actually spend on a rescue, after the reserve. */
export function spendableEmeralds(row, doctrine) {
  const pack = packOf(row);
  if (!pack) return null;
  const reserve = Math.max(0, Number(cfg(doctrine).emerald_reserve ?? 2));
  return countIn(pack, /emerald/i) - reserve;
}

// ---------------------------------------------------------------- memory

export const RESUPPLY_RETRY_MS = 30 * 60_000;

/**
 * The rescue leaves one fact behind, and WITHOUT IT THE RESCUE FIRES FOR EVER.
 *
 * An errand is the one write with nothing to diff against, so what stops it repeating is
 * the emitting rule's memory and nothing else — the module comment in src/record/memory.mjs
 * says so in as many words, and the symptom it names is a character that lives in a
 * basement. Here the symptom would be worse than a basement: the trigger (out of reagents)
 * stays true for the whole 15-25 seconds the teleport takes to land, so a rescue with no
 * memory would cast again on the next tick, and again, at one emerald a throw, out of the
 * very stock the trip exists to replace.
 */
export function recordCasterRescue({ agent, at, stopped }) {
  return {
    patch: { [agent]: { rescued_at: stopped ? null : at } },
    read: { agent, at, cast: !stopped, stopped: stopped ?? null,
            verified: 'nothing yet — rescue lands 15-25s later and its reply says nothing, ' +
                      'so the landing is read off the board on a later tick' },
  };
}

/**
 * What the shopping trip leaves behind, and why it has to leave anything.
 *
 * THE TRIGGER IS STILL TRUE AFTER A FAILED TRIP. He set out because he was out of reagents;
 * if the counter was empty, or the purse was short, or the road did not open, he is still
 * out of reagents on the next pass and the same trip goes out again — for ever, each lap
 * reporting success. That is "a trip that cannot fix the thing that opened it will run for
 * ever" (CLAUDE.md), and this backoff is what bounds it.
 *
 * AND IT IS JUDGED ON THE PACK, NOT ON THE COUNTER'S REPLY. A merchant that completes the
 * handshake and hands nothing over looks exactly like one that sold you forty berries. So
 * the verdict is the inventory read the errand ends with, differenced against the reagents
 * the trip went out for.
 */
export function recordCasterResupply({ agent, at, stopped, results = [], context = null } = {}) {
  const inv = label => results.find(r => r.label === label && Array.isArray(r.result?.items));
  const before = inv('pack-before'), after = inv('read-back');
  const bought = results.filter(r => r.tool === 'shop' && r.args?.buy_ids && !r.result?.error);
  // JUDGED ON THE PACK, AND THE FIRST VERSION OF THIS WAS NOT.
  //
  // It counted shop calls that did not ERROR. `shop` clamps every line to the purse, the
  // weight and the bulk and reports what it cut — so a character with nineteen shillings asks
  // for 179 elderberries, buys none, and the call returns perfectly well. Measured on prod
  // 2026-09-24: two counters, two successful calls, nothing in the pack, `ok: true`, no
  // backoff, and the trip set out again on the next tick at one emerald a lap.
  //
  // That is the failure CLAUDE.md names in the economy traps — "a trip that cannot fix the
  // thing that opened it will run for ever, and every lap reports success" — reached by
  // ignoring this repository's other standing rule, that the world is the evidence and the
  // reply is not. Both reads are needed, because a gain is a DIFFERENCE.
  const count = (r, re) => (r?.result?.items ?? [])
    .filter(i => re.test(String(i?.name ?? ''))).reduce((n, i) => n + (Number(i.amount) || 1), 0);
  // WHAT THE TRIP WENT OUT FOR, carried on the errand's own `context` — the channel
  // src/act/errands.mjs already provides for "what the rule knew when it composed this". A
  // recorder that re-derived the list from the doctrine would be reading a file that may have
  // been edited while the character was walking.
  const want = Array.isArray(context?.reagents) && context.reagents.length
    ? context.reagents : FORCES_OF_LIGHT.lines;
  const gained = (before && after)
    ? want.map(l => { const re = new RegExp(l.match, 'i');
                      return { item: l.item, got: count(after, re) - count(before, re) }; })
    : null;
  // THREE ANSWERS, NOT TWO, the same three `recordDeskUncurse` insists on: it worked, it did
  // not, and NOBODY LOOKED. An errand that never reached both reads cannot have proved
  // anything, and must not be filed as a success on the strength of not having crashed.
  const verified = gained ? { gained } : null;
  const ok = !stopped && verified !== null && gained.some(g => g.got > 0);
  return {
    // `rescued_at: null` CLOSES THE TELEPORT. The rescue and the counters are two errands
    // joined by this one field, exactly as the feast hall's outbound and grab are; leaving
    // it set would make the return rule believe a teleport was still in flight and refuse
    // to walk him home.
    patch: { [agent]: { last_try_at: at, ok, rescued_at: null, ...(ok ? { tries: 0 } : {}) } },
    read: { agent, at, ok, counters: bought.length, stopped: stopped ?? null,
            gained: gained ?? null,
            verified: !gained
              ? 'the pack was not read at both ends, so nothing here is evidence'
              : ok ? `the pack gained ${gained.filter(g => g.got > 0)
                       .map(g => `${g.got} ${g.item}`).join(', ')}`
                   : 'the counters were reached and NOTHING entered the pack — the usual ' +
                     'reason is the purse: `shop` clamps every line to what it can afford ' +
                     'and reports success either way' },
  };
}

/** Seconds left in the backoff from a failed trip, or null if there is none. */
export function coolingDown(memory, agent, now) {
  const row = memory?.[ROOM_CASTER_TOPIC]?.[agent];
  if (!row || row.ok !== false || !Number.isFinite(Number(row.last_try_at))) return null;
  const left = RESUPPLY_RETRY_MS - (Number(now) - Number(row.last_try_at));
  return left > 0 ? Math.round(left / 1000) : null;
}

/** Is this character mid-rescue — cast, and not yet landed? */
export function rescuePending(memory, agent, now, windowMs = 90_000) {
  const row = memory?.[ROOM_CASTER_TOPIC]?.[agent];
  if (!row || !Number.isFinite(Number(row.rescued_at))) return false;
  return Number(now) - Number(row.rescued_at) < windowMs;
}

// ---------------------------------------------------------------- the posture

/**
 * Agreement on the keys this rule sets, tolerant of the harness's own normalisation.
 *
 * A TWIN OF `sameSettings` IN src/act/orders.mjs, DELIBERATELY NOT IMPORTED. Importing act/
 * from a rule closes a cycle — act/errands.mjs imports the rules — and the suite died on
 * `Cannot access 'ORDER_FIELDS' before initialization` the last time somebody tried, naming
 * neither file involved (see the note in station.mjs). The duplication is also the shape the
 * fix is supposed to have: the sending end drops what it must not write, and the rule's own
 * convergence test has to agree separately, or the rule fires for ever and starves the table.
 *
 * The normalisation mirrors the broker's: names are trimmed and lowercased, numbers floored.
 */
export function agreesOn(live, want, keys) {
  if (!live) return false;
  // NUMBERS ARE COMPARED AS NUMBERS, AND THE FIRST DRAFT OF THIS FLOORED THEM.
  //
  // That looked like mirroring the broker, which does floor the millisecond and count
  // fields on the way in. It is wrong, and wrong in the direction that hides: `rest_below`
  // and `flee_below` are FRACTIONS of max health, so `Math.floor` turned 0.85 and 0.5 into
  // the same number and the rule agreed with a keeper it disagreed with completely. Caught
  // against the live fleet within a minute of shipping — the post reported converged while
  // the caster still held a farmer's flee line.
  //
  // Flooring bought nothing even where the broker does it: a rule that emits 8000 and a
  // keeper that stored 8000 are equal without help.
  const norm = v => Array.isArray(v) ? v.map(norm)
                  : v && typeof v === 'object'
                    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
                        .map(([k, x]) => [k, norm(x)]))
                  : typeof v === 'string' ? v.trim().toLowerCase()
                  : v ?? null;
  return Object.entries(want).every(([field, value]) => {
    // A KEY WITH NO MAPPING IS THE SILENT NEVER-CONVERGE, SO IT IS LOUD INSTEAD.
    //
    // `live[undefined]` is `undefined`, which compares unequal to anything the rule wants —
    // so one forgotten row here makes the rule fire every tick for ever, exactly the failure
    // this function exists to prevent, and it looks like a keeper that simply will not
    // agree. `mode` is the honest version of the same thing: it lives on the keeper and not
    // on its policy (see ORDER_FIELDS), so it is mapped to null and compared by the caller.
    if (!(field in keys))
      throw new Error(`agreesOn has no policy key for "${field}" — add it to POLICY_KEYS, or ` +
                      'this rule can never agree with the keeper and starves every rule below it');
    if (keys[field] == null) return true;
    const current = live[keys[field]];
    // An OBJECT setting is compared on the keys the intent carries and on no others: the
    // harness adds and drops keys of its own (`assume_ability`, `drop_for_space`), and an
    // opinion about those is an opinion this rule has not earned.
    if (value && typeof value === 'object' && !Array.isArray(value))
      return current && typeof current === 'object'
        && Object.entries(value).every(([k, v]) =>
             JSON.stringify(norm(current[k])) === JSON.stringify(norm(v)));
    return JSON.stringify(norm(current)) === JSON.stringify(norm(value));
  });
}

/**
 * A FIELD THE OPERATOR HAS PINNED IS NOT A FIELD THIS RULE MAY HAVE AN OPINION ABOUT.
 *
 * `yield_to` is the doctrine saying "something else writes this". A human control overlay is
 * the same statement made at run time, from a web page or the terminal, and the engine
 * already honours it at the SENDING end: `filterCall` strips every pinned key out of an
 * `autopilot start` before it goes out (src/link/human-controls.mjs).
 *
 * That is too late, and it is too late in the exact way this repository has already paid two
 * days for. First-match-wins happens BEFORE the send: a rule whose want differs from the
 * keeper on a pinned field returns an intent every tick, the send drops the field every
 * tick, the drift never clears, and every rule below it is starved while the journal shows a
 * healthy rule doing its job.
 *
 * Alfa is the live case. The operator's overlay pins `confine_rooms`, and releasing the
 * room lock writes `[]` to the keeper while the pin stays. Without this the post would want
 * `[38]`, the keeper would hold `[]` for ever, and the walk home — the rule directly below —
 * would never run again.
 *
 * So the pinned keys are dropped from BOTH halves, what is emitted and what is checked, and
 * the rule then genuinely agrees about everything it actually owns. Same shape as
 * `unyielded()` in rules/economy.mjs, and for the same recorded reason.
 */
export function unpinned(want, obs) {
  const pins = obs?.human_controls?.[obs?.agent];
  if (!pins || !Object.keys(pins).length) return want;
  return Object.fromEntries(Object.entries(want).filter(([k]) => !Object.hasOwn(pins, k)));
}

/** The keeper orders that make a character a posted caster. */
export function posture(doctrine) {
  const c = cfg(doctrine);
  const room = casterRoom(doctrine);
  const names = lines(doctrine).map(l => String(l.item));
  return {
    // `idle` IS THE MODE A POST RUNS IN, and it is a precondition rather than a preference:
    // `isRoomEnchantPost` tests it by name. It also means the keeper starts no fight of its
    // own, which for a 20-max-health body with no weapon is the whole point.
    mode: 'idle',
    assigned_room: room,
    // CONFINED AS WELL AS ASSIGNED. `assigned_room` says where he belongs; `confine_rooms`
    // is what stops a keeper errand deciding that somewhere else is briefly a better idea.
    confine_rooms: [room],
    roam: false,
    // THE SAFE SPOT, AND THIS IS THE FLAG THAT BUYS IT. `maintainRoomEnchantPost` calls
    // `takeRecoverySpot` when it is not already holding a wall, and that call is what puts
    // the caster somewhere nothing can reach him between throws.
    use_safe_spots: true,
    // A RESTING CASTER CANNOT CAST — PFLAG_NO_MAGIC is set while resting — so the rest line
    // is deliberately low for this one body. The post does its own short mana rests between
    // throws and stands up before each one; a high rest threshold would leave him sitting
    // through the enchantment's whole duration instead.
    rest_below: Number(c.rest_below ?? 0.5),
    // AND HE RUNS EARLY. On 20 max health 0.9 is eighteen: two points of damage and he
    // leaves. Absurd for anything else on a fleet; correct for the one body that cannot
    // afford a second hit.
    flee_below: Number(c.flee_below ?? 0.9),
    room_enchant: {
      enabled: true,
      spells: [String(c.spell ?? FORCES_OF_LIGHT.spell)],
      // Recast this far BEFORE the duration lapses, so the room is never dark between
      // throws — which is the whole value of a post over a visitor who casts once.
      margin_ms: Math.floor(Number(c.margin_ms ?? 8000)),
      // Never spend the last of the mana on the enchantment: the keeper needs some to get
      // itself out of trouble, and the enchantment is the thing that can wait.
      mana_floor: Math.floor(Number(c.mana_floor ?? FORCES_OF_LIGHT.mana + 7)),
    },
    // THE OTHER SUPPLY ROUTE, AND THE CHEAPER ONE. The operator asked for "buy more reagents
    // (or be given them by the fleet)": this is the second clause, and it needs no schedule
    // at all — a farmer already passing through pushes the goods across and leaves.
    accept_donations: {
      enabled: true,
      reagents: names,
      // NOTHING GETS PUT DOWN TO MAKE ROOM. This character carries the fleet's magic-item
      // collection; "cheapest kinds it may shed" is a reasonable default for a farmer and
      // an expensive one here.
      drop_for_space: [],
      min_bulk_free: Math.floor(Number(c.min_bulk_free ?? 40)),
    },
    // AND WHAT HE MUST NOT SELL OR SHED. A sell pass takes the reserve first — it is a
    // stack of gems with a price on it — which is precisely the thing that keeps the trip
    // to the counter possible at all.
    protect_items: names,
    // HE DOES NOT SHOP FOR HIMSELF. The keeper's own reagent buying goes to ONE apothecary
    // (`REAGENT_SHOP`, room 104) for elderberry and herbs and never buys a gem, so leaving
    // it on would send him on a trip that cannot fix what opened it. The trip below is the
    // one that visits both counters.
    buy_reagents: false,
  };
}

const POLICY_KEYS = {
  // NOT ON THE POLICY. The keeper's mode is a field on the keeper itself, exactly as
  // ORDER_FIELDS records — so it is mapped to null and the rule compares it separately
  // against `obs.keeper.mode`. Leaving it OUT of this table would be the silent
  // never-converge `agreesOn` throws about.
  mode: null,
  assigned_room: 'assignedRoom', confine_rooms: 'confineRooms', roam: 'roam',
  use_safe_spots: 'useSafeSpots', rest_below: 'restBelow', flee_below: 'fleeBelow',
  room_enchant: 'roomEnchant', accept_donations: 'acceptDonations',
  protect_items: 'protectedItems', buy_reagents: 'buyReagents',
};

// ---------------------------------------------------------------- the rules

export const roomCasterRules = [
  {
    // ------------------------------------------------------------ 1. the standing orders
    id: 'caster-post',
    faculty: 'economy',
    why: 'a posted caster is a POSTURE, not an action: the keeper keeps the enchantment up ' +
         'off its own clock and this is the set of orders that tells it to',
    enabled: on,
    offWhy: 'room_caster.on is false. A posted caster spends two elderberries and a gem ' +
            'every minute or so, for ever, so an operator arms it',
    decide(obs, doctrine) {
      if (!isTheCaster(obs, doctrine)) return null;
      const room = casterRoom(doctrine);
      if (!Number.isInteger(room)) return null;
      const row = obs.keeper ? { ...obs, ...obs.keeper } : obs;
      // A PERSON PLAYING IT OUTRANKS ANY POSTURE. `holdsTheBody` is piloted-or-busy, and
      // DUM's own claim deliberately does not count — see body.mjs.
      if (holdsTheBody(row)) return { kind: 'pass', why: 'somebody else has the body this pass' };
      // DROPPED FROM WHAT IT EMITS *AND* FROM WHAT IT CHECKS — see `unpinned`. Doing only the
      // first is what wedges a maintenance rule for ever against a field it may not write.
      const want = unpinned(posture(doctrine), obs);
      if (!Object.keys(want).length)
        return { kind: 'pass', why: 'the operator overlay pins every field this post sets, so ' +
                 'there is nothing left for this rule to own' };
      const live = obs.keeper?.policy ?? obs.policy ?? null;
      // NO POLICY IS NOT AN EMPTY POLICY. planOrders refuses to diff against a missing one
      // and it is right to: `{}` reads as "every field differs" and writes the whole
      // posture every tick. A `pass` says so and leaves the table free.
      if (!live) return { kind: 'pass', why: 'this board row carries no keeper policy to diff against' };
      const mode = obs.keeper?.mode ?? obs.mode ?? null;
      // `mode` is compared here rather than in `agreesOn` because it lives on the keeper and
      // not on its policy. Only when it is still ours: `unpinned` may have dropped it, and
      // `mode === undefined` is false for ever, which is the same wedge one line up.
      const modeOk = !Object.hasOwn(want, 'mode') || mode === want.mode;
      if (modeOk && agreesOn(live, want, POLICY_KEYS)) return null;
      // THE `why` IS BUILT FROM WHAT SURVIVED `unpinned`, NOT FROM THE POSTURE.
      //
      // The first version read `want.room_enchant.spells.join(', ')`, which is fine right up
      // until the operator pins `room_enchant` — and on the live fleet it was already pinned,
      // so this rule threw `Cannot read properties of undefined (reading 'spells')` on every
      // tick. The engine catches a throwing rule and carries on, which is what made it
      // survivable and also what made it quiet: the walk home still happened, and the only
      // sign was one line in `considered` with the verdict `error`.
      const spells = want.room_enchant?.spells;
      return {
        kind: 'orders',
        orders: { action: 'start', ...want },
        why: `posting this caster in ${room}` +
             (spells ? `: ${spells.join(', ')} from a safe spot` : '') +
             ` — setting ${Object.keys(want).join(', ')}`,
        evidence: { room, want, keeper_mode: mode,
                    pinned_elsewhere: Object.keys(posture(doctrine))
                      .filter(k => !Object.hasOwn(want, k)) },
      };
    },
  },

  {
    // ------------------------------------------------------------ 2. rescue out, phase one
    id: 'caster-rescue-to-shop',
    faculty: 'economy',
    why: 'the caster is out of reagents and the outbound town leg is where this fleet loses ' +
         'people; rescue costs one emerald and deletes the road',
    enabled: doctrine => on(doctrine) && cfg(doctrine).rescue !== false,
    offWhy: 'room_caster.rescue is off — the supply trip walks both ways instead',
    decide(obs, doctrine) {
      if (!isTheCaster(obs, doctrine)) return null;
      const room = casterRoom(doctrine);
      const row = obs.keeper ? { ...obs, ...obs.keeper } : obs;
      if (holdsTheBody(row)) return null;
      // ONLY FROM THE POST. Rescue from anywhere else is a teleport to a destination the
      // server picks, applied to a character that is already somewhere on a trip — which is
      // how one emerald buys a journey starting further from the counter than it began.
      if (Number(row.room) !== room) return null;
      const short = shortOfReagents(obs, row, doctrine);
      if (short.why) return short.pass ? { kind: 'pass', why: short.why } : null;
      // NOT WITH THE FLEET'S CHALICE IN HIS PACK. See `handOffBlocking`.
      const waiting = handOffBlocking(row, doctrine, short.casts);
      if (waiting) return { kind: 'pass', why: waiting };
      const now = Number(obs.at ?? obs.now ?? Date.now());
      if (rescuePending(obs.memory, obs.agent, now))
        return { kind: 'pass', why: 'a rescue is already in flight — it lands 15-25s after ' +
                 'the cast and the reply says nothing, so this waits for the room to change' };
      const spare = spendableEmeralds(row, doctrine);
      if (spare === null) return { kind: 'pass', why: 'the pack was not on this board row' };
      if (spare < RESCUE.emeralds)
        // NOT A FAILURE — the walk is still available and phase two will take it. Saying so
        // is the difference between "he cannot go shopping" and "he is going the long way".
        return { kind: 'pass', why: `${spare + Number(cfg(doctrine).emerald_reserve ?? 2)} ` +
                 'emerald(s) on hand and the reserve must survive the trip, so this one walks' };
      const mana = Number(row.mana?.value ?? row.mana ?? 0);
      if (mana && mana < RESCUE.mana)
        return { kind: 'pass', why: `paced by mana (${mana}/${RESCUE.mana}) — it regenerates, ` +
                 'so this is a wait rather than a shortage' };
      return {
        kind: 'errand',
        orders: {
          errand: 'caster-rescue',
          agent: obs.agent,
          label: 'rescue to the shopping town',
          steps: [
            // ONE STEP, AND IT ENDS HERE ON PURPOSE. The landing is 15-25s away and there is
            // nothing useful to do in the meantime that a later tick cannot do better from a
            // board that knows where he actually is.
            { tool: 'cast', args: { agent: obs.agent, spell: RESCUE.spell },
              expect: null, timeout_ms: 30_000, estimate_ms: 20_000 },
          ],
        },
        why: `out of ${short.binding.join(' and ')} — rescuing out rather than walking the ` +
             'outbound leg',
        evidence: { casts_left: short.casts, have: short.have, emeralds_spendable: spare },
      };
    },
  },

  {
    // ------------------------------------------------------------ 3. the counters, phase two
    id: 'caster-resupply',
    faculty: 'economy',
    why: 'a caster with no reagents is a character standing in a room doing nothing, and ' +
         'nothing about the world will change that on its own',
    enabled: on,
    offWhy: 'room_caster.on is false',
    decide(obs, doctrine) {
      if (!isTheCaster(obs, doctrine)) return null;
      const room = casterRoom(doctrine);
      if (!Number.isInteger(room)) return null;
      const row = obs.keeper ? { ...obs, ...obs.keeper } : obs;
      if (holdsTheBody(row)) return null;
      const short = shortOfReagents(obs, row, doctrine);
      if (short.why) return short.pass ? { kind: 'pass', why: short.why } : null;
      // NOT WITH THE FLEET'S CHALICE IN HIS PACK. Checked here as well as in the rescue rule
      // above rather than only there: `rescue` is optional (`room_caster.rescue: false`), and a
      // gate that only guards the optional half of a trip is not a gate.
      const waiting = handOffBlocking(row, doctrine, short.casts);
      if (waiting) return { kind: 'pass', why: waiting };
      const now = Number(obs.at ?? obs.now ?? Date.now());
      const cooling = coolingDown(obs.memory, obs.agent, now);
      if (cooling != null)
        return { kind: 'pass', why: `inside the backoff from a failed supply trip (${cooling}s ` +
                 'left) — a trip that cannot fix what opened it must not run every pass' };
      if (rescuePending(obs.memory, obs.agent, now))
        return { kind: 'pass', why: 'the rescue has not landed yet; the counter leg starts ' +
                 'from wherever it puts him, which is not knowable until it does' };
      // A HURT CHARACTER IS RECOVERING, NOT SHOPPING. Same floor `return-to-station` applies
      // and for the same recorded reason: a journey started below it is a death, not a trip.
      const hp = healthFraction(row);
      if (hp == null || hp < Number(cfg(doctrine).min_health ?? 1))
        return { kind: 'pass', why: hp == null
          ? 'the board did not report health, and unknown health is not permission to travel'
          : `healing first (${Math.round(hp * 100)}%) — a shopping trip is a journey` };

      const want = lines(doctrine);
      const buyTo = Math.max(1, Number(cfg(doctrine).restock_to_casts ?? 60));
      // EACH COUNTER ONCE, IN ROOM ORDER, AND THE HOME LEG ALWAYS. Two merchants sell the
      // two halves of this spell and they are not the same merchant: the apothecary has the
      // berries and does not stock a gem. A trip that visited one of them would come home
      // able to cast exactly as often as it left.
      const stops = [];
      for (const l of want) {
        const at = Number(l.room);
        if (!Number.isInteger(at)) continue;
        // A LINE MAY NAME ITS OWN TARGET (`restock_to`, a count of the reagent, not of casts)
        // when the operator wants the halves bought unevenly — 200 berries and 110 gems is
        // 100 casts plus ten spare emeralds for rescues, which no single cast count says.
        const target = Number.isInteger(l.restock_to) && l.restock_to > 0
          ? l.restock_to : buyTo * (Number(l.per_cast) || 1);
        const need = Math.max(0, target - (short.have[l.item] ?? 0));
        if (need <= 0) continue;
        const stop = stops.find(s => s.room === at && s.seller === l.seller);
        if (stop) stop.lines.push({ match: l.match, amount: need });
        else stops.push({ room: at, seller: l.seller, lines: [{ match: l.match, amount: need }] });
      }
      if (!stops.length)
        return { kind: 'pass', why: 'every reagent is already at its restock target — the ' +
                 'binding one is short of a CAST, not of the target' };

      // A CONFINEMENT IS "THESE ROOMS AND NOWHERE ELSE, WHATEVER HAPPENS", AND THE COUNTER IS
      // SOMEWHERE ELSE.
      //
      // `posture()` confines this caster to its post, which is right for every minute it is
      // standing there and wrong for the ten it spends shopping: `Autopilot.travel` carries a
      // `confineRooms` check, so every leg of this trip would be refused by the character's
      // own orders. So the trip lifts it, and puts it back after the walk home.
      //
      // TWO THINGS MAKE THAT SAFE TO DO FROM HERE. The errand declares `busy` before its first
      // step, and a busy character is one `holdsTheBody` reports as somebody else's — so
      // `caster-post` passes for the whole trip rather than re-asserting the confinement into
      // the middle of it. And if this process dies with the confinement still lifted, the next
      // pass of `caster-post` restores it, because a posture rule re-asserts the whole posture
      // rather than remembering what it changed.
      // `mode` IS CARRIED DELIBERATELY, even though only the confinement is changing. An
      // `autopilot start` that names no mode does not leave the mode alone — the broker
      // writes the ROSTER's mode over the live one ("we must preserve the roster's mode",
      // m59-broker.mjs), which is how a `tick` keeper was once silently reverted to
      // `survive`. Saying `idle` on every call is how a two-field edit stays a two-field
      // edit, and `idle` is a precondition of the post rather than a preference.
      const confineStep = (rooms, extra = {}) => ({
        tool: 'autopilot',
        args: { agent: obs.agent, action: 'start', mode: posture(doctrine).mode,
                confine_rooms: rooms },
        expect: null, timeout_ms: 60_000, extend_busy: false, ...extra,
      });
      const steps = [confineStep([], {
        label: 'lift-confinement',
        why: 'the post confines this character to its own room, and both counters are outside it',
      })];
      // WHAT HE LEFT WITH. The only honest verdict on a shopping trip is what the PACK gained,
      // and a delta needs both ends — so the trip opens with a read as well as closing with
      // one. See `recordCasterResupply`: judged on the counter's reply, a trip that could not
      // afford a single berry reported success and set straight back out.
      steps.push({ tool: 'inventory', args: { agent: obs.agent }, expect: null,
                   timeout_ms: 30_000, extend_busy: false, label: 'pack-before' });
      stops.forEach((stop, i) => {
        steps.push({ tool: 'travel', args: { agent: obs.agent, to: stop.room, run_errands: false },
                     expect: 'arrived', timeout_ms: Number(cfg(doctrine).travel_timeout_ms ?? 600_000),
                     label: `to-${stop.room}`,
                     why: `${stop.seller ?? 'the counter'} in ${stop.room} sells ` +
                          stop.lines.map(l => l.match).join(' and ') });
        // OPEN THE SHOP FIRST, because a buy is aimed at an object ID and an object id is a
        // handle that is renumbered on every save. This listing IS the step that learns them.
        steps.push({ tool: 'shop', args: { agent: obs.agent, seller: stop.seller },
                     expect: null, optional: true, timeout_ms: 60_000,
                     label: `list-${i}`, needs: `to-${stop.room}` });
        steps.push({ tool: 'shop', args: { agent: obs.agent, seller: stop.seller },
                     buy_from: { label: `list-${i}`, lines: stop.lines },
                     expect: null, optional: true, timeout_ms: 600_000,
                     label: `buy-${i}`, needs: `to-${stop.room}`,
                     why: 'the counter clamps every line to the purse, the weight and the ' +
                          'bulk, and reports what it cut rather than dropping it quietly' });
      });
      // READ THE PACK BACK. The counter's reply is not evidence — a merchant that completes
      // the handshake and hands nothing over looks exactly like one that sold you forty
      // berries — and `recordCasterResupply` judges the trip on this.
      steps.push({ tool: 'inventory', args: { agent: obs.agent }, expect: null,
                   timeout_ms: 30_000, always: true, label: 'read-back' });
      // THE WAY HOME, AND IT RUNS EVEN IF EVERYTHING ABOVE FAILED. An errand that leaves this
      // character standing in a shop is worse than one that failed: his keeper then makes
      // perfectly reasonable decisions about a room nobody meant him to be in, and the room
      // he was posted in goes dark for as long as that lasts.
      steps.push({ tool: 'travel', args: { agent: obs.agent, to: room, run_errands: false },
                   expect: 'arrived', timeout_ms: Number(cfg(doctrine).travel_timeout_ms ?? 600_000),
                   always: true, label: 'home',
                   why: `back to the post in ${room}` });
      // AND THE CONFINEMENT GOES BACK ON — after the walk home and not before it, or the walk
      // home is the leg this character's own orders refuse.
      steps.push(confineStep([room], { always: true, label: 'restore-confinement',
        why: 'the trip is over; the post is a confinement again' }));

      return {
        kind: 'errand',
        orders: { errand: 'caster-resupply', agent: obs.agent,
                  label: 'buy reagents and return to the post', steps,
                  // What the verdict is measured against, fixed at the moment the trip was
                  // composed. See `recordCasterResupply`.
                  context: { reagents: want.map(l => ({ item: l.item, match: l.match })) } },
        why: `${short.casts} cast(s) left, short of ${short.binding.join(' and ')} — ` +
             `${stops.length} counter(s), then back to ${room}`,
        evidence: { casts_left: short.casts, have: short.have, buy_to_casts: buyTo,
                    stops: stops.map(s => ({ room: s.room, seller: s.seller,
                                             lines: s.lines.map(l => `${l.match} x${l.amount}`) })),
                    purse: row.purse ?? null },
      };
    },
  },

  {
    // ------------------------------------------------------------ 4. back to the post
    id: 'caster-return-to-post',
    faculty: 'economy',
    why: 'with roam off and no work to do, a caster left anywhere but its post stands there ' +
         'indefinitely — not stalled, not reported as stalled, doing exactly what it was ' +
         'told in the wrong room',
    enabled: on,
    offWhy: 'room_caster.on is false',
    decide(obs, doctrine) {
      if (!isTheCaster(obs, doctrine)) return null;
      const room = casterRoom(doctrine);
      if (!Number.isInteger(room)) return null;
      const row = obs.keeper ? { ...obs, ...obs.keeper } : obs;
      if (holdsTheBody(row)) return null;
      if (!Number.isInteger(Number(row.room))) return null;
      if (Number(row.room) === room) return null;
      const now = Number(obs.at ?? obs.now ?? Date.now());
      // NOT WHILE A RESCUE IS LANDING. He is out of position because we teleported him, and
      // walking him home is the opposite of the trip he was sent on.
      if (rescuePending(obs.memory, obs.agent, now))
        return { kind: 'pass', why: 'mid-rescue — being out of the post room is the point' };
      // AND NOT WHILE HE STILL CANNOT CAST. Walking him back to stand in a lit room he has
      // no reagents to light is the wasted half of two journeys; the supply rule above owns
      // him until he can pay for a throw, and its own last step is this walk.
      const short = shortOfReagents(obs, row, doctrine);
      if (!short.why && coolingDown(obs.memory, obs.agent, now) == null)
        return { kind: 'pass', why: 'out of position AND out of reagents — the supply trip ' +
                 'owns this one, and it ends with the walk home' };
      const hp = healthFraction(row);
      if (hp == null || hp < Number(cfg(doctrine).min_health ?? 1))
        return { kind: 'pass', why: hp == null
          ? 'the board did not report health, and unknown health is not permission to travel'
          : `healing first (${Math.round(hp * 100)}%) — the walk home is still a journey` };
      return {
        kind: 'errand',
        orders: {
          errand: 'caster-return',
          agent: obs.agent,
          label: 'back to the post',
          steps: [
            { tool: 'travel', args: { agent: obs.agent, to: room, run_errands: false },
              expect: 'arrived', timeout_ms: Number(cfg(doctrine).travel_timeout_ms ?? 600_000),
              why: `out of position in ${row.room}, posted to ${room}` },
          ],
        },
        why: `out of position in ${row.room} with ${short.casts ?? '?'} cast(s) aboard, ` +
             `walking back to ${room}`,
        evidence: { agent: obs.agent, in: row.room, posted: room, casts_left: short.casts ?? null },
      };
    },
  },
];

// ---------------------------------------------------------------- shared gates

/**
 * Does this caster need reagents, and is that knowable?
 *
 * Returns `{casts, have, binding}` when a trip is warranted, and `{why, pass}` when it is
 * not — `pass: true` where the reason is worth saying out loud and `pass: false` where it is
 * the ordinary "not me".
 */
export function shortOfReagents(obs, row, doctrine) {
  const stock = castsOnHand(row, lines(doctrine));
  if (!stock.known)
    // UNKNOWN IS NOT ZERO, and here that rule has a price tag: read the other way it sends a
    // 20-health character across the world to buy reagents he is already carrying.
    return { ...stock, pass: true,
             why: 'this board row carried no pack, so how many casts are left is unknown — ' +
                  'which is not the same as none' };
  const floor = Math.max(0, Number(cfg(doctrine).restock_below_casts ?? 10));
  if (stock.casts > floor)
    // The ordinary "not me": he is stocked, and there is nothing worth saying about it on
    // every tick for ever. `pass: false` means the caller returns null rather than a line.
    return { ...stock, pass: false,
             why: `${stock.casts} cast(s) on hand, above the restock floor of ${floor}` };
  return { ...stock, pass: false, why: null };
}

const healthFraction = row => {
  const v = row.hp ?? row.health ?? row.vitals?.health;
  if (v && Number.isFinite(v.value) && Number.isFinite(v.max) && v.max > 0) return v.value / v.max;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(row.health ?? ''));
  if (m && Number(m[2]) > 0) return Number(m[1]) / Number(m[2]);
  return null;
};
