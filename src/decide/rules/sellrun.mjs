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
// WHAT THIS DRAFT DOES NOT DO YET, and why each is safe to leave out:
//   * It does not VAULT the rare keepers (Obert Cair'bre, room 114). There is no keeper-proxied
//     item-storage tool yet, so instead every stop's `sell_all` carries a `keep` list and the
//     rares/reagents simply stay in the pack, unsold. That protects them from being sold; it
//     does not protect them from death. A vault step waits on a storage action in the harness.
//   * It does not BUY reagents or BANK inside the errand. Banking needs an explicit amount and
//     there is no banker in Barloque (bank tool note: Tos/Jasper/Ko'catan only), and the
//     post-sell purse is not knowable when the static steps are built. Both belong to the
//     keeper's own economy policy (bank_above, buy_reagents), which the doctrine sets.
//
// PURE, like every rule here: `now` and the past both arrive on the observation. The memory
// window is what stops the errand re-firing every tick and marching a character to town for
// ever — the "character in a basement" failure the crate rule documents at length.

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

/** Build the ordered step list for one character's circuit. Pure; args only. */
function circuitSteps(agent, cfg, back) {
  const travelTimeout = cfg.travel_timeout_ms ?? 240_000;
  const keep = cfg.keep ?? [];
  const minPrice = cfg.min_price ?? 1;
  const steps = [];
  for (const stop of (cfg.stops ?? [])) {
    // run_errands:false — the circuit is the seller. Left at its default (true), each travel
    // hop would run the KEEPER's own bank/sell/supply errands first, selling the pack to the
    // keeper's default merchant before it ever reaches the Barloque specialist. That is the
    // very thing this circuit replaces.
    steps.push({ tool: 'travel', args: { agent, to: stop.room, run_errands: false }, expect: 'arrived',
      timeout_ms: travelTimeout, estimate_ms: 120_000, why: `to ${stop.merchant} (${stop.room})` });
    // Omit max_stack when there is no cap rather than sending null: the errand runner skips any
    // step with a null argument (it means "a value was not known"), which would silently drop
    // the sale at an uncapped shop. sell_all defaults to no cap when the field is absent.
    const sellArgs = { agent, merchant: stop.merchant, keep, min_price: minPrice };
    if (stop.max_stack != null) sellArgs.max_stack = stop.max_stack;
    steps.push({ tool: 'sell_all', args: sellArgs, collect: 'messages', estimate_ms: 15_000,
      why: `sell this stop's lane to ${stop.merchant}` });
  }
  if (cfg.return_home !== false)
    // ALWAYS: the way home runs even if a stop failed, so a half-done circuit does not strand a
    // character in a shop it could not reach the far side of.
    steps.push({ tool: 'travel', args: { agent, to: back, run_errands: false }, always: true,
      timeout_ms: travelTimeout, estimate_ms: 120_000, why: 'back to the room it was hunting in' });
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
      const cfg = doctrine.sellrun ?? {};
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
        const heavy = (row.carrying ?? 0) >= carryAt;
        const broke = brokeUnder > 0 && (row.purse ?? 0) < brokeUnder;
        if (!heavy && !broke) continue;
        // Do not march a hurt character across town. Selling is not survival; if it is below
        // the floor the keeper's ladder is the thing that should be acting, not this.
        if ((row.health?.pct ?? 1) < minHealth) continue;
        const win = sellrunWindow(mem, row.agent, now, cooldownMs, failBackoffMs);
        if (!win.ready) continue;   // per-agent window; try the next candidate

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
          why: `${row.agent} is carrying ${row.carrying ?? 0}` +
               `${heavy ? ' (pack heavy)' : ''}${broke ? ` and is nearly broke (${row.purse ?? 0})` : ''}` +
               `; route the pack across the Barloque specialists (${merchants}) rather than Roq`,
          evidence: { agent: row.agent, carrying: row.carrying ?? 0, purse: row.purse ?? 0,
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
