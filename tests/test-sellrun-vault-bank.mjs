import assert from 'node:assert/strict';
import { sellrunFleetRules } from '../src/decide/rules/sellrun.mjs';
import { runErrand } from '../src/act/errands.mjs';
import { GIVEAWAY_YELL, STREETS_OF_TOS } from '../src/decide/street-giveaway.mjs';
import { FEAST_HALL } from '../src/decide/feast-hall.mjs';
import { SELL_KEEP, BARLOQUE_VAULT, BARLOQUE_STOPS, TOS_BANK }
  from '../src/decide/rules/sellrun.mjs';

const test = globalThis.__dumTest;
const rule = sellrunFleetRules.find(r => r.id === 'barloque-sell-circuit');

// SELLING IS THE FIRST HALF OF A SELL RUN.
//
// A circuit that sells three shops and walks home has turned a pack into a purse, and a purse
// is the one thing a death takes in full. Half this fleet's deaths are on the road. So the
// stops the trip is actually FOR are the two after the shops: the vault takes what nobody
// would buy, the bank takes what they paid, and what walks home is a character carrying
// almost nothing worth losing.

const STOPS = [
  { room: 113, merchant: "Fehr'loi Qan", max_stack: null },
  { room: 109, merchant: 'Herbutte', max_stack: 25 },
];
const base = {
  on: true, stops: STOPS, keep: ['wand', 'signet', 'herb'], min_price: 1,
  cooldown_ms: 60_000, trigger: { carry_at: 10, min_health: 0.8 },
};
const heavy = { agent: 'a', in_game: true, room: 39, carrying: 30, purse: 4000,
                health: { pct: 1 } };
const plan = sellrun => rule.decide({ at: 1_000_000, memory: {}, characters: [heavy] },
                                    { sellrun });
const steps = sellrun => plan(sellrun).orders.steps;
const tools = sellrun => steps(sellrun).map(s => s.tool);

test('sellrun: a doctrine that says nothing about them still gets both', () => {
  // WHICH MERCHANT IS IN WHICH ROOM IS NOT AN ORDER, so a doctrine does not have to restate
  // Barloque to switch selling on. Saying nothing about the vault or the bank gets both.
  //
  // This is the shape it takes, not a preference: the live prod doctrine descends from
  // castle-victoria, not from the sell-circuit doctrine, so "turn selling on for this fleet"
  // used to mean copying four lists into a gitignored file — and a copy drifts silently from
  // the file the tests assert against.
  assert.deepEqual(tools(base),
    ['travel', 'vault', 'travel', 'sell_all', 'travel', 'sell_all', 'travel', 'bank', 'travel']);
});

test('sellrun: and `null` is how a doctrine declines one', () => {
  // Saying nothing and saying no are different instructions. An absent key takes the default;
  // an explicit null is an operator deciding this fleet does not make that stop, and it has
  // to be expressible or the default becomes a policy.
  assert.deepEqual(tools({ ...base, vault: null, bank: null }),
    ['travel', 'sell_all', 'travel', 'sell_all', 'travel']);
});

test('sellrun: the defaults are the ones the doctrine file documents', () => {
  const s = steps(base);
  assert.equal(s.find(x => x.tool === 'vault').args.items.length > 0, true);
  assert.equal(s[0].args.to, 114, 'the vault is the first place it walks');
  assert.equal(steps({ ...base, bank: undefined }).find(x => x.tool === 'bank').args.keep, 500,
               'and the walking float has a default too');
});

test('sellrun: the vault comes BEFORE the first shop', () => {
  // ORDER IS THE FAIL-SAFE, not a preference. `sell_all` offers a merchant everything he will
  // take, and the only thing between a ring of invisibility and his counter is the keep list —
  // a hand-written string match, one forgotten name away from selling the best thing the
  // character owns, and the mistake is invisible afterwards because the sale reports success
  // either way. What is IN the vault cannot be sold by a list that is wrong.
  //
  // The harness refuses the other order outright: m59-fleetscript.mjs rejects a plan that
  // vaults after it sells, before anything walks. These two are the same fleet's two ways of
  // saying "go and sell", and them disagreeing about which order is safe would be worse than
  // either answer. It costs two hops in forty, measured off the bake.
  const s = steps({ ...base, vault: { room: 114 } });
  const i = s.findIndex(x => x.tool === 'vault');
  assert.ok(i >= 0, 'there is a vault step');
  assert.ok(i < s.findIndex(x => x.tool === 'sell_all'), 'before any sale');
  assert.equal(s[i - 1].tool, 'travel');
  assert.equal(s[i - 1].args.to, 114, 'and it walks there first');
  assert.deepEqual(s[i].args.items, base.keep, 'the keep list, when no items are named');
  assert.deepEqual(steps({ ...base, vault: { room: 114, items: ['wand'] } })
                     .find(x => x.tool === 'vault').args.items, ['wand'],
                   'or exactly what the doctrine named');
});

test('sellrun: the bank is sent a FLOAT, never an amount', () => {
  // THE AMOUNT DOES NOT EXIST WHEN THESE STEPS ARE BUILT. What there is to bank is whatever
  // three shops are about to pay, and a number written in here would be a guess — one too
  // high is a deposit refused for the whole trip's takings, one too low leaves the rest in
  // the pack for the walk home, which is the thing banking exists to prevent. `keep` moves
  // the arithmetic to the counter, where the purse is a fact.
  const b = steps({ ...base, bank: { room: 54, keep: 500 } }).find(x => x.tool === 'bank');
  assert.equal(b.args.action, 'deposit');
  assert.equal(b.args.keep, 500);
  assert.equal(b.args.amount, undefined, 'an amount here would be a guess');
});

test('sellrun: neither detour may cost the character its trip home', () => {
  // A vaultman who is not at his counter, or a bank the router could not reach, is a detour
  // that did not come off — not a reason to abandon a character in Barloque. `optional` is
  // what the runner reads to keep going; `always` on the last leg is what gets it home even
  // when something did stop the errand. Both, because they answer different questions.
  const s = steps({ ...base, vault: { room: 114 }, bank: { room: 54, keep: 500 } });
  for (const t of ['vault', 'bank'])
    assert.equal(s.find(x => x.tool === t).optional, true, `${t} is optional`);
  const home = s[s.length - 1];
  assert.equal(home.tool, 'travel');
  assert.equal(home.args.to, 39, 'back to the room it was hunting in');
  assert.equal(home.always, true, 'and it runs even after a stop failed');
  assert.notEqual(home.optional, true, 'the way home is not a detour');
});

test('sellrun: a deposit is only sent from a room the walk reached', () => {
  // `needs` names the travel step's label. Without it, a vault deposit after a walk that
  // stalled is sent from wherever the character actually is — harmless, because the tool
  // resolves the vaultman off the live room and refuses, but it is a packet sent hopefully,
  // and that habit is what this codebase keeps paying for.
  const s = steps({ ...base, vault: { room: 114 }, bank: { room: 54, keep: 500 } });
  const labels = s.filter(x => x.label).map(x => x.label);
  assert.deepEqual(labels, ['at-the-vault', 'at-the-bank']);
  assert.equal(s.find(x => x.tool === 'vault').needs, 'at-the-vault');
  assert.equal(s.find(x => x.tool === 'bank').needs, 'at-the-bank');
  for (const l of labels)
    assert.equal(s.find(x => x.label === l).expect, 'arrived',
                 `${l} is only reached if the walk says it arrived`);
});

test('sellrun: the shops never run the keeper own errands', () => {
  // Left at its default, each travel hop runs the KEEPER's bank/sell/supply errands first —
  // selling the pack to the keeper's default merchant before it ever reaches a specialist,
  // which is the very thing this circuit replaces. It has to hold for the two new legs too:
  // a keeper errand on the way to the vault sells what the vault was going to store.
  for (const s of steps({ ...base, vault: { room: 114 }, bank: { room: 54, keep: 500 } }))
    if (s.tool === 'travel') assert.equal(s.args.run_errands, false, `${s.why}`);
});

// ------------------------------------------------- what the runner does with those flags
//
// The flags above are only worth writing if the runner reads them, and for `optional` it did
// not: steps have carried the field since the feast errand's walk-to-the-table, on the belief
// that a failed approach could not cost a courier its food, and the runner had never looked at
// it. These four pin the behaviour rather than the field.

const runner = (results, seen = []) => ({
  call: async (tool, args) => {
    if (tool === 'autopilot') { seen.push(args.action); return {}; }
    if (tool === 'cancel_movement') { seen.push('cancel'); return {}; }
    seen.push(tool);
    const r = results[tool];
    return typeof r === 'function' ? r() : (r ?? { arrived: true });
  },
  write: async () => ({ dry_run: true }),
});

const circuit = steps => ({ rule: 'barloque-sell-circuit', kind: 'errand', why: 'x',
                            orders: { errand: 'sellrun-circuit', agent: 'a', steps } });

test('runner: an optional step that fails does not stop the errand', async () => {
  const seen = [];
  const applied = await runErrand(
    runner({ vault: { error: 'no vaultman in this room' } }, seen),
    circuit([
      { tool: 'vault', args: { agent: 'a' }, optional: true },
      { tool: 'bank', args: { agent: 'a', action: 'deposit', keep: 500 } },
      { tool: 'travel', args: { agent: 'a', to: 39 }, always: true },
    ]), { commit: true, holder: 'dum/test@pid-1' });
  assert.ok(seen.includes('bank'), 'the banking still happened');
  assert.ok(seen.includes('travel'), 'and so did the walk home');
  assert.equal(applied.stopped, null, 'the errand did not stop');
  assert.ok(applied.results.some(r => r.optional && /no vaultman/.test(r.failed ?? '')),
            'and the failure is on the record rather than swallowed');
});

test('runner: a NON-optional step that fails still stops it', async () => {
  // The other half. `optional` has to be opt-in, or the first thing it does is hide a real
  // failure in the middle of a circuit that then walks on regardless.
  const seen = [];
  const applied = await runErrand(
    runner({ vault: { error: 'no vaultman in this room' } }, seen),
    circuit([
      { tool: 'vault', args: { agent: 'a' } },
      { tool: 'bank', args: { agent: 'a', action: 'deposit', keep: 500 } },
      { tool: 'travel', args: { agent: 'a', to: 39 }, always: true },
    ]), { commit: true, holder: 'dum/test@pid-1' });
  assert.ok(!seen.includes('bank'), 'the banking was skipped');
  assert.ok(seen.includes('travel'), 'but `always` still got it home');
  assert.match(applied.stopped ?? '', /no vaultman/);
});

test('runner: `needs` skips a step whose walk never arrived', async () => {
  // A deposit sent from wherever the character actually ended up is harmless — the tool
  // resolves the NPC off the live room and refuses — but it is a packet sent hopefully.
  const seen = [];
  await runErrand(
    runner({ travel: { arrived: false, reason: 'no route' } }, seen),
    circuit([
      { tool: 'travel', args: { agent: 'a', to: 114 }, expect: 'arrived',
        optional: true, label: 'at-the-vault' },
      { tool: 'vault', args: { agent: 'a' }, optional: true, needs: 'at-the-vault' },
      { tool: 'travel', args: { agent: 'a', to: 39 }, always: true },
    ]), { commit: true, holder: 'dum/test@pid-1' });
  assert.ok(!seen.includes('vault'), 'nothing was sent to a counter it never reached');
});

test('runner: a walk that timed out is cancelled even when it was optional', async () => {
  // A walk nobody is waiting for any more is still a walk in flight, and it is what makes
  // the NEXT step fail "busy: walk to ...". The cancel is not conditional on caring.
  const seen = [];
  await runErrand(
    runner({ travel: { started: true } }, seen),
    circuit([
      { tool: 'travel', args: { agent: 'a', to: 114 }, expect: 'arrived',
        optional: true, label: 'at-the-vault', timeout_ms: 1 },
      { tool: 'travel', args: { agent: 'a', to: 39 }, always: true },
    ]), { commit: true, holder: 'dum/test@pid-1' });
  assert.ok(seen.includes('cancel'), 'the dangling walk was cancelled');
});

// ---------------------------------------------- the keep list, against the shipped doctrine
//
// A KEEP LIST IS THE ONLY THING BETWEEN A MERCHANT AND EVERYTHING THE PACK HOLDS. `sell_all`
// offers him what he will take; the list is a hand-written set of substrings, and the sale
// reports success whether or not it sold the thing that mattered. So it is asserted against
// the doctrine that actually ships, not against a fixture — a fixture would still pass on the
// day somebody edits the file.

const kept = name => SELL_KEEP.some(
  k => name.toLowerCase().includes(String(k).toLowerCase()));

test('sellrun: the free food is never offered to a merchant', () => {
  // THE FEAST RUN AND THE SELL RUN WOULD OTHERWISE UNDO EACH OTHER. Resting stops awarding
  // vigor at 80 of 200 and everything above it has to be eaten; the Duke's tables are where
  // this fleet gets that for nothing. A courier can be carrying a hundred slices when its
  // pack trips the carry trigger, and a sell run that does not name them sells the lot for a
  // handful of shillings.
  for (const meal of ['slice of pork', 'bowl of soup', 'edible mushroom', 'Inky-cap mushroom'])
    assert.equal(kept(meal), true, `${meal} must never reach a counter`);
});

test('sellrun: four of the five mushrooms are still SOLD', () => {
  // The other direction, and the one that costs money if it goes wrong. Only two of this
  // world's five mushrooms are food; the rest are casting reagents that Joguer buys, and a
  // keep list containing a bare "mushroom" would match all five and quietly stop the fleet
  // selling its reagent loot. The operator lost a pack to the opposite reading on 2026-09-04.
  for (const stock of ['mushroom', 'red mushroom', 'blue mushroom'])
    assert.equal(kept(stock), false, `${stock} is a reagent and is meant to be sold`);
});

test('sellrun: the create-food reagents stay in the pack, and out of the vault', () => {
  // Herbs and elderberry are what Create Food is made of, so they are kept from the merchant
  // AND kept out of the vault — a reagent in Barloque is no use to a character casting in
  // Castle Victoria, and retrieving it costs a fee and a trip.
  assert.equal(kept('herb'), true);
  assert.equal(kept('elderberry'), true);
  const vaultItems = BARLOQUE_VAULT.items;
  for (const r of ['herb', 'elderberry'])
    assert.equal(vaultItems.some(v => r.includes(String(v).toLowerCase())), false,
                 `${r} is wanted in the pack, not in Barloque`);
});

// --------------------------------------------------- the whole return route, in order
//
// THE OPERATOR'S ORDER, 2026-09-05: vault, sell, bank, drop, yell, then the Duke's tables.
// Every step earns the next one, and the sequence is the argument:
//
//   * the vault takes what is worth keeping, before a keep list can get it wrong
//   * the shops take what will sell
//   * the bank takes what they paid, so the walk home carries no purse
//   * and only THEN does anything go in the road — so what hits the street is exactly what
//     no counter in the world wanted. Dropping earlier throws money away; carrying it home
//     hauls it for nothing.
//   * which leaves the pack empty immediately before the tables, which is the whole reason
//     the food is last: everything the character can hold is now food.

const FULL = { ...base, giveaway: { on: true }, finish: 'feast' };

test('sellrun: vault, sell, bank, drop, yell, feast — in that order', () => {
  assert.deepEqual(tools(FULL), [
    'travel', 'vault',            // what is worth keeping
    'travel', 'sell_all',         // what will sell
    'travel', 'sell_all',
    'travel', 'bank',             // what they paid
    'travel', 'drop_all', 'say',  // what nobody wanted, and the shout about it
    'travel',                     // the Duke's tables
  ]);
  const s = steps(FULL);
  assert.equal(s[s.length - 1].args.to, FEAST_HALL.room, 'it ends at the hall, not at home');
  assert.equal(s[s.length - 1].always, true, 'and gets there even after a stop failed');
  assert.equal(s.find(x => x.tool === 'drop_all') && true, true);
  assert.equal(s[s.findIndex(x => x.tool === 'drop_all') - 1].args.to, STREETS_OF_TOS);
  assert.equal(s.find(x => x.tool === 'say').args.text, GIVEAWAY_YELL);
  assert.equal(s.find(x => x.tool === 'say').args.type, 'yell');
});

test('sellrun: the drop comes AFTER every counter, never before one', () => {
  // The ordering IS the correctness here, so it is asserted as an ordering rather than as a
  // list: anything that could have been sold, banked or stored must have had its chance.
  const t = tools(FULL);
  const drop = t.indexOf('drop_all');
  assert.ok(drop > t.lastIndexOf('sell_all'), 'after the last shop');
  assert.ok(drop > t.indexOf('vault'), 'after the vault');
  assert.ok(drop > t.indexOf('bank'), 'after the bank');
  assert.ok(t.indexOf('say') > drop, 'and nobody is invited to a pile that is not there yet');
});

test('sellrun: exactly one weapon survives the shops — the one in hand', () => {
  // `max_weapons` counts equipped plus carried, and OMITTING IT MEANS NULL, WHICH MEANS KEEP
  // EVERY WEAPON. For as long as this circuit existed it walked every spare blade to
  // Barloque, declined to sell any of them, and walked them home again. One rather than zero
  // because a character with no weapon cannot fight and the keeper would buy one back.
  for (const sell of steps(FULL).filter(x => x.tool === 'sell_all'))
    assert.equal(sell.args.max_weapons, 1, sell.args.merchant);
  assert.equal(steps({ ...FULL, max_weapons: 3 }).find(x => x.tool === 'sell_all')
                 .args.max_weapons, 3, 'a doctrine may still say otherwise');
});

test('sellrun: a spare weapon is SOLD, not dropped — the keep list never spares one', () => {
  // The two halves of the same instruction. The shops are told to keep one weapon, and the
  // street keep list names only food and the create-food reagents — so a blade the smith
  // refuses has been past the one counter that wanted it and has earned the road.
  const keep = steps(FULL).find(x => x.tool === 'drop_all').args.keep;
  for (const w of ['battle axe', 'long sword', 'mace', 'dagger'])
    assert.equal(keep.some(k => w.includes(k)), false, `${w} must not be spared from the drop`);
});

test('sellrun: home is still the default, and the giveaway is still opt-in', () => {
  // Dropped is gone, and a fleet with no feast running should still come home. Silence has
  // to mean the behaviour that was already there.
  const t = tools(base);
  assert.equal(t.includes('drop_all'), false);
  assert.equal(t.includes('say'), false);
  assert.equal(steps(base)[steps(base).length - 1].args.to, 39, 'back where it was hunting');
});

test('sellrun: finishing at the feast does not require the giveaway, or vice versa', () => {
  // Two switches, two decisions. Somebody may want the food run without the litter, or the
  // litter without the food run, and neither should silently imply the other.
  const feastOnly = tools({ ...base, finish: 'feast' });
  assert.equal(feastOnly.includes('drop_all'), false);
  assert.equal(steps({ ...base, finish: 'feast' }).slice(-1)[0].args.to, FEAST_HALL.room);
  const dropOnly = tools({ ...base, giveaway: { on: true } });
  assert.ok(dropOnly.includes('drop_all'));
  assert.equal(steps({ ...base, giveaway: { on: true } }).slice(-1)[0].args.to, 39);
});
