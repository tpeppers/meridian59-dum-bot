// THE MOOT — the fleet stands in one room and levels itself up to its own standard.
//
// WHAT A MOOT IS FOR, IN ONE SENTENCE: the fleet's resources are never scarce, they are in
// the wrong pockets. Measured on this fleet in a single pass — one character on a 412-vigor
// larder next to one carrying nothing; 400 shillings and no food; 84 elderberry and 76
// herbs held by a character standing two rooms from four characters who could not cast
// `create food` for want of two herbs each. Nothing was short. Everything was misplaced.
//
// WHY IT MOVED OUT OF THE HARNESS. `m59-allhands.mjs` does the mechanics well — it musters
// to an inn, pools, feeds, relays and puts everyone back. What it cannot do is decide WHAT
// EACH CHARACTER SHOULD END UP WITH, because that is a per-character judgement and it had
// one hard-coded answer for twenty-one characters. The answer already exists elsewhere: a
// LOADOUT is exactly "what this character wants to be carrying", with a min, a priority
// weight and a kind. So the moot's target is not a constant in this file; it is read.

// ---------------------------------------------------------------- what each one wants
//
// FROM THE LOADOUT, NEVER FROM A CONSTANT HERE. `carry` entries are {item, min, weight,
// kind}; `min` is the floor this character wants to leave with. A character with no
// loadout gets the doctrine's fallback and is REPORTED as having used it — silence there
// would read as "this character wants nothing", which is the one answer that is never true.
export function wantOf(row, { fallback = {} } = {}) {
  const carry = row.loadout?.carry;
  if (!Array.isArray(carry) || !carry.length)
    return { want: { ...fallback }, from: 'fallback',
             why: `${row.character ?? row.agent} has no loadout carry list — using the ` +
                  `doctrine's default. That is a guess about what it needs, not its own answer` };
  const want = {};
  for (const c of carry) {
    if (!c?.item || !(c.min > 0)) continue;
    want[String(c.item).toLowerCase()] = { min: c.min, weight: c.weight ?? 1, kind: c.kind ?? null };
  }
  return { want, from: 'loadout', why: null };
}

const amountOf = (row, item) =>
  (row.items ?? []).filter(i => String(i.name ?? '').toLowerCase() === item)
                   .reduce((t, i) => t + (i.amount ?? 1), 0);

// ---------------------------------------------------------------- the share-out
//
// EQUITABLE MEANS EQUAL FRACTION OF WANT, NOT EQUAL COUNT, and the difference matters
// whenever wants differ. A caster wanting 40 herbs and a fighter wanting 4 are not made
// equal by giving them 10 each: that leaves the caster at a quarter and overshoots the
// fighter. Filling both to the same FRACTION is the sharing rule people actually mean when
// they say fair, and it degrades gracefully — at 50% supply everyone gets half of what
// they asked for rather than some getting everything and the rest nothing.
//
// The pool is what the fleet holds ABOVE its own wants. Nobody is stripped below their own
// floor to fill somebody else's: a moot that leaves the donor short has moved the problem.
export function shareOut(rows, opts = {}) {
  const wants = new Map(), notes = [];
  for (const r of rows) {
    const w = wantOf(r, opts);
    if (w.why) notes.push(w.why);
    wants.set(r.agent, w.want);
  }
  // Every item anyone wants, plus every item anyone holds a surplus of.
  const items = new Set();
  for (const w of wants.values()) for (const k of Object.keys(w)) items.add(k);

  const plan = [], transfers = [];
  for (const item of items) {
    let pool = 0;
    const need = [], donors = [];
    for (const r of rows) {
      const min = wants.get(r.agent)?.[item]?.min ?? 0;
      const has = amountOf(r, item);
      if (has > min) {
        const spare = has - min;
        pool += spare;
        donors.push({ row: r, spare, lots: exactLots(r, item) });
      }
      if (has < min) need.push({ agent: r.agent, character: r.character, short: min - has, min });
    }
    if (!need.length) continue;
    const total = need.reduce((t, n) => t + n.short, 0);
    // The fraction of everyone's shortfall the pool can cover. Capped at 1: a surplus does
    // not become an instruction to overfill.
    const cover = total > 0 ? Math.min(1, pool / total) : 0;
    const awards = [];
    for (const n of need) {
      const give = Math.floor(n.short * cover);
      plan.push({ ...n, item, give, cover,
                  why: cover >= 1 ? 'filled to its loadout floor'
                     : cover > 0  ? `fleet holds ${pool} spare against ${total} needed — ` +
                                    `everyone gets the same ${Math.round(cover * 100)}% of their shortfall`
                     : `nobody has any spare ${item}; the fleet is genuinely short, not misplaced` });
      if (give > 0) awards.push({ ...n, give });
    }
    for (const award of awards) {
      let left = award.give;
      for (const donor of donors) {
        if (!left || !donor.spare) continue;
        const what = takeLots(donor.lots, Math.min(left, donor.spare));
        const represented = what.reduce((t, x) => t + x.amount, 0);
        if (!represented) continue;
        const summary = plan.find(p => p.agent === award.agent && p.item === item);
        transfers.push({ from: donor.row.agent, to: award.agent, item,
                         amount: represented,
                         // In harness supply, a bare id means THE WHOLE STACK. Even one
                         // unit must therefore retain an explicit amount.
                         what: what.map(x => ({ id: x.id, amount: x.amount })),
                         why: summary?.why });
        donor.spare -= represented;
        left -= represented;
      }
    }
  }
  return { plan, transfers, notes };
}

function exactLots(row, item) {
  return (row.items ?? []).filter(i => !i.broken && i.id != null &&
    String(i.name ?? '').toLowerCase() === item)
    .map(i => ({ id: i.id, left: i.amount ?? 1 }));
}

function takeLots(lots, wanted) {
  let left = wanted;
  const out = [];
  for (let i = lots.length - 1; i >= 0 && left > 0; i--) {
    const lot = lots[i];
    const amount = Math.min(left, lot.left);
    if (amount > 0) out.push({ id: lot.id, amount });
    lot.left -= amount;
    left -= amount;
  }
  return out;
}

// ---------------------------------------------------------------- what cannot be shared
//
// A SHORTAGE AND A MISPLACEMENT LOOK THE SAME ON A BOARD AND HAVE OPPOSITE FIXES. Pooling
// cures the second and cannot touch the first — measured here: the fleet held 1739
// elderberry and 47 herbs, so every herb moved between characters left the total at 47 and
// `create food` stayed blocked. The moot must say which it is rather than reporting a
// successful redistribution of nothing.
export function shortfalls(share) {
  const byItem = new Map();
  for (const p of share.plan) {
    const cur = byItem.get(p.item) ?? { item: p.item, short: 0, unmet: 0, characters: 0 };
    cur.short += p.short; cur.unmet += p.short - p.give; cur.characters++;
    byItem.set(p.item, cur);
  }
  return [...byItem.values()].filter(x => x.unmet > 0)
    .map(x => ({ ...x, buy: x.unmet,
                 why: `${x.characters} character(s) short ${x.short} between them and the ` +
                      `fleet can only cover ${x.short - x.unmet} — the remaining ${x.unmet} ` +
                      `has to be BOUGHT, not moved` }));
}

// A MOOT HAPPENS IN AN INN AND NOWHERE ELSE. Standing a dozen characters still, in the
// open, to eat is standing them still somewhere things can hit them — the first accidental
// moot in this fleet ran in Deep Woods of Ileria, which spawns living trees, and every
// character in it was a target that was not fighting back.
export const DEFAULT_INNS = [153, 106, 103, 52, 202, 2001, 1017, 1007];

export const mootFleetRules = [
  {
    id: 'moot-pool-and-share',
    faculty: 'economy',
    scope: 'fleet',
    why: 'the fleet\'s resources are never scarce, they are in the wrong pockets — and ' +
         'every hand-over needs both characters in one room, which two driving keepers ' +
         'almost never are',
    enabled: doctrine => doctrine.moot?.hold === true,
    offWhy: 'moot.hold is off. With it on the fleet musters to an inn and levels itself ' +
            'up to each character\'s own loadout floor',

    decide(fleetObs, doctrine) {
      const m = doctrine.moot ?? {};
      const rows = (fleetObs.characters ?? []).filter(r => r.in_game);
      if (!rows.length) return { kind: 'pass', why: 'nobody in game' };

      const room = m.room ?? DEFAULT_INNS[3];
      const inns = m.inns ?? DEFAULT_INNS;
      if (!inns.includes(room))
        return { kind: 'pass',
                 why: `moot.room ${room} is not an inn. A muster stands characters still to ` +
                      `eat, so it only ever assembles somewhere nothing spawns` };

      // THE WINDOW OUTRANKS THE MOOT. Pooling is what the fleet does with the ~85 minutes
      // in every 120 when the undead are not up; doing it during a shift spends the thing
      // it is preparing for.
      if (fleetObs.window_open && m.yield_to_window !== false)
        return { kind: 'pass', why: 'the undead are up — the shift outranks the moot' };

      const here = rows.filter(r => r.room === room);
      const away = rows.filter(r => r.room !== room);
      const holds = here.filter(r => r.mode !== 'idle')
        .map(r => ({ agent: r.agent, do: 'hold', at: room,
                    why: 'the moot is still in session; survival stays with the keeper in idle mode' }));
      if (away.length && here.length < (m.quorum ?? 2))
        return { kind: 'act',
                 plan: [...holds, ...away.map(r => ({ agent: r.agent, do: 'muster', to: room,
                                                      why: `muster to room ${room} for the moot` }))],
                 why: `${here.length} at the inn — mustering ${away.length} more before ` +
                      `pooling, because a hand-over needs both ends in one room` };

      const unread = here.filter(r => !Array.isArray(r.items) || r.loadout === undefined);
      if (unread.length) {
        const positioning = [...holds, ...away.map(r => ({ agent: r.agent, do: 'muster', to: room,
                                                           why: `muster to room ${room} for the moot` }))];
        if (positioning.length)
          return { kind: 'act', plan: positioning,
                   why: `holding/mustering, but not pooling: exact inventories/loadouts were unreadable for ` +
                        unread.map(r => r.agent).join(', ') };
        return { kind: 'pass', why: `not pooling because exact inventories/loadouts were unreadable for ` +
                                    unread.map(r => r.agent).join(', ') };
      }

      const share = shareOut(here, { fallback: m.default_want ?? {} });
      const gaps = shortfalls(share);
      const moves = share.transfers;

      if (!moves.length && !gaps.length && !away.length && !holds.length)
        return { kind: 'pass',
                 why: `${here.length} at the inn and everyone is at its loadout floor` };

      return { kind: 'act',
               plan: [
                 ...holds,
                 ...away.map(r => ({ agent: r.agent, do: 'muster', to: room,
                                     why: `muster to room ${room} for the moot` })),
                 ...moves.map(p => ({ do: 'give', ...p })),
               ],
               shortfalls: gaps,
               notes: share.notes,
               why: `${here.length} pooling at the inn: ${moves.length} transfer(s)` +
                    (gaps.length
                      ? `; still short ${gaps.map(g => `${g.unmet} ${g.item}`).join(', ')} — ` +
                        `that part is a SHORTAGE and must be bought, not moved`
                      : '; everyone reaches their loadout floor') };
    },
  },
];
