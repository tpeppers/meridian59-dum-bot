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
/**
 * ONE DECISION PER CHARACTER, WHICH IS NOT THE SAME AS ONE DECISION PER PASS.
 *
 * The header above states the invariant: "at most one directional decision PER CHARACTER,
 * because a bot that emits three orders at once has no way to attribute what happened next
 * to any of them." For CHARACTER rules those are the same sentence -- the table runs once
 * per character, so first-match-wins delivers it exactly.
 *
 * FOR FLEET RULES THEY ARE DIFFERENT, and the difference cost this fleet a night. A fleet
 * rule names its own characters, so two of them acting on DISJOINT characters satisfy the
 * invariant completely -- and the table stopped anyway. Measured 2026-09-09: `hunt-shift`
 * fired on 78 of 78 fleet passes because there is always somebody to station, and every
 * rule below it went unevaluated for the whole day. Among them the entire fuel model:
 * `feast-hall-larder` and the sell circuit, both switched on in the doctrine, neither ever
 * reached. Eighteen of twenty characters ran out of food while the rules that exist to feed
 * them were structurally unreachable.
 *
 * This file already fixed one instance of that failure -- a rule whose every field was
 * yielded "still won the match, and still stopped the table" -- by teaching it to `pass`.
 * That fix was per-rule. This is the general form.
 *
 * `max` IS A TRAFFIC CONTROL, NOT A CORRECTNESS BOUND. Correctness is the disjointness test:
 * a rule is skipped when it wants a character an earlier rule this pass already took. The
 * cap exists because the world has thin corridors, and twenty characters dispatched down the
 * same needle in one tick is a jam. Operator, 2026-09-09: "we don't want the bots crowding
 * in thin travel needles and creating traffic jams, but running everyone on the same tracks
 * offset by maybe 30s each or so shouldn't be a problem." DUM ticks at thirty seconds, so a
 * small cap IS that stagger -- successive passes hand out the next few slots.
 *
 * `max: 1` reproduces the old behaviour exactly, and is the default, so nothing changes for
 * a doctrine that does not ask.
 */
export function decide(ruleSet, obs, doctrine, { max = 1, agentsOf = intentAgents } = {}) {
  const considered = [];
  const yieldSet = new Set(doctrine.yield_to ?? []);
  const fired = [];
  const taken = new Set();
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
      // WHAT THIS DECISION LEARNED, for the handful of decisions that cannot be re-derived
      // from the next board. `{topic, patch}`, written by the tick and only when the intent
      // actually acted — see the note there. Rules stay pure: this is the same shape they
      // already RECEIVE on `observation.memory`, handed back out rather than written.
      remember: out.remember ?? null,
      why: out.why ?? rule.why,
      evidence: out.evidence ?? {},
    };
    // A RULE THAT ONLY WANTS FIELDS IT HAS BEEN TOLD IT DOES NOT OWN MUST NOT TAKE THE
    // TURN — AND THIS IS THE FAILURE THAT WEDGED THE WHOLE TABLE FOR TWO DAYS.
    //
    // `yield_to` names fields something else writes. `planOrders` honours it correctly: it
    // drops them, finds nothing left to send, and says so. But the SENDING half is not
    // where first-match-wins is decided. A rule whose entire remaining want is yielded
    // still returned an intent, still won the match, and still stopped the table — and
    // because nothing was ever sent, the drift it was correcting never cleared, so it
    // fired again on the next tick, and the next, for ever.
    //
    // Measured on prod: `keeper-parity.jsonc` yields `max_carry`, `economy-thresholds`
    // wants `max_carry: 14`, the keeper has 50 and always will. That one field produced
    // 6,126 intents in a day and ZERO calls, while `ladder` and `placement` — the rules
    // directly below it, the ones that decide what the fleet is actually for — produced no
    // intents at all for two days, with DUM holding work and movement on twenty-one
    // characters the whole time.
    //
    // `pass` is the mechanism that already exists for exactly this: explain yourself
    // without taking the turn. So the reason goes into `considered` and every rule below
    // gets its turn. Note this is NOT the same as dropping the field — the rule keeps its
    // opinion, and the moment it wants something it does own, it fires normally.
    //
    // Only `orders` intents are filtered. A `report` carries no fields to write, and a
    // fleet `plan` is a list of calls rather than a policy diff; neither is yieldable.
    if (intent.kind === 'orders' && !intent.plan) {
      const fields = Object.keys(intent.orders)
        .filter(k => !['action', 'why', 'batch', 'agent'].includes(k));
      const yielded = fields.filter(k => yieldSet.has(k));
      if (yielded.length && yielded.length === fields.length) {
        considered.push({ rule: rule.id, verdict: 'no',
          why: `everything it wants to set (${yielded.join(', ')}) is yielded to another ` +
               `writer, so this rule can never make it true — passing rather than taking ` +
               `the turn, which would starve every rule below it for ever` });
        continue;
      }
    }
    // THE DISJOINTNESS TEST -- the thing that actually preserves the invariant.
    //
    // A second intent this pass is safe only if it touches nobody an earlier one took.
    // An intent whose reach cannot be read names nobody, and "nobody" would make it
    // compatible with everything -- the dangerous direction, since a fleet-wide policy
    // write would then run beside a rule steering the same bodies. So it is treated as
    // EXCLUSIVE: skipped for this pass, and taken on a pass where it fires first. Later
    // rules whose reach IS readable still get their turn, because punishing them for an
    // unrelated rule's opacity would be the starvation this change exists to end.
    const wants = agentsOf(intent);
    if (fired.length) {
      const clash = [...wants].filter(a => taken.has(a));
      if (!wants.size || clash.length) {
        considered.push({ rule: rule.id, verdict: 'no',
          why: clash.length
            ? `would also steer ${clash.join(', ')}, already decided this pass by ` +
              `"${fired[fired.length - 1].rule}" — one decision per character, so this waits ` +
              `for the next tick`
            : 'names no character this side can read, so it is treated as exclusive — it ' +
              'waits for a pass where it fires first rather than running beside another ' +
              'decision whose characters might overlap it' });
        continue;
      }
    }
    considered.push({ rule: rule.id, verdict: 'fired', why: intent.why });
    fired.push(intent);
    for (const a of agentsOf(intent)) taken.add(a);
    if (fired.length >= max) break;
  }
  return { intent: fired[0] ?? null, intents: fired, considered };
}

/**
 * Which characters an intent would touch, for the disjointness test above.
 *
 * Deliberately generous: an intent whose reach cannot be read returns the empty set and is
 * therefore treated as touching NOBODY, which would let it run beside anything. That is the
 * wrong default here, so `decide` counts an unreadable intent as exclusive instead -- see
 * the `max` guard. Kept in this file rather than imported from loop/ because engine.mjs is
 * pure and must stay importable by the tests without dragging the tick in.
 */
export function intentAgents(intent) {
  const out = new Set();
  if (!intent) return out;
  if (intent.agent) out.add(intent.agent);
  if (intent.orders?.agent) out.add(intent.orders.agent);
  for (const step of (intent.plan ?? [])) {
    if (step?.agent) out.add(step.agent);
    if (step?.args?.agent) out.add(step.args.agent);
    if (step?.from) out.add(step.from);
    if (step?.to) out.add(step.to);
  }
  return out;
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
// IS THIS CHARACTER FREE TO BE GIVEN ORDERS?
//
// ASK THIS, NEVER `!row.commitment`. The harness's own note is explicit: consumers ask
// `isTakeable(committed)`, because a bot CLAIM is ownership rather than an operation and
// is marked `takeable: true` with "nothing is mid-flight" spelled out in its detail. DUM
// claims every character it steers, so a rule testing the field for truthiness blocks on
// DUM's own claim and can never act on anybody — it reports the whole fleet as busy while
// nothing is happening, which reads as "the retarget landed" when it has not started.
//
// `partner` is a standing arrangement rather than a journey: it does not block a change
// of orders, only a relocation, and the rules that relocate check it themselves.
export const takeable = row => {
  const c = row?.commitment;
  if (!c || !c.kind) return true;
  return c.takeable === true || c.kind === 'partner';
};

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
