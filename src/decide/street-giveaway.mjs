// LEAVE THE LOOT IN THE ROAD, AND TELL THE STREET.
//
// Data and step-shape only, like feast-hall.mjs beside it, because TWO routes end this way
// and a copy of these three steps in each would drift. The sell circuit finishes here after
// the bank; the feast run finishes here when there was nothing to sell in the first place.
//
// THE ORDER IS THE OPERATOR'S, 2026-09-05: vault what is worth keeping, sell what will
// sell, bank what that paid, drop what is left, yell about it, then fill the pack at the
// Duke's tables. Every step of it earns the next one — the drop is what makes the pack
// empty enough for the food to be worth walking to, and it comes AFTER Barloque so that
// what hits the road is only what no merchant and no vault would take.

import { FEAST_DISPENSERS } from './feast-hall.mjs';

// Room 50, and the stop is FREE rather than a detour. Measured off the bake: Castle
// Victoria to the Duke's hall is 11 room hops, and Castle Victoria -> Streets of Tos -> the
// hall is 8 + 3. From the bank it is closer still: 54 -> 50 is 2 hops, 50 -> 953 is 3.
export const STREETS_OF_TOS = 50;

// The line. A constant here rather than anything composed — DUM still writes no text.
export const GIVEAWAY_YELL = 'free crap in streets';

// Never dropped, on top of the two floors the harness enforces for itself: what is WORN and
// MONEY. Those two are deliberately absent from this list, so the floors are what is being
// relied on rather than a duplicate of them here — the caller that forgets is the whole case
// they exist for, and a list that repeats them hides whether they work.
//
// NO SPARE WEAPONS: a second weapon is worth shillings at the Barloque smith and nothing at
// all in a pack, so the sell stop is told to keep exactly one (the equipped one) and anything
// the smith would not take has earned its place in the road.
//
// AND THE FOOD HALF IS DERIVED FROM THE HALL'S OWN TABLES, not typed out. A hand-written list of "what is food"
// drifts from the game, and this one had: it named two of the seven things the Duke hands
// out, so `spider eye`, `bunch of grapes`, `drumstick`, `goblet of ale` and `fortune cookie`
// were all being dropped in the road or sold in Barloque. The spider eye is the expensive
// one — nutrition 9, the same as a slice of pork, and the fleet was carrying six hundred.
//
// FEAST_DISPENSERS is the list the grab errand already walks up to and activates, so it
// cannot disagree with what the fleet actually comes home holding. Anything added to the
// hall arrives here for free.
//
// The three after it are foods the hall does NOT dispense but the fleet finds: the two
// edible mushrooms (four of this world's five are reagents, so they are named exactly and
// never as a family), and bread. The reagents at the end are not food at all — they are what
// Create Food is made of, which is the same argument for keeping them out of a merchant's
// hands and out of the road.
export const GIVEAWAY_KEEP = Object.freeze([
  ...FEAST_DISPENSERS.map(d => d.item),
  'edible mushroom', 'inky', 'loaf',
  'herb', 'elderberry',
]);

/**
 * Walk to the street, put the pack down, say so.
 *
 * ORDER MATTERS AND SO DOES `needs`. The yell is an invitation to a pile that has to exist
 * before anybody is invited to it, and neither the drop nor the yell may happen in a room
 * the walk never reached — a pile in a merchant's doorway or on a staging square is
 * antisocial in a way a public street is not.
 *
 * All three are `optional`: whatever this errand is attached to, the giveaway is the
 * manners and not the point, and it must never cost the trip.
 *
 * @param {string} agent
 * @param {{keep?:string[], room?:number, travelTimeoutMs?:number}} [opts]
 * @returns {object[]} errand steps
 */
export function giveawaySteps(agent, { keep = GIVEAWAY_KEEP, room = STREETS_OF_TOS,
                                       // Tos is eight hops from Castle Victoria and the
                                       // broker estimates 792s for it. The old 240s default
                                       // cancelled the walk at four minutes every time, so
                                       // the drop and the yell — both of which `needs` the
                                       // arrival — never ran. See the note in sellrun.mjs.
                                       travelTimeoutMs = 900_000 } = {}) {
  return [
    { tool: 'travel', args: { agent, to: room, run_errands: false },
      expect: 'arrived', optional: true, label: 'in-the-street',
      timeout_ms: travelTimeoutMs, estimate_ms: 800_000,
      why: `to the Streets of Tos (${room}) — on the way to the hall, not a detour` },
    { tool: 'drop_all', args: { agent, keep },
      optional: true, needs: 'in-the-street', estimate_ms: 20_000,
      why: 'put down everything not worn, not money and not food — it has been past every ' +
           'counter that would have bought it' },
    { tool: 'say', args: { agent, text: GIVEAWAY_YELL, type: 'yell' },
      // `needs` the street rather than the drop: the runner cannot express "only if that
      // step put something down", and a yell over an empty street is a smaller mistake than
      // the errand stopping.
      optional: true, needs: 'in-the-street', extend_busy: false, estimate_ms: 5_000,
      why: 'tell the street the pile is there — a yell carries to the adjacent rooms too' },
  ];
}
