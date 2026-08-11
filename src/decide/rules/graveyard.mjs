// THE NIGHT SHIFT — farming the Tos undead, and every rule here was paid for.
//
// The Graveyard of Tos (70) and The Crypt (71) are the only ground this fleet has found
// that advances a character at max health 50. Advancement rolls only when the creature's
// level is STRICTLY GREATER than base max health, so a level-50 fungus beast pays a
// level-50 character nothing, for ever — and everything else reachable and safe is level
// 50 or below. A zombie is 55. That one fact is the whole reason for the shift.
//
// TWO ATTEMPTS, AND THE DIFFERENCE BETWEEN THEM IS THIS FILE:
//
//   first    everyone into room 70, `max_threat_over` raised, no split       7 deaths, 0 gains
//   second   split 70/71, ceiling held at 12 for the bare, safe spots on     0 deaths, 7 gains
//
// The second one is also where the first character in the fleet's history passed max
// health 50. Nothing else tried all week moved that number.

// ---------------------------------------------------------------- the two rooms
//
// BOTH ROOMS OR NEITHER, AND THE REASON IS THE SPAWN CAP RATHER THAN VARIETY. Each
// generator caps at 10 creatures. Twenty-one characters in one room share ten spawns and
// spend the window waiting; split across two they share twenty. The tables are near
// enough identical — 85/15 zombie/skeleton in the graveyard, 80/20 in the crypt — so
// crossing BETWEEN them mid-shift costs the walk and buys nothing, which is why
// `assignRooms` below never moves a character that is already on either one.
export const GRAVEYARD = 70;
export const CRYPT = 71;

// The local inn. A flee from either room must not go further than this — see `retreatTo`.
export const TOS_INN = 52;

// ---------------------------------------------------------------- who fights what
//
// `max_threat_over` DECIDES WHAT A CHARACTER WILL START, NOT WHAT MAY START ON IT, and
// that distinction cost seven characters. A skeleton is level 75 and rates 525; a bare
// character is hit about 84% of the time for 5-7. Raising the ceiling so everyone could
// take skeletons did not make them survivable, it just stopped them declining. The ceiling
// is a filter on OUR choices and the room still puts skeletons next to us at 15-20%.
//
// So the split is on ARMOUR, not on level:
//
//   wearing body armour  -> skeleton, ceiling 28 (admits 75 for a character of 47)
//   bare                 -> zombie,   ceiling 12 (admits 55 for a character of 43,
//                                                  and refuses 75 for every character here)
//
// Zombies advance EVERYONE in this fleet, so the bare half is not being given a consolation
// prize — it is being given the same payout at a hundred points less attack rating.
export const SKELETON_CEILING = 28;
export const ZOMBIE_CEILING = 12;

const BODY_ARMOUR = /leather armor|chain armor|scale|plate|ring mail/i;
export const wearsBodyArmour = row =>
  (row.equipped ?? row.worn ?? []).some(n => BODY_ARMOUR.test(typeof n === 'string' ? n : n?.name ?? ''));

// ---------------------------------------------------------------- is it actually night
//
// THE WINDOW IS OBSERVED, NEVER COMPUTED, and this is the rule that cost the most time to
// learn. `tosgrave.kod` gates TryCreateMonster on the game hour, and the harness has an
// arithmetic model of that clock — which was WRONG on this server, twice, in a way nothing
// cross-checked: it reported "NIGHT: undead are spawning" while three characters standing
// in the room could see it was empty, and the operator could see daylight out of the window.
//
// The formula derives the hour from THIS machine's clock; the kod's GetTime() is the
// SERVER's, and the server is somebody else's box. Any offset silently shifts the window.
//
// A room, on the other hand, cannot lie about what is standing in it. So: undead present
// means night, and nothing else counts as evidence.
export function windowIsOpen(roomView = {}) {
  const objects = roomView.objects ?? [];
  const undead = objects.filter(o => /zombie|skeleton/i.test(o?.name ?? ''));
  if (undead.length) return { open: true, seen: undead.length, why: null };
  // LOOT ON THE FLOOR IS NOT EVIDENCE, AND THE FIRST VERSION OF THIS SAID IT WAS.
  //
  // The reasoning was that spoils mean something died recently, so the room must be
  // generating even if the fleet has cleared it. It is wrong because the floor does not
  // clear itself: the fleet REFUSES cursed and broken items, deliberately, and they lie
  // there for ever. Room 70 was observed holding six Amulets of Shadows — cursed, refused
  // by the loot tool, "it equips itself and cannot be removed without an uncurse spell" —
  // and a shattered mace, hours after the window shut. That heuristic read a dead room as
  // a live one and would have parked the fleet in it all day.
  //
  // Undead standing is the only evidence. It has one false NEGATIVE — a room being cleared
  // faster than it spawns — and that is the cheap direction: the next poll catches the next
  // spawn, whereas a false positive costs a whole window.
  return { open: false, seen: 0,
           why: `no undead standing${objects.length ? ` (${objects.length} object(s) here, ` +
                `but items on the floor are not evidence — cursed and broken loot is refused ` +
                `and stays there for ever)` : ''} — the room is not generating. Do NOT compute ` +
                `the hour to argue with this; the clock has been wrong here before` };
}

// ---------------------------------------------------------------- where to stand
//
// Never move somebody already on either room: the two are equivalent work and a swap is
// pure walking. Everyone else is dealt to whichever room is emptier, with the armoured
// preferring the crypt because its skeleton share is 20% against the graveyard's 15%.
// HALF IN EACH, AND THE BALANCE IS ENFORCED RATHER THAN HOPED FOR.
//
// The first version had one rule — never move a character already standing on either room,
// because the two are equivalent work and a swap is pure walking. That is right about
// SWAPPING and wrong about BALANCE: whoever reaches the graveyard first simply stays, and a
// live shift settled at twelve and six. Twelve characters in a room whose generator caps at
// ten are queueing for spawns that do not exist, while six share the other ten.
//
// So there are now two rules and they are applied in order:
//
//   1. fill the empty half — unplaced characters go to whichever room is shorter;
//   2. THEN level the two, moving the excess out of the over-full one.
//
// Nobody is moved except to correct an imbalance, which keeps the original intent: a
// character on station stays on station unless its room is carrying more than its share.
export const ROOM_CAP = 10;

export function assignRooms(rows = [], { cap = ROOM_CAP } = {}) {
  const at = room => rows.filter(r => r.room === room).length;
  const out = [];
  let gy = at(GRAVEYARD), cr = at(CRYPT);

  // 1. place everyone who is on neither room.
  for (const r of rows) {
    if (r.room === GRAVEYARD || r.room === CRYPT) { out.push({ ...r, to: r.room, moved: false }); continue; }
    const armoured = wearsBodyArmour(r);
    const to = armoured ? CRYPT : (gy <= cr ? GRAVEYARD : CRYPT);
    if (to === GRAVEYARD) gy++; else cr++;
    out.push({ ...r, to, moved: true, why: 'unplaced' });
  }

  // 2. level them. Target is half the shift, never more than the generator's cap — beyond
  // that the extra bodies are competing for spawns the room cannot make.
  const total = out.length;
  const target = Math.min(cap, Math.ceil(total / 2));
  const overfull = () => (gy > target ? GRAVEYARD : cr > target ? CRYPT : null);
  let from;
  while ((from = overfull()) && Math.abs(gy - cr) > 1) {
    const to = from === GRAVEYARD ? CRYPT : GRAVEYARD;
    // Move the ones that did NOT choose that room deliberately first: an armoured
    // character is in the crypt because its prey is denser there, so it is the last to be
    // shuffled out of it.
    const pick = out.find(x => x.to === from && !x.moved && !(from === CRYPT && wearsBodyArmour(x)))
              ?? out.find(x => x.to === from && !x.moved);
    if (!pick) break;
    pick.to = to; pick.moved = true;
    pick.why = `rebalancing — ${from} was carrying more than its half of the shift`;
    if (from === GRAVEYARD) { gy--; cr++; } else { cr--; gy++; }
  }
  return out;
}

// A SHIFT IS 35 MINUTES AND A TRIP TO A BANK IS MOST OF IT. Banking and selling are the
// right thing BETWEEN shifts and the wrong thing inside one, and the keeper cannot tell the
// difference because its thresholds have no clock on them: `bank_above` at 500 and
// `max_carry` at 14 both trip on a pack full from the PREVIOUS shift, so the window opens
// and the fleet sets off for Barloque. Watched live, eleven of twenty-one walked out of a
// spawning graveyard this way and the rooms had to be refilled by hand three times.
//
// So the shift suppresses both for its duration. This is not "errands are bad" — it is that
// a 35-minute window is shorter than the errand, and `standDownOrders` hands the fleet back
// with its ordinary thresholds the moment the window shuts.
export const SHIFT_MAX_CARRY = 60;

// NAME THE PREY THE ROOM ACTUALLY MAKES, NOT THE ONE WORTH MOST. Both rooms are mostly
// zombie — 70 is 85/15 and the crypt 80/20 — and a `farm` keeper told to hunt the 15%
// concludes the room cannot produce its prey and leaves to find some, which is the same
// departure documented under `standDownOrders` below. Naming the skeleton emptied both
// rooms inside a minute.
//
// The skeleton is still fought: `max_threat_over` is what decides whether one may be
// engaged when it does appear, and that is the knob the armour buys. Hunt says what to look
// for; the ceiling says what is allowed. Conflating them costs the whole shift.
export const ordersFor = row => ({
  hunt: 'zombie',
  max_threat_over: wearsBodyArmour(row) ? SKELETON_CEILING : ZOMBIE_CEILING,
  flee_below: wearsBodyArmour(row) ? 0.40 : 0.35,
  max_carry: SHIFT_MAX_CARRY,
  bank_above: null,
  roam: false,
});

// ---------------------------------------------------------------- where to run
//
// A FLEE MUST NOT LEAVE TOS. The harness's `nearestSanctuary` built its candidate list from
// the spawn index and then filtered out anything huntable — but a room that generates
// nothing has NO ENTRY in that index, so every inn in the world was invisible to it. What
// survived was outdoor rooms that merely happen to carry no huntable spawn. A character
// fled the graveyard at 2 health and set off for the Twisted Wood, which holds trolls at
// rating 750, while Familiars sat two rooms away and was never considered.
//
// The route is the part that kills: a planned trip is not reconsidered and goes THROUGH
// whatever is on the way. So the retreat is named explicitly rather than searched for.
export const retreatTo = () => TOS_INN;

// ---------------------------------------------------------------- when it shuts
//
// NOTHING WALKS A CHARACTER HOME WHEN THE WINDOW CLOSES, and that is a separate failure
// from fleeing. At the end of a shift the fleet was found standing in the Badlands with a
// groundworm queen, in Ukgoth with a stone troll, and in the Sewers with a lupogg — not
// because anything drove them there, but because that is where the last fight ended and
// nothing told them to come back. They were at full health and earning nothing.
//
// Worse, a `farm` keeper left pointed at a room that has stopped generating decides the
// room cannot produce its prey and LEAVES TO FIND SOME — which is how a graveyard shift
// turns into twenty characters scattered across the world. So standing down means going
// IDLE, not merely staying put: idle has no prey to go looking for.
export const standDownOrders = () => ({ mode: 'idle', assigned_room: TOS_INN, roam: false });

export const graveyardFleetRules = [
  {
    id: 'graveyard-shift',
    faculty: 'work',
    scope: 'fleet',
    why: 'the Tos undead are the only prey this fleet has found that advances a character ' +
         'at max health 50, and they exist for about 35 minutes in every 120 — so the ' +
         'shift is worth forming quickly and worth standing down completely',
    enabled: doctrine => doctrine.graveyard?.shift === true,
    offWhy: 'graveyard.shift is off. With it on, the whole fleet is re-tasked onto the ' +
            'undead whenever the rooms are observed to be generating, and stood down to ' +
            'the Tos inn whenever they are not',

    decide(fleetObs, doctrine) {
      const rows = fleetObs.characters ?? [];
      const g = doctrine.graveyard ?? {};
      const live = rows.filter(r => r.in_game);
      if (!live.length) return { kind: 'pass', why: 'nobody in game' };

      // The room decides, not the clock. Either room generating counts as open — they run
      // off the same game hour, so one being stocked while the other is bare means the
      // fleet has simply cleared the second.
      const views = fleetObs.room_views ?? [];
      const inGrave = views.find(v => v.room === GRAVEYARD) ?? {};
      const inCrypt = views.find(v => v.room === CRYPT) ?? {};
      const a = windowIsOpen(inGrave), b = windowIsOpen(inCrypt);
      const open = a.open || b.open;

      if (!views.length)
        return { kind: 'pass',
                 why: 'nobody is standing in either room, so there is no observation of ' +
                      'whether they are generating — and this rule will not fall back to ' +
                      'the computed hour, which has been wrong on this server' };

      if (!open)
        return { kind: 'act',
                 plan: live.filter(r => r.mode !== 'idle' || r.room !== TOS_INN)
                           .map(r => ({ agent: r.agent, do: 'stand-down', ...standDownOrders(),
                                        why: 'the rooms are not generating' })),
                 why: `standing down to the Tos inn — ${a.why ?? b.why}` };

      const plan = assignRooms(live).map(r => ({
        agent: r.agent, do: 'deploy', to: r.to, moved: r.moved,
        ...ordersFor(r),
        use_safe_spots: true,
        // Every kill of the clean shift came from behind a wall and nobody died; the shift
        // that fought in the open lost seven. This is not a preference.
        retreat_to: retreatTo(),
      }));
      const moving = plan.filter(p => p.moved).length;
      return { kind: 'act', plan,
               why: `undead observed (${a.seen + b.seen} standing) — ${plan.length} on the ` +
                    `shift, ${moving} moving, ${plan.length - moving} already on station; ` +
                    `${plan.filter(p => p.hunt === 'skeleton').length} armoured on skeletons` };
    },
  },
];
