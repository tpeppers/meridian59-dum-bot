// LOIAL'S SERVICE DESK — the two things one standing caster can do for a fleet that farms.
//
// Operator, 2026-09-17: Alfa is to stand in the Brownestone Inn in Barloque offering `reveal`
// to the fleet, and to "advertise his uncurse services" so that everyone can "drop by and take
// advantage of it when they do town stops in Barloque".
//
// TWO RULES, AND THEY ARE NOT THE SAME SHAPE. Revealing happens where the desk already is and
// needs nobody to move; uncursing needs the WEARER, because `remove curse` targets the player
// rather than the item. So one is a cast in place and the other is a two-actor errand with a
// journey in it, and conflating them would have put a caster on a road.
//
// OFF BY DEFAULT. `service_desk.on` is false unless a doctrine says otherwise: this rule spends
// orc teeth (three a reveal, and there is no way to get them back) and walks characters across
// the world. An operator arms it; nobody discovers it.
//
// ---------------------------------------------------------------- what makes this affordable
//
// THE SERVER ALREADY SAYS WHICH ITEMS ARE WORTH A CAST. Every object on the wire carries a
// rarity grade and `GetRarity` checks identification FIRST, so anything with a hidden attribute
// reads 100. `reveal` sets `piAdvance` from `RevealHiddenAttributes`, which returns TRUE only if
// something WAS hidden — so a cast at a mundane item spends three teeth and thirty mana, reveals
// nothing, AND teaches the caster nothing. Filtering on grade 100 is what turns this from a
// grind into an errand. Grade 200 is cursed.
//
// Both grades arrive on `row.items` already: the observation reads the `inventory` tool, which
// carries `rarity` per object. Nothing here needs a new read.
//
// ---------------------------------------------------------------- what it refuses to believe
//
// A CAST REPLY DOES NOT SAY WHETHER THE CAST HAPPENED. Measured on prod driving this same
// character: `cast` answered `{cast: true, mana_spent: 0}` on a cast whose mana demonstrably
// went 65 -> 52. So every step here is followed by a READ-BACK of the thing that must have
// changed — the item's grade for a reveal, the equipment list for an uncurse — and the errand's
// `expect` is set on that read rather than on the cast.

// WHO OWNS A BODY, IMPORTED RATHER THAN RESTATED. The first version of this file restated it and
// got it wrong in the quietest way available: it tested `row.committed`, which the observation
// does not carry — the field is `row.commitment` — so the guard was always false and never once
// refused anybody. It happened to pick a takeable character on the pass it was checked on, which
// is exactly how a guard that does nothing survives review.
//
// The real rule is subtler than "is it claimed". The harness distinguishes a CLAIM, which leaves
// a character takeable, from `busy`, which is what makes everything step over it — so DUM's own
// claim must NOT block this, or DUM could never act on anything it had claimed.
import { holdsTheBody } from './body.mjs';

// A NumberItem is money, arrows, reagents or food and carries no attribute, and the test is the
// TAG rather than the amount: a stack of ONE is still a stack. (This repository has paid for the
// amount test twice — a hand-over that moves nothing, and a board that sorted 16,876 shillings
// as an unidentified magic item.)
const isStack = (i) => (i?.tag != null ? Number(i.tag) === 1 : (Number(i?.amount) || 0) > 1);
const gradeIs = (i, g) => !isStack(i) && Number(i?.rarity) === g;

// WHO OWNS THIS BODY — imported rather than restated, because the first version of this file
// restated it and got it wrong in the quietest possible way. It tested `row.committed`, which
// the observation does not carry (the field is `row.commitment`), so the guard was always false
// and never once refused anybody. It happened to pick a takeable character on the pass it was
// checked on, which is exactly how a guard that does nothing survives review.
//
// The real rule is subtler than "is it claimed": the harness draws a distinction between a CLAIM,
// which leaves a character takeable, and `busy`, which is what makes everything step over it. So
// DUM's own claim must NOT block this — if it did, DUM could never act on anything it had
// claimed. `holdsTheBody` already encodes that, and it is one import away.

export const UNIDENTIFIED = 100;
export const CURSED = 200;
export const REVEAL = Object.freeze({ spell: 'reveal', mana: 30, teeth: 3, castMs: 30_000 });
export const REMOVE_CURSE = Object.freeze({ spell: 'remove curse', mana: 9, emeralds: 1,
  // How many rolls one visit is worth. The visitor has already crossed the world; three
  // attempts cost at most one emerald and take seconds, and a fourth walk is minutes.
  attempts: 3 });

const TOOTH = /orc (teeth|tooth)/i;
const EMERALD = /emerald/i;
const countIn = (items, re) => (items || [])
  .filter(i => re.test(String(i?.name ?? ''))).reduce((n, i) => n + (Number(i.amount) || 1), 0);

// AN ITEM WITH NO USABLE ID CANNOT BE CAST AT, AND CASTING AT NOTHING IS NOT A NO-OP.
//
// A single-target spell sent with an empty target list lands on the CASTER — that is how every
// `bless` and `super strength` a raid thought it had put on somebody had gone onto the person
// casting it instead (measured 2026-09-11; the tell was `keeper_said.targets: []`). For `reveal`
// the caster is not a valid target, so it would be three orc teeth spent on a refusal. The SHAPE
// is the danger rather than this particular spell, and the fix belongs where the target is
// chosen, not in the caller that happens to notice.
//
// A NEGATIVE ID IS ALSO NOT AN ID. The keeper-backed `equipment` path synthesises ids as a
// negative counter — an ARRAY INDEX wearing an id's field name — and it reads back perfectly,
// because it is a number in a field called `id`. Treat one as a refusal to answer.
const castableId = (i) => Number.isSafeInteger(Number(i?.id)) && Number(i.id) > 0;

/** Everything in this pack that a reveal would pay for AND can be aimed at. */
export function revealable(items = []) {
  return (items || []).filter(i => gradeIs(i, UNIDENTIFIED) && castableId(i));
}

/** Grade 100 but unaimable. Reported rather than silently dropped: it is a gap, not an absence. */
export function unaimable(items = []) {
  return (items || []).filter(i => gradeIs(i, UNIDENTIFIED) && !castableId(i));
}

/** Everything in this pack the server grades cursed. */
export function cursedIn(items = []) {
  return (items || []).filter(i => gradeIs(i, CURSED));
}

const cfg = (doctrine) => doctrine?.service_desk ?? {};
const deskAgent = (doctrine) => String(cfg(doctrine).agent ?? 'acct08');
const deskRoom = (doctrine) => Number(cfg(doctrine).room ?? 106);
const on = (doctrine) => cfg(doctrine).on === true;

/** The desk's own row in a fleet observation, or null when it is not in game. */
export function deskRow(fleetObs, doctrine) {
  const want = deskAgent(doctrine);
  return (fleetObs?.characters ?? []).find(r => r.agent === want && r.in_game) ?? null;
}

// WHAT THE UNCURSE ERRAND LEAVES BEHIND, AND WHY IT HAS TO LEAVE ANYTHING.
//
// DUM refused to run this errand until it was registered in ERRANDS with a reader, and the
// refusal's own words are the argument: "the walk happens and the finding is lost". For a reveal
// that would be pedantry — the item's GRADE is the record, it is on the item, and it is what the
// errand's own `expect` reads. For an uncurse it is not: the errand crosses the world, and if the
// cast did not take, the next pass sees the same worn curse and sends the same character on the
// same journey. Nothing about the world would have changed to stop it.
//
// So a failure is remembered and backed off. A SUCCESS needs no memory at all: the curse is gone
// from the equipment list, which is the condition the rule triggers on.
export const DESK_TOPIC = 'service_desk';
export const UNCURSE_RETRY_MS = 30 * 60_000;

/**
 * Same pure record-fn shape as recordSellrun: read the finished transcript, return the patch.
 *
 * AND IT DOES THE VERIFYING ITSELF, BECAUSE `expect` CANNOT. The errand runner's `expect` is a
 * CLOSED SET OF FOUR STRINGS — 'cleared', 'vaulted', 'withdrawn', 'arrived' — each with bespoke
 * logic in src/act/errands.mjs. Anything else is silently ignored. This errand was written with
 * `expect: "cursed == null || length(cursed) == \`0\`"`, which reads like a check, matches no
 * constant, and verifies NOTHING.
 *
 * Measured on prod 2026-09-18: the errand cast three times, read the equipment back, and walked
 * on to the next step — which it only reaches if the read "passed" — while EchoTwo was still
 * wearing the ring. A verification that cannot fail is worse than none, because it is quoted in
 * the finding as though it held.
 *
 * So the equipment step's own RESULT is read here. `stopped` is kept as a second reason to fail:
 * an errand that never reached the read cannot have proved anything either.
 */
export function recordDeskUncurse({ agent, at, stopped, results = [] }) {
  const read = [...results].reverse().find(r => r.tool === 'equipment' && r.result);
  const said = read?.result ?? null;
  // THREE ANSWERS, NOT TWO. `cursed: []` or null is off; a non-empty list is still on; and NO
  // read at all is "we never found out" — which must not count as success, and must not be
  // confused with the server saying it is clean.
  // `cursed: null` IS THE CLEAN ANSWER, NOT AN ABSENT ONE. The broker sends null with
  // `cursed_note: "the server graded everything equipped and none of it is cursed"`, and a LIST
  // when something is. The genuinely unknown case is `grades_known: false` — a keeper too old to
  // report grades — or no equipment read at all. Reading null as unknown made every success look
  // like a failure, which is the same confusion as the one above running the other way.
  const stillCursed = !said || said.grades_known === false ? null
                    : Array.isArray(said.cursed) ? said.cursed.length > 0
                    : said.cursed == null ? false : true;
  const ok = !stopped && stillCursed === false;
  const casts = results.filter(r => r.tool === 'cast').length;
  return { patch: { [agent]: { last_try_at: at, ok, ...(ok ? { tries: 0 } : {}) } },
           read: { agent, at, ok, casts, stopped: stopped ?? null,
                   verified: stillCursed === null ? 'the equipment was never read back'
                           : stillCursed ? 'the server still reports a cursed item'
                           : 'the server reports nothing cursed' } };
}

/** Is this character inside the backoff from a failed attempt? */
export function coolingDown(memory, agent, now) {
  const row = memory?.[DESK_TOPIC]?.[agent];
  if (!row || row.ok !== false || !Number.isFinite(Number(row.last_try_at))) return null;
  const left = UNCURSE_RETRY_MS - (Number(now) - Number(row.last_try_at));
  return left > 0 ? Math.round(left / 1000) : null;
}

export const serviceDeskFleetRules = [
  {
    // ------------------------------------------------------------ 1. reveal, in place
    id: 'desk-reveal-own-pack',
    faculty: 'work',
    scope: 'fleet',
    why: 'the desk holds unidentified items and can pay for the casts; revealing is the service, ' +
         'and it also trains the spell, because the kod only advances it on an item that really ' +
         'had something hidden',
    enabled: doctrine => on(doctrine) && cfg(doctrine).reveal !== false,
    offWhy: 'service_desk.on is false, or service_desk.reveal is off. It spends three orc teeth ' +
            'a cast and there is no way to get them back, so it is opted into',
    decide(fleetObs, doctrine) {
      const desk = deskRow(fleetObs, doctrine);
      if (!desk) return { kind: 'pass', why: `${deskAgent(doctrine)} is not in game` };

      // IN THE CASTER'S OWN PACK OR ON HIS FLOOR, and this rule only does the pack. Reveal's
      // `IsTargetInRange` is `who = GetOwner(target) OR GetOwner(who) = GetOwner(target)`, so an
      // item in somebody else's pack is not reachable however close they stand. Getting work TO
      // the desk is the hand-over rule below, not this one.
      const work = revealable(desk.items);
      if (!work.length) {
        const blind = unaimable(desk.items);
        return { kind: 'pass', why: blind.length
          ? blind.length + ' unidentified item(s) carry no usable id, so nothing can be aimed '
            + 'at them. A targeted cast with no target lands on the CASTER, so this refuses '
            + 'rather than spending three teeth to find out'
          : "nothing in the desk's pack reads unidentified" };
      }

      const teeth = countIn(desk.items, TOOTH);
      const mana = Number(desk.mana?.value ?? desk.mana ?? 0);
      const byTeeth = Math.floor(teeth / REVEAL.teeth);
      if (!byTeeth)
        // A SHORTAGE AND A WAIT ARE DIFFERENT ANSWERS. Teeth do not come back and mana does, so
        // saying which one is blocking is the difference between an operator buying and waiting.
        return { kind: 'pass', why: `${work.length} item(s) to reveal and only ${teeth} orc ` +
                 'teeth — three a cast, and the farmers are the supply (restock-allies)' };
      if (mana < REVEAL.mana)
        return { kind: 'pass', why: `paced by mana (${mana}/${REVEAL.mana}) — it regenerates, ` +
                 'so this is a wait rather than a shortage' };

      const cap = Math.max(1, Number(cfg(doctrine).max_per_errand ?? 3));
      const take = work.slice(0, Math.min(cap, byTeeth, Math.floor(mana / REVEAL.mana)));

      return {
        kind: 'errand',
        orders: {
          errand: 'desk-reveal',
          agent: desk.agent,
          steps: [
            // A RESTING CASTER CANNOT CAST AND THE REFUSAL IS FREE. PFLAG_NO_MAGIC is set while
            // resting, so stand up first rather than after the first silent failure.
            // NO STAND-UP STEP HERE EITHER — `rest` is not on DUM's write surface. See the
            // note in the uncurse errand below.
            ...take.flatMap(item => [
              { tool: 'cast', args: { agent: desk.agent, spell: REVEAL.spell, target: item.id },
                expect: null, timeout_ms: REVEAL.castMs + 20_000 },
              // JUDGE IT ON THE ITEM, NOT ON THE REPLY. The grade is the thing the errand exists
              // to change and the one field a racing before/after read cannot fake.
              // NO `expect` HERE, AND THAT IS NOT AN OVERSIGHT. The runner's `expect` is a closed
              // set of four strings and anything else is ignored in silence, so the expression
              // this used to carry read like a check and was one. The grade still decides — the
              // rule re-reads the pack next pass and simply does not offer an item that is no
              // longer grade 100.
              { tool: 'inventory', args: { agent: desk.agent }, expect: null,
                timeout_ms: 20_000 },
            ]),
          ],
        },
        why: `${take.length} of ${work.length} unidentified item(s), ${teeth} teeth, ${mana} mana`,
        evidence: { revealable: work.length, taking: take.map(i => i.name), teeth, mana,
                    by_teeth: byTeeth },
      };
    },
  },

  {
    // ------------------------------------------------------------ 2. uncurse, which needs a body
    id: 'desk-uncurse-a-visitor',
    faculty: 'movement',
    scope: 'fleet',
    why: 'a cursed item can never be unequipped, and the wearer pays for it every hour it is on; ' +
         'the desk can lift it for one emerald, but `remove curse` targets the PLAYER, so the ' +
         'wearer has to be standing there',
    enabled: doctrine => on(doctrine) && cfg(doctrine).uncurse !== false,
    offWhy: 'service_desk.on is false, or service_desk.uncurse is off. It walks a character ' +
            'across the world, so it is opted into',
    decide(fleetObs, doctrine) {
      const desk = deskRow(fleetObs, doctrine);
      if (!desk) return { kind: 'pass', why: `${deskAgent(doctrine)} is not in game` };
      const room = deskRoom(doctrine);
      if (Number(desk.room) !== room)
        // THE DESK MOVED, SO DO NOT SEND ANYBODY TO IT. A visitor walked to an empty inn has
        // taken all of the risk and none of the service.
        return { kind: 'pass', why: `the desk is in ${desk.room}, not ${room} — nobody is sent ` +
                 'to a room the caster has left' };

      const emeralds = countIn(desk.items, EMERALD);
      if (emeralds < REMOVE_CURSE.emeralds)
        return { kind: 'pass', why: `the desk has ${emeralds} emerald(s) and a remove curse ` +
                 'costs one' };
      if (Number(desk.mana?.value ?? desk.mana ?? 0) < REMOVE_CURSE.mana)
        return { kind: 'pass', why: 'the desk is short of mana — it regenerates' };

      // WHO IS WEARING ONE. A cursed item in the PACK is not urgent: the cost is paid by wearing
      // it, and picking one up is what equips it (item.kod posts TryUseItem on the picker). So
      // this asks the equipment list, and a row whose equipment is UNKNOWN is skipped rather
      // than guessed at — "we could not see" is not "they are fine".
      const sufferers = (fleetObs?.characters ?? []).filter(r => {
        if (!r.in_game || r.agent === desk.agent) return false;
        if (!Array.isArray(r.equipped)) return false;
        const worn = new Set(r.equipped.map(e => String(typeof e === 'string' ? e : e?.name ?? '')
          .toLowerCase()));
        return cursedIn(r.items).some(i => worn.has(String(i.name).toLowerCase()));
      });
      if (!sufferers.length)
        return { kind: 'pass', why: 'nobody in game is wearing a cursed item' };

      // A HUMAN-PILOTED CHARACTER IS NOT OURS TO WALK. The broker releases the keeper while a
      // client holds the body, and sending it on a journey would fight the person playing it.
      const takeable = sufferers.filter(r => !holdsTheBody(r));
      if (!takeable.length)
        return { kind: 'pass', why: `${sufferers.length} wearing a curse, all of them piloted or ` +
                 'already busy — they keep their own bodies' };

      // AND NOT ONE WE HAVE JUST FAILED ON. Without this, a cast that does not take sends the
      // same character across the world on the very next pass, for ever: nothing in the world
      // has changed, so the trigger is still true. See recordDeskUncurse.
      const now = Number(fleetObs?.now ?? Date.now());
      const ready = takeable.filter(r => coolingDown(fleetObs?.memory, r.agent, now) == null);
      if (!ready.length) {
        const secs = coolingDown(fleetObs?.memory, takeable[0].agent, now);
        return { kind: 'pass', why: `${takeable.length} wearing a curse, all inside the backoff ` +
                 `from a failed attempt (${secs}s left) — a cast that did not take must not ` +
                 'become a journey every pass' };
      }

      // ONE AT A TIME. Two visitors is two journeys and one caster; the second would arrive to
      // find the first mid-trance, and both would read as having been served.
      const who = ready[0];
      const home = who.room ?? null;

      return {
        kind: 'errand',
        orders: {
          errand: 'desk-uncurse',
          agent: who.agent,
          steps: [
            { tool: 'travel', args: { agent: who.agent, to: room }, expect: 'arrived',
              timeout_ms: Number(cfg(doctrine).travel_timeout_ms ?? 600_000) },
            // AND THEN WALK ACROSS THE ROOM, because arriving in the room is not arriving at the
            // desk, and the spell cares about the difference.
            //
            // `SuccessChance` (spell.kod:1174-1240) applies a distance penalty when the caster
            // has no line of sight to the target: past a certain range it simply HALVES the
            // chance. Measured on prod 2026-09-18: Bravo travelled to 106 and stopped at
            // r17c16 while Alfa stood at r5c6 — twelve rows and ten columns apart, opposite
            // ends of the Brownestone Inn — and four casts in a row failed. At ability 63 the
            // base chance is around 78%, so four straight failures is roughly one run in five
            // hundred; halved to 39% it is one in seven. The room was right and the square was
            // not.
            //
            // Optional, and aimed at the desk's own square with a two-square tolerance so the
            // visitor ends up BESIDE the caster rather than trying to stand inside it. If the
            // observation carries no position for the desk the step is simply not emitted —
            // a walk to an unknown square is not a walk.
            ...(Number.isFinite(Number(desk.position?.row)) &&
                Number.isFinite(Number(desk.position?.col))
              ? [{ tool: 'walk_to',
                   args: { agent: who.agent, row: Number(desk.position.row),
                           col: Number(desk.position.col), arrive_within: 128 },
                   expect: null, optional: true, timeout_ms: 120_000 }]
              : []),
            // NO STAND-UP STEP, BECAUSE DUM MAY NOT SEND ONE. `rest` is not on the write
            // surface (src/link/surface.mjs) — the refusal is literally `"rest" is not on DUM's
            // surface` — so the step could never have worked from here, only from the harness's
            // own m59-reveal.mjs, which is where the idea came from.
            //
            // THE FIRST DIAGNOSIS OF THIS WAS WRONG AND THE JOURNAL IS WHY IT DID NOT STAY
            // WRONG. A refused `rest` stopped the first live errand one step before the spell,
            // and it was read as "the caster was already standing, so standing again is refused"
            // — plausible, and the fix (mark the step optional) was right for the wrong reason.
            // The errand's own finding said the real thing: a surface denial. Marking it optional
            // turned a stopped errand into a permanently refused no-op step, which is quieter and
            // no more correct.
            //
            // The consequence of having no stand-up: a desk that happens to be RESTING cannot
            // cast (PFLAG_NO_MAGIC) and the round is wasted. That is survivable here in a way it
            // is not in m59-reveal.mjs — the desk stands idle in an inn at full health, and the
            // rule retries. If it ever stops being survivable the answer is `rest_up` on the
            // surface or a resting flag on the observation, not a step that is always refused.
            // THE CASTER IS A DIFFERENT AGENT FROM THE ERRAND'S OWNER, and that is deliberate:
            // the visitor is the one taking the risk and the one whose faculties are claimed, so
            // the errand belongs to it. `target` takes a player NAME — the tool resolves it and
            // faces first, because a single-target spell obeys the same view rule as a swing.
            //
            // CAST MORE THAN ONCE, BECAUSE THE SPELL IS A ROLL. `remove curse` answered "You
            // were unsuccessful in casting remove curse" with `mana_spent: 0` on the first live
            // attempt at ability 63 — the generic spell-skill failure, not a refusal.
            // `CanPayCosts` (remcurse.kod:65-92) had already passed: right target class, and
            // `IsCursedByItems` true. So a single cast and a single read turns one unlucky roll
            // into a failed errand, a thirty-minute backoff, and a walk home for nothing.
            //
            // The extra attempts are FREE once it works: `CanPayCosts` returns FALSE on a target
            // that is no longer cursed, and it returns before the base class takes the mana or
            // the emerald. So this costs at most one emerald however many times it fires, and
            // every attempt is `optional` so a refusal cannot stop the errand.
            ...Array.from({ length: REMOVE_CURSE.attempts }, () => ({
              tool: 'cast', args: { agent: desk.agent, spell: REMOVE_CURSE.spell,
                                    target: who.character },
              expect: null, optional: true, timeout_ms: 60_000,
            })),
            // READ THE EQUIPMENT BACK. The cast reply cannot be trusted, and the thing that must
            // have changed is what the server says is worn.
            // THE VERDICT, AND IT IS READ IN `recordDeskUncurse` RATHER THAN HERE. `expect` is a
            // closed set of four constants; an expression is ignored in silence. This step
            // exists to put the server's own answer in the transcript, where the recorder reads
            // it and decides whether the errand actually worked.
            { tool: 'equipment', args: { agent: who.agent }, expect: null, timeout_ms: 30_000 },
            ...(home != null && home !== room
              ? [{ tool: 'travel', args: { agent: who.agent, to: home }, expect: 'arrived',
                   timeout_ms: Number(cfg(doctrine).travel_timeout_ms ?? 600_000) }]
              : []),
          ],
        },
        why: `${who.character} is wearing ${cursedIn(who.items).map(i => i.name).join(', ')}` +
             (ready.length > 1 ? ` (${ready.length - 1} more waiting)` : ''),
        evidence: { visitor: who.character, from: home, desk: desk.character, room,
                    queued: ready.slice(1).map(r => r.character),
                    also_piloted: sufferers.filter(r => r.piloted).map(r => r.character) },
      };
    },
  },
];
