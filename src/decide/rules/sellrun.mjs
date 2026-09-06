// THE BARLOQUE SELL CIRCUIT — sell a full pack ACROSS the specialists instead of to Roq.
//
// townDestinations() in the harness picks ONE shop, and for a mixed pack that shop is Roq
// (room 110): the one NPC that buys every category. But Roq pays the standard merchant rate
// with no fence premium (assassin.kod has no buy-price override), and his room sits behind a
// tunnel that has been unsafe enough to ban. The Barloque specialists each buy only their own
// lane, so no single one clears a mixed pack — but routed across them they clear it AND, for
// the lanes they specialise in, tend to pay better than the universal buyer. This rule turns
// that route into one errand: travel to each specialist, sell that lane, come home.
//
// WHY AN ERRAND AND NOT A POLICY. Selling-across-shops is a SEQUENCE with a fixed order, not a
// threshold the keeper maintains — so it is emitted as `kind:'errand'` (which bypasses the
// planOrders/ORDER_FIELDS diff path entirely) and runs step by step. The keeper still owns the
// second-to-second execution of each `travel` and each `sell_all`; DUM owns only the decision
// to make the trip and the order of the stops.
//
// THE RETURN ROUTE, IN THE ORDER THE OPERATOR GAVE IT (2026-09-05):
//
//     vault -> sell -> bank -> drop -> yell -> the Duke's tables
//
// Every step earns the next. The vault takes what is worth keeping, the shops take what will
// sell, the bank takes what they paid, and what reaches the street is exactly what no counter
// in the world wanted — which is why the drop is LAST of the four and not first. Dropping
// before Barloque throws money in the road; carrying it home hauls it for nothing.
//
// And emptying the pack immediately before the hall is what makes the food step worth taking:
// a character arrives carrying its weapon, its armour, its money and its reagents, and
// everything else it can hold is the Duke's food.
//
// VAULT, THEN SELL, THEN BANK - and the first and last are why the trip is worth taking.
// Selling turns a pack into a purse, which moves the risk of dying rather than removing it: a
// circuit that sells and walks home has converted loot into a bigger thing to lose. So the
// shops are bracketed by Obert Cair'bre's vault (114) for what must not be sold at all, and the
// First Royal Bank of Tos (54) for what the shops paid. The vault comes FIRST, which costs two
// hops in forty and means a wrong keep list cannot reach what is already stored.
//
// Both were deferred when this was a draft, and the note here said why: there was no
// keeper-proxied storage tool, and a deposit amount is not knowable when a static step list is
// built. Both are now answered in the harness rather than worked around here - a `vault` tool
// that resolves the vaultman in the process that can see the room, and a `keep` float on `bank`
// that moves the arithmetic to the counter, where the purse is a fact.
//
// WHAT IT STILL DOES NOT DO: buy reagents. That belongs to the keeper's own economy policy
// (buy_reagents), which the doctrine sets, and which already runs a shorter loop for it.
//
// PURE, like every rule here: `now` and the past both arrive on the observation. The memory
// window is what stops the errand re-firing every tick and marching a character to town for
// ever — the "character in a basement" failure the crate rule documents at length.

// WHICH MERCHANT IS IN WHICH ROOM IS NOT AN ORDER. It is a fact about Barloque, like the
// nutrition table or the room flags, and it belongs in the repository rather than in every
// operator's local doctrine. What IS an order is whether to go at all and how full a pack has
// to be first — `on` and `trigger` — and those stay in the doctrine, where an operator can
// change them without a commit.
//
// The split matters because the alternative was making every doctrine restate the geography.
// The live prod doctrine does not extend the sell-circuit doctrine (it descends from
// castle-victoria, which descends from survive), so "turn selling on for this fleet" meant
// copying four lists into a gitignored file — and a copy is a thing that drifts silently from
// the file the tests assert against. Now it is `"sellrun": { "on": true }`.

/** The three specialists, in the order a pack is routed across them. */
export const BARLOQUE_STOPS = Object.freeze([
  // The Royal Blacksmith of Barloque — body armour, shields, weapons. Singletons, so no cap.
  { room: 113, merchant: "Fehr'loi Qan", max_stack: null },
  // Sparkling Stone Shop — gems and sundries. Refuses a stack OVER 25 wholesale
  // (bqmerch.kod:113), so a bigger gem stack is sold 25 at a time.
  { room: 109, merchant: 'Herbutte', max_stack: 25 },
  // Joguer's Herbs and Roots — loot mushrooms and other reagents. No cap.
  { room: 104, merchant: 'Joguer', max_stack: null },
]);

// NEVER OFFERED TO A MERCHANT, however heavy the pack. Matched as case-insensitive
// substrings, so "wand" covers every wand and "orb of" every orb.
//
// The free food is on this list and it is the half people forget. Resting stops awarding
// vigor at 80 of 200 — everything above it has to be EATEN — and the Duke's tables are where
// this fleet gets that for nothing. A courier can be carrying a hundred slices when its pack
// trips the carry trigger, and `sell_all` offers a merchant everything he will take, so a
// circuit that does not name them undoes the feast run that filled the pack for a handful of
// shillings.
//
// A bare "mushroom" is deliberately NOT here. Four of this world's five are casting reagents
// and are meant to be sold; only `edible mushroom` and `Inky-cap mushroom` are food, and both
// are named. A substring that matched all five would quietly stop the fleet selling its
// reagent loot, which is the mistake in the other direction and it costs money.
export const SELL_KEEP = Object.freeze([
  'inky', 'dragon scale', 'angel feather', 'wand', 'scroll', 'signet', 'orb of', 'potion',
  'herb', 'elderberry',
  // THE FOOD HALF IS DERIVED, NOT TYPED. It was typed, and it named two of the seven things
  // the Duke's tables hand out — so a character that had just filled its pack at the feast
  // walked to Barloque and sold five of them, `spider eye` included, of which the fleet was
  // carrying six hundred. FEAST_DISPENSERS is what the grab errand actually activates, so
  // this cannot drift from what comes home in the pack.
  ...FEAST_DISPENSERS.map(d => d.item),
  'edible mushroom', 'loaf',
]);

// Obert Cair'bre's office. VISITED BEFORE THE FIRST SHOP: what is in the vault cannot be sold
// by a keep list that is wrong, and a keep list is a hand-written string match one forgotten
// name away from selling the best thing the character owns. m59-fleetscript.mjs refuses the
// other order outright. It costs two hops in forty, measured off the bake.
//
// The create-food reagents are NOT stored: a herb in Barloque is no use to a character casting
// in Castle Victoria, and getting it back costs a retrieval fee and a trip.
export const BARLOQUE_VAULT = Object.freeze({
  room: 114,
  items: ['dragon scale', 'angel feather', 'wand', 'scroll', 'signet', 'orb of', 'potion'],
});

// The First Royal Bank of Tos. THERE IS NO BANKER IN BARLOQUE — Setag'lib is a compiled class
// that nothing ever creates — so this is a real detour, eleven hops from the vault.
//
// Tos rather than Jasper, and the reason is the leg after it rather than the leg to it. Both
// are eleven hops from the vault and both pay into the same account (BANK_BASIC and BID_TOS
// are both 1, blakston.khd:1275), but Tos is eight hops from Castle Victoria against Jasper's
// ten — and Tos is the town this fleet already crosses for the Duke's tables.
//
// `keep` is a walking float rather than an amount. 500 is enough to buy reagents on the way
// back without a withdrawal, and a withdrawal is the one bank operation that never states the
// new balance (Lm_bnkr_did_withdraw, monster.kod:144).
export const TOS_BANK = Object.freeze({ room: 54, keep: 500 });

import { giveawaySteps, GIVEAWAY_KEEP } from '../street-giveaway.mjs';
import { FEAST_HALL, FEAST_DISPENSERS } from '../feast-hall.mjs';

const mins = ms => `${Math.round(ms / 60000)}m`;

// The same test `engine.mjs` exports as `takeable`, inlined to keep this rule out of the
// engine←→schema import cycle (crate.mjs inlines it for the same reason). A character with no
// commitment kind is free; a `bot` claim marked takeable is DUM's own ownership, not an
// operation; a `partner` is a standing arrangement that does not block a change of orders. Ask
// THIS, never `!commitment`: DUM claims every character it manages, so a truthiness test skips
// its own characters and the circuit fires once and never again.
const isTakeable = row => {
  const c = row?.commitment;
  return !c || !c.kind || c.takeable === true || c.kind === 'partner';
};

/**
 * Per-character gate: has this character run the circuit too recently to run it again?
 * `mem` is the whole `sellrun` memory topic, keyed by agent. Unknown means READY — the cost
 * of being wrong is one trip, and the opposite convention (silence = "just went") produces a
 * fleet whose pack fills and never empties.
 *
 * @param {object} mem        obs.memory.sellrun, {[agent]: {last_run_at}}
 * @param {string} agent
 * @param {number} now
 * @param {number} cooldownMs
 * @returns {{ready: boolean, why: string}}
 */
export function sellrunWindow(mem = {}, agent, now, cooldownMs, failBackoffMs = cooldownMs) {
  const e = mem?.[agent];
  const last = e?.last_run_at;
  const since = (typeof last === 'number' && Number.isFinite(last)) ? now - last : null;
  if (since !== null) {
    // A completed run empties the pack, so it waits the full cooldown before another trip. A
    // FAILED one (travel stalled, a shop refused) waits only the short backoff — long enough not
    // to thrash a town trip every tick, short enough that a full pack is not stranded for the
    // whole cooldown while nothing is wrong with it.
    const failed = e?.ok === false;
    const gate = failed ? failBackoffMs : cooldownMs;
    if (since < gate)
      return { ready: false, why: failed
        ? `${agent}'s last circuit failed ${mins(since)} ago; retry in ${mins(gate - since)}`
        : `${agent} ran the Barloque circuit ${mins(since)} ago; not again for ${mins(gate - since)}` };
  }
  return { ready: true, why: since === null
    ? `${agent} has no recorded circuit run` : `${mins(since)} since ${agent}'s last circuit` };
}

/**
 * Would this circuit take this character? The carry/purse/health test, and nothing else.
 *
 * TWO RULES ASK THIS AND ONLY ONE OF THEM OWNS THE THRESHOLDS. The feast rule asks it to
 * decide whether to leave a heavy character alone — a character the circuit wants should
 * arrive at the Duke's tables by way of Barloque, having emptied its pack, rather than
 * being dispatched straight there with ten long swords in it. One did exactly that.
 *
 * So it is a function rather than a repeated comparison: two thresholds for one question
 * drift apart, and `carry_at` is set per fleet in the doctrine, so a copy in the feast rule
 * would be a second opinion about somebody else's setting.
 *
 * DELIBERATELY NOT THE WHOLE ELIGIBILITY. The per-agent cooldown window, `piloted`,
 * `parked` and takeability are the circuit's own bookkeeping — the feast rule tests those
 * for itself and must not be made to wait on a cooldown that only means "this character
 * sold recently".
 *
 * @param {object} row      a fleet row
 * @param {object} cfg      the `sellrun` doctrine block
 * @returns {boolean}
 */
export function sellCircuitWants(row, cfg = {}, memory = null) {
  if (!row || cfg?.on === false) return false;
  const t = cfg.trigger ?? {};
  const heavy = (row.carrying ?? 0) >= (t.carry_at ?? 24);
  const broke = (t.broke_under ?? 0) > 0 && (row.purse ?? 0) < t.broke_under;
  if (!heavy && !broke && !handoverOwed(row.agent, memory)) return false;
  // Do not march a hurt character across town. Selling is not survival; if it is below the
  // floor the keeper's ladder is the thing that should be acting, not this.
  //
  // THE HEALTH FLOOR APPLIES TO A HANDOVER TOO, and it is the only gate that does. A
  // character that just changed band by DYING is the commonest way into this branch, and
  // it comes out of the Underworld at a fraction of its bar. Forty hops in that state is
  // not a wrap-up run, it is the road deaths this fleet already has too many of.
  return (row.health?.pct ?? 1) >= (t.min_health ?? 0.8);
}

/**
 * Does this character owe a last run at the station it has just left?
 *
 * THE CIRCUIT IS THE HANDOVER, AND THAT IS WHY THERE IS NO SECOND ERRAND FOR IT.
 *
 * A character whose max health crosses the doctrine's band boundary is reassigned across
 * the world — Upstairs Castle Victoria and the Valley of Ileria are opposite ends of the
 * map — and the route between them runs through the towns this circuit already visits. So
 * the wrap-up an operator would do by hand IS this trip: empty the pack at the Barloque
 * specialists, bank what they paid, drop what nobody wanted, and come home by way of the
 * Duke's tables with a pack full of food. One crossing instead of three.
 *
 * THE ORDER IS REASSIGN FIRST, THEN RUN, and it is not a preference. The circuit ends at the
 * feast hall and the feast rule walks the character home to `policy.assignedRoom` — so a
 * handover that ran BEFORE the redeploy would carry forty slices of pork back to the room
 * the character was leaving. The shift deploys and records the crossing in the same pass;
 * this fires on the pass after.
 *
 * SELF-CLEARING, WITH NO SECOND WRITE. `handover_since` is a timestamp and it is compared
 * against the circuit's own `last_run_at`, so a run that happened after the crossing
 * satisfies it and the flag never has to be cleared by anybody. That matters because there
 * is no mechanism to clear it: `readErrand` writes one topic per errand and this one is
 * `sellrun`, while the crossing is recorded under `band`.
 *
 * @param {string} agent
 * @param {object|null} memory   the whole `obs.memory`
 */
export function handoverOwed(agent, memory) {
  const since = memory?.band?.[agent]?.handover_since;
  if (typeof since !== 'number') return false;
  const ran = memory?.sellrun?.[agent]?.last_run_at;
  return !(typeof ran === 'number' && ran >= since);
}

/** Build the ordered step list for one character's circuit. Pure; args only. */
function circuitSteps(agent, cfg, back) {
  // FOUR MINUTES WAS SHORTER THAN EVERY LEG OF THIS CIRCUIT, SO NO LEG EVER FINISHED.
  //
  // The step timeout was 240s. Measured 2026-09-06 off the broker's own `travel_estimate`,
  // from Castle Victoria where this fleet lives:
  //
  //     vault (114)   15 hops  702s        bank (54)        8 hops  680s
  //     smith (113)   13 hops  666s        Streets of Tos    8 hops  792s
  //     jeweler (109) 13 hops  659s        feast hall (953) 11 hops  830s
  //     herbalist (104) 14 hops  700s
  //
  // Every one of them is 2.7x to 3.5x the timeout. So the runner cancelled the walk at four
  // minutes, mid-journey, every time, for every character — and the journal shows exactly
  // that shape and nothing else: `travel` ok, then `cancel_movement` 241 seconds later, then
  // the next `travel`, then `cancel_movement` 242 seconds later. The `vault` and `sell_all`
  // steps in between never ran at all, because they `needs` an arrival that never came.
  //
  // Nothing reported a failure. Every call returned ok, the circuit was dispatched over and
  // over, and the fleet-facing symptom was a character walking into the Duke's feast hall
  // with ten long swords still in its pack.
  //
  // 900s is the longest leg plus a margin, not a guess at "long enough". A journey that has
  // not arrived in fifteen minutes has genuinely gone wrong and cancelling it is right; one
  // cancelled at four was simply still walking.
  const travelTimeout = cfg.travel_timeout_ms ?? 900_000;
  const keep = cfg.keep ?? [];
  const minPrice = cfg.min_price ?? 1;
  const steps = [];
  // THE VAULT GOES FIRST, BEFORE A SINGLE SHOP, AND IT COSTS TWO HOPS TO DO IT.
  //
  // `sell_all` offers a merchant everything he will take, and the only thing standing between
  // a ring of invisibility and his counter is the keep list. A keep list is a string match
  // written by hand: it is one forgotten name, or one item whose name reads differently from
  // what anybody typed, away from selling the best thing the character owns - and the mistake
  // is invisible afterwards, because the sale reports success either way and the ring is
  // simply gone. What is IN the vault cannot be sold by a list that is wrong.
  //
  // So the order is not a preference, it is the fail-safe, and the harness already refuses the
  // other way round: m59-fleetscript.mjs rejects a plan that `vault`s after it `sell`s, before
  // anything walks, while the loot is still in the pack. This rule agrees with that on purpose
  // - the two are the same fleet's two ways of saying "go and sell", and them disagreeing about
  // which is safe is worse than either answer.
  //
  // WHAT IT COSTS, measured off the bake rather than assumed: Castle Victoria to the vault is
  // 15 hops against 13 to the smith, and the vault is 4 hops from the smith rather than 3 from
  // Joguer's. Vault-first is 42 hops against 40. Two hops in forty is the price of the keep
  // list not being the last line of defence.
  if (cfg.vault?.room != null) {
    steps.push({ tool: 'travel', args: { agent, to: cfg.vault.room, run_errands: false },
      expect: 'arrived', optional: true, label: 'at-the-vault',
      timeout_ms: travelTimeout, estimate_ms: 700_000,
      why: `to the vault (${cfg.vault.room}) BEFORE any shop, so a wrong keep list cannot sell it` });
    steps.push({ tool: 'vault', args: { agent, action: 'deposit',
        items: cfg.vault.items ?? keep },
      // Optional: a vaultman who is not at his counter must not cost the character its
      // selling, its banking or its trip home. `needs` is the other half - a deposit is only
      // sent from a room the walk actually reached, rather than hopefully from wherever the
      // character ended up.
      optional: true, needs: 'at-the-vault', estimate_ms: 20_000,
      why: 'store what must not be sold, where no keep list can reach it' });
  }

  for (const stop of (cfg.stops ?? [])) {
    // run_errands:false — the circuit is the seller. Left at its default (true), each travel
    // hop would run the KEEPER's own bank/sell/supply errands first, selling the pack to the
    // keeper's default merchant before it ever reaches the Barloque specialist. That is the
    // very thing this circuit replaces.
    steps.push({ tool: 'travel', args: { agent, to: stop.room, run_errands: false }, expect: 'arrived',
      timeout_ms: travelTimeout, estimate_ms: 700_000, why: `to ${stop.merchant} (${stop.room})` });
    // Omit max_stack when there is no cap rather than sending null: the errand runner skips any
    // step with a null argument (it means "a value was not known"), which would silently drop
    // the sale at an uncapped shop. sell_all defaults to no cap when the field is absent.
    // KEEP ONE WEAPON: THE ONE IN HAND. `max_weapons` counts equipped plus carried, and
    // OMITTING IT MEANS NULL, WHICH MEANS KEEP EVERY WEAPON — so for as long as this
    // circuit existed it walked every spare blade to Barloque, declined to sell any of
    // them, and walked them home again. A second weapon is worth shillings at the smith
    // and nothing at all in a pack. Operator's correction, 2026-09-05.
    //
    // One, not zero: a character with no weapon at all is a character that cannot fight,
    // and the keeper's own rearming would then have to buy one back.
    const sellArgs = { agent, merchant: stop.merchant, keep, min_price: minPrice,
                       max_weapons: cfg.max_weapons ?? 1 };
    if (stop.max_stack != null) sellArgs.max_stack = stop.max_stack;
    steps.push({ tool: 'sell_all', args: sellArgs, collect: 'messages', estimate_ms: 15_000,
      why: `sell this stop's lane to ${stop.merchant}` });
  }
  // THE BANK, WHICH IS THE EXPENSIVE LEG AND IS STILL THE POINT.
  //
  // A purse is the one thing a death takes in full, and by this point in the circuit the purse
  // is everything three shops just paid. There is no banker in Barloque - Setag'lib is a
  // compiled class that nothing ever creates - so this is a real detour: eleven hops from the
  // vault to the First Royal Bank of Tos, both measured off the bake.
  //
  // TOS RATHER THAN JASPER, and the reason is the leg after it, not the leg to it. Both are
  // eleven hops from the vault and both pay into the same account (BANK_BASIC and BID_TOS are
  // both 1) - but Tos is eight hops from Castle Victoria against Jasper's ten, and Tos is the
  // town this fleet already crosses for the Duke's tables. The bank stop is on ground the
  // character was going to walk anyway.
  //
  // `keep` RATHER THAN AN AMOUNT, because the amount does not exist yet. These steps are built
  // before the first shop is reached and what there is to bank is whatever the shops pay; a
  // number written in here would be a guess, and a guess too high is a deposit refused for the
  // whole trip's takings. The broker forwards the float to the keeper, which owns the purse.
  if (cfg.bank?.room != null) {
    steps.push({ tool: 'travel', args: { agent, to: cfg.bank.room, run_errands: false },
      expect: 'arrived', optional: true, label: 'at-the-bank',
      // 680s to the bank from Castle Victoria, measured; 180_000 was the old guess.
      timeout_ms: travelTimeout, estimate_ms: 700_000,
      why: `to the bank (${cfg.bank.room})` });
    steps.push({ tool: 'bank', args: { agent, action: 'deposit',
        keep: cfg.bank.keep ?? 500 },
      optional: true, needs: 'at-the-bank', estimate_ms: 20_000,
      why: `bank everything above a ${cfg.bank.keep ?? 500} walking float` });
  }

  // AND THEN WHAT NONE OF THE THREE WOULD TAKE GOES IN THE ROAD.
  //
  // This is the last step of the route rather than an alternative to it, and the ordering is
  // the whole point: the vault has taken what is worth keeping, the shops have taken what
  // will sell, the bank has taken what they paid — so what reaches the street is exactly
  // what no counter in the world wanted. Dropping it earlier would be throwing money away;
  // carrying it home is hauling it for nothing.
  //
  // It also empties the pack immediately before the tables, which is why the food step is
  // last and not first: a character arrives at the Duke's hall carrying its weapon, its
  // armour, its money and its reagents, and everything else it can hold is food.
  if (cfg.giveaway?.on === true)
    steps.push(...giveawaySteps(agent, { keep: cfg.giveaway.keep ?? GIVEAWAY_KEEP,
                                         room: cfg.giveaway.room,
                                         travelTimeoutMs: travelTimeout }));

  // WHERE THE CIRCUIT ENDS. Home by default — that is what it always did, and what a fleet
  // with no feast on should still do. `finish: "feast"` sends it to the Duke's tables
  // instead, which is the operator's return route: everything above happens on the way, and
  // the character walks home from the hall with a pack full of food rather than loot.
  //
  // The grab is not scheduled here. The feast rule fires on a character STANDING IN THE
  // HALL, whatever brought it there, so the two errands join without either knowing about
  // the other.
  const finishAtFeast = cfg.finish === 'feast';
  const endsAt = finishAtFeast ? FEAST_HALL.room : back;
  if (cfg.return_home !== false || finishAtFeast)
    // ALWAYS: the last leg runs even if a stop failed, so a half-done circuit does not strand
    // a character in a shop it could not reach the far side of.
    steps.push({ tool: 'travel', args: { agent, to: endsAt, run_errands: false }, always: true,
      timeout_ms: travelTimeout, estimate_ms: 700_000,
      why: finishAtFeast
        ? `on to ${FEAST_HALL.name} (${endsAt}) to fill the pack with food`
        : 'back to the room it was hunting in' });
  return steps;
}

export const sellrunFleetRules = [
  {
    id: 'barloque-sell-circuit',
    faculty: 'work',
    scope: 'fleet',
    why: 'a full pack is worth more sold across the Barloque specialists than dumped on Roq, ' +
         'who buys everything at the standard rate from behind an unsafe tunnel — so route the ' +
         'pack across the smith, the jeweler and the herbalist, then come home',
    enabled: doctrine => doctrine.sellrun?.on === true,
    offWhy: 'sellrun.on is off. The circuit walks a character out of its hunting room across ' +
            'town and back, so it is opted into by a doctrine rather than assumed',
    decide(obs, doctrine) {
      // The doctrine says WHETHER and WHEN; the constants above say WHERE. A doctrine that
      // names its own stops, keep list, vault or bank still wins — this is a default, not a
      // policy — but it does not have to restate Barloque to switch selling on.
      const given = doctrine.sellrun ?? {};
      const cfg = {
        ...given,
        stops: (given.stops ?? []).length ? given.stops : BARLOQUE_STOPS,
        keep: given.keep ?? SELL_KEEP,
        // `null` is how a doctrine says "do not make this stop at all", which is a different
        // instruction from saying nothing. Only an absent key takes the default.
        vault: given.vault === undefined ? BARLOQUE_VAULT : given.vault,
        bank: given.bank === undefined ? TOS_BANK : given.bank,
      };
      if (!(cfg.stops ?? []).length) return null;   // nothing to route to
      const now = obs.at;
      const mem = obs.memory?.sellrun ?? {};
      const t = cfg.trigger ?? {};
      const carryAt = t.carry_at ?? 24;
      const brokeUnder = t.broke_under ?? 0;
      const minHealth = t.min_health ?? 0.8;
      const cooldownMs = cfg.cooldown_ms ?? 20 * 60_000;
      const failBackoffMs = cfg.fail_backoff_ms ?? 5 * 60_000;

      for (const row of (obs.characters ?? [])) {
        if (!row.in_game) continue;
        // Leave alone a character a human is playing, one parking for a fleet update, or one
        // that is BUSY with an operation. Ask `takeable`, never `!commitment`: DUM claims every
        // character it manages, so a bare truthiness test on the commitment would skip the very
        // characters this rule exists to task — its own — and the circuit would fire once, on the
        // tick before the claim, and never again. A takeable `bot` commitment is DUM's own
        // ownership, not an operation in flight, and is exactly who should get the sell trip.
        if (row.piloted || row.parked || !isTakeable(row)) continue;
        // ONE PREDICATE, TWO READERS. The feast rule asks this exact question to decide
        // whether to leave a character alone for this circuit, so it lives in one place.
        if (!sellCircuitWants(row, cfg, obs.memory)) continue;
        // A HANDOVER SKIPS THE COOLDOWN, AND IT IS THE ONLY THING THAT DOES.
        //
        // The window means "this character sold recently and its pack cannot be full again
        // yet", which is true and beside the point: the trip is not being taken for the
        // pack, it is being taken because the character has changed station and this is the
        // road between the two. A graduate that happened to sell twenty minutes before it
        // crossed 50 would otherwise walk to its new room, then walk back the way it came.
        //
        // It cannot loop. `handoverOwed` compares the crossing against `last_run_at`, which
        // this errand writes on the way out — so satisfying it is the same act as running it.
        const owed = handoverOwed(row.agent, obs.memory);
        const win = sellrunWindow(mem, row.agent, now, cooldownMs, failBackoffMs);
        if (!win.ready && !owed) continue;   // per-agent window; try the next candidate

        const back = row.room;
        const steps = circuitSteps(row.agent, cfg, back);
        const merchants = (cfg.stops ?? []).map(s => s.merchant).join(', ');
        return {
          kind: 'errand',
          orders: {
            errand: 'sellrun-circuit',
            agent: row.agent,
            label: `Barloque sell circuit (${(cfg.stops ?? []).length} stops)`,
            context: { stops: (cfg.stops ?? []).map(s => s.room), from: back },
            steps,
          },
          why: owed
            ? `${row.agent} has changed station at ${row.level} max health — one last run at ` +
              `the counters on the way, ending at the Duke's tables and walking home to the ` +
              `new room with a full larder rather than crossing the world three times`
            : `${row.agent} is carrying ${row.carrying ?? 0}` +
              `${(row.carrying ?? 0) >= carryAt ? ' (pack heavy)' : ''}` +
              `${brokeUnder > 0 && (row.purse ?? 0) < brokeUnder
                 ? ` and is nearly broke (${row.purse ?? 0})` : ''}` +
              `; route the pack across the Barloque specialists (${merchants}) rather than Roq`,
          evidence: { agent: row.agent, carrying: row.carrying ?? 0, purse: row.purse ?? 0,
                      handover: owed ? (obs.memory?.band?.[row.agent] ?? true) : false,
                      stops: (cfg.stops ?? []).map(s => s.room), window: win.why },
        };
      }
      return null;   // nobody needs a run this tick; let the lower rules decide
    },
  },
];

/**
 * The memory this errand leaves behind: when this character last ran the circuit, so the
 * window above can gate the next one. Same pure record-fn shape as recordCrateCheck — it reads
 * the finished errand's transcript and the pre-errand topic, and returns the shallow patch the
 * tick writes. Keyed by agent so one character's run does not reset another's clock.
 */
export function recordSellrun({ agent, at, stopped }) {
  // `ok:false` shortens the next window to the fail-backoff instead of the full cooldown, so a
  // circuit that could not complete (usually a travel that stalled on the way to town) retries
  // soon rather than stranding a full pack for the whole cooldown.
  const ok = !stopped;
  return { patch: { [agent]: { last_run_at: at, ok } },
           read: { ran: true, ok, agent, at, stopped: stopped ?? null } };
}
