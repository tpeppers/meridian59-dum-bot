// KEEPING A FACTION, NOT JOINING ONE.
//
// These pin the half of the faction surface driven by the SERVER rather than by an
// operator: a membership decays on a wall-clock timer, the only notice is a sentence with
// no packet behind it, and four hours after that sentence the membership is gone and
// costs the whole join quest to get back.
//
// The assertions worth keeping are the ones that fail in the dangerous direction if
// somebody inverts them later: that a repeated warning is the same deadline, that a
// soldier's warning is not work, that a revoked membership is never retried, and that a
// merchant which can run dry is never planned against.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactionGoalStore } from '../src/record/factions.mjs';
import { loyaltySpec, loyaltyPayment, loyaltyPurchase, LOYALTY_CATALOG }
  from '../src/factions/catalog.mjs';
import { loyaltyFleetRules, activeFactionWork } from '../src/decide/rules/factions.mjs';
import { ERRANDS } from '../src/act/errands.mjs';
import { deny, WRITE, NOT_YET } from '../src/link/surface.mjs';


const test = globalThis.__dumTest;
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const debt = (over = {}) => ({ faction: 'rebel', warned_at: NOW - HOUR,
  due_at: NOW + 3 * HOUR, due_in_ms: 3 * HOUR, expired: false, soldier: false,
  automated: true, ...over });

const row = (agent, over = {}) => ({
  agent, in_game: true, level: 60, room: 27, mode: 'farm', purse: 500,
  health: { value: 60, max: 60, pct: 1 }, commitment: null, parked: null, piloted: null,
  policy: { hunt: 'spider', assignedRoom: 27, purpose: 'money', roam: true,
    maxThreatOver: 6, protectedItems: [] },
  items: [], loyalty_debt: debt(), ...over,
});

const obs = (rows, loyalty = {}) => ({ at: NOW, characters: rows, factions: { loyalty } });

// The rules are called directly rather than through `decide`, which additionally gates on
// the doctrine having CLAIMED the faculty. That gate is real and tested elsewhere; here
// the subject is the rule table's own ordering and refusals.
const firedOn = (observation) => {
  for (const rule of loyaltyFleetRules) {
    const intent = rule.decide(observation, {});
    if (intent) return { ...intent, rule: rule.id };
  }
  return null;
};
const fired = (rows, loyalty) => firedOn(obs(rows, loyalty));

// ---------------------------------------------------------------------------

test('loyalty: the catalogue matches the source, and the Duke is refused rather than guessed', () => {
  // Node 198's cargo list is seven entries and the liege names ONE of them
  // (questengine.kod:5686-5693). Seven, not six: dropping one silently makes a legitimate
  // assignment unrecognisable.
  assert.equal(LOYALTY_CATALOG.rebel.accepts.length, 7);
  assert.equal(loyaltySpec('jonas').room, 371);
  assert.equal(loyaltySpec('princess').supplied_by_liege, true,
    'the Princess hands over the letter, so there is nothing to carry in');
  assert.equal(loyaltySpec('duke').automated, false,
    'his middle leg names a different townsperson each time; that is operator work');
});

test('loyalty: a payment is only planned at a counter that cannot run dry', () => {
  // "I have none of those" is a sentence spoken to the room, never an error on the wire,
  // so a plan resting on a merchant with finite stock reports success and comes home with
  // an empty pack and the hour gone.
  const plan = loyaltyPurchase('rebel');
  assert.equal(plan.item, 'long sword');
  assert.equal(plan.room, 154, 'Rook in Cor Noth — CorNothSergeant does not declare ' +
    'vbSellFromInventory, so his list is assembled on demand');
  assert.equal(plan.finite_stock, false);
  assert.equal(plan.wanders, false, 'a wanderer cannot be travelled to');
  assert.equal(loyaltyPurchase('princess'), null, 'she supplies the letter herself');
  assert.equal(loyaltyPurchase('duke'), null);

  assert.deepEqual(loyaltyPayment('rebel', [{ name: 'long sword' }, { name: 'mace' }]),
    [{ name: 'long sword' }]);
  assert.deepEqual(loyaltyPayment('rebel', []), [],
    'an empty pack is an empty list, never null');
});

test('loyalty: a repeated warning is the same deadline, not a new one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-loyalty-'));
  try {
    let now = NOW;
    const store = new FactionGoalStore({ dir, fleet: 'fixture', now: () => now });
    store.syncLoyalty('a', debt({ warned_at: NOW, due_at: NOW + 4 * HOUR }));
    assert.equal(store.read().loyalty.a.status, 'owed');
    assert.equal(store.read().loyalty.a.due_at, NOW + 4 * HOUR);

    // The server re-sends the warning every twenty minutes until the deadline, and every
    // one of them is about the SAME deadline. Re-dating on each would push the due time
    // forward for ever and the character would be expelled while the record said it had
    // hours left.
    now = NOW + 20 * 60_000;
    store.syncLoyalty('a', debt({ warned_at: NOW, due_at: NOW + 4 * HOUR }));
    assert.equal(store.read().loyalty.a.due_at, NOW + 4 * HOUR);
    assert.equal(store.read().loyalty.a.warned_at, NOW);

    // Survives a restart, because the deadline outlives this process by hours.
    assert.equal(new FactionGoalStore({ dir, fleet: 'fixture' }).read().loyalty.a.due_at,
      NOW + 4 * HOUR);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loyalty: the two clocks are kept apart, and a revoked membership is never retried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-loyalty-'));
  try {
    const store = new FactionGoalStore({ dir, fleet: 'fixture', now: () => NOW });
    store.syncLoyalty('a', debt({ warned_at: NOW, due_at: NOW + 4 * HOUR }));

    // The reply starts a ONE-hour quest timer inside the FOUR-hour grace. Both are kept:
    // one says whether there is still time to start, the other whether the attempt in
    // flight is running out, and they are opposite instructions.
    const serving = store.recordErrand({ acted: true, errand: 'loyalty-request', agent: 'a',
      results: [{ tool: 'faction_loyalty', result: { requested: true, faction: 'rebel',
        assigned: { item: 'long sword', target: "Jonas D'Accor", room: 371,
          time_limit_ms: HOUR } } }] }, { at: NOW });
    assert.equal(serving.status, 'serving');
    assert.equal(serving.item, 'long sword');
    assert.equal(serving.deadline_at, NOW + HOUR, 'the quest hour');
    assert.equal(serving.due_at, NOW + 4 * HOUR, 'the grace it sits inside, untouched');

    // A REVOKED MEMBERSHIP IS TERMINAL. The quest node is gone and the character is
    // neutral, so another trip would ask a stranger for work — `failed` is a resting
    // state, deliberately not a backoff.
    const lost = store.recordErrand({ acted: true, errand: 'loyalty-offer', agent: 'a',
      results: [{ tool: 'faction_loyalty', result: { offered: true, accepted: true,
        served: false, failed: true } }] }, { at: NOW });
    assert.equal(lost.status, 'failed');
    assert.equal(lost.retry_after, null, 'nothing to come back for');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loyalty: an ordinary failure backs off but an accepted service completes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-loyalty-'));
  try {
    const store = new FactionGoalStore({ dir, fleet: 'fixture', now: () => NOW });
    store.syncLoyalty('a', debt());

    // A CALL THAT MERELY COMPLETED IS NOT A PURCHASE. The proof is the pack.
    const missed = store.recordErrand({ acted: true, errand: 'loyalty-acquire', agent: 'a',
      results: [{ tool: 'faction_loyalty', result: { bought: false,
        reason: 'Rook did not list a long sword' } }] }, { at: NOW });
    assert.equal(missed.status, 'owed');
    assert.equal(missed.retry_after, NOW + 5 * 60_000);
    assert.equal(missed.last_error, 'Rook did not list a long sword');

    store.patchLoyalty('a', { status: 'serving', item: 'long sword', retry_after: null });
    const done = store.recordErrand({ acted: true, errand: 'loyalty-offer', agent: 'a',
      results: [{ tool: 'faction_loyalty', result: { served: true } }] }, { at: NOW });
    assert.equal(done.status, 'complete');

    // And the debt going away on its own closes the goal too.
    store.syncLoyalty('a', null);
    assert.equal(store.read().loyalty.a.status, 'complete');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('loyalty: a soldier is warned for ever and is never sent on the errand', () => {
  // `UpdateFactionService` clamps the counter at the warn threshold while a SoldierShield
  // is worn (player.kod:11203), so the deadline the warning implies never arrives. Read
  // naively, this would send every soldier in the fleet on the same errand every twenty
  // minutes, for ever.
  const soldier = row('s', { loyalty_debt: debt({ soldier: true, due_at: null, due_in_ms: null }) });
  assert.equal(fired([soldier], { s: null }), null);
  assert.equal(activeFactionWork({ at: NOW, factions: { loyalty: { s: {
    status: 'owed', due_at: null } } } }, 's'), false,
    'a warning with no deadline does not own the character');
});

test('loyalty: the Duke is left alone and a fleet of neutrals costs nothing', () => {
  assert.equal(fired([row('d', { loyalty_debt: debt({ faction: 'duke', automated: false }) })],
    { d: null }), null, 'recognised, and handed back rather than half-attempted');
  assert.equal(fired([row('n', { loyalty_debt: null })], { n: null }), null);
  assert.equal(fired([row('u', { loyalty_debt: undefined })], { u: null }), null,
    'unread is not the same as owing nothing');
});

test('loyalty: buy before asking, because the liege names one item out of seven', () => {
  // Asking converts a comfortable four-hour grace into a one-hour timer whose penalty is
  // expulsion. Carrying a candidate is only a one-in-seven head start, but a unit with
  // neither a candidate nor a purse cannot beat that hour at all.
  const empty = row('a', { items: [], purse: 500 });
  const buy = fired([empty], { a: { faction: 'rebel', status: 'owed', due_at: NOW + 3 * HOUR } });
  assert.equal(buy.kind, 'errand');
  assert.equal(buy.orders.errand, 'loyalty-acquire');
  assert.equal(buy.orders.steps[0].args.to, 154, 'to Rook, not to the liege');

  // Holding one, the ask comes first.
  const armed = row('a', { items: [{ id: 9, name: 'long sword' }] });
  const ask = fired([armed], { a: { faction: 'rebel', status: 'owed', due_at: NOW + 3 * HOUR } });
  assert.equal(ask.orders.errand, 'loyalty-request');
  assert.equal(ask.orders.steps[0].args.to, 371);
  assert.equal(ask.orders.steps[1].args.action, 'request');

  // Nothing to pay with and no purse: the walk is not started either, and the reason is
  // reported rather than the character silently being skipped.
  const broke = fired([row('a', { items: [], purse: 0 })],
    { a: { faction: 'rebel', status: 'owed', due_at: NOW + 3 * HOUR } });
  assert.equal(broke.kind, 'pass');
  assert.match(broke.why, /waiting on a free unit/);
});

test('loyalty: the delivery goes to the exact named item and recipient, inside the hour', () => {
  const goal = { faction: 'rebel', status: 'serving', item: 'long sword',
    target: "Jonas D'Accor", target_room: 371, due_at: NOW + 3 * HOUR, deadline_at: NOW + HOUR };
  const carrying = row('a', { items: [{ id: 42, name: 'long sword' }] });
  const intent = fired([carrying], { a: goal });
  assert.equal(intent.orders.errand, 'loyalty-offer');
  assert.equal(intent.orders.steps[1].args.item, 42);
  assert.equal(intent.orders.steps[1].args.target, "Jonas D'Accor");
  assert.equal(intent.orders.steps[2].always, true,
    'the interrupted work is restored even when the offer stops');

  // Carrying the wrong one of the seven is not carrying it. The liege named an item and
  // an ITEMFINDCLASS node compares the class, so a scimitar answers nothing.
  assert.notEqual(fired([row('a', { items: [{ id: 7, name: 'scimitar' }] })], { a: goal })
    ?.orders?.errand, 'loyalty-offer');

  // Past the quest hour there is nothing to deliver to; the goal is re-asked, not offered.
  const late = { at: NOW + 2 * HOUR, characters: [carrying], factions: { loyalty: { a: goal } } };
  assert.notEqual(firedOn(late)?.orders?.errand, 'loyalty-offer');
});

test('loyalty: a committed or piloted character is left alone', () => {
  const goal = { faction: 'rebel', status: 'owed', due_at: NOW + 3 * HOUR };
  const armed = { items: [{ id: 9, name: 'long sword' }] };
  for (const block of [{ commitment: 'loot run' }, { piloted: true }, { parked: true }]) {
    const intent = fired([row('a', { ...armed, ...block })], { a: goal });
    assert.equal(intent?.kind, 'pass', `${Object.keys(block)[0]} must not be interrupted`);
  }
});

test('loyalty: the surface widened by exactly one bounded primitive, and no further', () => {
  // The whole point of doing it this way: the trigger is a sentence the SERVER sent,
  // caught by the harness and handed over as a field. DUM still cannot read chat, hear a
  // player, or compose any text — the one word it causes to be spoken is a constant in
  // the harness.
  assert.equal(deny('faction_loyalty', { action: 'request' }), null);
  for (const shut of ['say', 'chat', 'converse', 'inbox', 'look_at', 'trade'])
    assert.equal(NOT_YET.has(shut), true, `${shut} must stay closed`);
  assert.match(deny('say', { text: 'loyalty' }) ?? '', /refused/);
  assert.equal(WRITE.has('faction_loyalty'), true);

  // An errand kind the runner does not know throws by design, so all three are registered.
  for (const kind of ['loyalty-acquire', 'loyalty-request', 'loyalty-offer'])
    assert.ok(ERRANDS[kind], `${kind} must be registered`);
});
