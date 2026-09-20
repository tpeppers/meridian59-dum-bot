// WHO OWNS A BODY. One sentence, in a leaf module, because two rules need it and one of them
// cannot import the other.
//
// It lived in station.mjs, which is the right place for it by subject and the wrong place by
// module graph: `servicedesk.mjs` needs it too, and `src/act/errands.mjs` imports servicedesk to
// register its recorder — so importing station from servicedesk closed a cycle through
// `act/orders.mjs` and `config/schema.mjs` and broke `ORDER_FIELDS`'s initialisation. The whole
// test suite died with `Cannot access 'ORDER_FIELDS' before initialization`, which names neither
// file involved.
//
// This module imports nothing, so it cannot participate in a cycle. station.mjs re-exports it, so
// every existing caller is untouched and there is still exactly one definition.
//
// ---------------------------------------------------------------- the rule itself
//
// THE HARNESS ALREADY DRAWS THIS DISTINCTION, and it is subtler than "is it claimed". A CLAIM
// leaves a character TAKEABLE; `busy` is what makes everything step over it. So `takeable` is the
// field to read. An errand mid-flight, a two-sided trade, or anything that did not mark itself
// takeable keeps the body; a bare claim does not — which matters because DUM's own claim is a
// bare one and sits on every character it drives. A guard that refused it would refuse the fleet.
//
// A piloted character is off limits regardless: that is a person playing it.
export const holdsTheBody = row => Boolean(row.parked) || Boolean(row.piloted) ||
  (Boolean(row.commitment) && row.commitment?.takeable !== true);
