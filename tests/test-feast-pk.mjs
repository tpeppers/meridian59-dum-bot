import assert from 'node:assert/strict';
import { killedByPlayer, pkBanFrom, roomBanned, feastBan, recordFeastPkCheck,
         PK_BAN_BASE_MS, PK_BAN_EXTRA_MAX_MS, BAN_KEY,
         feastFleetRules } from '../src/decide/rules/feast.mjs';
import { FEAST_HALL } from '../src/decide/feast-hall.mjs';

const test = globalThis.__dumTest;
const rule = feastFleetRules.find(r => r.id === 'feast-hall-larder');
const MIN = 60_000;
const NOW = 1_700_000_000_000;
const doctrine = { feast: { on: true }, food: {} };

// THE HALL IS SAFE AND THE WALK TO IT IS NOT. duke4.kod:27 gives the Feast Hall
// ROOM_NO_COMBAT | ROOM_SANCTUARY; duke1 (the Courtyard, 950) and duke2 (Blackstone Keep,
// 951) declare no such flags. The likeliest ambush is the moment a courier walks OUT of the
// hall with a full pack, which is why the ban is on the ROOM rather than on the feast.

test('feast/pk: the game does not name the killer, and the label is the discriminator', () => {
  // THE MISTAKE THIS PINS. A first version looked for a bare capitalised name after
  // "killed by" — and system.kod:50 uses a dedicated broadcast that names NOBODY:
  //     system_user_killed_by_pker = "### %q has been murdered in cold blood."
  // So that version would have missed every real murder there is. The harness parses all
  // the forms (m59-skills.mjs DEATH_FORMS) and labels them; the label is the fact.
  assert.equal(killedByPlayer({ how: 'murdered by a player' }), true);
  assert.equal(killedByPlayer({ how: 'killed', killer: 'battered skeleton' }), false);
  assert.equal(killedByPlayer({ how: 'the room itself' }), false, 'lava, a fall, a trap');
  assert.equal(killedByPlayer({ how: 'own folly' }), false);
  // These two mean the victim was itself flagged — still a player kill, still a room to
  // stay out of.
  assert.equal(killedByPlayer({ how: 'killed as a murderer' }), true);
  assert.equal(killedByPlayer({ how: 'killed as an outlaw' }), true);
});

test('feast/pk: the raw broadcast still works when nothing labelled it', () => {
  // A record written before the harness labelled these, or by another tool.
  assert.equal(killedByPlayer({ text: '### Aardvark has been murdered in cold blood.' }), true);
  assert.equal(killedByPlayer({ text: '### Aardvark was just killed by a giant rat.' }), false);
  assert.equal(killedByPlayer(null), false);
  assert.equal(killedByPlayer({}), false, 'unknown is not a murder');
});

test('feast/pk: the ban is an hour plus a random hour, rolled once and stored', () => {
  // THE RANDOMNESS IS THE POINT. A fixed ban is a schedule, and a schedule is something to
  // wait out — a killer who knows it is exactly sixty minutes returns at minute sixty-one.
  const b = how => pkBanFrom({ how, who: 'Aardvark' }, { at: 0, room: 951, rand: () => how });
  const low = pkBanFrom({ how: 'murdered by a player' }, { at: 0, room: 951, rand: () => 0 });
  const high = pkBanFrom({ how: 'murdered by a player' }, { at: 0, room: 951, rand: () => 0.999 });
  assert.equal(low.until, PK_BAN_BASE_MS, 'the floor is one hour');
  assert.ok(high.until > PK_BAN_BASE_MS && high.until <= PK_BAN_BASE_MS + PK_BAN_EXTRA_MAX_MS,
            'and the ceiling is two');
  // Stored rather than recomputed, so reading it does not move the deadline.
  const mem = { [BAN_KEY]: { rooms: { 951: low } } };
  assert.equal(roomBanned(mem, 951, PK_BAN_BASE_MS - 1).remaining_ms, 1);
  assert.equal(roomBanned(mem, 951, PK_BAN_BASE_MS + 1), null, 'and it does expire');
});

test('feast/pk: the ban is on the ROOM, not on the feast', () => {
  const ban = pkBanFrom({ how: 'murdered by a player', who: 'Aardvark' },
                        { at: NOW, room: 108, rand: () => 0.5 });
  const mem = { [BAN_KEY]: { rooms: { 108: ban } } };
  assert.ok(roomBanned(mem, 108, NOW + MIN), 'the Sewers of Barloque are shut');
  assert.equal(feastBan(mem, NOW + MIN), null, 'but the feast road is nowhere near them');
  assert.equal(pkBanFrom({ how: 'murdered by a player' }, { at: NOW, room: null }), null,
               'a ban has to be ON somewhere');
});

test('feast/pk: a murder anywhere on the feast road shuts the whole trip', () => {
  // Including a murder in the hall's own doorway — the sanctuary protects a character
  // standing in it, and it still has to walk home through the room it happened in.
  for (const room of [FEAST_HALL.room, ...FEAST_HALL.approach]) {
    const ban = pkBanFrom({ how: 'murdered by a player', who: 'Aardvark' },
                          { at: NOW, room, rand: () => 0.5 });
    const mem = { [BAN_KEY]: { rooms: { [room]: ban } } };
    assert.ok(feastBan(mem, NOW + MIN), `a murder in ${room} stops the trip`);
    const obs = { at: NOW + MIN, memory: { feast: mem },
                  characters: [{ agent: 'a', in_game: true, room: FEAST_HALL.room,
                                 health: { pct: 1 }, policy: { assignedRoom: 39 } }] };
    const out = rule.decide(obs, doctrine);
    assert.equal(out.kind, 'pass', `nobody goes or grabs while ${room} is shut`);
    assert.match(out.why, /no feast trips for/);
  }
});

test('feast/pk: a death is read once, and only a murder shuts anything', () => {
  const context = { at: NOW, room: 951 };
  const pm = broadcast => [{ tool: 'post_mortem',
                             result: { record: { killed_by_broadcast: broadcast } } }];

  const monster = recordFeastPkCheck({ at: NOW, context, was: {},
                                       results: pm({ how: 'killed', killer: 'battered skeleton' }) });
  assert.equal(monster.read.murdered, false);
  assert.equal(monster.patch[BAN_KEY].rooms, undefined, 'no room shut for a monster');
  assert.equal(monster.patch[BAN_KEY].checked_at, NOW, 'but the death is marked read');

  const murder = recordFeastPkCheck({ at: NOW, context, was: {}, rand: () => 0.5,
                                      results: pm({ how: 'murdered by a player', who: 'Aardvark' }) });
  assert.equal(murder.read.murdered, true);
  assert.equal(murder.patch[BAN_KEY].rooms['951'].until,
               NOW + PK_BAN_BASE_MS + PK_BAN_EXTRA_MAX_MS / 2);
});

test('feast/pk: a second murder elsewhere does not clear the first room', () => {
  const was = { [BAN_KEY]: { rooms: { 951: { room: 951, until: NOW + 90 * MIN } } } };
  const out = recordFeastPkCheck({ at: NOW, context: { at: NOW, room: 950 }, was, rand: () => 0,
    results: [{ tool: 'post_mortem',
                result: { record: { killed_by_broadcast: { how: 'murdered by a player' } } } }] });
  assert.ok(out.patch[BAN_KEY].rooms['951'], 'the first room is still shut');
  assert.ok(out.patch[BAN_KEY].rooms['950'], 'and so is the second');
});

test('feast/pk: a post-mortem that says nothing is not a murder', () => {
  const out = recordFeastPkCheck({ at: NOW, context: { at: NOW, room: 950 }, was: {},
                                   results: [{ tool: 'post_mortem', result: { record: {} } }] });
  assert.equal(out.read.murdered, false);
  assert.match(out.read.why, /no broadcast/);
});
