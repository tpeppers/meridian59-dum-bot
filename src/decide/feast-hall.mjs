// THE DUKE'S FEAST HALL — the facts, read off the kod, that the feast rule and the
// surface both depend on. Pure data: no I/O, no clock, importable from anywhere.
//
// The Duke's castle sits off Tos: Tos (50) -> the courtyard (950) -> the great hall
// (951) -> the feast hall (953), three hops from the town square (duke1.kod:62,
// duke2.kod:213, duke4.kod:52). The feast hall is ROOM_NO_COMBAT | ROOM_SANCTUARY
// (duke4.kod:27): nothing can be hurt in it, which is what makes standing there for two
// minutes taking food safe on a shared server.
//
// IT IS LOCKED BY DEFAULT (duke4.kod:31, pbLocked = TRUE) and opened on the Duke's
// authority — an actor working the wood door in the great hall (duke2.kod:106-140). A
// player walking into the locked hall is hustled straight back out to the great hall by
// NewHold (duke4.kod:38-45), so a journey to a locked hall never ARRIVES: the character
// reaches 951 and stays there. The rule treats that as a stale journey, not a route
// failure, and the doctrine has to be switched off when the event ends.
//
// THE FOOD IS ON DISPENSERS, AND A DISPENSER IS ACTIVATED, NOT PICKED UP. Each table
// piece is a FoodDispenser (dispensr.kod): `activate` on it creates one item of its class
// and hands it over (TryActivate, dispensr.kod:41-58), refusing only when the pack cannot
// hold it — "You can't hold anything more!" — or when a finite dispenser has run dry.
// The hall's are created with amount -1, which is infinite (duke4.kod:123: "infinite for
// now, may change"). The server checks only that the dispenser is in the SAME ROOM
// (user.kod UserTryActivate: GetOwner <> poOwner), not that the character is standing next
// to it, so nothing here needs a walk_to.
//
// WHICH FOOD. viNutrition is vigor one-for-one; viFilling is what it costs against a
// stomach of 100 that drains about seven a minute (m59-items.mjs). The pork, the soup and
// the spider eyes are the best on the table at 9 vigor for 20 stomach and 9 weight each;
// grapes are 7 for 16 at 7 weight; a goblet of ale is 3 for 10 at 10 weight and a fortune
// cookie is 1 for 2. Pork first because it also SPEAKS when taken (pork.kod:32), and a
// sentence in the transcript is the only way the errand can count what it got — the
// grapes, the spider eyes and the drumsticks are handed over in silence.
export const FEAST_HALL = Object.freeze({
  room: 953,
  name: "The Duke's Feast Hall",
  // The rooms a journey passes through on the way in, innermost first. A character seen
  // in one of these with an outbound journey is still walking; one seen there long after
  // it should have arrived was hustled out of a locked hall.
  approach: Object.freeze([951, 950, 50]),
});

// Every dispenser on the hall's tables, by the name the server gives the object — which
// is what `act target:` resolves against in the room — with the item each hands over.
export const FEAST_DISPENSERS = Object.freeze([
  Object.freeze({ dispenser: 'roast pig', item: 'slice of pork', nutrition: 9, filling: 20, weight: 9,
    taken: /slice yourself a hefty slab/i }),
  Object.freeze({ dispenser: 'cauldron of soup', item: 'bowl of soup', nutrition: 9, filling: 20, weight: 9,
    taken: /ladle a steamy bowlful/i }),
  Object.freeze({ dispenser: 'platter of raw spider eyes', item: 'spider eye', nutrition: 9, filling: 20, weight: 9,
    taken: null }),
  Object.freeze({ dispenser: 'platter of grapes', item: 'bunch of grapes', nutrition: 7, filling: 16, weight: 7,
    taken: null }),
  Object.freeze({ dispenser: 'platter of drumsticks', item: 'drumstick', nutrition: 9, filling: 30, weight: 9,
    taken: null }),
  Object.freeze({ dispenser: 'pitcher of ale', item: 'goblet of ale', nutrition: 3, filling: 10, weight: 10,
    taken: /fill your goblet/i }),
  Object.freeze({ dispenser: 'basket of fortune cookies', item: 'fortune cookie', nutrition: 1, filling: 2, weight: 2,
    taken: /select a fortune cookie/i }),
]);

export const FEAST_DISPENSER_NAMES = Object.freeze(FEAST_DISPENSERS.map(d => d.dispenser));

/** The sentence a full pack gets (dispensr.kod:16). The errand stops on it. */
export const FEAST_PACK_FULL = /can't hold anything more/i;

/** A dispenser row by its in-room name, case-insensitively, or null. */
export const dispenserNamed = name =>
  FEAST_DISPENSERS.find(d => d.dispenser === String(name ?? '').trim().toLowerCase()) ?? null;
