// PAIRING — the decision that is most obviously fleet-level and most easily made worse.
//
// WHAT IT BUYS. There is no party system in Meridian 59. A pairing is a convention two
// keepers hold, and what it buys is that BOTH characters advance from one kill:
// advancement is a per-character flag rather than a split pot, so two characters on one
// creature each gain from the one corpse. They also share a wall and split the incoming
// damage while each regenerates on its own clock.
//
// WHAT IT COSTS, AND WHY THIS IS OFF BY DEFAULT. Pairing is the single most thrash-prone
// decision in the fleet. Pair by level and the pairing reshuffles every time anyone
// gains or dies; every reshuffle stops two keepers and re-travels two characters, and
// nobody arrives before being reassigned. The harness's supervisor recorded nineteen of
// twenty-one characters misplaced and six pairings one-sided within two rounds of doing
// it that way, with deaths climbing.
//
// The fix it landed on is the one encoded below: AN EXISTING MUTUAL PAIR IS NEVER
// DISTURBED. Only the unpaired are matched. That still heals a widowed character — its
// partner is gone, so it is unpaired and gets re-matched — without touching anything
// that is working.
//
// AND THE UNCOMFORTABLE MEASUREMENT. The same supervisor carries a `--solo` flag with a
// note that over the hour after splitting the fleet, solo ran 1 death and +14 max health
// against 14 deaths and +3 for the paired hour before it. One hour is one hour and the
// two hours were not otherwise controlled — but a doctrine that turns pairing on is
// making a claim that is measurable, and `m59-bard` is where the claim gets settled.
// That is precisely the kind of thing this repository is supposed to make arguable.

/**
 * Pure pairing over a fleet observation. Exported for testing without a broker.
 *
 * Two rules, both about not producing a party that cannot function:
 *   * never pair a character with itself, and never leave a three;
 *   * pair by level, so neither partner is fighting something the other outclasses.
 * An odd fleet leaves one unpaired, and that is REPORTED rather than hidden — a
 * character that thinks it has a partner and has not is worse than a solo one.
 */
export function pairUp(rows, { keepWorking = true } = {}) {
  const by = new Map(rows.map(r => [r.agent, r]));
  const pairs = [];
  const taken = new Set();
  // A PAIR IS SYMMETRIC AND ITS WRITTEN ORDER IS NOT. Both characters get the same
  // write, so [a,b] and [b,a] mean the same thing — but they PRINT differently, and a
  // plan whose output depends on the order the harness happened to return the board in
  // cannot be diffed against yesterday's. Normalise once, here.
  const ordered = (x, y) => String(x.agent) <= String(y.agent) ? [x, y] : [y, x];

  if (keepWorking) {
    for (const r of rows) {
      if (taken.has(r.agent)) continue;
      const mate = by.get(r.partner);
      // MUTUAL only. A one-sided pairing is the failure being healed, not preserved:
      // one character believing it has a partner that has never heard of it is worse
      // than a solo one, because it will not start a fight while its partner is
      // elsewhere and its partner is not coming.
      if (!mate || taken.has(mate.agent) || mate.partner !== r.agent) continue;
      taken.add(r.agent); taken.add(mate.agent);
      pairs.push(ordered(r, mate));
    }
  }

  const rest = rows.filter(r => !taken.has(r.agent))
    // Deterministic: level descending, then agent name, so the same board always
    // produces the same pairing. A tie broken by object order would make the fleet's
    // arrangement depend on the harness's iteration order.
    .sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || String(a.agent).localeCompare(String(b.agent)));
  while (rest.length >= 2) pairs.push(ordered(rest.shift(), rest.shift()));
  // `kept` counts PAIRS, not characters — it is what the reason string reports as
  // "N existing mutual pair(s) left exactly as they are".
  return { pairs, odd: rest[0] ?? null, kept: taken.size / 2 };
}

export const partyFleetRules = [
  {
    id: 'pair-the-unpaired',
    faculty: 'work',
    scope: 'fleet',
    why: 'two characters on one creature both advance from it, and a widowed character ' +
         'is one that will not start a fight until it is re-matched',
    enabled: doctrine => doctrine.party?.pair === true,
    offWhy: 'party.pair is off. Pairing is measurable and contested — see the note in ' +
            'src/decide/rules/party.mjs — so it is opted into rather than assumed',
    decide(fleetObs, doctrine) {
      // Only characters that are actually available. A character on an errand is
      // travelling on the fleet's business and pairing it abandons the errand.
      const rows = (fleetObs.characters ?? []).filter(r =>
        r.in_game && !r.stalled && !r.parked &&
        (!r.commitment || r.commitment.kind === 'partner'));
      if (rows.length < 2) return null;

      const { pairs, odd, kept } = pairUp(rows, { keepWorking: doctrine.party?.keep_working_pairs !== false });
      // Only the pairs that are NEW. Re-asserting a working pair is a write that stops
      // two keepers to tell them something they already believe.
      const fresh = pairs.filter(([a, b]) => a.partner !== b.agent || b.partner !== a.agent);
      if (!fresh.length) return null;

      return {
        kind: 'orders',
        // BOTH SIDES, ALWAYS. The harness is explicit that setting the policy without
        // registering the pair is silent: the character believes it has a partner and no
        // other keeper knows. Emitting both writes here keeps that indivisible in the
        // plan as well as in the act.
        orders: {
          batch: fresh.flatMap(([a, b]) => ([
            { agent: a.agent, action: 'start', partner: b.agent },
            { agent: b.agent, action: 'start', partner: a.agent },
          ])),
        },
        why: `${fresh.length} pairing(s) to make; ${kept} existing mutual pair(s) left ` +
             `exactly as they are` + (odd ? `; ${odd.agent} is the odd one out and stays solo` : ''),
        evidence: {
          new_pairs: fresh.map(([a, b]) => [a.agent, b.agent]),
          kept_pairs: kept,
          odd: odd?.agent ?? null,
        },
      };
    },
  },
];
