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

const clamp01 = v => Math.max(0, Math.min(1, Number(v)));

/** The vigor floor a throttle asks for, on the 0..200 scale. Pure; exported for the test. */
export function floorForThrottle(throttle) {
  return Math.round(clamp01(throttle) * 200);
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
      const target = floorForThrottle(doctrine.throttle);
      const live = obs.keeper?.policy ?? obs.policy ?? {};
      if (live.fightAboveVigor === target) return null;
      return {
        kind: 'orders',
        orders: { action: 'start', fight_above_vigor: target },
        why: `throttle ${Math.round(clamp01(doctrine.throttle) * 100)}% -> fight_above_vigor=${target}`,
        evidence: { throttle: doctrine.throttle, target, keeper_has: live.fightAboveVigor ?? null },
      };
    },
  },
];
