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
import { crateFleetRules } from './rules/crate.mjs';
import { shiftFleetRules } from './rules/shift.mjs';
import { swarmFleetRules } from './rules/swarm.mjs';
import { graveyardFleetRules } from './rules/graveyard.mjs';
import { mootFleetRules } from './rules/moot.mjs';
import { weaponFleetRules } from './rules/weapons.mjs';
import { foodFleetRules } from './rules/food.mjs';
import { castleVictoriaFleetRules } from './rules/castle-victoria.mjs';
import { factionCharacterRules, factionActiveFleetRules, factionRequestFleetRules,
  loyaltyFleetRules } from './rules/factions.mjs';
import { factionGameFleetRules } from './rules/faction-games.mjs';
import { learningFleetRules } from './rules/learning.mjs';

const isFleet = r => r.scope === 'fleet';

/**
 * One character, one tick.
 *
 * `respect-commitment` is first. Everything below it assumes the character is available
 * to be redirected, and a character the fleet is already using for a non-takeable
 * operation is not — taking one half of a two-character operation abandons the other
 * half silently. A takeable bot claim is ownership, not an operation, and passes through.
 */
export const characterRules = new RuleSet('character', [
  respectCommitment,
  // A one-hour server quest outranks the indefinite advancement ladder. The rule is a
  // no-op without a durable Set Faction goal and restores the prior hunt on completion.
  ...factionCharacterRules,
  // Escalation before work: a character that is stuck or has outgrown its prey should
  // be reported before DUM decides what its orders ought to be, because the answer to
  // "what should it be doing" is unreliable while the answer to "is it doing anything"
  // is no.
  ...escalateRules.filter(r => !isFleet(r)),
  // Strategy-backed policy maintenance returns null once the keeper agrees, so it can
  // run ahead of the ladder without starving ordinary work decisions.
  ...economyRules.filter(r => !isFleet(r)),
  // The ladder is the directional decision. Everything after it is a refinement of the
  // orders it produced.
  ...ladderRules.filter(r => !isFleet(r)),
  ...placementRules.filter(r => !isFleet(r)),
]);

/**
 * The whole fleet, one tick. Slower, and every rule here stops keepers and walks
 * characters across the world, so the cadence default is five minutes rather than
 * thirty seconds.
 */
export const fleetRules = new RuleSet('fleet', [
  // FIRST, AND THE ORDERING ARGUMENT IS NOT "IT MATTERS MOST". It is the only rule in
  // this table gated on a WINDOW THAT CLOSES. Everything below it is a standing
  // condition — an unpaired character is just as unpaired in five minutes, a stalled one
  // just as stalled — so being deferred costs those rules a tick and costs this one an
  // item somebody else on a shared server can take in the meantime. It is also by far
  // the rarest to fire: it needs a quorum in one castle and a probe interval to have
  // elapsed, so putting it below a rule that can fire on any tick would starve it
  // without ever looking wrong.
  // ABOVE EVERYTHING, AND FOR THE OPPOSITE REASON TO THE CRATE. The crate is first
  // because its window closes; the swarm is first because a HUMAN IS WAITING. Every rule
  // below re-tasks, re-places or re-pairs a character on its own schedule, and any of
  // them firing while an operator is leading pulls a follower out of the swarm and sends
  // it somewhere the operator did not go. With `swarm.follow` off — the ordinary case —
  // both rules return `pass` on their first line and cost one comparison.
  ...swarmFleetRules,
  // IMMEDIATELY BELOW THE HUMAN, AND ABOVE EVERY OTHER PERISHABLE THING, BECAUSE THIS IS
  // THE ONE THAT CANNOT BE RE-EARNED CHEAPLY. A missed token is a token; a missed crate
  // is a crate; a missed loyalty deadline is the MEMBERSHIP, and getting it back means
  // the whole join quest over again — an item found rather than bought, plus another
  // trip, plus a liege that may refuse an outsider outright when the faction is strong.
  //
  // The window is four hours, so this is never urgent on any single tick; it is placed
  // high because what closes is irreplaceable, not because it is imminent. With no warned
  // member — the ordinary case for a fleet of neutrals — each of these rules finds an
  // empty list on its first line and costs one comparison.
  ...loyaltyFleetRules,
  // Explicit token-game PvP has a perishable target and therefore outranks standing
  // faction errands. The broker re-verifies the player before every engagement.
  ...factionGameFleetRules,
  // THE HUNTING SHIFT SITS WHERE THE CASTLE SHIFT DOES, and above the maintenance rules for
  // the same reason: it establishes the hands-off patrol policy that everything below then
  // maintains. It is `pass` on its first line when `crypt.shift` is off.
  ...shiftFleetRules,
  // A human-led swarm still wins. Once free, an ASSIGNED one-hour faction quest outranks
  // standing maintenance windows. Merely asking for a new assignment is below the farm
  // baseline: a stopped/rejoined character should resume useful work before it records
  // `mode: waiting` as the policy to restore after a long errand.
  ...factionActiveFleetRules,
  // The crate window closes and the strategy-selected checker is already in the castle.
  ...crateFleetRules,
  // Establish the hands-off patrol policy before its maintenance strategies try to
  // spend mana or hand over equipment. This is also the baseline a finite learning
  // errand returns to. It returns `pass` as soon as the policy agrees, so putting it
  // immediately above learning costs the queue one tick after a doctrine change and
  // prevents a long queue from starving a safety-critical room reassignment forever.
  ...castleVictoriaFleetRules,
  // Learning is finite and explicitly queued. Keep it above food/weapon maintenance,
  // which can remain true indefinitely, but below the patrol baseline it must restore.
  ...learningFleetRules,
  // A queued faction/soldier request has no closing window until it is spoken. Once the
  // patrol baseline is sound it can interrupt at the next natural break and restore a
  // real farming policy afterwards.
  ...factionRequestFleetRules,
  // An empty larder outranks equipment upgrades. Fleet rules are first-match-wins and
  // Create Weapon can remain true through many unlucky rolls; putting it first could
  // starve Create Food indefinitely. Food returns pass as soon as every selected unit
  // has a meal, so ordinary weapon work loses no useful cadence.
  ...foodFleetRules,
  ...weaponFleetRules,
  // BELOW THE SWARM, ABOVE EVERYTHING ELSE. A human at the controls outranks a schedule —
  // if an operator is leading, followers should not be pulled onto the night shift. But
  // the shift outranks placement, pairing and the ladder for the same reason the crate
  // does: its window CLOSES, and the rules below it are standing conditions that will be
  // just as true in five minutes.
  ...graveyardFleetRules,
  // BELOW THE SHIFT ON PURPOSE. A round trip to a counter is most of a 35-minute
  // window, so the shift decides first and this only fires for characters it has not
  // claimed — or for one so heavy it cannot pick up what it kills.
  // The moot yields to an open window on its own, so it sits below the shift and
  // above the standing rules — pooling is what the ~85 idle minutes in every 120 are
  // for, and it must not start while there is anything to farm.
  ...mootFleetRules,
  ...partyFleetRules,
  ...placementFleetRules,
  ...economyRules.filter(isFleet),
  ...escalateRules.filter(isFleet),
]);

export { decide } from './engine.mjs';
