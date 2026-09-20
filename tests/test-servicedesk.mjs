// LOIAL'S SERVICE DESK — offline, no broker, no server, no clock.
//
// Both rules are pure decisions over a fleet observation, so every case here is a fixture. What
// is pinned, in order of how expensive being wrong would be:
//
//   * a cast is never aimed at an item with no usable id — a single-target spell sent with an
//     empty target list lands on the CASTER, which is how every buff a raid thought it had put
//     on somebody went onto the person casting it;
//   * a piloted or already-busy character is never sent on a journey — the person playing it
//     would be fighting the mover for the body;
//   * nobody is sent to a room the caster has LEFT, which is all of the risk and none of the
//     service;
//   * a cursed item in the PACK is not urgent and a WORN one is, because the cost is paid by
//     wearing it;
//   * an unknown equipment list is skipped rather than read as "they are fine";
//   * both rules are OFF unless a doctrine arms them — they spend orc teeth that cannot be
//     got back, and they walk characters across the world.

const test = globalThis.__dumTest;

import { serviceDeskFleetRules, revealable, unaimable, cursedIn, recordDeskUncurse,
         UNIDENTIFIED, CURSED, REVEAL, REMOVE_CURSE } from '../src/decide/rules/servicedesk.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

const [reveal, uncurse] = serviceDeskFleetRules;
const ARMED = { service_desk: { on: true, agent: 'acct08', room: 106 } };

const desk = (over = {}) => ({
  agent: 'acct08', character: 'Alfa', in_game: true, room: 106,
  mana: { value: 65, max: 65 },
  items: [{ name: 'orc tooth', amount: 21, tag: 1, rarity: 0 },
          { name: 'emerald', amount: 98, tag: 1, rarity: 0 },
          { id: 8199, name: 'scroll', amount: 0, tag: 0, rarity: UNIDENTIFIED }],
  equipped: [{ name: 'nerudite armor' }], ...over,
});
const sufferer = (over = {}) => ({
  agent: 'acct06', character: 'EchoTwo', in_game: true, room: 27,
  items: [{ id: 8761, name: 'ring of lethargy', amount: 0, tag: 0, rarity: CURSED }],
  equipped: [{ name: 'ring of lethargy' }, { name: 'hammer' }], ...over,
});
const obs = (...rows) => ({ characters: rows });

// ------------------------------------------------------------------ the filters

test('desk: a stack is never magic, and the test is the TAG rather than the amount', () => {
  // A sapphire stack of ONE is still a stack — amount 1, tag 1 — and an amount test lets it
  // through. That is what a pack looks like after it has spent the rest.
  const items = [{ id: 1, name: 'sapphire', amount: 1, tag: 1, rarity: UNIDENTIFIED },
                 { id: 2, name: 'scroll', amount: 0, tag: 0, rarity: UNIDENTIFIED }];
  eq(revealable(items).length, 1, 'only the scroll');
  eq(revealable(items)[0].name, 'scroll');
});

test('desk: an item with no usable id is UNAIMABLE, not revealable', () => {
  const noId = [{ name: 'scroll', amount: 0, tag: 0, rarity: UNIDENTIFIED }];
  eq(revealable(noId).length, 0, 'nothing can be aimed at');
  eq(unaimable(noId).length, 1, 'and it is reported rather than dropped');
  // A NEGATIVE ID IS AN ARRAY INDEX WEARING AN ID'S FIELD NAME — the keeper-backed equipment
  // path synthesises them, and it reads back perfectly because it is a number in a field
  // called `id`.
  eq(revealable([{ id: -1, name: 'mace', tag: 0, rarity: UNIDENTIFIED }]).length, 0,
     'a negative id is a refusal to answer, not an answer');
});

test('desk: cursedIn reads grade 200 and ignores stacks', () => {
  eq(cursedIn([{ id: 1, name: 'ring of lethargy', tag: 0, rarity: CURSED },
               { name: 'shilling', amount: 999, tag: 1, rarity: CURSED }]).length, 1);
});

// ------------------------------------------------------------------ reveal, in place

test('desk: with work, teeth and mana it returns an errand that aims at the ITEM', () => {
  const r = reveal.decide(obs(desk()), ARMED);
  eq(r.kind, 'errand');
  const cast = r.orders.steps.find(s => s.tool === 'cast');
  eq(cast.args.target, 8199, 'the cast names the item id');
  eq(cast.args.spell, REVEAL.spell);
  // THE FIRST STEP IS THE CAST. There is no stand-up step: the rest tool is not on DUM's
  // write surface, so it could never run. See the surface case below.
  eq(r.orders.steps[0].tool, 'cast');
  // AND IT READS THE PACK BACK AFTERWARDS, because the cast reply was measured saying
  // `mana_spent: 0` on a cast whose mana demonstrably moved. The step carries NO `expect`: the
  // runner's is a closed set of four strings and an expression is ignored in silence. What
  // decides is the next pass, which simply does not offer an item that is no longer grade 100.
  const read = r.orders.steps.find(s => s.tool === 'inventory');
  ok(read, 'the pack is read back');
  eq(read.expect ?? null, null, 'no expect the runner would ignore');
});

test('desk: an unaimable item REFUSES rather than casting at nothing', () => {
  const r = reveal.decide(obs(desk({
    items: [{ name: 'orc tooth', amount: 21, tag: 1, rarity: 0 },
            { name: 'scroll', amount: 0, tag: 0, rarity: UNIDENTIFIED }] })), ARMED);
  eq(r.kind, 'pass');
  ok(/no usable id/.test(r.why), 'and says why');
  ok(/lands on the CASTER/.test(r.why), 'and says what it was avoiding');
});

test('desk: a shortage of teeth and a wait for mana are DIFFERENT answers', () => {
  const noTeeth = reveal.decide(obs(desk({
    items: [{ id: 8199, name: 'scroll', tag: 0, rarity: UNIDENTIFIED }] })), ARMED);
  eq(noTeeth.kind, 'pass');
  ok(/orc teeth/.test(noTeeth.why), 'teeth do not come back, so it names them');

  const noMana = reveal.decide(obs(desk({ mana: { value: 5 } })), ARMED);
  eq(noMana.kind, 'pass');
  ok(/regenerates/.test(noMana.why), 'mana does come back, so it says wait');
});

test('desk: no work is not a fault', () => {
  const r = reveal.decide(obs(desk({ items: [] })), ARMED);
  eq(r.kind, 'pass');
  ok(/nothing in the desk/.test(r.why));
});

test('desk: a desk that is not in game passes rather than throwing', () => {
  eq(reveal.decide(obs(desk({ in_game: false })), ARMED).kind, 'pass');
  eq(uncurse.decide(obs(desk({ in_game: false })), ARMED).kind, 'pass');
});

// ------------------------------------------------------------------ uncurse, which needs a body

test('uncurse: a worn curse produces a two-actor errand owned by the VISITOR', () => {
  const r = uncurse.decide(obs(desk(), sufferer()), ARMED);
  eq(r.kind, 'errand');
  // The errand belongs to the visitor: it is the one taking the risk and the one whose
  // faculties get claimed. The CAST is the desk's.
  eq(r.orders.agent, 'acct06');
  const cast = r.orders.steps.find(s => s.tool === 'cast');
  eq(cast.args.agent, 'acct08', 'the desk casts');
  eq(cast.args.spell, REMOVE_CURSE.spell);
  // `remove curse` targets the PLAYER, not the item, and the tool resolves a name.
  eq(cast.args.target, 'EchoTwo');
  // It goes, and it comes back.
  const travels = r.orders.steps.filter(s => s.tool === 'travel');
  eq(travels.length, 2, 'out and home');
  eq(travels[0].args.to, 106);
  eq(travels[1].args.to, 27);
  // And the verdict is read off the equipment, not the cast — the step puts the server's own
  // answer in the transcript, and `recordDeskUncurse` is what reads it. The step carries no
  // `expect`, because the runner's is a closed set and an expression is ignored in silence.
  const read = r.orders.steps.find(s => s.tool === 'equipment');
  ok(read, 'the equipment is read back');
  eq(read.expect ?? null, null, 'no expect the runner would ignore');
  // The read must come AFTER the casts, or it describes the state before them.
  const lastCast = r.orders.steps.map(s => s.tool).lastIndexOf('cast');
  ok(r.orders.steps.indexOf(read) > lastCast, 'read after the last cast');
});

test('neither errand sends a step DUM is not allowed to send', () => {
  // `rest` is not on the write surface, and the first live errand stopped one step before the
  // spell because of it. The refusal was read as "the caster was already standing" -- plausible,
  // and wrong; the errand's own finding said `"rest" is not on DUM's surface`. Marking it
  // optional made the failure quiet rather than absent, which is not the same repair.
  const steps = [...uncurse.decide(obs(desk(), sufferer()), ARMED).orders.steps,
                 ...reveal.decide(obs(desk()), ARMED).orders.steps];
  ok(!steps.some(s => s.tool === 'rest'), 'no rest step in either errand');
  // Everything they DO send has to be on the surface, or it is a step that cannot run.
  const allowed = new Set(['travel', 'walk_to', 'cast', 'inventory', 'equipment',
                           'cancel_movement', 'autopilot']);
  for (const s of steps) ok(allowed.has(s.tool), `step ${s.tool} is not on DUM's surface`);
});

test('uncurse: it walks ACROSS the room to the desk, not just to the room', () => {
  // SuccessChance applies a distance penalty without line of sight and past a range simply
  // HALVES the chance. Measured on prod: Bravo travelled to 106 and stopped twelve rows and
  // ten columns from Alfa, and four casts in a row failed -- about one run in five hundred at
  // the unpenalised chance, one in seven at half of it. The room was right, the square was not.
  const r = uncurse.decide(obs(desk({ position: { row: 5, col: 6 } }), sufferer()), ARMED);
  const walk = r.orders.steps.find(s => s.tool === 'walk_to');
  ok(walk, 'the visitor closes the distance before the cast');
  eq(walk.args.row, 5); eq(walk.args.col, 6);
  eq(walk.optional, true, 'a failed approach must not cancel the cast');
  // The steps must be in the right order, or it walks after casting.
  const at = t => r.orders.steps.findIndex(s => s.tool === t);
  ok(at('travel') < at('walk_to') && at('walk_to') < at('cast'), 'travel, approach, then cast');
});

test('uncurse: with no position for the desk, no walk is emitted', () => {
  // A walk to an unknown square is not a walk. The first draft would have sent an undefined row.
  const r = uncurse.decide(obs(desk(), sufferer()), ARMED);
  ok(!r.orders.steps.some(s => s.tool === 'walk_to'), 'no square, no step');
});

test('uncurse: the spell is a ROLL, so one visit is worth several attempts', () => {
  // `remove curse` answered "You were unsuccessful in casting remove curse" with
  // `mana_spent: 0` at ability 63 — the generic spell-skill failure, not a refusal:
  // CanPayCosts had already passed (right target class, IsCursedByItems true). One cast and
  // one read turns an unlucky roll into a failed errand, a backoff, and a walk home.
  const r = uncurse.decide(obs(desk(), sufferer()), ARMED);
  const casts = r.orders.steps.filter(s => s.tool === 'cast');
  eq(casts.length, REMOVE_CURSE.attempts, 'one visit, several rolls');
  ok(casts.every(c => c.optional === true), 'a refused cast must not stop the errand');
  ok(casts.every(c => c.args.target === 'EchoTwo' && c.args.agent === 'acct08'));
  // AND THE VERDICT IS NOT OPTIONAL. The extra casts are free — CanPayCosts returns FALSE on
  // a target that is no longer cursed, before the base class takes the mana or the emerald —
  // but the read that decides whether it worked has to be able to fail the errand.
  const read = r.orders.steps.find(s => s.tool === 'equipment');
  ok(!read.optional, 'the equipment read is the verdict and must be able to stop it');
});

test('uncurse: a curse in the PACK is not urgent — the cost is paid by WEARING it', () => {
  const r = uncurse.decide(obs(desk(), sufferer({ equipped: [{ name: 'hammer' }] })), ARMED);
  eq(r.kind, 'pass');
  ok(/nobody in game is wearing/.test(r.why));
});

test('uncurse: an unknown equipment list is SKIPPED rather than read as fine', () => {
  eq(uncurse.decide(obs(desk(), sufferer({ equipped: null })), ARMED).kind, 'pass');
  eq(uncurse.decide(obs(desk(), sufferer({ equipped: undefined })), ARMED).kind, 'pass');
});

test('uncurse: nobody is sent to a room the caster has left', () => {
  const r = uncurse.decide(obs(desk({ room: 39 }), sufferer()), ARMED);
  eq(r.kind, 'pass');
  ok(/not 106/.test(r.why), 'and it says where the desk actually is');
});

test('uncurse: a piloted or busy character keeps its own body', () => {
  const piloted = uncurse.decide(obs(desk(), sufferer({ piloted: true })), ARMED);
  eq(piloted.kind, 'pass');
  ok(/piloted or already busy/.test(piloted.why));
  eq(uncurse.decide(obs(desk(), sufferer({ parked: true })), ARMED).kind, 'pass', 'parked too');
  // THE FIELD IS `commitment`, NOT `committed`, and the first draft of this case used the wrong
  // one — matching a guard that used the wrong one. Both were wrong together, so the case passed
  // while the guard refused nobody. A fixture written against the implementation cannot catch
  // the implementation reading a field that does not exist.
  eq(uncurse.decide(obs(desk(),
       sufferer({ commitment: { kind: 'driven', takeable: false } })), ARMED).kind, 'pass',
     'an errand mid-flight keeps the body');
});

test('uncurse: a TAKEABLE claim does not block it — or DUM could never act at all', () => {
  // The harness distinguishes a CLAIM, which leaves a character takeable, from `busy`, which is
  // what makes everything step over it. DUM's own claim is a takeable one and shows up on every
  // character it is driving, so a guard that refused it would refuse the entire fleet. Measured
  // on prod: every row read `committed: bot` while being perfectly available.
  const r = uncurse.decide(obs(desk(),
    sufferer({ commitment: { kind: 'bot', takeable: true } })), ARMED);
  eq(r.kind, 'errand');
  eq(r.orders.agent, 'acct06');
});

test('uncurse: one visitor at a time, and it says who is waiting', () => {
  const second = sufferer({ agent: 'acct03', character: 'Bravo', room: 27 });
  const r = uncurse.decide(obs(desk(), sufferer(), second), ARMED);
  eq(r.kind, 'errand');
  eq(r.orders.agent, 'acct06', 'the first one only');
  eq(r.evidence.queued.length, 1, 'and the other is named rather than forgotten');
  eq(r.evidence.queued[0], 'Bravo');
});

test('uncurse: the desk must be able to pay for it', () => {
  const r = uncurse.decide(obs(desk({
    items: [{ name: 'orc tooth', amount: 21, tag: 1, rarity: 0 }] }), sufferer()), ARMED);
  eq(r.kind, 'pass');
  ok(/emerald/.test(r.why));
});

test('uncurse: the desk never sends itself on its own errand', () => {
  // A desk wearing a cursed item is a real possibility — Alfa is carrying an Amulet of
  // Shadows — and an errand that travelled him to his own room would be a walk to nowhere.
  const r = uncurse.decide(obs(desk({
    items: [{ id: 5, name: 'Amulet of Shadows', tag: 0, rarity: CURSED }],
    equipped: [{ name: 'Amulet of Shadows' }] })), ARMED);
  eq(r.kind, 'pass');
});

// ------------------------------------------------------------------ armed on purpose


// ------------------------------------------------------------------ did it actually work

// A VERIFICATION THAT CANNOT FAIL IS WORSE THAN NONE, because it is quoted in the finding as
// though it held. The errand runner's `expect` is a CLOSED SET of four strings — 'cleared',
// 'vaulted', 'withdrawn', 'arrived' — each with bespoke logic in src/act/errands.mjs. This
// errand shipped with `expect: "cursed == null || length(cursed) == \`0\`"`, which reads like a
// check, matches no constant, and was ignored in silence.
//
// Measured on prod 2026-09-18: three casts, an equipment read, and the errand walked on to the
// step AFTER the read — which it only reaches if the read passed — while EchoTwo was still wearing
// the ring. So the verdict is read from the transcript here instead.

test('verify: the server saying nothing is cursed is the only success', () => {
  const r = recordDeskUncurse({ agent: 'acct06', at: 1000, stopped: null,
    results: [{ tool: 'cast', result: {} },
              { tool: 'equipment', result: { cursed: null } }] });
  eq(r.patch.acct06.ok, true);
  ok(/nothing cursed/.test(r.read.verified));
});

test('verify: a curse the server still reports is a FAILURE, however the errand ended', () => {
  const r = recordDeskUncurse({ agent: 'acct06', at: 1000, stopped: null,
    results: [{ tool: 'cast', result: {} },
              { tool: 'equipment', result: { cursed: ['ring of lethargy'] } }] });
  eq(r.patch.acct06.ok, false, 'this is the case that used to report success');
  ok(/still reports a cursed item/.test(r.read.verified));
});

test('verify: a keeper too old to report grades is not a clean bill of health', () => {
  const r = recordDeskUncurse({ agent: 'acct06', at: 1000, stopped: null,
    results: [{ tool: 'equipment', result: { grades_known: false, cursed: null } }] });
  eq(r.patch.acct06.ok, false, "grades_known false means we could not see, not nothing is there");
});

test('verify: never reading the equipment back is NOT success', () => {
  // Three answers, not two. "We never found out" must not be confused with the server saying
  // it is clean — an errand that stopped before the read cannot have proved anything.
  const r = recordDeskUncurse({ agent: 'acct06', at: 1000, stopped: null,
    results: [{ tool: 'cast', result: {} }] });
  eq(r.patch.acct06.ok, false);
  ok(/never read back/.test(r.read.verified));
});

test('verify: a stopped errand fails even if an earlier read looked clean', () => {
  const r = recordDeskUncurse({ agent: 'acct06', at: 1000, stopped: 'travel did not arrive',
    results: [{ tool: 'equipment', result: { cursed: [] } }] });
  eq(r.patch.acct06.ok, false);
});

test('verify: neither errand carries an expect the runner cannot evaluate', () => {
  // The four the runner understands. Anything else is ignored in silence, so a step carrying
  // one is a check that is not a check.
  const KNOWN = new Set(['cleared', 'vaulted', 'withdrawn', 'arrived']);
  const steps = [...uncurse.decide(obs(desk({ position: { row: 5, col: 6 } }), sufferer()), ARMED)
                   .orders.steps,
                 ...reveal.decide(obs(desk()), ARMED).orders.steps];
  for (const st of steps)
    ok(st.expect == null || KNOWN.has(st.expect),
       `step ${st.tool} carries expect ${JSON.stringify(st.expect)}, which the runner ignores`);
});

// THE SURFACE IS WHY NONE OF THIS RAN FOR FIVE RESTARTS. Every cast came back
// `refused -- DUM may cast only the self-only provisioning spell "create weapon"`, and the
// findings said so from the first attempt. Both halves of the desk were blocked by policy, not
// by a bug: `reveal` targets an item and `remove curse` targets a player, and the list held
// neither. It is widened BY NAME in src/link/surface.mjs, and these cases pin both directions.
test('surface: the desk may cast exactly its two service spells, and nothing else', async () => {
  const { deny } = await import('../src/link/surface.mjs');
  for (const spell of ['reveal', 'remove curse', 'create weapon', 'create food'])
    eq(deny('cast', { agent: 'acct08', spell }), null, spell + ' must be castable');
  // A LIST AND NOT A CATEGORY, on purpose: "targeted spells" would have admitted every attack
  // spell in the game the day somebody wanted one healing spell.
  for (const spell of ['bless', 'super strength', 'minor heal', 'blink', 'shadow strike'])
    ok(deny('cast', { agent: 'acct08', spell }), spell + ' must stay refused');
});

test('desk: both rules are OFF unless a doctrine arms them', () => {
  ok(!reveal.enabled({}), 'reveal off by default');
  ok(!uncurse.enabled({}), 'uncurse off by default');
  ok(!reveal.enabled({ service_desk: {} }), 'an empty block is not an arming');
  ok(reveal.enabled(ARMED) && uncurse.enabled(ARMED), 'and on when it is');
  // Each half can be switched off on its own: revealing spends teeth, uncursing spends a
  // journey, and an operator may well want one and not the other.
  ok(!reveal.enabled({ service_desk: { on: true, reveal: false } }));
  ok(!uncurse.enabled({ service_desk: { on: true, uncurse: false } }));
  ok(reveal.enabled({ service_desk: { on: true, uncurse: false } }), 'and they are independent');
});
