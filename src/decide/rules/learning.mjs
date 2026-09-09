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
    // Named rather than silently skipped: "ready to learn and cannot pay" is a fleet fact
    // an operator can act on, and it is invisible everywhere else on the board.
    const unfunded = [];
    for (const row of strategyRows(observation, doctrine, STRATEGY_IDS.AUTO_LEVEL_PLANNED)) {
      // A bot claim is takeable ownership and a partner is a standing arrangement; an
      // active drive/errand, a parked update, or a human pilot is not "convenient".
      const commitment = row.commitment;
      if (commitment?.kind && commitment.takeable !== true && commitment.kind !== 'partner') continue;
      if (row.parked || row.piloted || (row.health?.pct != null && row.health.pct < 0.8)) continue;
      const next = row.learning?.planned?.next;
      if (!next?.expected_buyable) continue;

      // AND IT HAS TO BE ABLE TO PAY, WHICH `expected_buyable` DOES NOT MEAN.
      //
      // `expected_buyable` is PlayerCanLearn plus "the character does not hold it yet"
      // (monster.kod:4855-4862) — a statement about EARNING the ability, with nothing at
      // all about money. Without this gate DUM walks a character from the valley to Cor
      // Noth, stands it in front of Rook, finds it cannot pay, and walks it home; the
      // character is then uncommitted and ready again, so the same errand starts on the
      // next pass, for ever.
      //
      // That loop is not merely wasteful, it is a STARVER: this rule sits above food and
      // weapon maintenance, and a fleet rule that always has something to say stops every
      // rule below it from ever running. The table's own comment above `feastFleetRules`
      // records the last time that happened and what it cost.
      //
      // Measured 2026-09-08: two characters were both ready to learn all three level-3
      // proficiencies at 2000 each and were carrying 800 and 780.
      //
      // The two purses must NOT be summed in general — `purse` is lost on death and
      // `banked` is not — but this is the one question where their sum is the right
      // number, because the errand's first step is a bank withdrawal when it is short.
      // `banked: null` means nobody has seen this character at a counter, which is not a
      // balance of zero; an unknown bank is treated as empty here on purpose, because
      // sending a character to spend money nobody has ever seen is the loop above.
      const price = Number(next.price);
      const funds = Number(row.purse ?? 0) + Number(row.banked ?? 0);
      if (Number.isFinite(price) && funds < price) { unfunded.push({
        agent: row.agent, character: row.character, name: next.name, price, funds }); continue; }
      const active = Array.isArray(row.learning?.planned?.active)
        ? row.learning.planned.active : [];
      candidates.push({ agent: row.agent, character: row.character, next,
        active_stage: row.learning?.planned?.active_stage ?? null,
        remaining_current: active.length });
    }
    if (!candidates.length) return {
      kind: 'pass',
      why: 'no selected, uncommitted character has a buyable ability in its first unfinished learning-queue level' +
        (unfunded.length ? ` (${unfunded.length} ready but short of the price: ` +
          unfunded.slice(0, 4).map(u => `${u.character} needs ${u.price - u.funds} more for ${u.name}`)
            .join('; ') + ')' : ''),
      evidence: { unfunded },
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
