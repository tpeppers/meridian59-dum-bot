// THE SPELL-TRAINING PLAN, THE COURIER REQUESTS IT WRITES, AND ORDERS-ONLY MODE.
//
// The assertions worth keeping fail in the dangerous direction if inverted: a teleport or a
// creature-target spell drilled on a station; a buff list that silently means "all of them";
// an unread spell book read as an empty one (which switches the drill off AND sends the
// character shopping); somebody else's courier line lowered or deleted; and an orders-only
// doctrine whose other rules quietly start firing without a lease.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spellTrainingPlan, trainingSettings, exclusion, trainingWantsLearning,
  spellTrainingRequests, trainingCandidates, KEEPER_BUFFS } from '../src/decide/plans/spell-training.mjs';
import { shiftFleetRules } from '../src/decide/rules/shift.mjs';
import { learningFleetRules } from '../src/decide/rules/learning.mjs';
import { callsForFleetPlan } from '../src/act/fleet-plan.mjs';
import { mergeRequests, syncReagentRequests, writeJsonAtomic } from '../src/act/reagent-requests.mjs';
import { parseSpellCatalogue, reagentName } from '../src/sense/spell-catalogue.mjs';
import { enrichSpellTraining } from '../src/sense/observe.mjs';
import { decide, ORDERS_ONLY_FACULTIES } from '../src/decide/engine.mjs';
import { fleetRules, characterRules } from '../src/decide/index.mjs';
import { validate } from '../src/config/schema.mjs';
import { pass } from '../src/loop/tick.mjs';
import { Journal } from '../src/record/journal.mjs';
import { freshDefaults } from '../src/config/defaults.mjs';

const test = globalThis.__dumTest;
const tmp = () => mkdtempSync(join(tmpdir(), 'dum-st-'));

// A spell row as enrichSpellTraining leaves it on the fleet row.
const sp = (name, ability, extra = {}) => ({ name, ability, targets: 1, mana: 10,
  reagents: [['mushroom', 2]], harmful: false, parent: 'PersonalEnchantment', school: 'Kraanan', ...extra });

const book = () => [
  sp('magic shield', 40, { mana: 9, reagents: [['mushroom', 2], ['red mushroom', 1]] }),
  sp('free action', 20, { reagents: [['red mushroom', 1], ['purple mushroom', 1]] }),
  sp('bless', 99, { mana: 6, reagents: [['mushroom', 2], ['sapphire', 2]] }),
  sp('blink', 10, { parent: 'Spell', reagents: [], mana: 15 }),
  sp('hold', 5, { harmful: true, parent: 'Spell', reagents: [['purple mushroom', 2]] }),
  sp('light', 30, { parent: 'RoomEnchantment' }),
  sp('mystery', 10, { mana: null, reagents: [] }),
  sp('touch of flame', 60, { parent: 'TouchAttackSpell', targets: 0, reagents: [['red mushroom', 1]] }),
];

const STATION = { room: 552, plan: 'spell-training', max_health: { at_least: 150 } };
const trainer = (over = {}) => ({ agent: 'role-a', character: 'Caster One', in_game: true, level: 160,
  room: 552, mode: 'farm', policy: {}, commitment: null, parked: null, piloted: null,
  spells_known: book(), ...over });
const doctrine = (over = {}) => {
  const d = freshDefaults();
  d.claim = { ...d.claim, work: 'keeper', movement: 'keeper', economy: 'keeper', orders_only: true };
  d.strategies = { enabled: true, defaults: [], settings: {} };
  d.shift = { ...d.shift, on: true, stations: [STATION, { room: 552, farm_strategy: 'great-ocean-marion',
    max_health: { below: 150 } }] };
  Object.assign(d, over);
  return d;
};

// The keeper's policy once a trainer's station orders have landed.
const settled = (row, d = {}) => {
  const o = spellTrainingPlan(row, STATION, d).orders;
  return { ...row, mode: 'survive', policy: { assignedRoom: o.to, confineRooms: o.confine_rooms, roam: false,
    farmStrategy: null, molluskCoverRecovery: false, townTrips: false,
    practiceSpells: o.practice_spells, buffAllies: o.buff_allies } };
};

// ---------------------------------------------------------------- the practice list

test('spell training: exclusions — teleports, creature targets, room spells, no cost data, doctrine never', () => {
  const s = trainingSettings({ spell_training: { never: ['free action'] } }, trainer());
  const why = n => exclusion(book().find(x => x.name === n), s);
  assert.match(why('blink'), /never/);
  assert.match(why('hold'), /creature target/);
  assert.match(why('light'), /RoomEnchantment/);
  assert.match(why('mystery'), /no mana/);
  assert.match(why('free action'), /never/, 'the doctrine never-list adds to the built-in one');
  assert.equal(why('magic shield'), null);
});

test('spell training: priority first, then lowest ability; 99 is dropped; targets by kind', () => {
  const plan = spellTrainingPlan(trainer(), STATION, { spell_training: { priority: ['touch of flame'] } });
  assert.deepEqual(plan.practice, ['touch of flame', 'free action', 'magic shield']);
  assert.ok(!plan.practice.includes('bless'), 'a spell at 99 has nothing left to learn');
  const spells = plan.orders.practice_spells.spells;
  assert.deepEqual(spells.find(x => x.name === 'magic shield'),
    { name: 'magic shield', target: 'fleetmate', min_vigor: 16 }, 'an ally buff is drilled on a fleet-mate');
  assert.deepEqual(spells.find(x => x.name === 'touch of flame'), { name: 'touch of flame', target: 'none' });
  assert.deepEqual(plan.orders.practice_spells.rooms, [552]);
});

test('spell training: the posture is pinned — survive, confined, no roaming, no strategy, no town trips', () => {
  const o = spellTrainingPlan(trainer(), STATION, {}).orders;
  assert.equal(o.mode, 'survive');
  assert.equal(o.to, 552);
  assert.deepEqual(o.confine_rooms, [552]);
  assert.equal(o.roam, false);
  assert.equal(o.farm_strategy, null);
  assert.equal(o.mollusk_cover_recovery, false);
  assert.equal(o.town_trips, false);
});

test('spell training: buffs are the keeper-castable ones it knows; none is null, never "all"', () => {
  const plan = spellTrainingPlan(trainer(), STATION, {});
  assert.deepEqual(plan.orders.buff_allies, { enabled: true, spells: ['bless', 'magic shield'], gap_ms: 20000 });
  // Mana floor: the costliest buff (magic shield, 9) plus 4.
  assert.equal(plan.orders.practice_spells.mana_floor, 13);
  const none = spellTrainingPlan(trainer({ spells_known: [sp('free action', 10)] }), STATION, {});
  assert.equal(none.orders.buff_allies, null, '{enabled:true} with no list means every buff to the keeper');
  assert.deepEqual(KEEPER_BUFFS, ['super strength', 'bless', 'magic shield']);
});

test('spell training: a per-character override replaces both lists exactly', () => {
  const d = { spell_training: { characters: { 'caster one': {
    buff: ['magic shield'], practice: ['magic shield', 'free action'], request_cap: 50 } } } };
  const plan = spellTrainingPlan(trainer(), STATION, d);
  assert.deepEqual(plan.practice, ['magic shield', 'free action']);
  assert.deepEqual(plan.orders.buff_allies.spells, ['magic shield']);
  assert.equal(plan.requests['red mushroom'], 50);
  assert.equal(plan.requests.sapphire, undefined, 'bless is not this character\'s buff, so no sapphires');
  // Maxed is judged on the override list.
  const done = spellTrainingPlan(trainer({ spells_known: [sp('magic shield', 99), sp('free action', 99), sp('night vision', 3)] }), STATION, d);
  assert.equal(done.maxed, true);
});

test('spell training: an unread book is a question, not an empty book', () => {
  const plan = spellTrainingPlan(trainer({ spells_known: null, spells_error: 'no list yet' }), STATION, {});
  assert.equal(plan.unread, 'no list yet');
  const obs = { characters: [trainer({ spells_known: null })] };
  assert.deepEqual(trainingWantsLearning(obs, doctrine()), [], 'never sent shopping on a missing field');
  const r = spellTrainingRequests(obs, doctrine());
  assert.deepEqual(r.unread, ['role-a']);
  assert.ok(!r.scope.includes('role-a'), 'an unread trainer is out of scope, so its lines are kept');
});

test('spell training: maxed trainers hand over to learning, and only they do', () => {
  const maxedBook = book().map(s => ({ ...s, ability: 99 }));
  const next = { learning: { planned: { active_stage: 3, active: [{ name: 'eagle eyes' }],
    next: { name: 'eagle eyes', kind: 'spell', level: 4, expected_buyable: true, price: 100 } } },
    health: { pct: 1 }, purse: 500 };
  const d = doctrine();
  const unsettled = { characters: [trainer({ ...next, spells_known: maxedBook })] };
  assert.deepEqual(trainingWantsLearning(unsettled, d), [],
    'deploy first: the errand walks home to assignedRoom, and one decision per character per pass');
  const obs = { characters: [settled(trainer({ ...next, spells_known: maxedBook }), d),
    trainer({ ...next, agent: 'role-b', character: 'Caster Two' })], strategies: { agents: {}, settings: {} } };
  assert.deepEqual(trainingWantsLearning(obs, d), ['role-a']);
  const intent = learningFleetRules[0].decide(obs, d);
  assert.equal(intent.kind, 'act');
  assert.deepEqual(intent.plan, [{ do: 'buy-next-planned', agent: 'role-a' }],
    'the strategy is not selected for anybody; the plan alone enables it for the maxed trainer');
  // A character whose book holds nothing practiceable is not "maxed".
  const empty = spellTrainingPlan(trainer({ spells_known: [sp('blink', 99, { parent: 'Spell' })] }), STATION, {});
  assert.equal(empty.maxed, false);
});

// ---------------------------------------------------------------- the shift deploys it

test('spell training: the shift deploys the plan, then finds no drift once the keeper has it', () => {
  const d = doctrine();
  const out = shiftFleetRules[0].decide({ characters: [trainer()] }, d);
  assert.equal(out.kind, 'act');
  const step = out.plan[0];
  assert.equal(step.do, 'deploy');
  const args = callsForFleetPlan(out.plan)[0].args;
  assert.equal(args.mode, 'survive');
  assert.equal(args.assigned_room, 552);
  assert.equal(args.farm_strategy, null, 'null is SENT: it unassigns a strategy file');
  assert.deepEqual(args.confine_rooms, [552]);
  assert.equal(args.town_trips, false);
  assert.equal(args.mollusk_cover_recovery, false);
  assert.equal(args.hunt, undefined);
  assert.equal(args.purpose, undefined);
  assert.ok(args.practice_spells.enabled);
  // The keeper as it would store these (practice: as sent, but key order may differ).
  const ps = args.practice_spells;
  const policy = { assignedRoom: 552, confineRooms: [552], roam: false, farmStrategy: null,
    molluskCoverRecovery: false, townTrips: false,
    practiceSpells: { rooms: ps.rooms, spells: ps.spells, mana_floor: ps.mana_floor, enabled: true },
    buffAllies: { enabled: true, spells: ['bless', 'magic shield'], gap_ms: 20000 } };
  const again = shiftFleetRules[0].decide({ characters: [trainer({ mode: 'survive', policy })] }, d);
  assert.equal(again.kind, 'pass', again.why);
});

test('farm-strategy station: no hunt, room 552, mode farm, and no shift-wide posture rides along', () => {
  const d = doctrine();
  const small = trainer({ agent: 'role-c', level: 90, spells_known: undefined });
  const out = shiftFleetRules[0].decide({ characters: [small] }, d);
  const args = callsForFleetPlan(out.plan)[0].args;
  assert.equal(args.farm_strategy, 'great-ocean-marion');
  assert.equal(args.mode, 'farm');
  assert.equal(args.assigned_room, 552);
  assert.equal(args.hunt, undefined);
  assert.equal(args.flee_below, undefined, 'the shift default 0.35 is a hunting posture, not this station\'s');
  assert.equal(args.max_threat_over, undefined);
  // Settled: nothing to send.
  const settled = trainer({ agent: 'role-c', level: 90, mode: 'farm',
    policy: { farmStrategy: 'great-ocean-marion', assignedRoom: 552 } });
  assert.equal(shiftFleetRules[0].decide({ characters: [settled] }, d).kind, 'pass');
});

test('farm-strategy station with no room does not clear the assignment; survive band clears the file', () => {
  const d = doctrine();
  d.shift.stations = [
    { only: ['role-n'], max_health: { below: 50 }, farm_strategy: 'newbie-ileria-fungus' },
    { only: ['role-n'], max_health: { at_least: 50 }, farm_strategy: null, mode: 'survive' },
  ];
  const climbing = shiftFleetRules[0].decide({ characters: [trainer({ agent: 'role-n', level: 40 })] }, d);
  const a1 = callsForFleetPlan(climbing.plan)[0].args;
  assert.ok(!('assigned_room' in a1) || a1.assigned_room === undefined, 'no room: assignment left alone');
  assert.equal(a1.farm_strategy, 'newbie-ileria-fungus');
  const done = shiftFleetRules[0].decide({ characters: [trainer({ agent: 'role-n', level: 50,
    policy: { farmStrategy: 'newbie-ileria-fungus' } })] }, d);
  const a2 = callsForFleetPlan(done.plan)[0].args;
  assert.equal(a2.mode, 'survive');
  assert.equal(a2.farm_strategy, null);
});

// ---------------------------------------------------------------- courier requests

test('requests: never lower somebody else\'s number, raise a smaller one and give it back', () => {
  const current = { 'role-a': { mushroom: 150, 'red mushroom': 10 }, other: { herb: 5 } };
  const r1 = mergeRequests(current, { 'role-a': { mushroom: 100, 'red mushroom': 100, sapphire: 100 } }, {}, ['role-a']);
  assert.equal(r1.next['role-a'].mushroom, 150, 'a higher foreign value is left alone');
  assert.equal(r1.next['role-a']['red mushroom'], 100, 'a lower foreign value is raised');
  assert.equal(r1.next['role-a'].sapphire, 100);
  assert.deepEqual(r1.next.other, { herb: 5 }, 'out of scope: untouched');
  assert.equal(r1.owned['role-a'].mushroom, undefined, 'and not claimed');
  // Nothing wanted any more: our own line goes, a raised one is restored.
  const r2 = mergeRequests(r1.next, {}, r1.owned, ['role-a']);
  assert.deepEqual(r2.next['role-a'], { mushroom: 150, 'red mushroom': 10 });
  assert.deepEqual(r2.owned, {});
});

test('requests: a line changed by somebody else since is theirs, and an emptied line we made is removed', () => {
  const r1 = mergeRequests({}, { 'role-a': { herb: 100, sapphire: 100 } }, {}, ['role-a']);
  const edited = { 'role-a': { ...r1.next['role-a'], herb: 40 } };
  const r2 = mergeRequests(edited, {}, r1.owned, ['role-a']);
  assert.deepEqual(r2.next['role-a'], { herb: 40 }, 'the hand-edited herb stays; our sapphire goes');
  const r3 = mergeRequests(r1.next, {}, r1.owned, ['role-a']);
  assert.equal(r3.next['role-a'], undefined, 'a line that only ever held our requests is removed');
  const r4 = mergeRequests(r1.next, {}, r1.owned, []);
  assert.deepEqual(r4.next, r1.next, 'an agent outside the scope keeps everything');
});

test('requests: written atomically without a BOM, and an unparseable file is never overwritten', () => {
  const dir = tmp();
  const file = join(dir, 'courier-requests.json');
  const stateFile = join(dir, 'state', 'fleet.json');
  writeFileSync(file, '﻿{ "other": { "herb": 5 } }');
  const r = syncReagentRequests({ file, stateFile, desired: { 'role-a': { mushroom: 100 } },
    scope: ['role-a'], commit: true });
  assert.equal(r.written, true);
  const raw = readFileSync(file);
  assert.notEqual(raw[0], 0xEF, 'no BOM');
  assert.deepEqual(JSON.parse(raw.toString('utf8')), { other: { herb: 5 }, 'role-a': { mushroom: 100 } });
  assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'no temp file left behind');
  assert.ok(existsSync(stateFile));
  // A dry run reports and writes nothing.
  const dry = syncReagentRequests({ file, stateFile, desired: {}, scope: ['role-a'], commit: false });
  assert.equal(dry.written, false);
  assert.equal(dry.changes.length, 1);
  assert.ok(readFileSync(file, 'utf8').includes('role-a'));
  // Half-saved by hand: refused.
  writeFileSync(file, '{ "other": ');
  const bad = syncReagentRequests({ file, stateFile, desired: {}, scope: ['role-a'], commit: true });
  assert.match(bad.skipped, /did not parse/);
  assert.equal(readFileSync(file, 'utf8'), '{ "other": ');
});

test('requests: the plan asks for what the drills and buffs consume, up to the cap', () => {
  const r = spellTrainingRequests({ characters: [trainer()] },
    doctrine({ spell_training: { ...freshDefaults().spell_training, request_cap: { default: 100, sapphire: 40 } } }));
  assert.deepEqual(r.desired['role-a'], { mushroom: 100, 'red mushroom': 100, 'purple mushroom': 100, sapphire: 40 });
  assert.ok(r.scope.includes('role-a'));
});

test('requests: a note is journalled once per reason', () => {
  const dir = tmp();
  const args = { file: join(dir, 'r.json'), stateFile: join(dir, 's.json'), desired: {}, scope: ['role-a'],
    commit: true, notes: { 'role-a': 'maxed' } };
  assert.equal(syncReagentRequests(args).fresh_notes.length, 1);
  assert.equal(syncReagentRequests(args).fresh_notes.length, 0, 'said once');
  assert.equal(syncReagentRequests({ ...args, notes: {} }).fresh_notes.length, 0);
  assert.equal(syncReagentRequests(args).fresh_notes.length, 1, 'a reason that went away and came back is news');
});

// ---------------------------------------------------------------- sensing

test('catalogue and enrichment: class names become item names; an unreadable list stays null', async () => {
  assert.equal(reagentName('Herbs'), 'herb');
  assert.equal(reagentName('RedMushroom'), 'red mushroom');
  assert.equal(reagentName('Mushroom'), 'mushroom', 'not "edible mushroom"');
  assert.equal(reagentName('OrcTooth'), 'orc tooth');
  const cat = parseSpellCatalogue({ spells: [{ name: 'magic shield', mana: 9, harmful: false,
    parent: 'PersonalEnchantment', school_name: 'Kraanan', reagents: [{ item: 'Mushroom', count: 2 }, { item: 'RedMushroom', count: 1 }] }] });
  const rows = [{ agent: 'a' }, { agent: 'b' }];
  const broker = { call: async (tool, args) => {
    assert.equal(tool, 'abilities');
    assert.equal(args.known_only, false, 'a spell bought this minute reads 0 and must be seen');
    return args.agent === 'a' ? { spells: [{ name: 'Magic Shield', ability: 12, targets: 1 }] }
      : { spells: null, spells_unreadable: 'no spell list from the server yet' };
  } };
  await enrichSpellTraining(broker, rows, cat);
  assert.deepEqual(rows[0].spells_known[0].reagents, [['mushroom', 2], ['red mushroom', 1]]);
  assert.equal(rows[0].spells_known[0].mana, 9);
  assert.equal(rows[1].spells_known, null);
  assert.match(rows[1].spells_error, /no spell list/);
  assert.deepEqual(trainingCandidates([{ agent: 'x', in_game: true, level: 10 }], doctrine()), []);
});

// ---------------------------------------------------------------- orders-only

test('orders-only: shift and learning decide on unclaimed faculties; nothing else does', () => {
  const d = doctrine();
  assert.deepEqual(validate(d), []);
  const fleet = decide(fleetRules, { characters: [trainer()], strategies: { agents: {}, settings: {} } }, d, { max: 3 });
  const verdict = id => fleet.considered.find(c => c.rule === id)?.verdict;
  assert.equal(fleet.intents[0]?.rule, 'hunt-shift');
  assert.notEqual(verdict('auto-level-next-planned-school'), 'not-claimed');
  for (const c of fleet.considered)
    if (!['hunt-shift', 'auto-level-next-planned-school'].includes(c.rule))
      assert.equal(c.verdict, 'not-claimed', `${c.rule} must not run without a lease`);
  const ch = decide(characterRules, trainer(), d);
  assert.equal(ch.intent ?? null, null);
  assert.ok(ch.considered.every(c => c.verdict === 'not-claimed'));
  // Without the flag the same doctrine decides nothing.
  const off = decide(fleetRules, { characters: [trainer()] }, { ...d, claim: { ...d.claim, orders_only: false } }, { max: 3 });
  assert.equal(off.intents.length, 0);
  assert.deepEqual(ORDERS_ONLY_FACULTIES, ['work', 'movement', 'economy']);
});

test('orders-only: claiming work as bot as well is refused, and a non-boolean is refused', () => {
  const d = doctrine();
  d.claim.work = 'bot';
  assert.ok(validate(d).some(p => p.where === 'claim.orders_only' && /claimed as bot/.test(p.why)));
  const e = doctrine();
  e.claim.orders_only = 'yes';
  assert.ok(validate(e).some(p => p.where === 'claim.orders_only'));
});

test('orders-only: the run loop asks for no claim at all', async () => {
  // run.mjs claims only faculties whose owner is the string "bot"; orders_only: true is not one.
  const d = doctrine();
  const wanted = Object.entries(d.claim).filter(([f, owner]) => owner === 'bot' &&
    !['i_accept_the_character_may_die', 'lease_ms'].includes(f)).map(([f]) => f);
  assert.deepEqual(wanted, []);
});

// ---------------------------------------------------------------- one whole pass, offline


test('pass: an orders-only training doctrine reads spells, plans requests and deploys, all dry', async () => {
  const dir = tmp();
  const catalogue = join(dir, 'spells.json');
  writeFileSync(catalogue, JSON.stringify({ spells: [
    { name: 'magic shield', mana: 9, harmful: false, parent: 'PersonalEnchantment', school_name: 'Kraanan',
      reagents: [{ item: 'Mushroom', count: 2 }, { item: 'RedMushroom', count: 1 }] }] }));
  const requests = join(dir, 'courier-requests.json');
  writeFileSync(requests, JSON.stringify({ other: { herb: 5 } }));
  const calls = [];
  const broker = {
    url: 'http://127.0.0.1:8901',
    health: async () => ({ fleet: 'test', pid: 1, sessions: [] }),
    call: async (tool, args) => {
      calls.push(tool);
      if (tool === 'fleet') return { fleet: [{ agent: 'role-a', character: 'Caster One', in_game: true,
        room_num: 552, health: '160/160', level: 160, autopilot: { mode: 'farm', running: true },
        policy: {}, committed: null }] };
      if (tool === 'abilities') return { spells: [{ name: 'magic shield', ability: 30, targets: 1 }] };
      return {};
    },
    write: async (tool, args) => { calls.push('write:' + tool); return { dry_run: true, args }; },
  };
  const config = doctrine();
  config.fleet = 'test';
  config.spell_training = { ...config.spell_training, requests_file: requests, catalogue_file: catalogue };
  config.record = { ...config.record, spell_training_dir: join(dir, 'state') };
  const result = await pass({ broker, config, journal: new Journal({ dir: join(dir, 'j'), enabled: false }),
    commit: false }, { decideFleet: true });
  assert.ok(calls.includes('abilities'), 'the spell list is read for a would-be trainer');
  assert.ok(calls.includes('write:autopilot'), 'and the training orders are planned (dry)');
  const rr = result.fleet.reagent_requests;
  assert.equal(rr.written, false);
  assert.deepEqual(rr.changes.map(c => [c.agent, c.item, c.to]),
    [['role-a', 'mushroom', 100], ['role-a', 'red mushroom', 100]], 'what it would have asked the courier for');
  assert.deepEqual(JSON.parse(readFileSync(requests, 'utf8')), { other: { herb: 5 } }, 'a dry pass writes nothing');
});

test('learning under orders-only: the strategy store is not inherited, only the trainer hand-off', () => {
  const next = { learning: { planned: { active_stage: 3, active: [{ name: 'x' }],
    next: { name: 'x', kind: 'spell', level: 4, expected_buyable: true, price: 1 } } },
    health: { pct: 1 }, purse: 500 };
  const obs = { characters: [
    settled(trainer({ ...next, spells_known: book().map(s => ({ ...s, ability: 99 })) })),
    trainer({ ...next, agent: 'role-f', level: 90 }),            // a farmer the store selected
  ], strategies: { agents: { 'role-f': ['auto-level-planned-school'] }, settings: {} } };
  const d = doctrine({ strategies: { enabled: false, defaults: [], settings: {} } });
  assert.equal(learningFleetRules[0].enabled(d), true, 'on because a training station exists');
  const intent = learningFleetRules[0].decide(obs, d);
  assert.deepEqual(intent.plan, [{ do: 'buy-next-planned', agent: 'role-a' }]);
  const none = doctrine({ strategies: { enabled: false, defaults: [], settings: {} } });
  none.shift.stations = none.shift.stations.filter(st => st.plan == null);
  assert.equal(learningFleetRules[0].enabled(none), false);
});

// 2026-11-13: a trainer station that names a farm strategy farms between casts (Zoot at the Ocean).
test('spell training: a station with farm_strategy hunts under it between casts, drill unchanged', () => {
  const still = spellTrainingPlan(trainer(), STATION, {});
  const farming = spellTrainingPlan(trainer(), { ...STATION, farm_strategy: 'great-ocean-marion' }, {});
  assert.equal(still.orders.mode, 'survive', 'no farm_strategy: the trainer stands still as before');
  assert.equal(still.orders.farm_strategy, null);
  assert.equal(farming.orders.mode, 'farm', 'farm_strategy: the trainer hunts between casts');
  assert.equal(farming.orders.farm_strategy, 'great-ocean-marion');
  assert.equal(farming.orders.confine_rooms, undefined, 'the strategy file owns the confinement');
  assert.deepEqual(farming.orders.practice_spells, still.orders.practice_spells, 'the drill is unchanged');
  assert.deepEqual(farming.orders.buff_allies, still.orders.buff_allies, 'the buffs are unchanged');
});
