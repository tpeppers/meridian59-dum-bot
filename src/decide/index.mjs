// THE TWO TABLES, ASSEMBLED — and the ordering argument, which is the whole design.
//
// ORDER IS URGENCY, exactly as it is in the keeper's own pass(). The difference is
// where DUM's table STARTS. The keeper's runs:
//
//   0 identity   am I still who the server thinks I am
//   1 mortality  am I dead, and can I get out of the Underworld
//   2 survival   is something hitting me, and should I be somewhere else
//   3 recovery   am I hurt and safe enough to sit down
//   4 work       what am I actually here to do
//
// DUM's table begins at 4 and has no rules above it, on purpose. Those decisions run at
// one second and DUM ticks at thirty; a survival rule here would be acting on
// information that is on average fifteen seconds old, against a keeper that has better
// information and is already acting on it. Claiming them would not make the character
// safer, it would make it slower.
//
// That is the carve-out in one sentence: THE KEEPER KEEPS THE CLOCK-BOUND DECISIONS
// AND DUM TAKES THE DIRECTIONAL ONES.

import { RuleSet, respectCommitment } from './engine.mjs';
import { ladderRules } from './rules/ladder.mjs';
import { escalateRules } from './rules/escalate.mjs';
import { economyRules } from './rules/economy.mjs';
import { placementRules, placementFleetRules } from './rules/placement.mjs';
import { partyFleetRules } from './rules/party.mjs';

const isFleet = r => r.scope === 'fleet';

/**
 * One character, one tick.
 *
 * `respect-commitment` is first and unconditional. Everything below it assumes the
 * character is available to be redirected, and a character the fleet is already using
 * for something is not — taking one half of a two-character operation abandons the
 * other half silently.
 */
export const characterRules = new RuleSet('character', [
  respectCommitment,
  // Escalation before work: a character that is stuck or has outgrown its prey should
  // be reported before DUM decides what its orders ought to be, because the answer to
  // "what should it be doing" is unreliable while the answer to "is it doing anything"
  // is no.
  ...escalateRules.filter(r => !isFleet(r)),
  // The ladder is the directional decision. Everything after it is a refinement of the
  // orders it produced.
  ...ladderRules.filter(r => !isFleet(r)),
  ...placementRules.filter(r => !isFleet(r)),
  ...economyRules.filter(r => !isFleet(r)),
]);

/**
 * The whole fleet, one tick. Slower, and every rule here stops keepers and walks
 * characters across the world, so the cadence default is five minutes rather than
 * thirty seconds.
 */
export const fleetRules = new RuleSet('fleet', [
  ...partyFleetRules,
  ...placementFleetRules,
  ...economyRules.filter(isFleet),
  ...escalateRules.filter(isFleet),
]);

export { decide } from './engine.mjs';
