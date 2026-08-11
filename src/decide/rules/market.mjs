// WHEN TO STOP FIGHTING AND GO AND SELL — which is a question about what the fleet is
// saving for, not a question the keeper can answer from one character's purse.
//
// WHY THIS MOVED OUT OF THE KEEPER. The harness sent a character to market when
// `purse + bank < 500` and it held four or more non-money stacks. Both halves are lower
// than they look: four stacks is four kinds of mushroom, and 500 is cleared by any moot or
// hand-out that moves money between characters. So the condition went true for nearly the
// whole fleet at the same moment and twenty characters queued at the same NPC carrying
// almost nothing — while the thing they were actually for, being ready for the next
// undead window, went unserved.
//
// The keeper now goes to market on ONE condition: the pack is genuinely heavy. That is a
// fact about a character and it belongs there. Everything below is a judgement about the
// fleet's priorities, which is what a doctrine is for.

// FULL IS A WEIGHT. Counting stacks is the mistake this file exists to correct: measured
// in one pass, one character held ELEVEN stacks at 4% of capacity while another held SIX
// at 87%. `weight_max = 1700 + might * 20` (player.kod:10456), weight and bulk share the
// formula, and either can bind — so the fuller of the two decides.
export const DEFAULT_SELL_AT_LOAD = 0.85;

export function loadFraction(carry) {
  if (!carry?.known || !carry.load) return null;
  const f = (v, max) => (max > 0 && Number.isFinite(v) ? v / max : 0);
  return Math.max(f(carry.load.weight, carry.weight_max), f(carry.load.bulk, carry.bulk_max));
}

// AN INEXACT LOAD MEANS GO, NOT STAY. `carryCapacity` withholds `room_for` when something
// in the pack is not in the weight table, because the load it computed is a LOWER bound.
// Reading that as "there is room" is the direction that fails — it says there is space
// when there is none, and the server silently deletes what will not fit.
export const loadIsUncertain = carry => !!carry?.known && carry.load?.exact === false;

// SELLING IS NOT THE POINT; BEING READY IS. A character that is heavy has stopped being
// able to pick up what it kills, so the trip pays for itself. A character that is merely
// poor has lost nothing yet — and if the window is open, a walk to Cor Noth costs it the
// entire shift, which is worth far more than the ninety shillings of mushroom it would sell.
export function shouldGoToMarket(row, { sellAtLoad = DEFAULT_SELL_AT_LOAD,
                                        windowOpen = false, alsoWhenBroke = false,
                                        brokeUnder = 500, brokeStacks = 8 } = {}) {
  const frac = loadFraction(row.carry);
  if (loadIsUncertain(row.carry))
    return { go: true, why: 'the pack holds something not in the weight table, so the load ' +
                            'is a lower bound — treat that as "make room", never as "there is room"' };
  if (frac != null && frac >= sellAtLoad)
    return { go: true, why: `pack is ${Math.round(frac * 100)}% of capacity` };
  // The poverty trip, off unless a doctrine asks for it, and never during a window.
  if (alsoWhenBroke && !windowOpen) {
    const money = (row.purse ?? 0) + (row.banked ?? 0);
    const stacks = row.stacks ?? 0;
    if (money < brokeUnder && stacks >= brokeStacks)
      return { go: true, why: `only ${money} to its name and ${stacks} stacks aboard, and ` +
                              `nothing is spawning — a good time to convert stock to money` };
  }
  if (windowOpen && frac != null && frac < sellAtLoad)
    return { go: false, why: `${Math.round(frac * 100)}% loaded and the undead are up — ` +
                             `the shift is worth more than the pack` };
  return { go: false, why: frac == null ? 'carry capacity not read yet'
                                        : `${Math.round(frac * 100)}% loaded, nothing to do` };
}

export const marketFleetRules = [
  {
    id: 'market-when-heavy',
    faculty: 'economy',
    scope: 'fleet',
    why: 'a character that cannot carry what it kills has stopped earning, and that is the ' +
         'only reason to leave a hunting ground for a counter — being poor is not one, ' +
         'because the fleet is saving for readiness rather than for money',
    enabled: doctrine => doctrine.market?.sell_when_heavy !== false,
    offWhy: 'market.sell_when_heavy is off; nobody leaves to sell and packs fill until the ' +
            'server starts refusing pickups',

    decide(fleetObs, doctrine) {
      const m = doctrine.market ?? {};
      const rows = (fleetObs.characters ?? []).filter(r => r.in_game);
      if (!rows.length) return { kind: 'pass', why: 'nobody in game' };

      // THE WINDOW OUTRANKS THE PACK. A shift is 35 minutes in every 120 and a round trip
      // to Cor Noth is most of it. Nothing goes shopping while the undead are up unless it
      // physically cannot carry any more.
      const windowOpen = !!fleetObs.window_open;
      const opts = { sellAtLoad: m.sell_at_load ?? DEFAULT_SELL_AT_LOAD,
                     windowOpen,
                     alsoWhenBroke: m.sell_when_broke === true,
                     brokeUnder: m.broke_under ?? 500,
                     brokeStacks: m.broke_stacks ?? 8 };
      const going = [], staying = [];
      for (const r of rows) {
        const d = shouldGoToMarket(r, opts);
        (d.go ? going : staying).push({ agent: r.agent, why: d.why });
      }
      if (!going.length)
        return { kind: 'pass',
                 why: windowOpen
                   ? `nobody is heavy enough to leave an open window (${staying.length} checked)`
                   : `nobody needs a counter (${staying.length} checked)` };
      return { kind: 'act',
               plan: going.map(g => ({ ...g, do: 'sell-at-market' })),
               why: `${going.length} going to market${windowOpen ? ' DESPITE the window being open — ' +
                     'they physically cannot carry more' : ''}` };
    },
  },
];
