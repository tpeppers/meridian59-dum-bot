// THE RULE TABLE, AND THE THREE PROPERTIES THAT MAKE IT WORTH HAVING.
//
// PURE. Every rule is `(observation, doctrine) => Intent | null`. No clock, no
// randomness, no network. A rule that needs the time is handed it in the observation.
// This is not fastidiousness — it is what makes a decision reproducible from a single
// journal line six hours later, and it is the only reason the tests in tests/ can be
// fixtures rather than a live server.
//
// ORDERED, FIRST MATCH WINS. Exactly like the keeper's own pass(). One tick produces
// at most one directional decision per character, because a bot that emits three
// orders at once has no way to attribute what happened next to any of them.
//
// EVERY RULE CARRIES ITS REASON. The `why` is not a comment; it travels into the
// journal and into `plan` output, and it is the entire user interface for "the fleet
// is doing something strange." A rule without one does not load.
//
// WHAT IS DELIBERATELY ABSENT: any rule about being attacked, being hurt, or being
// dead. Those belong to the keeper, they run at one second, and DUM ticks at thirty.
// A DUM rule that fired on health would be making a survival decision on information
// that is on average fifteen seconds old.

/**
 * @typedef {object} Intent
 * @property {string} rule      which rule produced this
 * @property {string} faculty   which faculty it exercises — checked against the claim
 * @property {string} agent
 * @property {string} kind      'orders' | 'travel' | 'report' | 'none'
 * @property {object} orders    arguments for the harness call, when kind is a write
 * @property {object[]|null} plan fleet-level actions, when kind is 'act'
 * @property {string} why       human sentence, journalled
 * @property {object} evidence  the observation fields the rule actually read
 */

import { FACULTIES } from '../config/schema.mjs';

export class RuleSet {
  /**
   * @param {string} name
   * @param {Array<object>} rules ordered, first match wins
   */
  constructor(name, rules) {
    this.name = name;
    this.rules = rules;
    for (const r of rules) {
      if (!r.id) throw new Error(`${name}: a rule has no id`);
      if (!r.why) throw new Error(`${name}: rule "${r.id}" has no why. The why is what the ` +
                                  `journal shows when the fleet is doing something strange`);
      if (!FACULTIES.includes(r.faculty))
        throw new Error(`${name}: rule "${r.id}" claims faculty "${r.faculty}", which is not ` +
                        `one of ${FACULTIES.join(', ')}`);
      if (typeof r.decide !== 'function')
        throw new Error(`${name}: rule "${r.id}" has no decide()`);
    }
  }

  /** Every extra read this rule set may need, so the tick fetches each fact once. */
  needs(doctrine) {
    const wants = new Set();
    for (const r of this.rules) for (const w of (r.needs?.(doctrine) ?? [])) wants.add(w);
    return [...wants];
  }
}

/**
 * Run an ordered rule set against one observation.
 *
 * Returns BOTH the intent and the rules that were considered and declined, because
 * "nothing happened" is the answer a fleet gives most of the time and it is exactly
 * the answer that is impossible to debug without the trail. A silent bot and a wedged
 * bot look identical on a board.
 *
 * @returns {{intent: Intent|null, considered: {rule: string, verdict: string, why: string|null}[]}}
 */
export function decide(ruleSet, obs, doctrine) {
  const considered = [];
  for (const rule of ruleSet.rules) {
    // A rule may only exercise a faculty the doctrine actually claimed. This is the
    // enforcement point for the whole split: a doctrine that leaves `survival` with
    // the keeper cannot have a survival rule fire by accident, however it was written.
    const owner = doctrine.claim?.[rule.faculty];
    if (owner !== 'bot') {
      considered.push({ rule: rule.id, verdict: 'not-claimed',
                        why: `faculty "${rule.faculty}" is ${owner ?? 'unset'}, not bot` });
      continue;
    }
    if (rule.enabled && !rule.enabled(doctrine)) {
      considered.push({ rule: rule.id, verdict: 'off', why: rule.offWhy ?? 'disabled by doctrine' });
      continue;
    }
    let out;
    try {
      out = rule.decide(obs, doctrine);
    } catch (e) {
      // A THROWING RULE MUST NOT STOP THE TABLE. The consequence of one bad rule
      // should be that one decision is not made, not that every character below it in
      // the table is unattended.
      considered.push({ rule: rule.id, verdict: 'error', why: e.message });
      continue;
    }
    if (!out) {
      considered.push({ rule: rule.id, verdict: 'no', why: null });
      continue;
    }
    // A DECLINE THAT KNOWS WHY IT DECLINED.
    //
    // `return null` is the ordinary "not me", and it is right for a rule whose condition
    // simply is not met. It is wrong for one whose whole job is a clock nobody can read:
    // "the crate is not being checked" and "the crate was checked eleven minutes ago and
    // the next probe is in nineteen" are the same silence on a board and completely
    // different facts. `kind: 'pass'` carries the reason into `considered` WITHOUT
    // stopping the table, so every rule below it still runs — which is the difference
    // between explaining yourself and taking the turn.
    if (out.kind === 'pass') {
      considered.push({ rule: rule.id, verdict: 'no', why: out.why ?? null });
      continue;
    }
    const intent = {
      rule: rule.id,
      faculty: rule.faculty,
      // A FLEET RULE HAS NO `obs.agent`, AND SOME OF THEM PICK ONE. Pairing writes a
      // batch and names each side inside it; an errand picks a single character out of
      // the board and that character is who the journal, the backoff and the verifier
      // are about. Character rules never set `orders.agent`, so they are unaffected.
      agent: out.orders?.agent ?? obs.agent ?? null,
      kind: out.kind ?? 'orders',
      orders: out.orders ?? {},
      // Fleet rules describe several characters at once. Keeping that plan on the
      // intent is not presentation trivia: act/ is the boundary that validates and
      // executes it. The first implementation dropped this field here, then tried to
      // diff an empty order against a board observation and failed on agent=null.
      plan: Array.isArray(out.plan) ? out.plan : null,
      shortfalls: out.shortfalls ?? null,
      notes: out.notes ?? null,
      why: out.why ?? rule.why,
      evidence: out.evidence ?? {},
    };
    considered.push({ rule: rule.id, verdict: 'fired', why: intent.why });
    return { intent, considered };
  }
  return { intent: null, considered };
}

/**
 * A guard every rule set puts first: characters the fleet is already using for
 * something are not available to be redirected.
 *
 * This is not politeness. `supply` drives both ends of a trade, an errand walks a
 * character across the map, and a partner is standing in a field counting on it — so
 * taking one half of a multi-character operation abandons the other half, silently,
 * and the only symptom is somebody waiting for a partner that is now doing something
 * else. The harness publishes exactly this as `commitment`; DUM's job is to read it.
 */
export const respectCommitment = {
  id: 'respect-commitment',
  faculty: 'work',
  why: 'this character is already spoken for by the fleet, and taking one half of a ' +
       'multi-character operation abandons the other half silently',
  decide(obs) {
    const c = obs.commitment;
    if (!c || !c.kind) return null;
    // A bot claim is ownership, not an operation. The harness marks it `takeable: true`
    // and explicitly says nothing is mid-flight. Blocking on our own claim makes every
    // later strategy edit impossible to apply until the lease expires, even though DUM
    // is the process holding that lease. Claim acquisition still prevents one bot from
    // taking another bot's faculties; this guard only decides whether an order may be
    // considered.
    if (c.takeable === true) return null;
    // `partner` is the weakest of the four and is a standing arrangement rather than a
    // journey — it does not block a change of orders, only a relocation. The rules that
    // relocate check it themselves.
    if (c.kind === 'partner') return null;
    return {
      kind: 'none',
      why: `leaving ${obs.agent} alone: ${c.label ?? c.kind} — ${c.detail ?? 'the fleet is using it'}`,
      evidence: { commitment: c },
    };
  },
};
