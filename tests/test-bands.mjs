// A STATION THAT KNOWS WHAT SIZE OF CHARACTER IT IS FOR.
//
// The failure this feature exists to end is not a crash. It is that cohort membership was a
// LIST OF NAMES in two doctrine files, maintained by hand, and a list of names is a snapshot
// of one afternoon. The Valley of Ileria pays a character only while its max health is under
// 50 — a kill advances you only when the creature's level is strictly above it, and the
// fungus beast is 50 — so nine characters went on killing 28 an hour in a room that had
// stopped paying any of them, reading healthy on every board, until somebody noticed and
// edited two files and restarted two processes. `yield_check` was the only field in the
// system that said so.
//
// So the assertions worth keeping here are the ones that fail in the dangerous direction:
// that a band is a HARD gate rather than a preference the overflow can route around, that a
// hole between two bands is refused at load rather than discovered as a character standing
// still for ever, that the boundary belongs to exactly one station, and that a crossing is
// recorded once and is satisfied by the run it asks for rather than repeating.

import assert from 'node:assert/strict';
import { loadDoctrine } from '../src/config/load.mjs';
import { validate } from '../src/config/schema.mjs';
import { shiftAssignments, shiftFleetRules, stationBand, bandAdmits, huntList,
  stationIndexFor, bandMemory } from '../src/decide/rules/shift.mjs';
import { handoverOwed, handoverWaiting, sellCircuitWants,
  sellrunFleetRules } from '../src/decide/rules/sellrun.mjs';
import { HUNT_ROOMS, QUARRY_LEVEL } from '../src/strategies/catalog.mjs';

const test = globalThis.__dumTest;

// The two stations this was built for: Upstairs Castle Victoria (39, battered skeleton at
// level 60, difficulty 4) for anyone the level-60 kill still pays and can survive, and the
// Valley of Ileria (544, fungus beast at 50, difficulty 1 — the softest fight in the game)
// for anyone under 50 whom the castle is hardest on and pays least.
const STATIONS = [
  { room: 39, hunt: ['battered skeleton', 'zombie'], max_health: { at_least: 50 },
    use_safe_spots: true, rest_below: 0.85, flee_below: 0.45, fight_above_vigor: 80 },
  { room: 544, hunt: 'fungus beast', max_health: { below: 50 },
    use_safe_spots: false, rest_below: 0.85, flee_below: 0.45, fight_above_vigor: 80 },
];

const doctrine = (over = {}) => {
  const d = loadDoctrine({ file: 'doctrines/castle-graveyard.jsonc' }).config;
  d.shift = { on: true, stations: STATIONS, rest_below: 0.75, flee_below: 0.35,
              fight_above_vigor: 180, use_safe_spots: true, handover: { on: true }, ...over };
  d.castle_victoria = { ...d.castle_victoria, shift: false };
  d.graveyard = { ...d.graveyard, shift: false };
  return d;
};

const row = (agent, level, over = {}) => ({
  agent, in_game: true, level, room: 39, mode: 'farm', activity: 'idle',
  policy: {}, commitment: null, parked: null, piloted: null, ...over,
});
const obsOf = (rows, over = {}) => ({ characters: rows, strategies: { agents: {} },
  at: 1_000_000, memory: {}, ...over });
const fire = (rows, d = doctrine(), over = {}) =>
  shiftFleetRules[0].decide(obsOf(rows, over), d);

test('bands: max health decides the room, and nobody had to be named', () => {
  // A twenty-one character fleet spread either side of the boundary, which is the case this
  // was written against: eleven at or over 50 and ten under it, on ONE doctrine with no
  // cohort list anywhere and no `--agent` scope. Handles are positional here on purpose —
  // this repository is public and the real ones identify accounts on a shared server.
  const spread = [54, 53, 53, 53, 52, 51, 51, 50, 50, 50, 50,
                  49, 48, 48, 48, 47, 47, 46, 46, 43, 43];
  const fleet = spread.map((mh, i) => row(`role-${i}`, mh));
  const got = shiftAssignments(fleet, doctrine());
  const where = Object.fromEntries(got.map(a => [a.row.agent, [a.to, a.row.level]]));
  for (const [agent, [to, mh]] of Object.entries(where))
    assert.equal(to, mh >= 50 ? 39 : 544, `${agent} at ${mh} max health`);
  assert.equal(got.filter(a => a.to === 39).length, 11);
  assert.equal(got.filter(a => a.to === 544).length, 10);
  assert.equal(got.filter(a => a.to == null).length, 0, 'nobody is left unplaced');
});

test('bands: 50 belongs to exactly one station, and it is the upper one', () => {
  // `at_least` inclusive and `below` exclusive is the whole reason those two bounds were
  // chosen. If the boundary were claimed twice the first station would silently win and the
  // pair would look symmetric while behaving otherwise; if it were claimed by neither, a
  // character sitting exactly on it would stand still for ever.
  assert.equal(bandAdmits(STATIONS[0], 50), true);
  assert.equal(bandAdmits(STATIONS[1], 50), false);
  assert.equal(bandAdmits(STATIONS[0], 49), false);
  assert.equal(bandAdmits(STATIONS[1], 49), true);
  assert.equal(stationIndexFor(STATIONS, 50), 0);
  assert.equal(stationIndexFor(STATIONS, 49), 1);
});

test('bands: the gate is HARD — an overflow may not route around it', () => {
  // The fallback loop at the bottom of shiftAssignments exists for a unit too SMALL for the
  // first quarry, and it walks the stations in order. Before the band was folded into
  // `eligible` it would have handed a 43-max-health character straight to room 39 the moment
  // the valley hit a capacity cap, and called it an overflow.
  const d = doctrine({ stations: [{ ...STATIONS[0] }, { ...STATIONS[1], max: 1 }] });
  const got = shiftAssignments([row('a', 43), row('b', 44), row('c', 45)], d);
  const placed = got.filter(a => a.to === 544);
  assert.equal(placed.length, 1, 'the cap is honoured');
  for (const a of got.filter(x => x.to !== 544))
    assert.equal(a.to, null,
      'an under-50 that overflows the valley is UNPLACED, never promoted to the castle');
});

test('bands: an unknown max health is refused rather than guessed at', () => {
  assert.equal(bandAdmits(STATIONS[0], null), false);
  assert.equal(bandAdmits(STATIONS[1], undefined), false);
  // ...but a station with no band still admits everyone its ceiling allows, which is what
  // every doctrine written before this had.
  assert.equal(bandAdmits({ room: 39, hunt: 'battered skeleton' }, null), true);
  assert.equal(stationBand({ room: 39 }), null);
  assert.equal(stationBand({ room: 39, max_health: {} }), null);
});

test('bands: a banded station takes its whole band without being given a share', () => {
  // Without the explicit `bandTakesAll`, a first station with no `share` computes
  // `want = round(n * 0)` = 0 and every character falls through to the fallback loop — which
  // happens to produce the right answer today, by accident, through a path whose own comment
  // says it is for units too small for the first quarry. Correct-by-accident is the state
  // this assertion exists to stop returning to.
  const got = shiftAssignments([row('a', 54), row('b', 53), row('c', 52)], doctrine());
  assert.equal(got.filter(a => a.to === 39).length, 3);
  // AND A BAND NEVER LEAVES SOMEBODY UNPLACED WHO HAS A HOME, whatever the share says. With
  // `share: 0` the allocation pass takes nobody and the fallback loop catches them — which is
  // the right outcome and the reason the fallback exists: unplaced means `roam: false` in a
  // room nobody chose, for ever. The band is what stops the fallback picking the WRONG
  // station; it is not a reason to pick none.
  const d = doctrine({ stations: [{ ...STATIONS[0], share: 0 }, STATIONS[1]] });
  const shared = shiftAssignments([row('a', 54), row('b', 53)], d);
  assert.equal(shared.filter(a => a.to === 39).length, 2);
  assert.equal(shared.filter(a => a.to === 544).length, 0,
    'and never into the band that does not admit them');
});

test('bands: each station carries its own posture', () => {
  // The Valley measured BETTER with safe spots off — takeSafeSpot/returnToSpot oscillates on
  // the fine walker there, and the fleet sat at "travelling / NOT MOVING" with fungus beasts
  // in reach and zero kills for hours — while the castle's difficulty-4 fight wants the wall.
  // Before this, saying both meant two doctrines, which meant two processes.
  const out = fire([row('a', 54, { policy: {} }), row('b', 43, { policy: {} })]);
  const bySpot = Object.fromEntries(out.plan.map(s => [s.agent, s]));
  assert.equal(bySpot.a.use_safe_spots, true);
  assert.equal(bySpot.b.use_safe_spots, false);
  assert.equal(bySpot.a.to, 39);
  assert.equal(bySpot.b.to, 544);
  assert.deepEqual(bySpot.a.hunt, ['battered skeleton', 'zombie']);
  assert.equal(bySpot.b.hunt, 'fungus beast');
  // And a station that says nothing falls back to the shift's own number, not to a default
  // buried somewhere else.
  const d = doctrine({ stations: [{ room: 39, hunt: 'battered skeleton', max_health: { at_least: 40 } }] });
  const plain = fire([row('a', 54)], d).plan[0];
  assert.equal(plain.rest_below, 0.75);
  assert.equal(plain.fight_above_vigor, 180);
});

test('bands: a hunt LIST is compared as a set, or the shift redeploys every pass', () => {
  // `['battered skeleton','zombie'] !== ['battered skeleton','zombie']` is true for two
  // arrays, so a station naming a pair would look like drift on every single pass: deploy,
  // stop the keeper, restart it, read the same value back, deploy again. That is the exact
  // loop prod-cv-upstairs.jsonc's fight_above_vigor comment paid for once already.
  const settled = row('a', 54, { room: 39, policy: {
    assignedRoom: 39, hunt: ['battered skeleton', 'zombie'], roam: false, purpose: 'advance' } });
  const out = fire([settled]);
  assert.equal(out.kind, 'pass', out.why);
  assert.match(out.why, /already hold their station orders/);
  assert.equal(huntList({ hunt: 'fungus beast' }).length, 1);
  assert.equal(huntList({ hunt: ['a', 'b'] }).length, 2);
  assert.equal(huntList({}).length, 0);
});

test('bands: the ceiling still gates, and it is sized to the ROOM', () => {
  // A band says which characters a station is FOR; the engagement ceiling says which it can
  // survive, and both have to pass. At 39 max health the ceiling is round(39 * 1.5) = 59
  // against room 39's threat of 60, so the castle refuses this character on the ceiling
  // whatever its band says — and the valley (threat 50) takes it.
  assert.equal(stationIndexFor([STATIONS[0]], 39), -1);
  assert.equal(stationIndexFor(STATIONS, 39), 1);
  // NOTE FOR THE NEXT ROOM ADDED. `admitsStation` checks EVERY name a station lists rather
  // than the first, because a character admitted on the strength of the softer quarry would
  // stand in the room refusing the other half of what appears — everything works and none of
  // it is worth anything. It cannot be demonstrated against today's table: in every rated
  // room the threat is at least the toughest thing the room GENERATES (2600 is the
  // interesting one — mummies at 40 in a room rated 75, because a level-75 statue stands in
  // it), so the room gate already subsumes the per-quarry one. The loop is the guard for the
  // first room where that stops being true.
  for (const r of Object.values(HUNT_ROOMS))
    assert.ok(Math.max(...r.generates.map(q => QUARRY_LEVEL[q])) <= r.threat,
      `${r.name} generates something above its own threat: the per-quarry ceiling check has ` +
      'become observable and deserves a real assertion here');
});

// ---------------------------------------------------------------- the crossing

test('handover: a crossing is recorded, a first sighting is not', () => {
  // A fleet that has never run this doctrine has no memory at all. Treating that as
  // "everybody just changed band" would send twenty-one characters to Barloque in one round,
  // down the roads that are the only thing killing this fleet.
  const rows = [row('a', 54), row('b', 43)];
  const first = fire(rows);
  assert.equal(first.remember.topic, 'band');
  assert.equal(first.remember.patch.a.handover_since, null, 'first sight owes nothing');
  assert.equal(first.remember.patch.a.band, '39');
  assert.equal(first.remember.patch.b.band, '544');

  // Now `a` drops to 49 — a death took max health off it — and crosses into the valley.
  const memory = { band: { a: { band: '39', at: 1, handover_since: null },
                           b: { band: '544', at: 1, handover_since: null } } };
  const after = fire([row('a', 49), row('b', 43)], doctrine(), { memory });
  assert.equal(after.remember.patch.a.band, '544');
  assert.equal(after.remember.patch.a.handover_since, 1_000_000, 'the crossing is stamped');
  assert.equal(after.remember.patch.a.from, '39');
  assert.equal(after.remember.patch.b, undefined, 'nothing changed for b, so b is not rewritten');
});

test('handover: a unit stepped over mid-errand does not owe a run it has not been moved for', () => {
  // The handover ends at the Duke's tables and the feast rule walks the character home to
  // `policy.assignedRoom`. Recording the crossing for a character that was NOT redeployed
  // this pass would owe a run that comes home to the room it is leaving.
  const memory = { band: { a: { band: '39', at: 1, handover_since: null } } };
  const busy = row('a', 49, { activity: 'travelling to Barloque' });
  const out = fire([busy, row('b', 43)], doctrine(), { memory });
  assert.equal(out.remember?.patch?.a, undefined,
    'a was not deployed this pass, so its crossing is not stamped yet');
});

test('handover: the flag is satisfied by the run it asks for, and never loops', () => {
  const mem = { band: { a: { band: '544', handover_since: 500 } }, sellrun: {} };
  assert.equal(handoverOwed('a', mem), true, 'crossed and has not sold since');
  mem.sellrun.a = { last_run_at: 400, ok: true };
  assert.equal(handoverOwed('a', mem), true, 'a run BEFORE the crossing does not count');
  mem.sellrun.a = { last_run_at: 600, ok: true };
  assert.equal(handoverOwed('a', mem), false, 'the run that followed the crossing satisfies it');
  assert.equal(handoverOwed('a', { band: { a: { band: '544', handover_since: null } } }), false);
  assert.equal(handoverOwed('a', null), false);
});

test('handover: an owed run fires on an empty pack, and a hurt one still waits', () => {
  const cfg = { on: true, trigger: { carry_at: 20, min_health: 0.8 } };
  const light = { agent: 'a', carrying: 3, purse: 100, health: { pct: 1 } };
  assert.equal(sellCircuitWants(light, cfg), false, 'three items is not a sell trip');
  const owed = { band: { a: { handover_since: 500 } } };
  assert.equal(sellCircuitWants(light, cfg, owed), true, 'unless it has just changed station');
  // THE HEALTH FLOOR IS THE ONE GATE A HANDOVER DOES NOT SKIP. The commonest way into this
  // branch is DYING, and a character comes out of the Underworld at a fraction of its bar.
  // Forty hops in that state is not a wrap-up run, it is another road death.
  assert.equal(sellCircuitWants({ ...light, health: { pct: 0.3 } }, cfg, owed), false);
});

test('handover: an owed run skips the cooldown, because the trip is not about the pack', () => {
  const d = doctrine();
  d.sellrun = { on: true, stops: [{ room: 113, merchant: "Fehr'loi Qan" }],
                trigger: { carry_at: 20, min_health: 0.8 }, cooldown_ms: 20 * 60_000 };
  const obs = {
    at: 1_000_000, characters: [{ agent: 'a', in_game: true, level: 44, room: 39,
      carrying: 2, purse: 900, health: { pct: 1 }, commitment: null }],
    memory: { band: { a: { band: '544', handover_since: 999_000 } },
              // Sold one minute ago, which normally means eighteen more minutes of waiting.
              sellrun: { a: { last_run_at: 940_000, ok: true } } },
  };
  const out = sellrunFleetRules[0].decide(obs, d);
  assert.equal(out?.kind, 'errand');
  assert.equal(out.orders.agent, 'a');
  assert.match(out.why, /changed station/);
  assert.equal(out.evidence.handover.band, '544');
});

test('handover: switching it off leaves the reassignment and drops the trip', () => {
  const memory = { band: { a: { band: '39', at: 1, handover_since: null } } };
  const out = fire([row('a', 49)], doctrine({ handover: { on: false } }), { memory });
  assert.equal(out.kind, 'act');
  assert.equal(out.plan[0].to, 544, 'the character is still reassigned');
  assert.equal(out.remember, null, 'it just does not owe a last run');
});

// ---------------------------------------------------------------- the schema

test('bands: a hole between two bands is refused at LOAD, not discovered in a room', () => {
  // `{below: 50}` and `{at_least: 51}` looks like a pair and leaves everybody at exactly 50
  // with nowhere to go — unplaced, roaming off, standing where they are indefinitely,
  // hunting something that does not spawn there and reporting healthy the whole time.
  const d = doctrine({ stations: [
    { room: 39, hunt: 'battered skeleton', max_health: { at_least: 51 } },
    { room: 544, hunt: 'fungus beast', max_health: { below: 50 } }] });
  const bad = validate(d);
  assert.ok(bad.some(b => b.where === 'shift.stations' && /max health 50/.test(b.why)),
    JSON.stringify(bad));
  // And the pair that tiles cleanly passes.
  assert.equal(validate(doctrine()).filter(b => b.where.startsWith('shift')).length, 0);
});

test('bands: every band having a ceiling is refused, because growth falls out of the shift', () => {
  const d = doctrine({ stations: [
    { room: 544, hunt: 'fungus beast', max_health: { below: 50 } },
    { room: 39, hunt: 'battered skeleton', max_health: { at_least: 50, below: 60 } }] });
  assert.ok(validate(d).some(b => /grows past the highest one/.test(b.why)));
});

test('bands: an empty band and an unknown bound are refused', () => {
  const empty = doctrine({ stations: [
    { room: 39, hunt: 'battered skeleton', max_health: { at_least: 50, below: 50 } },
    { room: 544, hunt: 'fungus beast', max_health: { below: 50 } }] });
  assert.ok(validate(empty).some(b => /admit nobody/.test(b.why)));
  const typo = doctrine({ stations: [
    { room: 39, hunt: 'battered skeleton', max_health: { at_most: 50 } },
    { room: 544, hunt: 'fungus beast', max_health: { below: 50 } }] });
  assert.ok(validate(typo).some(b => /unknown band bound/.test(b.why)));
});

test('bands: a station may name a PAIR of quarry, and a wrong one is still refused', () => {
  // Room 39's spawn cap is a room-wide TOTAL, so a cohort that declines the zombies standing
  // next to it lets them hold the cap that would otherwise have spawned more skeletons. Until
  // the schema read a list, `generates.includes([...])` was false for every array and the
  // pair could not be said here at all.
  assert.equal(validate(doctrine()).filter(b => b.where.startsWith('shift')).length, 0);
  const wrong = doctrine({ stations: [
    { room: 39, hunt: ['battered skeleton', 'frogman'], max_health: { at_least: 50 } },
    { room: 544, hunt: 'fungus beast', max_health: { below: 50 } }] });
  assert.ok(validate(wrong).some(b => /"frogman"/.test(b.why)), 'the bad half is named');
  const none = doctrine({ stations: [
    { room: 39, max_health: { at_least: 50 } },
    { room: 544, hunt: 'fungus beast', max_health: { below: 50 } }] });
  assert.ok(validate(none).some(b => /tells it to kill\s+nothing/.test(b.why)));
});

test('handover: the feast dispatch yields the pass, because it is starved otherwise', () => {
  // ONE INTENT PER PASS, and the feast sits above the sell circuit. The feast has something
  // to say on nearly every pass — 464 dispatches against a 13% arrival rate, measured on prod
  // the day this was written — so a handover starved behind it never happens, and nothing
  // looks wrong: the character IS reassigned, it DOES walk to its new station, and the
  // wrap-up quietly does not occur.
  const cfg = { on: true, trigger: { carry_at: 20, min_health: 0.8 } };
  const rows = [
    { agent: 'a', in_game: true, carrying: 2, health: { pct: 1 }, commitment: null },
    { agent: 'b', in_game: true, carrying: 2, health: { pct: 1 }, commitment: null },
  ];
  assert.equal(handoverWaiting(rows, cfg, { band: {} }), null, 'nobody owes one');
  assert.equal(handoverWaiting(rows, cfg, { band: { b: { handover_since: 5 } } }), 'b');
  // A character too hurt to make the trip must NOT hold the feast up waiting for it — the
  // circuit would refuse it on the same floor, so the pass would be yielded to nobody.
  const hurt = [{ ...rows[0] }, { ...rows[1], health: { pct: 0.3 } }];
  assert.equal(handoverWaiting(hurt, cfg, { band: { b: { handover_since: 5 } } }), null);
  // And with the circuit switched off there is nothing to yield to.
  assert.equal(handoverWaiting(rows, { on: false }, { band: { b: { handover_since: 5 } } }), null);
});
