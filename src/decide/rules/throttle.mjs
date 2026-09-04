// THE THROTTLE — how hard the fleet runs, expressed as the vigor it maintains.
//
// Vigor is the fuel a character spends to fight, and `fightAboveVigor` is the FLOOR it will
// not fight below: the keeper eats up to the floor, then swings (autopilot.mjs — "wellfed ate
// its way to 120 and then fought"). Resting alone only refills vigor to 80; everything above
// that has to be EATEN, which means casting Create Weapon's sibling, Create Food, and eating
// it. So a HIGH floor is not just a number — it is an instruction to PREPARE: park somewhere
// safe, amass food, eat it, and let vigor climb, only fighting once it is up. A low floor lets
// a character fight off the rest cap without ever touching food.
//
// The throttle expresses that as a single fraction of the 200-vigor maximum:
//   1.0  = full throttle  -> floor ~200: park and feed to near-max vigor before every fight
//   0.9  =                -> floor  180 (the fleet's long-standing default)
//   0.4  =                -> floor   80: fight straight off the rest cap, no food needed
//
// It is a CHARACTER rule so each unit converges on its own floor, and it emits nothing once the
// keeper already holds the target — the ordinary "returns null when the keeper agrees" contract,
// so it cannot wedge the table. `fight_above_vigor` is a routable order field and is NOT among
// keeper-parity's yielded keys, so the order actually sends.

import { mealsAboard, canCook } from './feast.mjs';

const clamp01 = v => Math.max(0, Math.min(1, Number(v)));

/**
 * The vigor floor a throttle asks for, on the 0..200 scale. Pure; exported for the test.
 *
 * TWO SPELLINGS, AND THE BOUNDARY IS 1. A fraction of the 200 maximum is the original
 * spelling and every existing doctrine uses it. An absolute vigor is what an operator
 * actually says out loud — "get them to 180 before they start a fight" — and there is no
 * ambiguity between the two, because a floor of one vigor is not a thing anybody means.
 */
export function floorForThrottle(throttle) {
  const v = Number(throttle);
  if (!Number.isFinite(v)) return 0;
  return v > 1 ? Math.round(Math.min(200, v)) : Math.round(clamp01(v) * 200);
}

/**
 * ONE FLOOR IS A BET ON THE LARDER, AND IT LOSES IN BOTH DIRECTIONS.
 *
 * Vigor above the resting cap of 80 has to be EATEN. So a single number has to be either
 * high — and idle-locks every character whose larder is empty, because it will not fight
 * below the floor and cannot climb to it without food — or low, and throws away the
 * regeneration a fed character has already paid for. Health returns as
 * ((200-vigor)^2/6 + 1000) ms a point: 1.0 hp/s at 200 against 0.29 at 80. That is most of
 * the difference between a fleet that grinds upward and one that dies in the same room.
 *
 * Both halves of that were measured on one fleet on 2026-09-04. A cohort was given 140 with
 * no supply line and one character sat at vigor 76 with zero reagents and zero shillings for
 * thirty-six minutes — not hurt, not lost, not stalled by any detector, just standing in the
 * right room correctly refusing to fight. Meanwhile the cohort that DID have food was held
 * at the same 140 when the Duke's tables were handing out unlimited pork.
 *
 * So the floor follows the larder. `with_food` is what a character climbs to when it can
 * actually get there — meals aboard, or the reagents to cast some — and `no_food` is what it
 * drops to when it cannot. 80 is the honest bottom: exactly what resting alone delivers, so
 * it is the last value that cannot deadlock.
 *
 * The harness has its own version of this (reachableFightFloor) and it is not the same
 * thing: that one is a SAFETY NET the keeper applies at one second so an unfed character is
 * not frozen. This is a POLICY, decided over minutes, that says how hard a fed fleet should
 * run — and it is the half that can be raised, which the safety net can never do.
 */
export function throttleFloors(throttle) {
  if (throttle != null && typeof throttle === 'object') {
    const withFood = floorForThrottle(throttle.with_food);
    const noFood = floorForThrottle(throttle.no_food);
    // A `no_food` above `with_food` is not a fleet that eats to relax; it is a typo, and
    // obeying it would idle exactly the characters this split exists to keep fighting.
    return { withFood, noFood: Math.min(noFood, withFood), split: true };
  }
  const flat = floorForThrottle(throttle);
  return { withFood: flat, noFood: flat, split: false };
}

/** Can this character actually reach the fed floor — something to eat, or something to cook? */
export function fedEnough(row, food = {}, minMeals = 1) {
  const meals = mealsAboard(row);
  // UNKNOWN IS NOT EMPTY. A larder the board did not report reads null, and treating that as
  // "no food" would drop a well-stocked character to the resting cap on a bad snapshot. The
  // reagents are the second chance, and only when BOTH are unknown-or-absent do we step down.
  if (meals != null && meals >= minMeals) return true;
  return canCook(row, food);
}

export const throttleRules = [
  {
    id: 'throttle-vigor',
    faculty: 'work',
    why: 'the throttle sets the vigor a character maintains before it will fight — a high one ' +
         'parks it to cast and eat Create Food up toward max vigor, a low one fights straight ' +
         'off the rest cap',
    enabled: doctrine => doctrine.throttle != null,
    offWhy: 'no throttle set — the doctrine leaves fight_above_vigor to the ladder/keeper',
    decide(obs, doctrine) {
      const floors = throttleFloors(doctrine.throttle);
      const row = obs.keeper ? { ...obs, ...obs.keeper } : obs;
      const fed = floors.split
        ? fedEnough(row, doctrine.food ?? {}, doctrine.throttle?.min_meals ?? 1)
        : true;
      const target = fed ? floors.withFood : floors.noFood;
      const live = obs.keeper?.policy ?? obs.policy ?? {};
      if (live.fightAboveVigor === target) return null;
      const meals = mealsAboard(row);
      return {
        kind: 'orders',
        orders: { action: 'start', fight_above_vigor: target },
        why: floors.split
          ? `${fed ? 'fed' : 'nothing to eat and nothing to cook'} -> fight_above_vigor=${target} ` +
            `(${floors.withFood} fed / ${floors.noFood} not)`
          : `throttle ${Math.round(clamp01(doctrine.throttle) * 100)}% -> fight_above_vigor=${target}`,
        evidence: { throttle: doctrine.throttle, target, fed, meals,
                    can_cook: canCook(row, doctrine.food ?? {}),
                    floors: floors.split ? { with_food: floors.withFood, no_food: floors.noFood } : null,
                    keeper_has: live.fightAboveVigor ?? null },
      };
    },
  },
];
