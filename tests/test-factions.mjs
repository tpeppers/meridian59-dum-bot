import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FactionGoalStore, factionRequestRetryMs } from '../src/record/factions.mjs';
import { FACTION_CATALOG, acquisitionSource } from '../src/factions/catalog.mjs';
import { factionFleetRules, factionCharacterRules, activeFactionWork }
  from '../src/decide/rules/factions.mjs';
import { factionGameFleetRules } from '../src/decide/rules/faction-games.mjs';
import { deny } from '../src/link/surface.mjs';

const test = globalThis.__dumTest;
const NOW = 1_700_000_000_000;

const row = (agent, over = {}) => ({
  agent, in_game: true, level: 60, room: 27, mode: 'farm',
  health: { value: 60, max: 60, pct: 1 }, commitment: null, parked: null, piloted: null,
  policy: { hunt: 'spider', assignedRoom: 27, purpose: 'money', roam: true,
    maxThreatOver: 6, protectedItems: [] },
  town_service_at: NOW, items: [], ...over,
});

test('factions: catalogue matches the three source-defined leaders and assignments', () => {
  assert.deepEqual(FACTION_CATALOG.map(f => f.id), ['duke', 'princess', 'rebel']);
  assert.equal(FACTION_CATALOG.find(f => f.id === 'princess').assignments.length, 3);
  assert.equal(FACTION_CATALOG.find(f => f.id === 'duke').assignments.length, 4);
  assert.equal(FACTION_CATALOG.find(f => f.id === 'rebel')
    .assignments.filter(item => item === 'scimitar').length, 2);
  assert.deepEqual(acquisitionSource('scimitar', 50, 6),
    { hunt: 'orc', room: 27, level: 45, chance: 16 });
});

test('factions: goals survive restart and record the server-selected quest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-factions-'));
  try {
    const store = new FactionGoalStore({ dir, fleet: 'fixture', now: () => NOW });
    store.set(['a', 'b'], 'rebel');
    assert.equal(new FactionGoalStore({ dir, fleet: 'fixture' }).read().agents.a.status, 'queued');
    const assigned = store.recordErrand({ acted: true, errand: 'faction-request', agent: 'a',
      context: { previous: { mode: 'farm', hunt: 'spider' } }, results: [{
        tool: 'faction_join', result: { faction: 'rebel', assigned: {
          item: 'scimitar', target: "Jonas D'Accor", room: 371,
        } },
      }] }, { at: NOW });
    assert.equal(assigned.status, 'acquiring');
    assert.equal(assigned.item, 'scimitar');
    assert.equal(assigned.deadline_at, NOW + 60 * 60_000);
    assert.deepEqual(assigned.previous, { mode: 'farm', hunt: 'spider' });

    const complete = store.recordErrand({ acted: true, errand: 'faction-offer', agent: 'a',
      results: [{ tool: 'faction_join', result: { faction: 'rebel', joined: true } }] },
    { at: NOW + 10_000 });
    assert.equal(complete.status, 'complete');
    assert.equal(complete.completed_at, NOW + 10_000);

    const failed = store.recordErrand({ acted: true, errand: 'faction-request', agent: 'b',
      stopped: 'travel did not arrive (watchdog fled to safety)', results: [
        { tool: 'travel', result: { arrived: false, reason: 'watchdog fled to safety' } },
        { tool: 'faction_join', skipped: true },
      ] }, { at: NOW + 20_000 });
    assert.equal(failed.status, 'queued');
    assert.equal(failed.attempts, 1);
    assert.equal(failed.retry_after, NOW + 20_000 + factionRequestRetryMs(0));
    assert.match(failed.last_error, /watchdog fled/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('factions: active quest work is exclusive of standing farm placement', () => {
  const observation = { factions: {
    agents: { joiner: { desired: 'rebel', status: 'acquiring' } },
    soldiers: { recruit: { faction: 'rebel', status: 'hunting' } },
  } };
  assert.equal(activeFactionWork(observation, 'joiner'), true);
  assert.equal(activeFactionWork(observation, { agent: 'recruit' }), true);
  assert.equal(activeFactionWork(observation, 'farmer'), false);
  observation.at = NOW;
  observation.factions.agents.joiner.deadline_at = NOW - 1;
  observation.factions.soldiers.recruit.deadline_at = NOW - 1;
  assert.equal(activeFactionWork(observation, 'joiner'), false);
  assert.equal(activeFactionWork(observation, 'recruit'), false);
});

test('factions: a queued goal waits for town service, then emits only the bounded request', () => {
  const rule = factionFleetRules.find(r => r.id === 'request-faction-join');
  const unit = row('a', { town_service_at: null });
  const goals = { agents: { a: { desired: 'rebel', status: 'queued', requested_at: NOW } } };
  const waiting = rule.decide({ at: NOW + 1000, characters: [unit], factions: goals });
  assert.equal(waiting.kind, 'pass');
  unit.town_service_at = NOW + 2000;
  const intent = rule.decide({ at: NOW + 3000, characters: [unit], factions: goals });
  assert.equal(intent.orders.errand, 'faction-request');
  assert.deepEqual(intent.orders.steps.map(step => step.tool), ['travel', 'faction_join']);
  assert.equal(intent.orders.steps[1].args.action, 'request');
  assert.equal(intent.orders.steps[1].args.faction, 'rebel');
});

test('factions: an assignment hunts a safe source, protects cargo, and offers the exact item', () => {
  const goal = { desired: 'rebel', status: 'acquiring', requested_at: NOW,
    item: 'scimitar', target: "Jonas D'Accor", target_room: 371,
    deadline_at: NOW + 60 * 60_000, previous: { mode: 'farm', hunt: 'spider',
      assigned_room: 27, purpose: 'money', roam: true, max_threat_over: 6, protect_items: [] } };
  const unit = row('a');
  const hunt = factionCharacterRules.find(r => r.id === 'acquire-faction-item').decide({ ...unit, agent: 'a',
    factions: { agents: { a: goal } } }, { prey: { max_threat_over: 6 } });
  assert.equal(hunt.orders.hunt, 'orc');
  assert.deepEqual(hunt.orders.protect_items, ['scimitar']);

  unit.items = [{ id: 77, name: 'scimitar' }];
  const offer = factionFleetRules.find(r => r.id === 'complete-faction-join')
    .decide({ at: NOW + 1000, characters: [unit], factions: { agents: { a: goal } } });
  assert.equal(offer.orders.errand, 'faction-offer');
  assert.equal(offer.orders.steps[1].args.item, 77);
  assert.equal(offer.orders.steps[1].args.target, "Jonas D'Accor");
  assert.deepEqual(offer.orders.steps.at(-1).args.protect_items, ['scimitar']);
});

test('factions: clearing a goal releases only its temporary cargo protection', () => {
  const rule = factionCharacterRules.find(r => r.id === 'release-faction-cargo-protection');
  const intent = rule.decide({ agent: 'a', policy: { protectedItems: ['old cargo', 'scimitar'] },
    factions: { agents: { a: { desired: 'rebel', status: 'cancelled',
      previous: { protect_items: ['old cargo'] } } } } });
  assert.deepEqual(intent.orders.protect_items, ['old cargo']);
});

test('factions: DUM still refuses general speech and trade', () => {
  assert.equal(deny('faction_join', { action: 'request', faction: 'rebel' }), null);
  assert.match(deny('say', { text: 'anything' }), /does not claim/);
  assert.match(deny('trade', {}), /does not claim/);
});

test('factions: soldier promotion is durable and preserves both three-hour stages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dum-soldiers-'));
  try {
    const store = new FactionGoalStore({ dir, fleet: 'fixture', now: () => NOW });
    store.setSoldier(['a'], { a: { faction: 'rebel' } });
    const requested = store.recordErrand({ acted: true, errand: 'soldier-request', agent: 'a',
      context: { previous: { mode: 'farm' } }, results: [{ tool: 'faction_soldier', result: {
        faction: 'rebel', assigned: { target: "soldier of the Princess' army",
          rooms: [593, 583, 603], stage_index: 0 },
      } }] }, { at: NOW });
    assert.equal(requested.status, 'hunting');
    assert.equal(requested.deadline_at, NOW + 3 * 60 * 60_000);
    const killed = store.recordErrand({ acted: true, errand: 'soldier-hunt', agent: 'a',
      results: [{ tool: 'faction_soldier', result: { faction: 'rebel', killed: true } }] },
    { at: NOW + 1000 });
    assert.equal(killed.status, 'reporting');
    const second = store.recordErrand({ acted: true, errand: 'soldier-report', agent: 'a',
      results: [{ tool: 'faction_soldier', result: { faction: 'rebel', assigned: {
        target: "soldier of the Duke's army", rooms: [586, 596, 585], stage_index: 1,
      } } }] }, { at: NOW + 2000 });
    assert.equal(second.stage_index, 1);
    assert.equal(second.status, 'hunting');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('factions: soldier request rule requires 75 health and uses only the bounded tool', () => {
  const rule = factionFleetRules.find(r => r.id === 'request-soldier-service');
  const goal = { faction: 'rebel', status: 'queued', requested_at: NOW };
  assert.equal(rule.decide({ at: NOW, characters: [row('a', { level: 74 })],
    factions: { soldiers: { a: goal } } }), null);
  const intent = rule.decide({ at: NOW, characters: [row('a', { level: 75,
    health: { value: 75, max: 75, pct: 1 } })], factions: { soldiers: { a: goal } } });
  assert.equal(intent.orders.errand, 'soldier-request');
  assert.deepEqual(intent.orders.steps.map(step => step.tool), ['travel', 'faction_soldier']);
  assert.equal(intent.orders.steps[1].args.action, 'request');
});

test('factions: token PvP is inert until explicitly selected and uses only verified scan output', () => {
  const rule = factionGameFleetRules.find(r => r.id === 'engage-opposing-token-carrier');
  const unit = row('a', { faction_game: { faction: 'rebel', targets: [{
    id: 99, name: 'Opponent', faction: 'duke', token: 'jade cat token',
  }] } });
  const doctrine = { strategies: { defaults: [], settings: {} } };
  const off = rule.decide({ at: NOW, characters: [unit], strategies: { agents: { a: [] } } }, doctrine);
  assert.equal(off, null);
  const on = rule.decide({ at: NOW, characters: [unit],
    strategies: { agents: { a: ['play-faction-games'] } } }, doctrine);
  assert.equal(on.orders.errand, 'faction-game-engage');
  assert.equal(on.orders.steps[0].args.target, 99);
  assert.equal(deny('faction_game', { action: 'engage', target: 99 }), null);
  assert.match(deny('fight', { target: 'Opponent' }), /does not claim/);
});
