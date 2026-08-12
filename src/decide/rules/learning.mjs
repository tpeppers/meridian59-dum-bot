import { STRATEGY_IDS, strategyRows, strategySettings } from '../../strategies/catalog.mjs';

// Learning is a fleet errand, not a keeper policy. The harness owns the expensive part:
// it refreshes PlayerCanLearn, funds the exact fixed price, routes to a catalogued teacher,
// buys one ability, verifies the new ability list, and restores the keeper. DUM contributes
// only the slow-clock decision: whether this quiet character should start that errand now.
export const learningFleetRules = [{
  id: 'auto-level-next-planned-school',
  scope: 'fleet',
  faculty: 'economy',
  why: 'the first unfinished compendium learning-queue level has an ability available now',
  enabled: doctrine => doctrine.strategies?.enabled === true,
  offWhy: 'DUM strategies are disabled',
  decide(observation, doctrine) {
    const candidates = [];
    for (const row of strategyRows(observation, doctrine, STRATEGY_IDS.AUTO_LEVEL_PLANNED)) {
      // A bot claim is takeable ownership and a partner is a standing arrangement; an
      // active drive/errand, a parked update, or a human pilot is not "convenient".
      const commitment = row.commitment;
      if (commitment?.kind && commitment.takeable !== true && commitment.kind !== 'partner') continue;
      if (row.parked || row.piloted || (row.health?.pct != null && row.health.pct < 0.8)) continue;
      const next = row.learning?.planned?.next;
      if (!next?.expected_buyable) continue;
      const active = Array.isArray(row.learning?.planned?.active)
        ? row.learning.planned.active : [];
      candidates.push({ agent: row.agent, character: row.character, next,
        active_stage: row.learning?.planned?.active_stage ?? null,
        remaining_current: active.length });
    }
    if (!candidates.length) return {
      kind: 'pass',
      why: 'no selected, uncommitted character has a buyable ability in its first unfinished learning-queue level',
    };

    // Breadth first across the selected fleet. Without this ordering, stable roster
    // order makes the first two characters buy every level before the third character
    // buys anything. Prefer the lowest queue stage, then the units with the most work
    // remaining in that stage, so level 2 spreads fleet-wide before level 3 advances.
    candidates.sort((a, b) =>
      (a.active_stage ?? Number.MAX_SAFE_INTEGER) -
        (b.active_stage ?? Number.MAX_SAFE_INTEGER) ||
      b.remaining_current - a.remaining_current ||
      String(a.agent).localeCompare(String(b.agent)));
    const limit = strategySettings(observation, doctrine, candidates[0].agent,
      STRATEGY_IDS.AUTO_LEVEL_PLANNED).max_parallel;
    const selected = candidates.slice(0, limit);
    return {
      kind: 'act',
      plan: selected.map(row => ({ do: 'buy-next-planned', agent: row.agent })),
      why: `start ${selected.length} planned-learning errand(s); each buys one ability and rechecks before the next`,
      evidence: { selected, waiting_ready: candidates.length - selected.length },
    };
  },
}];
