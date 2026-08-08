// STUCK, OR DELIBERATELY WAITING? — the rule this repository exists to get right.
//
// The harness's supervisor restarts keepers that report no progress. It also has to
// avoid restarting the ones that are deliberately waiting, and the way it currently
// tells them apart is by running regular expressions over the keeper's own prose:
//
//     if (/no safe wall|refusing to fight/i.test(reason)) ...leave it alone
//     if (/needs \d+ to make one|resting for the mana|regain mana|unarmed —/i.test(reason))
//
// Both of those exist because of a recorded loop. A keeper that refuses to fight in a
// room with no safe wall records which rooms those are for the session; restarting it
// throws that record away, so the fresh keeper walks back in, re-probes, refuses again,
// and reports a stall again — once a minute, for ever, with every line of the log
// looking like the supervisor working. Eight characters were caught in it within a
// minute. The mana one is the same shape: an unarmed character sitting to accumulate
// the 15 mana that `create weapon` needs looks precisely like a stall, and restarting
// it restarts the decision rather than the wait, so the mana barely climbs.
//
// DUM DOES NOT REPRODUCE THAT REGEX, and this file's refusal to is the point. Matching
// on prose is a coupling to sentences, and the sentences are the harness's to change —
// the day one of them is reworded the fleet starts churning again and nothing says so.
//
// So the rule below is written against `status.refusals` and `status.waiting_on`,
// STRUCTURED FIELDS THE HARNESS DOES NOT YET EXPOSE. Until it does, this rule reports
// and never acts. That is a deliberate null result: DUM will not restart a keeper it
// cannot distinguish from one that is working, and the missing field is the single
// highest-value thing the harness could add for either bot.
//
// See docs/harness-contract.md §Gap 1 for the proposed shape.

export const escalateRules = [
  {
    id: 'stall-report-only',
    faculty: 'work',
    why: 'a keeper that reports being stuck may be deliberately waiting, and DUM cannot ' +
         'tell the difference from what the harness currently reports',
    enabled: doctrine => doctrine.escalate?.unstick === true,
    offWhy: 'escalate.unstick is off',
    decide(obs) {
      if (!obs.stalled) return null;

      // THE ONLY HONEST TEST AVAILABLE. If the harness told us structurally that this
      // is a refusal or a wait, believe it and leave the character alone.
      const refusal = (obs.refusals ?? []).find(r => r.faculty === 'work' || r.blocking);
      if (refusal) return {
        kind: 'none',
        why: `leaving ${obs.agent} alone: ${refusal.code} — ${refusal.why}. ` +
             `A refusal is not a stall, and restarting it discards the record that ` +
             `produced it` + (refusal.remedy ? `. Remedy: ${refusal.remedy}` : ''),
        evidence: { refusal },
      };
      if (obs.waiting_on) return {
        kind: 'none',
        why: `leaving ${obs.agent} alone: waiting on ${obs.waiting_on.code}` +
             (obs.waiting_on.expected_ms ? ` (~${Math.round(obs.waiting_on.expected_ms / 1000)}s)` : '') +
             `. Churning the keeper restarts the decision, not the wait`,
        evidence: { waiting_on: obs.waiting_on },
      };

      // NO STRUCTURED ANSWER. This is where the supervisor reaches for the regex. DUM
      // does not. It reports the stall with everything it saw and leaves the keeper
      // running, because the cost of a wrong restart here is a fleet-wide churn loop
      // and the cost of a missed restart is one idle character.
      return {
        kind: 'report',
        why: `${obs.agent} reports a stall and the harness gave no machine-readable ` +
             `reason, so DUM will not restart it. Matching the keeper's prose is how ` +
             `a fleet ends up restarting eight characters a minute for an afternoon. ` +
             `See docs/harness-contract.md §Gap 1`,
        evidence: {
          stalled: obs.stalled,
          refusals_reported: (obs.refusals ?? []).length,
          // Carried so a human can read it. Deliberately NOT matched against.
          keeper_says: obs.keeper?.journal?.slice(-3) ?? [],
        },
      };
    },
  },

  {
    // GRADUATION: the check a single keeper structurally cannot make.
    //
    // A kill only advances a character when the creature is at or above its level —
    // the game's own rule compares monster level against base max health. A keeper
    // happily farms something worth nothing for ever and reports kills the whole time,
    // so from inside one character everything looks healthy. Noticing requires
    // comparing what is being killed against what the character has become, which is
    // what a directional bot is for.
    id: 'outgrown-prey',
    faculty: 'work',
    why: 'a kill below the character\'s own level pays nothing, and a keeper farming ' +
         'one looks exactly like a keeper that is working',
    needs: () => ['prey'],
    enabled: doctrine => (doctrine.prey?.graduate_margin ?? null) !== null,
    offWhy: 'prey.graduate_margin is unset, so DUM has no graduation opinion',
    decide(obs, doctrine) {
      const hunting = obs.keeper?.policy?.hunt ?? obs.hunting ?? null;
      if (!hunting) return null;
      const mine = obs.max_health ?? null;
      // The prey read is where the creature's level comes from. Without it there is
      // nothing to compare, and guessing a level from a name is exactly the kind of
      // lookup table that goes stale silently.
      const row = (obs.prey?.creatures ?? obs.prey?.prey ?? [])
        .find(p => String(p.name ?? '').toLowerCase() === hunting.toLowerCase());
      const theirs = Number(row?.level);
      if (mine === null || !Number.isFinite(theirs)) return null;

      const margin = doctrine.prey.graduate_margin ?? 0;
      if (theirs >= mine + margin) return null;

      return {
        kind: 'report',
        why: `${obs.agent} has outgrown "${hunting}": the creature is level ${theirs} ` +
             `and the character is at ${mine} max health, so the kill no longer advances ` +
             `it. It will keep killing and the board will keep reading healthy`,
        evidence: { hunting, creature_level: theirs, max_health: mine, margin },
      };
    },
  },
];
