// NORMALISED OBSERVATIONS, HAND-WRITTEN.
//
// These are the shape `src/sense/normalize.mjs` produces, not the shape the harness
// returns. That is the whole reason normalize.mjs exists: a harness response change
// breaks one file loudly instead of making four rules quietly stop firing, and the rule
// tests do not have to be rewritten every time something upstream is renamed.
//
// Each fixture is a SITUATION with a name, because the tests read better as "a character
// that has just died" than as "obs3".

/** A healthy character mid-grind, with a keeper on defaults. */
export const working = () => ({
  at: 1_700_000_000_000,
  agent: 'role-a',
  character: 'ROLE-A',
  in_game: true,
  level: 12,
  health: { value: 27, max: 30, pct: 0.9 },
  vigor: { value: 160, max: 200, pct: 0.8 },
  mana: { value: 18, max: 20, pct: 0.9 },
  max_health: 30,
  room: 71,
  room_name: 'a hunting room',
  safe_spot: { room: 71, col: 12, row: 8, works: true },
  keeper: {
    running: true,
    mode: 'farm',
    inert: null,
    parked: null,
    policy: {
      hunt: 'giant rat', strategy: 'baseline', assignedRoom: 71, partner: null,
      restBelow: 0.7, fleeBelow: 0.4, maxCarry: 14, bankAbove: 500,
      roam: false, useSafeSpots: true, holdResumeAbove: 0.9,
    },
    tally: { kills: 41, deaths: 2 },
    journal: [],
  },
  commitment: null,
  stalled: null,
  refusals: [],
  waiting_on: null,
  // Deepened: this observation was paid for with a `status` call, so it carries the
  // keeper's policy and an order may be diffed against it. A board-only observation
  // has depth 'board' and policy null — see tests/test-act.mjs.
  depth: 'status',
});

/** The same character, freshly killed and back below the first rung. */
export const setBack = () => {
  const o = working();
  o.max_health = 22;
  o.health = { value: 8, max: 22, pct: 8 / 22 };
  o.keeper.tally = { kills: 41, deaths: 3 };
  return o;
};

/** A character the fleet is already using: halfway through a signet errand. */
export const onErrand = () => {
  const o = working();
  o.commitment = {
    kind: 'errand',
    label: 'signet: an owner, a town',
    since: 1_699_999_000_000,
    detail: 'dispatched by the fleet; taking it abandons the other end',
  };
  return o;
};

/** A character reporting a stall, with no machine-readable reason. */
export const stalledOpaque = () => {
  const o = working();
  o.stalled = { why: 'no progress in 6 passes' };
  o.keeper.journal = [
    { at: 1, note: 'refusing to fight here', why: 'no safe wall found in this room' },
  ];
  return o;
};

/** The same stall, with the structured field the harness does not yet emit. */
export const stalledStructured = () => {
  const o = stalledOpaque();
  o.refusals = [{
    code: 'NO_SAFE_WALL', faculty: 'work', blocking: true,
    why: 'no wall in this room held under test',
    remedy: 'assign a different room; the keeper relocates itself',
    retry_after_ms: 600_000,
  }];
  return o;
};

/** A fleet board with four characters, two of them mutually paired. */
export const fleet = () => ({
  at: 1_700_000_000_000,
  source: 'fleet',
  in_game: 4,
  stalled: 0,
  parking: 0,
  characters: [
    { agent: 'role-a', in_game: true, level: 30, partner: 'role-b', commitment: null, stalled: null, parked: null },
    { agent: 'role-b', in_game: true, level: 28, partner: 'role-a', commitment: null, stalled: null, parked: null },
    { agent: 'role-c', in_game: true, level: 22, partner: null, commitment: null, stalled: null, parked: null },
    { agent: 'role-d', in_game: true, level: 19, partner: null, commitment: null, stalled: null, parked: null },
  ],
});

/** A doctrine that claims work/economy/movement and has a two-rung ladder. */
export const doctrine = (patch = {}) => {
  const base = {
    fleet: 'test',
    name: 'a test doctrine',
    claim: {
      identity: 'keeper', mortality: 'keeper', survival: 'keeper', recovery: 'keeper',
      work: 'bot', movement: 'bot', economy: 'bot', social: 'keeper',
      i_accept_the_character_may_die: false, lease_ms: 120_000,
    },
    goals: {
      ladder: [
        { id: 'to-30', until: { kind: 'max_health', at_least: 30 },
          orders: { mode: 'farm', strategy: 'wellfed' }, why: 'margin before speed' },
        { id: 'to-60', until: { kind: 'max_health', at_least: 60 },
          orders: { mode: 'farm', strategy: 'trader' }, why: 'the starter prey stops paying' },
      ],
      on_complete: 'report',
    },
    prey: { choose: false, graduate_margin: 0, max_threat_over: 6 },
    placement: { spread: false, rooms: [], per_room: 2 },
    economy: { bank_above: null, walking_money: null, max_carry: null, sell_loot: null,
               concentration_report_at: null },
    party: { pair: false, keep_working_pairs: true },
    escalate: { unstick: false, stall_ticks: 4 },
  };
  return deepMerge(base, patch);
};

function deepMerge(a, b) {
  const out = structuredClone(a);
  for (const [k, v] of Object.entries(b)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object')
      ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}
