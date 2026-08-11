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
    mana: vital(r.mana ?? r.mana_now),
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
    has_weapon: bool(r.has_weapon),
    wielding: str(r.wielding),
    provides: Array.isArray(r.provides) ? r.provides.map(String) : [],
    // The keeper's own commitment description: errand | driven | parked | partner.
    // The board calls it `committed`.
    commitment: r.committed ?? r.commitment ?? null,
    parked: r.parked ?? null,
    piloted: r.piloted ?? null,
    // `stalled` is either false, a string, or an object with a `why`. All three occur.
    stalled: (r.stalled && r.stalled !== false) ? r.stalled : null,
    // THE KEEPER'S OWN ORDERS, NOW FREE.
    //
    // This was the one field whose absence forced the expensive call. Any order has to be
    // diffed against the current policy or it is written every tick, and the only place to
    // read the policy was `status` — four server requests per character, 84 a tick for
    // twenty-one of them, to discover there was nothing to do. Harness recommendation 7
    // put it on the row; the row is built from the keeper's in-memory status and simply
    // dropped it.
    //
    // Absent on an older broker, and that is the case to keep working: `null` here means
    // "not answered", the deepen() path still exists, and a fleet on a broker that
    // predates the field behaves exactly as it did. It must never read as "no policy",
    // which would diff as "every field differs" and write orders to all of them.
    policy: r.policy ?? null,
    // Hoisted the same way the harness hoists it, because placement is asked about far
    // more often than the rest of the policy.
    assigned_room: num(r.assigned_room ?? r.policy?.assignedRoom),
    // WHY THIS CHARACTER IS NOT WORKING, AS DATA RATHER THAN AS PROSE.
    //
    // The reason `escalate.mjs` refuses to act on `doing`: matching sentences the harness
    // owns is a coupling that breaks silently when one is reworded, and the harness's own
    // supervisor had two such regexes, both written after a churn loop. These carry a
    // stable code instead. Empty array, never undefined — "this keeper reports no
    // refusals" and "this broker does not answer that question" must stay distinguishable.
    refusals: Array.isArray(r.refusals) ? r.refusals : [],
    waiting_on: r.waiting_on ?? null,
    // Who owns which half of this character. With nothing attached every entry is the
    // string 'keeper'.
    faculties: r.faculties ?? null,
    // ON THE BOARD NOW — harness recommendation 7 landed, and this is what it bought.
    //
    // `policy` used to be null here unconditionally, with a comment saying the diff could
    // not be made from the free read. That was true and is the thing that changed: the
    // fleet row carries the keeper's whole policy, so planOrders can diff without paying
    // four server requests per character to discover there is nothing to do.
    //
    // It stays NULL when the broker does not send it, and that is deliberate rather than
    // defensive: planOrders REFUSES to diff against a missing policy instead of treating
    // it as `{}`, because `{}` makes every field read as different and writes every
    // setting on every tick while reporting success. So an older broker degrades to the
    // deepen() path exactly as before, and a newer one skips it.
    keeper: { mode: str(r.autopilot?.mode ?? r.mode), running: r.autopilot?.running !== false,
              policy: r.policy ?? null,
              tally: { kills: num(r.autopilot?.kills) ?? 0 }, journal: [] },
    // Where this observation came from. `board` still means board — the depth is about
    // which CALL produced it, not about which fields happen to be present, and a rule
    // that declares it needs `progress` or `inventory` must still deepen for those.
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
      //
      // NEVER `?? {}` — AND THIS DEFAULTED TO `{}` AND CAUSED EXACTLY THAT.
      //
      // planOrders refuses to diff against a missing policy and says why: an empty object
      // makes every field read as different, so the bot writes every setting on every tick
      // and reports success each time. This line handed it an empty object instead of
      // nothing, which turned the refusal into the silent failure it exists to prevent.
      //
      // It showed up the moment the board began carrying the policy: `planOrders` called
      // directly on a board row returned `send: null` — correctly, nothing to do — while
      // the full tick sent all eight fields for all twenty-one characters, because
      // deepen() ran afterwards and replaced a good policy with `{}`. Both halves looked
      // right in isolation, which is why it survived the unit tests.
      //
      // So: the status's policy, else the one the board already gave us, else NOTHING and
      // let planOrders refuse.
      policy: keeper.policy ?? base.keeper?.policy ?? null,
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
