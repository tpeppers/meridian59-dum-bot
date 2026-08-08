// DECIDE CHEAP, CONFIRM EXPENSIVE.
//
// This is the most consequential thing in the repository and it was got wrong first
// time round. The two reads a bot lives on cost wildly different amounts, and the
// difference is not visible in their signatures:
//
//   `fleet`   sends NOTHING to the game server. It reads the client's cached world and
//             each keeper's in-memory status. One call, N characters, free.
//
//   `status`  sends FOUR requests per character — stats(1), stats(2), the spell list,
//             the skill list — through the pacer, plus a settle. For twenty-one
//             characters that is eighty-four requests every tick.
//
// The harness says the same thing in its own words: DECIDING IS FREE, ASKING IS NOT.
// Asking is not passive either — a room-contents resync counts as an action and calls
// NotifyMonstersOfPresence, which is why the keeper forbids it while playing dead. A
// bot polling every character every tick would be announcing twenty-one characters,
// repeatedly, in rooms whose entire value is that nothing attacks until you swing.
//
// So the tick is two phases:
//
//   1. decide from the board. Free. Most ticks end here, because most of what a
//      directional bot concludes is "leave this alone".
//   2. only if that produced an ORDER — something that has to be diffed against the
//      keeper's live policy, which is not on the board — pay for `status` and decide
//      again on the fuller observation.
//
// Re-deciding is free: rules are pure. And the second decision may legitimately differ
// from the first — that is the point, not a bug. A rule that could not see the keeper's
// policy may find on the second pass that the keeper already has these orders.

import { normalizeFleetRow, normalizeStatus } from './normalize.mjs';

/**
 * The whole-fleet observation. One call, and it costs the game server nothing.
 * @param {import('../link/broker.mjs').Broker} broker
 * @param {object} [opts]
 * @param {number} [opts.now] injected clock — see CLAUDE.md, decide/ must be pure
 */
export async function observeFleet(broker, { now = Date.now() } = {}) {
  const raw = await broker.call('fleet', {});
  const rows = (raw.fleet ?? []).map(normalizeFleetRow);
  return {
    at: now,
    source: 'fleet',
    characters: rows,
    in_game: rows.filter(r => r.in_game).length,
    stalled: rows.filter(r => r.stalled).length,
    // PARKING STANDS THE WHOLE TICK DOWN. A parked keeper is running and deliberately
    // doing nothing, which is exactly what a supervising loop is built to notice and
    // "fix" — and fixing it clears the parking flag and sends the character back to
    // work in the minute before the broker goes down. The harness's own supervisor
    // stands its whole round down for one parked character; so does this.
    parking: rows.filter(r => r.parked).length,
    depth: 'board',
  };
}

/** The free half: one character's observation, taken from the board row. */
export function observeFromBoard(row, { now = Date.now() } = {}) {
  return { ...row, at: now };
}

/**
 * The paid half. Four server requests, so this is called only when a decision cannot be
 * made without the keeper's policy — and the caller is expected to have a reason.
 *
 * @param {import('../link/broker.mjs').Broker} broker
 * @param {object} base   the board-derived observation to merge onto
 * @param {string[]} [extras]  further reads a rule declared it needs
 */
export async function deepen(broker, base, extras = [], { now = Date.now() } = {}) {
  const agent = base.agent;
  const status = await broker.call('status', { agent, brief: true });
  const obs = normalizeStatus(base, status, { now });

  // The declared extras, each fetched at most once. Declaring them is how the tick
  // stays one round-trip per FACT rather than one per rule.
  for (const want of new Set(extras)) {
    if (want === 'policy') continue;                 // that is what `status` was for
    if (!EXTRA_READS[want]) continue;
    obs[want] = await broker.call(EXTRA_READS[want], { agent }).catch(e => ({ error: e.message }));
  }
  return obs;
}

// Which harness call answers each declared need. Kept as data so that a rule declaring
// something nobody can fetch is visible here rather than failing silently at run time.
const EXTRA_READS = {
  progress: 'progress',
  inventory: 'inventory',
  prey: 'prey',
  bank: 'bank',
};

export { EXTRA_READS };
