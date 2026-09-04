// THE GRAVEYARD NIGHT SHIFT — the cold-start bootstrap especially.
//
// The rule refuses to deploy without OBSERVING the window (undead standing in 70/71) and refuses to
// guess from the unreliable server clock. On a cold start from a scattered fleet nobody is in either
// room, so it used to report and move no one — a deadlock: it will not deploy without observing, and
// it never observes without someone in the room. The bootstrap sends ONE scout in to establish the
// observation and gathers the rest at the Tos inn. These pin that, and the observed shut branch.

import assert from 'node:assert/strict';
import { loadDoctrine } from '../src/config/load.mjs';
import { graveyardFleetRules, GRAVEYARD, CRYPT, TOS_INN, ordersFor } from '../src/decide/rules/graveyard.mjs';

const test = globalThis.__dumTest;
const rule = graveyardFleetRules[0];
const doctrine = () => loadDoctrine({ file: 'doctrines/graveyard.jsonc' }).config;
const row = (agent, over = {}) => ({ agent, in_game: true, level: 60, room: 39, mode: 'farm', policy: {}, ...over });

test('graveyard: cold start with nobody observing scouts one in and gathers the rest at the inn', () => {
  const rows = [row('unit-1'), row('unit-2', { equipped: ['plate mail'] }), row('unit-3')]; // unit-2 is the armoured one
  const intent = rule.decide({ characters: rows, room_views: [] }, doctrine());
  assert.equal(intent.kind, 'act', 'the deadlock is broken with an action, not a report');
  const deploys = intent.plan.filter(p => p.do === 'deploy');
  const standdowns = intent.plan.filter(p => p.do === 'stand-down');
  assert.equal(deploys.length, 1, 'exactly one scout deploys — not the whole fleet into the danger');
  assert.equal(deploys[0].to, GRAVEYARD, 'the scout goes to the graveyard to observe');
  assert.equal(deploys[0].agent, 'unit-2', 'the body-armoured character is chosen as scout');
  assert.equal(deploys[0].use_safe_spots, true, 'the scout fights from behind a wall');
  assert.equal(deploys[0].retreat_to, TOS_INN, 'the scout has the inn armed as its retreat');
  assert.equal(standdowns.length, 2, 'everyone else gathers at the inn to wait');
  assert.ok(standdowns.every(p => p.assigned_room === TOS_INN), 'gathered at the Tos inn');
});

test('graveyard: with no armoured unit, any live unit scouts — still exactly one, still to the graveyard', () => {
  const rows = [row('unit-1'), row('unit-2'), row('unit-3')];
  const intent = rule.decide({ characters: rows, room_views: [] }, doctrine());
  const deploys = intent.plan.filter(p => p.do === 'deploy');
  assert.equal(deploys.length, 1, 'one scout even when none is armoured');
  assert.equal(deploys[0].to, GRAVEYARD);
});

test('graveyard: a unit holding the shift policy but stranded idle off the GY is re-deployed; a traveller is not', () => {
  // THE RECOVERY BUG. A broker restart rejoins the fleet at Castle Victoria with assignedRoom
  // already set to the GY, so deploymentDiffers reads "policy matches" and the unit is never
  // re-sent — it sits idle while the open window burns. The fix re-deploys anyone who must MOVE
  // (not standing in the GY/crypt) and is not already travelling there.
  const doc = doctrine();
  const o = ordersFor({ equipped: ['plate mail'] }, doc); // armoured -> crypt, so both units target CRYPT
  const shiftPolicy = { assignedRoom: CRYPT, hunt: o.hunt, maxThreatOver: o.max_threat_over, fleeBelow: o.flee_below,
    maxCarry: o.max_carry, bankAbove: o.bank_above, roam: o.roam, useSafeSpots: true, weaponPriority: o.weapon_priority };
  const at = (agent, doing) => ({ agent, in_game: true, room: 39, mode: 'farm', doing,
    equipped: ['plate mail'], policy: shiftPolicy }); // policy matches -> deploymentDiffers is false
  const view = { room: GRAVEYARD, objects: [{ name: 'zombie' }, { name: 'zombie' }] }; // window open
  const intent = rule.decide({ characters: [at('stranded', 'idle'), at('traveller', 'travelling')], room_views: [view] }, doc);
  const deployed = (intent.plan ?? []).filter(p => p.do === 'deploy').map(p => p.agent);
  assert.ok(deployed.includes('stranded'), 'the stranded idle unit is re-deployed despite holding the policy');
  assert.ok(!deployed.includes('traveller'), 'the one already travelling there is left alone, not re-issued every tick');
});

test('graveyard: window observed SHUT stands the whole fleet down to the inn, no scout loop', () => {
  const rows = [row('unit-1', { room: GRAVEYARD }), row('unit-2')]; // unit-1 is standing in the graveyard
  const intent = rule.decide({ characters: rows, room_views: [{ room: GRAVEYARD, objects: [] }] }, doctrine());
  assert.equal(intent.kind, 'act');
  assert.ok(intent.plan.every(p => p.do === 'stand-down'), 'no deploy when the observed window is shut');
  assert.ok(intent.plan.every(p => p.assigned_room === TOS_INN), 'stood down to the Tos inn');
});
