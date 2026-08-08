// HARNESS SHAPES IN, ONE SHAPE OUT.
//
// Every field the rule table reads is named here, once. That has two effects worth the
// indirection:
//
//   * a harness response shape change breaks ONE file, loudly, instead of making four
//     rules quietly stop firing. A rule that reads `r.level` and gets `undefined`
//     does not throw — it just never matches, and a bot that never matches looks
//     exactly like a bot with nothing to do;
//   * the fixtures in tests/ are normalised observations, so the rule tests do not
//     have to be rewritten every time the harness renames something.
//
// WHERE A FIELD IS ABSENT IT IS null, NEVER 0. `level: 0` and "the harness did not
// report a level" are opposite facts and the rules treat them so — the second one must
// never satisfy a "below 30" test.
//
// TWO NAMING TRAPS THE HARNESS HAS, BOTH HANDLED HERE AND NOWHERE ELSE:
//   * on the fleet board, `room` is the room's NAME and `room_num` is its number. On
//     `status` it is `where: {num, name}`. Reading `row.room` as a number silently
//     yields NaN and every room comparison then fails closed.
//   * the board says `committed`; the keeper's own status says `commitment`. Same
//     object, and a rule reading the wrong one sees no commitments at all — which
//     means it happily redirects characters that are halfway through an errand.

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
const str = v => (typeof v === 'string' && v.trim()) ? v.trim() : null;
const bool = v => typeof v === 'boolean' ? v : null;

/**
 * Vitals arrive in three shapes depending on the call: `{value, max}` from `status`,
 * the string `"27/30"` from the fleet board, and a bare number from some summaries.
 * All three mean the same thing and none of the rules should have to know that.
 */
function vital(v) {
  if (num(v) !== null) return { value: num(v), max: null, pct: null };
  if (typeof v === 'string') {
    const m = /^(-?\d+)\s*\/\s*(\d+)$/.exec(v.trim());
    if (!m) return { value: null, max: null, pct: null };
    const value = Number(m[1]), max = Number(m[2]);
    return { value, max, pct: max ? value / max : null };
  }
  if (!v || typeof v !== 'object') return { value: null, max: null, pct: null };
  const value = num(v.value ?? v.current);
  const max = num(v.max ?? v.scale_max);
  return { value, max, pct: (value !== null && max) ? value / max : num(v.pct) };
}

/**
 * One row of the `fleet` board — THE FREE READ.
 *
 * `fleet` sends nothing to the game server: it reads the client's cached world and
 * each keeper's in-memory status. That is why it is the tick's spine, and why DUM
 * decides from it before paying for anything else. See observe.mjs.
 */
export function normalizeFleetRow(r = {}) {
  const health = vital(r.health);
  return {
    agent: str(r.agent),
    // The character's in-world name. Recorded but NEVER written to a tracked file —
    // see CLAUDE.md rule 4. The journal is gitignored for exactly this.
    character: str(r.character),
    in_game: r.in_game !== false,
    // MAX HEALTH IS THE LEVEL. The harness says so on the row itself, and every other
    // system compares monsters against it. A ladder rung phrased in max health is
    // phrased in the units the server uses.
    level: num(r.level) ?? health.max,
    max_health: health.max ?? num(r.level),
    health,
    vigor: vital(r.vigor_of ?? r.vigor),
    mana: vital(r.mana),
    // `room` on the board is the NAME; the number is `room_num`.
    room: num(r.room_num),
    room_name: str(r.room_name ?? (typeof r.room === 'string' ? r.room : null)),
    // What the keeper says it is doing, in its own words. Read for display; never
    // matched against. See rules/escalate.mjs for why that restraint is load-bearing.
    doing: str(r.activity ?? r.doing),
    hunting: str(r.autopilot?.hunt ?? r.hunting),
    mode: str(r.autopilot?.mode ?? r.mode),
    strategy: str(r.strategy),
    partner: str(r.partner),
    // A PAIRING IS TWO HALVES AND BOTH MUST AGREE. A character whose policy names a
    // partner that does not name it back is not in a party — the tactic degrades to two
    // characters standing in the same room, and the failure is invisible in `partner`
    // alone. This is the field the pairing rule heals on.
    partner_ok: bool(r.partner_ok),
    kills_30m: num(r.kills_30m),
    // MONEY, IN TWO NUMBERS THAT MUST NOT BE SUMMED. `purse` is lost on death and
    // `banked` is not, and that distinction is the entire economics of this fleet.
    // `banked: null` means nobody has seen this character at a counter — which is not
    // a balance of zero and must never be rendered as one.
    purse: num(r.purse),
    banked: num(r.banked?.value ?? r.banked),
    carrying: num(r.carrying),
    // The keeper's own commitment description: errand | driven | parked | partner.
    // The board calls it `committed`.
    commitment: r.committed ?? r.commitment ?? null,
    parked: r.parked ?? null,
    piloted: r.piloted ?? null,
    // `stalled` is either false, a string, or an object with a `why`. All three occur.
    stalled: (r.stalled && r.stalled !== false) ? r.stalled : null,
    // NOT ON THE BOARD, and it is the reason an orders diff cannot be made from the
    // free read alone. See docs/harness-contract.md §Gap 5.
    keeper: { mode: str(r.autopilot?.mode), running: r.autopilot?.running !== false,
              policy: null, tally: { kills: num(r.autopilot?.kills) ?? 0 }, journal: [] },
    refusals: [],
    waiting_on: null,
    // Where this observation came from, so a rule that needs the policy can tell that
    // it has not been paid for yet rather than concluding the policy is empty.
    depth: 'board',
  };
}

/**
 * The `status` call — THE EXPENSIVE READ.
 *
 * It is four server requests (`stats(1)`, `stats(2)`, the spell list, the skill list)
 * plus a settle, per character, through the pacer. Called only when a decision cannot
 * be made without the keeper's full policy. Merged onto the board row rather than
 * replacing it, because the board carries things `status` does not.
 */
export function normalizeStatus(base, s = {}, { now = Date.now() } = {}) {
  const vitals = s.vitals ?? s.status?.vitals ?? {};
  const keeper = s.autopilot ?? s.keeper ?? {};
  const health = vital(vitals.health ?? s.health);
  return {
    ...base,
    at: now,
    character: str(s.character ?? s.name) ?? base.character,
    in_game: s.in_game !== false,
    level: health.max ?? base.level,
    max_health: health.max ?? base.max_health,
    health: health.value !== null ? health : base.health,
    vigor: vitals.vigor ? vital(vitals.vigor) : base.vigor,
    mana: vitals.mana ? vital(vitals.mana) : base.mana,
    room: num(s.where?.num ?? s.room?.num ?? s.room_num) ?? base.room,
    room_name: str(s.where?.name ?? s.room?.name ?? s.room_name) ?? base.room_name,
    // Where the keeper is standing and whether the square has been PROVED to work.
    // `works` is evidence — the keeper stood in it with something adjacent and was not
    // hit — and geometry is not. A rule that treats a geometric guess as proof is how
    // characters end up somewhere nothing can reach them and nothing can be reached.
    safe_spot: s.safe_spot ? {
      room: num(s.safe_spot.room), col: num(s.safe_spot.col), row: num(s.safe_spot.row),
      works: bool(s.safe_spot.works),
    } : (base.safe_spot ?? null),
    keeper: {
      running: keeper.running !== false,
      mode: str(keeper.mode) ?? base.keeper.mode,
      inert: keeper.inert ?? null,
      parked: keeper.parked ?? null,
      // THE FIELD THE WHOLE EXPENSIVE READ IS FOR. Without it there is nothing to diff
      // an order against, so every write would be sent every tick.
      policy: keeper.policy ?? {},
      tally: keeper.did ?? keeper.tally ?? base.keeper.tally,
      // The journal tail, as the harness returns it. Carried so a human can read it;
      // never matched against.
      journal: Array.isArray(keeper.journal) ? keeper.journal : [],
    },
    commitment: s.commitment ?? base.commitment,
    stalled: (s.stalled && s.stalled !== false) ? s.stalled : base.stalled,
    // THE FIELDS THAT DO NOT EXIST YET, and the single most valuable thing the harness
    // could add. See docs/harness-contract.md §Gap 1.
    //
    // A keeper refusing to fight in a room with no safe wall, or waiting to accumulate
    // the mana `create weapon` needs, is doing exactly the right thing and looks
    // identical to a stall from out here. The harness's own supervisor resorts to
    // regular expressions over journal prose to tell them apart. DUM will not — an
    // empty list here means "the harness has not told me", and rules that need it
    // degrade to doing nothing rather than to guessing.
    refusals: Array.isArray(s.refusals) ? s.refusals : [],
    waiting_on: s.waiting_on ?? null,
    depth: 'status',
  };
}
