// ONE TICK. sense -> decide -> act -> verify -> record, in that order, for one
// character or for the fleet.
//
// The stages are separate functions rather than one loop because a wrong answer has to
// be attributable to one of them. "The bot did the wrong thing" is not a diagnosis;
// "the observation had a null level so the ladder rung was unanswerable" is.
//
// A TICK NEVER THROWS. Every stage's failure becomes a journal line and the next
// character is still ticked. The alternative — one bad observation stopping the fleet —
// is the failure mode that costs most, because it is silent: a bot that died on
// character three looks exactly like a bot with nothing to do for characters four
// through twenty-one.

import { observeFleet, observeFromBoard, deepen, enrichForMoot, enrichEquipment,
         enrichMaintenance, enrichFactionInventory, enrichFactionGames, enrichFactionLoyalty, enrichTravelEstimates } from '../sense/observe.mjs';
import { characterRules, fleetRules, decide } from '../decide/index.mjs';
import { apply } from '../act/orders.mjs';
import { verify } from '../act/verify.mjs';
import { readErrand } from '../act/errands.mjs';
import { FEAST_HALL } from '../decide/feast-hall.mjs';
import { STRATEGY_IDS } from '../strategies/catalog.mjs';

/**
 * One character.
 *
 * TWO PHASES, and the split is the whole cost model — see src/sense/observe.mjs.
 * Phase one decides from the free fleet board. Only an intent that has to be DIFFED
 * against the keeper's live policy justifies paying for `status`, which is four server
 * requests per character.
 *
 * @param {object} ctx
 * @param {import('../link/broker.mjs').Broker} ctx.broker
 * @param {object} ctx.config
 * @param {import('../record/journal.mjs').Journal} ctx.journal
 * @param {boolean} ctx.commit
 * @param {object} row  this character's normalised fleet-board row
 */
export async function tickCharacter(ctx, row) {
  const { broker, config, journal, commit } = ctx;
  const now = ctx.now?.() ?? Date.now();
  const agent = row.agent;
  const line = { kind: 'tick', at: now, agent };

  try {
    // ---- phase one: free
    // THE MEMORY, WHICH THE PER-CHARACTER PATH DID NOT HAVE. It is a local file read, not a
    // packet, and without it a rule here cannot see what an errand this fleet already started
    // is doing. `return-to-station` is the one that needed it: a character eleven hops into a
    // walk to the Duke's hall is in none of the rooms that walk ends at, so it read as
    // out-of-position and was recalled — 28 times in one watch, against zero food taken.
    let obs = { ...observeFromBoard(row, { now }), memory: ctx.memory?.read() ?? null };
    let { intent, considered } = decide(characterRules, obs, config);
    line.considered = considered;

    // ---- phase two: paid, and only for an order
    //
    // `report` and `none` never reach the server. That is not a saving at the margin:
    // on a quiet fleet it is the difference between a tick costing one call and a tick
    // costing eighty-five.
    if (intent && intent.kind === 'orders') {
      obs = await deepen(broker, obs, characterRules.needs(config), { now });
      line.deepened = true;
      // Decide AGAIN on the fuller observation. Rules are pure, so this costs nothing,
      // and the second answer may legitimately differ — a rule that could not see the
      // keeper's policy may now find the keeper already has these orders. That is the
      // design working, not a race.
      ({ intent, considered } = decide(characterRules, obs, config));
      line.considered = considered;
    }

    line.observation = obs;
    line.intent = intent;
    if (!intent) { journal.write(line); return line; }

    // A lease must exist BEFORE the write it authorises. The old loop claimed after the
    // whole pass, which made the first pass of every committed run an unclaimed write.
    if (!['none', 'report'].includes(intent.kind))
      await ctx.ensureClaim?.([intent.agent].filter(Boolean));

    if (commit && ctx.circuits && intent.kind === 'errand'
        && intent.orders?.errand === 'return-to-station') {
      const started = await ctx.circuits.start(intent);
      line.applied = { acted: started, kind: 'background-errand', agent };
      journal.write(line);
      return line;
    }

    const applied = await apply(broker, intent, obs, { commit, yieldTo: config.yield_to ?? [], holder: ctx.holder });
    line.applied = applied;

    if (applied.acted) {
      line.verified = await verify(broker, applied);
      if (line.verified.verified === false)
        journal.finding(agent, line.verified.why, { sent: applied.sent, fields: line.verified.fields });
    }
    if (intent.kind === 'report') journal.finding(agent, intent.why, intent.evidence);

    journal.write(line);
    return line;
  } catch (e) {
    line.error = e.message;
    line.retriable = !!e.retriable;
    journal.write(line);
    return line;
  }
}

/**
 * The fleet-level tick.
 *
 * `decide: false` reads the board and runs no fleet rules. That combination is not a
 * half-measure — the board is the tick's SPINE (it is where the list of characters
 * comes from, and it is free) while the fleet RULES run on a much slower cadence,
 * because each of them stops keepers and walks characters across the world.
 */
export async function tickFleet(ctx, { decide: runRules = true, only = null } = {}) {
  const { broker, config, journal, commit } = ctx;
  const now = ctx.now?.() ?? Date.now();
  const line = { kind: 'fleet-tick', at: now, decided: runRules };
  const write = () => {
    ctx.detailStats?.captureFleetTick(line, config);
    journal.write(line);
    return line;
  };

  try {
    // WHAT DUM REMEMBERS ARRIVES IN THE OBSERVATION, EXACTLY AS THE CLOCK DOES.
    //
    // `src/decide/` is pure by law — no clock, no randomness, no I/O — and a rule that
    // read the memory file directly would break that for the same reason `Date.now()`
    // would: the decision would stop being reproducible from its own journal line. So it
    // is read ONCE here, put on the observation, and journalled with it. A rule that
    // needs the past gets it as data.
    const memory = ctx.memory?.read() ?? null;
    const observed = await observeFleet(broker, { now,
      rooms: config.graveyard?.shift === true ? (config.graveyard.rooms ?? []) : [],
      // Bodies another operator is driving. Dropped here so that every consumer below --
      // the claim, the stations, the strategies, coverage -- is unaware they exist.
      notOurs: config.not_ours ?? [] });
    const strategies = ctx.strategies?.snapshot((observed.characters ?? [])
      .filter(r => r.in_game).map(r => r.agent)) ?? null;
    const agents = (observed.characters ?? []).filter(r => r.in_game).map(r => r.agent);
    // Own the configured faculties before paid observation lets the keeper choose
    // a new farming destination for a runner left in town by a process restart.
    if (commit && ctx.circuits)
      await ctx.ensureClaim?.(agents.filter(agent => !only || only.has(agent)));
    const factions = ctx.factions?.snapshot(agents) ?? null;
    const obs = { ...observed, memory, strategies, factions };
    if (factions) {
      // Scoped like the maintenance enrichment below: a run that manages a handful of
      // characters must not pay a per-character inventory read for every OTHER character that
      // happens to be mid faction-acquisition.
      const waitingForCargo = (obs.characters ?? []).filter(row =>
        (!only || only.has(row.agent)) && factions.agents?.[row.agent]?.status === 'acquiring');
      if (waitingForCargo.length) await enrichFactionInventory(broker, waitingForCargo);
    }
    // WHETHER A MEMBERSHIP IS ABOUT TO LAPSE, READ FROM DISK RATHER THAN FROM THE SERVER.
    //
    // The warning is prose the server pushes with no packet behind it; the harness catches
    // it off its own event stream and files it beside the membership. So this is a local
    // read, and it is what lets a four-hour deadline be watched on a five-minute clock
    // without a per-tick server request — and what lets DUM react to something the server
    // SAID while remaining unable to read anything anyone says.
    //
    // Gated on the doctrine and off by default: a fleet of neutrals would otherwise pay a
    // read per character per tick to be told, every time, that nobody owes anything.
    if (config.factions?.keep_membership === true) {
      const members = (obs.characters ?? []).filter(row => row.in_game);
      if (members.length) {
        await enrichFactionLoyalty(broker, members);
        // THE SERVER OPENS THIS GOAL, so it is synced from what was observed rather than
        // from anybody's selection — here, before decide() runs, so the rules read it as
        // ordinary data and stay pure.
        for (const row of members) {
          if (row.loyalty_debt === undefined) continue;    // unread; leave the goal alone
          try { ctx.factions?.syncLoyalty?.(row.agent, row.loyalty_debt, { at: now }); }
          catch { /* a read-only store is a legitimate configuration, not a failure */ }
        }
        obs.factions = ctx.factions?.snapshot(agents) ?? obs.factions;
      }
    }
    // HOW FAR THE NEXT WINDOW IS, IN WALKING TIME. Only for a station that is waiting to
    // open and only when it is close enough for the answer to change a decision — the
    // estimate is free of game-server traffic but it is still a call per distinct room,
    // and asking two hours out would be asking about a walk nobody is about to make.
    const waiting = (config.shift?.stations ?? []).find(st => {
      if (!Number.isFinite(Number(st?.lead_ms)) || Number(st.lead_ms) <= 0) return false;
      const when = String(st.when ?? 'always').toLowerCase();
      if (when === 'always') return false;
      const clock = obs.world_clock;
      if (!clock) return false;
      const until = when === 'night' ? clock.opens_in_ms : clock.closes_in_ms;
      // Twice the lead: enough warning to have a fresh number before the moment it is
      // needed, without polling all cycle.
      return Number.isFinite(until) && until <= Number(st.lead_ms) * 2;
    });
    if (waiting)
      await enrichTravelEstimates(broker, (obs.characters ?? []).filter(r => r.in_game),
                                  Number(waiting.room));
    // PAID ENRICHMENT RESPECTS THE RUN'S SCOPE. Each of these reads inventory/spells PER
    // CHARACTER, one paced server request each — so on a fleet where every unit selects
    // create-weapons/create-food, an unscoped read is 21 requests a tick and a scoped `--agent`
    // run was paying all of them for a handful of characters it actually manages. A scoped run
    // decides over only its in-scope characters (see the decideObs filter below), so it needs
    // facts for only those; reading the rest is pure cost with nothing downstream to consume it.
    const inScope = only ? (r => only.has(r.agent)) : (() => true);
    const live = () => (obs.characters ?? []).filter(r => r.in_game && inScope(r) && !ctx.circuits?.has(r.agent));
    if (config.graveyard?.shift === true)
      await enrichEquipment(broker, live());
    if (config.moot?.hold === true || config.weapons?.provision?.enabled === true) {
      const room = config.weapons?.provision?.enabled
        ? config.weapons.provision.room : config.moot.room;
      const here = live().filter(r => r.room === room);
      const enough = config.weapons?.provision?.enabled
        ? here.length === live().length
        : here.length >= (config.moot.quorum ?? 2);
      if (enough) await enrichForMoot(broker, here,
        { weapons: config.weapons?.provision?.enabled === true });
    }
    if (config.strategies?.enabled === true) {
      const needsFacts = live().filter(r =>
        [STRATEGY_IDS.CREATE_WEAPONS, STRATEGY_IDS.CREATE_FOOD].some(id =>
          obs.strategies?.agents?.[r.agent]?.includes(id)));
      if (needsFacts.length) await enrichMaintenance(broker, needsFacts);
      const factionPlayers = live().filter(r =>
        obs.strategies?.agents?.[r.agent]?.includes(STRATEGY_IDS.PLAY_FACTION_GAMES));
      if (factionPlayers.length) await enrichFactionGames(broker, factionPlayers);
    }
    // HOW FAR EVERYBODY IS FROM THE DUKE'S TABLES. Free — the estimate is local arithmetic
    // in the harness, asked once per distinct room — and it is the fact both feast doors
    // turn on: "near Tos" is a hop count and "the supply trip, redirected" is a walk time.
    // On its own field so it cannot collide with the graveyard's `travel_to_station`.
    if (config.feast?.on === true)
      await enrichTravelEstimates(broker, live(), FEAST_HALL.room, { field: 'travel_to_feast' });
    line.observation = obs;

    // STAND DOWN WHILE THE FLEET IS PARKING. A parked keeper is running and
    // deliberately doing nothing, which is exactly what this loop is built to notice
    // and "fix" — and fixing it clears the parking flag and sends the character back to
    // work in the minute before the broker goes down. Worse, deploying is not merely
    // useless here: it stops keepers and walks characters across the world, so an update
    // arriving mid-deploy takes the outage with characters somewhere between towns.
    //
    // One parked character stands the whole tick down. The update is measured in
    // minutes and this runs every few of them; nothing is lost by waiting.
    if (obs.parking > 0) {
      line.stood_down = `${obs.parking} character(s) are parking for a fleet update`;
      return write();
    }

    if (!runRules) return write();

    // SCOPE: a run restricted to a set of agents must touch NO other character, including
    // through a fleet-scoped rule. `--agent` filters the per-character rows in `pass`, but a
    // fleet rule — the sell circuit, a faction request — iterates the board itself and names its
    // OWN actor, so a two-character run could otherwise walk a third character it happened to
    // pick as the heaviest pack or the next queued join. So the fleet rules DECIDE over only the
    // in-scope characters: nothing outside the set is ever chosen as a target, and — unlike
    // dropping the finished intent — a lower in-scope rule is not starved by a higher rule that
    // keeps re-picking an out-of-scope character every tick and never converging. The full board
    // is still read (above) and still used for the claim, the send and the memory patch; only
    // the decision input is narrowed. `line.scope` records that it happened.
    const decideObs = only
      ? { ...obs, characters: (obs.characters ?? []).filter(r => only.has(r.agent)) }
      : obs;
    if (only) line.scope = [...only];
    // The current pass may predate a newly launched busy lease on the broker.
    // Exclude only actors with a local job, so no rule can take the same body.
    if (ctx.circuits) decideObs.characters = decideObs.characters.filter(r => !ctx.circuits.has(r.agent));
    // Jobs can finish during enrichment; use their completed cooldowns now.
    decideObs.memory = ctx.memory?.read() ?? memory;
    // SEVERAL DECISIONS PER FLEET PASS, ON DISJOINT CHARACTERS.
    //
    // The engine's invariant is one directional decision per CHARACTER; stopping the whole
    // table after one rule was always stricter than that, and on this fleet it meant
    // `hunt-shift` -- which fires every pass, because there is always somebody to station --
    // sat on the entire fuel model for a day. The disjointness test in `decide` is what
    // keeps this correct; `cadence.fleet_intents_per_pass` is only traffic control, so a
    // crowd is not dispatched down one thin corridor at once. DUM's own 30s tick is the
    // stagger between successive batches.
    const perPass = Math.max(1, Number(config.cadence?.fleet_intents_per_pass ?? 1));
    const { intents = [], considered } = decide(fleetRules, decideObs, config, { max: perPass });
    line.considered = considered;
    line.intent = intents[0] ?? null;
    if (intents.length > 1)
      line.intents = intents.map(i => ({ rule: i.rule, agent: i.agent }));
    if (!intents.length) return write();
    const [intent, ...rest] = intents;

    // An errand has one named actor and no fleet `plan`; a batch act has a plan and may
    // name both sides of a transfer. Claim the shape that was actually emitted. Reading
    // `null.flatMap` here used to abort a perfectly valid crate check before its first
    // write, so the timer stayed unknown and the same doomed intent returned forever.
    // Both fleet plans and errands need ownership before their first write. The helper
    // deliberately returns the errand's named actor even though it has no fleet `plan`;
    // gating this call on `kind === 'act'` computed the right character and then skipped
    // the claim, so `busy` correctly refused every crate mission.
    await ensureFleetIntentClaim(ctx, intent);
    if (commit && ctx.circuits && intent.kind === 'errand'
        && ['sellrun-circuit', 'feast-grab'].includes(intent.orders?.errand)) {
      const started = await ctx.circuits.start(intent);
      line.applied = { acted: started, kind: 'background-errand', agent: intent.orders.agent };
      return write();
    }

    const applied = await apply(broker, intent, obs, { commit, yieldTo: config.yield_to ?? [], holder: ctx.holder });
    line.applied = applied;

    // THE REST OF THIS PASS'S DECISIONS. Disjoint from the first by construction, so each
    // gets its own claim and its own apply. A failure is recorded per intent rather than
    // aborting the batch: these rules were reached precisely because the one above them had
    // nothing to say about their characters, and dropping them would restore the starvation
    // this exists to end.
    // AND A SECOND DECISION MUST NEVER BE ABLE TO WEDGE THE FIRST.
    //
    // Measured 2026-09-09, the first time this ran committed on prod: at a cap of 3 the
    // pass stopped completing. 320 broker calls in eleven minutes and NOT ONE tick or
    // fleet-tick line, and no `pass-failed` either -- so nothing threw; an await simply
    // never resolved. Because the extras are applied before `write()`, the whole pass was
    // swallowed: no journal line, no character ticks below it, and the fleet ran on its
    // keepers alone until the process was restarted. The dry `plan` path completed fine at
    // the same cap, which is why 451 offline tests and a clean plan said nothing.
    //
    // The lesson is not "find that await". It is that the FIRST decision of a pass is the
    // one the doctrine ranked highest, it has already been applied by the time we get here,
    // and nothing optional below it may be allowed to cost the fleet its tick. So each
    // extra is bounded and failure-open: a slow one is abandoned, recorded by name, and the
    // pass finishes. A rule that times out repeatedly is then visible in the journal
    // instead of invisible in a wedged loop.
    for (const extra of rest) {
      (line.applied_extra ??= []);
      const started = Date.now();
      try {
        const out = await withDeadline(EXTRA_INTENT_MS, async () => {
          await ensureFleetIntentClaim(ctx, extra);
          // A BACKGROUND ERRAND IS STARTED, NOT AWAITED -- AND THAT BRANCH EXISTED ONLY
          // FOR THE FIRST INTENT.
          //
          // This is the actual hang, not merely a slow call. `sellrun-circuit` and
          // `feast-grab` are circuits: minutes of walking, selling and banking, handed to
          // `circuits.start` so the tick returns immediately. The primary intent has taken
          // that branch since it was written. A SECONDARY intent fell past it into
          // `apply()`, which runs the errand inline -- so the pass sat waiting for a
          // Barloque round trip, wrote no journal line, and took every character tick
          // below it down with it.
          //
          // Journalled proof, 2026-09-09 23:27: `barloque-sell-circuit` as an extra,
          // "abandoned after 20000ms". The deadline above is the safety net; this is the
          // fix. Both stay: one keeps a future long call from wedging the loop, the other
          // stops this one being long in the first place.
          if (commit && ctx.circuits && extra.kind === 'errand'
              && ['sellrun-circuit', 'feast-grab'].includes(extra.orders?.errand)) {
            const started2 = await ctx.circuits.start(extra);
            return { acted: started2, kind: 'background-errand', agent: extra.orders.agent };
          }
          return apply(broker, extra, obs,
            { commit, yieldTo: config.yield_to ?? [], holder: ctx.holder });
        });
        line.applied_extra.push({ rule: extra.rule, agent: extra.agent, applied: out,
                                  ms: Date.now() - started });
      } catch (e) {
        line.applied_extra.push({ rule: extra.rule, agent: extra.agent,
                                  error: e.message, ms: Date.now() - started });
      }
    }

    // A DECISION THAT CANNOT BE RE-DERIVED FROM THE NEXT BOARD HAS TO SAY SO WHEN IT IS MADE.
    //
    // Until now the only way into the memory was `readErrand`, which is right for an errand
    // — its whole product is what the world said back — and impossible for anything else. A
    // fleet PLAN has no transcript to interpret, so a rule that learned something while
    // deciding had nowhere to put it and had to re-derive it next pass from a board that no
    // longer showed it.
    //
    // The worked case is the hunting shift's max-health bands. "This character is in the
    // 50-and-over band" is on every row for ever; "this character CROSSED 50 and owes a last
    // sell run at the station it is leaving" is true for about two minutes, and after the
    // deploy lands nothing distinguishes a graduate from a character that was always here.
    //
    // ONLY ON A REAL WRITE. `acted` is false for a dry run and for a plan the diff found
    // nothing to send in, and remembering either would have `plan` change what the fleet
    // believes — which is the one thing a plan must never do. Memory is also constructed
    // with `enabled:false` for `plan`, so this is the second of two locks and deliberately
    // so: the first is a constructor argument somebody could pass wrongly.
    if (intent.remember?.topic && applied.acted) {
      line.memory_patch = intent.remember;
      ctx.memory?.patch(intent.remember.topic, intent.remember.patch);
    }

    // WHAT AN ERRAND LEARNED, WRITTEN DOWN BEFORE ANYTHING ELSE CAN FAIL.
    //
    // An errand's whole product is what the world said back to it, and that answer exists
    // in exactly one place for a few milliseconds. If this pass throws afterwards — or
    // the broker goes away, or the process is killed — the walk still happened, the
    // window may still have been consumed, and nothing would remember. So the memory is
    // patched here, immediately, and the patch is journalled as data.
    if (applied.errand) {
      const factionGoal = ctx.factions?.recordErrand(applied, { at: now });
      if (factionGoal) line.faction_goal = factionGoal;
      // `memory` is the PRE-errand snapshot read at the top of this tick, which is what
      // the interpreter needs: `checked_by` is a per-character map and Memory.patch is
      // deliberately shallow, so the merge has to happen against what was there before.
      const learned = readErrand(applied, { at: now, memory });
      if (learned) {
        line.memory_patch = learned;
        ctx.memory?.patch(learned.topic, learned.patch);
        // A CHECK THAT REACHED NOTHING IS A FINDING, NOT A MISS. On the wire the two are
        // identical — no message either way — so without this a fleet under 30 max health
        // would walk to a basement every half hour for ever and the board would show it
        // working. See readCrateTranscript in src/decide/rules/crate.mjs.
        if (learned.read.reached === false)
          journal.finding(applied.agent, learned.read.why,
                          { errand: applied.errand, transcript: applied.transcript,
                            stopped: applied.stopped ?? null });
      }
      if (applied.stopped)
        journal.finding(applied.agent, `the ${applied.errand} errand stopped early: ${applied.stopped}`,
                        { sent: applied.sent });
    }

    if (applied.acted) line.verified = await verify(broker, applied);
    if (applied.partial)
      journal.finding(null, 'a batch was half applied — see verified.fields for which side is missing',
                      { sent: applied.sent });
    if (intent.kind === 'report') journal.finding(null, intent.why, intent.evidence);

    return write();
  } catch (e) {
    line.error = e.message;
    return write();
  }
}

// `to` is overloaded by the plan language: a give's `to` is an agent, while a muster's
// `to` is a room number. Treating both as people created an empty broker session named
// "52" during the first live moot. Keep this mapping next to the claim call and test it.
export function fleetPlanAgents(plan = []) {
  return [...new Set(plan.flatMap(p => ['give', 'give-weapon'].includes(p.do) ? [p.from, p.to] : [p.agent])
    .filter(v => typeof v === 'string' && v))];
}

export function fleetIntentAgents(intent = {}) {
  return intent.kind === 'errand'
    ? [intent.agent].filter(Boolean)
    : fleetPlanAgents(intent.plan ?? []);
}

/**
 * How long a SECONDARY fleet decision may take before the pass abandons it.
 *
 * Generous enough for a claim plus a batch of autopilot writes, short enough that a wedged
 * one costs a fraction of a tick rather than the tick. The primary decision is deliberately
 * NOT bounded by this: it is what the doctrine ranked highest, and cutting it short would
 * trade a visible hang for a silent half-applied order.
 */
export const EXTRA_INTENT_MS = 20_000;

/** Run `fn`, but give up after `ms` rather than letting one await stop the loop. */
export async function withDeadline(ms, fn) {
  let timer = null;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, rej) => { timer = setTimeout(
        () => rej(new Error(`abandoned after ${ms}ms — the pass must not wait on a secondary decision`)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function ensureFleetIntentClaim(ctx, intent) {
  const agents = fleetIntentAgents(intent);
  if (agents.length) await ctx.ensureClaim?.(agents);
  return agents;
}

/**
 * A full pass: the fleet board, then every character the doctrine is responsible for.
 *
 * `only` restricts the run to a SET of agents (one name, a comma-list, or an array), which is
 * what `--agent` uses. It restricts both halves: the per-character rows below, AND — inside
 * tickFleet — any fleet-scoped intent that names an agent outside the set, so a scoped run
 * genuinely touches nobody else. Restricting is not the same as skipping the board: a scoped
 * plan still reads the whole board, because half of what makes a directional decision correct
 * is what the other characters are doing, and the board is where a character's own numbers come
 * from.
 */
export async function pass(ctx, { only = null, decideFleet = true } = {}) {
  const scope = only == null ? null : new Set(Array.isArray(only) ? only : [only]);
  const fleetLine = await tickFleet(ctx, { decide: decideFleet, only: scope });
  if (fleetLine.stood_down || fleetLine.error) return { fleet: fleetLine, characters: [] };

  const rows = (fleetLine.observation?.characters ?? [])
    .filter(r => r.in_game)
    .filter(r => !scope || scope.has(r.agent));

  if (scope && !rows.length)
    return { fleet: fleetLine, characters: [],
             note: `none of "${[...scope].join(', ')}" is in game on this fleet` };

  const characters = [];
  for (const r of rows.filter(r => !ctx.circuits?.has(r.agent))) characters.push(await tickCharacter(ctx, {
    ...r, strategies: fleetLine.observation?.strategies ?? null,
    factions: fleetLine.observation?.factions ?? null,
  }));
  // THE RUNNING TOTALS, READ AFTER THE PASS RATHER THAN ACCUMULATED IN IT. A pass may
  // have written to them (an errand recorded itself), so this is deliberately the read
  // that happens last. The report prints them; nothing decides on them.
  return { fleet: fleetLine, characters, memory: ctx.memory?.read() ?? null };
}
