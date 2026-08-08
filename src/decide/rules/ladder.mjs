// THE LADDER: what this character is trying to become, as an ordered list of rungs.
//
// This is the rule that most directly replaces a model. Asked "what should this
// character be doing", an LLM produces a sentence; a ladder produces the same answer
// from the same numbers every time, and the answer is checkable.
//
// The shape is deliberately narrow. A rung is:
//
//   { id:     'survive-to-30',
//     until:  { kind: 'max_health', at_least: 30 },
//     orders: { mode: 'farm', strategy: 'wellfed', purpose: 'advance' },
//     why:    'below 30 max health the valley kills a character faster than it pays' }
//
// The FIRST rung whose `until` is not yet met is the active one. That ordering matters
// more than it looks: it makes the ladder self-healing. A character that dies back
// below a threshold falls back to the earlier rung automatically, with no state kept
// anywhere, because the ladder is a pure function of the character's current numbers.
// Nothing has to remember where it was, and nothing can disagree about it after a
// restart.
//
// WHY EVERY RUNG NEEDS AN `until`, enforced in schema.mjs: a rung with no completion
// test never completes, so the character farms it for ever while the board reports
// steady progress. That is the same failure the harness records for prey — a keeper
// grinding worthless creatures kills something every pass, so the stall detector never
// trips and the board reads healthy for as long as you leave it.

/**
 * Is a rung's completion test met by this observation?
 * Returns null when the observation cannot answer, which is NOT the same as false —
 * a rung whose evidence is missing must not be treated as incomplete and re-ordered.
 */
export function criterionMet(until, obs) {
  const at = Number(until.at_least);
  switch (until.kind) {
    case 'max_health': {
      const v = obs.max_health ?? obs.health?.max ?? null;
      return v === null ? null : v >= at;
    }
    case 'level': {
      const v = obs.level ?? null;
      return v === null ? null : v >= at;
    }
    case 'kills': {
      const v = obs.keeper?.tally?.kills ?? null;
      // A KEEPER RESTART RESETS THIS. The harness says so itself: the tally is rebuilt
      // with the keeper, so on a fleet whose keepers are restarted constantly the total
      // mostly measures uptime. A `kills` rung is therefore a poor completion test and
      // is supported only because a doctrine may want it for a short errand.
      return v === null ? null : v >= at;
    }
    case 'shillings_banked': {
      const v = obs.bank?.balance ?? obs.progress?.banked ?? null;
      return v === null ? null : v >= at;
    }
    case 'skill':
    case 'spell': {
      const list = obs.progress?.[until.kind === 'skill' ? 'skills' : 'spells'];
      if (!Array.isArray(list)) return null;
      const row = list.find(x => String(x.name ?? '').toLowerCase() === String(until.name ?? '').toLowerCase());
      if (!row) return null;
      const v = Number(row.ability ?? row.percent ?? row.value);
      return Number.isFinite(v) ? v >= at : null;
    }
    default:
      return null;
  }
}

/**
 * Which rung is active, and why. Exported separately from the rule because `plan` and
 * `explain` both want to show the whole ladder with each rung's verdict, not just the
 * one that won.
 */
export function evaluateLadder(ladder, obs) {
  const rows = ladder.map(rung => ({
    id: rung.id,
    met: criterionMet(rung.until, obs),
    until: rung.until,
    why: rung.why,
  }));
  // Unanswerable rungs are reported and SKIPPED, not treated as incomplete. Treating
  // "the harness did not tell me this character's skill" as "the skill is low" would
  // park a character on a training rung it may have finished weeks ago.
  const active = ladder.find((_, i) => rows[i].met === false) ?? null;
  const unanswerable = rows.filter(r => r.met === null);
  return { rows, active, unanswerable, complete: !active && !unanswerable.length };
}

export const ladderRules = [
  {
    id: 'ladder-active-rung',
    faculty: 'work',
    why: 'the first ladder rung this character has not finished decides what it is doing',
    needs: doctrine => doctrine.goals?.ladder?.some(r => ['skill', 'spell'].includes(r.until?.kind))
      ? ['progress'] : [],
    enabled: doctrine => (doctrine.goals?.ladder?.length ?? 0) > 0,
    offWhy: 'goals.ladder is empty, so DUM has no opinion about what this character is for',
    decide(obs, doctrine) {
      const { active, unanswerable, complete } = evaluateLadder(doctrine.goals.ladder, obs);

      if (complete) {
        const on = doctrine.goals.on_complete ?? 'hold';
        if (on === 'hold') return null;
        if (on === 'idle') return {
          kind: 'orders',
          orders: { action: 'start', mode: 'idle' },
          why: 'every ladder rung is met and the doctrine says to stand down when finished',
          evidence: { ladder: 'complete' },
        };
        return {
          kind: 'report',
          why: 'every ladder rung is met — this character has outgrown its doctrine and ' +
               'needs a new one, which is an operator decision and not one DUM invents',
          evidence: { ladder: 'complete' },
        };
      }

      if (!active) {
        // Nothing is incomplete but something is unanswerable: say so rather than
        // acting. A rule that cannot see its evidence must do nothing, loudly.
        return {
          kind: 'report',
          why: `cannot tell which rung is active: ${unanswerable.map(r => r.id).join(', ')} ` +
               `cannot be evaluated from what the harness reported`,
          evidence: { unanswerable: unanswerable.map(r => r.id) },
        };
      }

      // WHAT MAKES THIS A NO-OP MOST OF THE TIME. The rung's orders are the DESIRED
      // state; act/orders.mjs diffs them against what the keeper already has and sends
      // nothing when they agree. Re-asserting the same policy every tick would land in
      // the roster, pin values that would otherwise track the harness's defaults, and
      // fill the board with writes that changed nothing.
      return {
        kind: 'orders',
        orders: { action: 'start', ...(active.orders ?? {}) },
        why: `rung "${active.id}" is the first not met — ${active.why}`,
        evidence: {
          rung: active.id,
          until: active.until,
          max_health: obs.max_health ?? null,
          level: obs.level ?? null,
        },
      };
    },
  },
];
