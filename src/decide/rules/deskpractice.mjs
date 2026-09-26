// PRACTICE WHILE RUNNING A SERVICE DESK — the directional half.
//
// Operator, 2026-09-25: a service character builds its spells in the time between customers,
// and "keeps enough mana in reserve for 2x casts of its most expensive service".
//
// WHAT DUM DECIDES AND WHAT IT DOES NOT. Which spells a desk character drills, and whether it
// drills at all, is a minutes-clock decision with no single right answer — so it is DUM's, and
// it lives in the doctrine. WHEN to cast, whether the mana is there, whether a ticket just
// arrived: those are one-second decisions and the keeper makes them (m59-harness
// `Autopilot.practiceAtDesk`). So this rule does exactly one thing: it keeps the keeper's
// `practiceSpells` policy equal to the doctrine, and returns null once it is.
//
// THERE IS DELIBERATELY NO MANA NUMBER HERE. The reserve is two casts of the dearest service the
// desk both OFFERS and the character KNOWS, and both of those are harness-side facts — the
// chalice menu and the spell book. A number typed into a doctrine would be right for the menu
// on the day it was written and wrong the day somebody switched reveal off. `reserve_casts` is
// the operator's multiplier; `mana_floor` is only ever a floor UNDER the derived reserve.
//
// NOT A SHIFT STATION. `shift.stations` is the where-to-hunt table and refuses any room outside
// HUNT_ROOMS, and the desk (Outside Castle Victoria, room 2) will never be in it. Where the desk
// stands is the chalice config's business; this rule never moves anybody.
//
// OFF BY DEFAULT. `desk_practice.on` is false unless a doctrine says so, and `agents` must name
// who — in `doctrines/local/`, because a desk character's handle identifies the fleet.

// Keys the harness accepts. Anything else is refused by the broker for the WHOLE push, so it is
// never forwarded — the schema reports it at load instead.
export const PRACTICE_KEYS = Object.freeze(['spells', 'reserve_casts', 'mana_floor', 'gap_ms',
  'refused_ms', 'rooms', 'rest_seconds']);

const cfg = (doctrine) => doctrine?.desk_practice ?? {};
const lower = (s) => String(s ?? '').trim().toLowerCase();

/** Is this character one of the doctrine's desk characters? By agent handle or character name. */
export function isDeskCharacter(obs, doctrine) {
  const who = [].concat(cfg(doctrine).agents ?? []).map(lower).filter(Boolean);
  if (!who.length) return false;
  return who.includes(lower(obs?.agent)) || who.includes(lower(obs?.character));
}

/** The policy this doctrine wants on a desk character: `{enabled: true, spells, ...}`. */
export function wantedPractice(doctrine) {
  const c = cfg(doctrine);
  const out = { enabled: true };
  for (const k of PRACTICE_KEYS) if (c[k] !== undefined && c[k] !== null) out[k] = c[k];
  return out;
}

// KEY ORDER IS NOT A DIFFERENCE. The broker stores what it was sent, but a doctrine re-ordered
// by hand must not redeploy the desk on every tick.
const canon = (v) => (Array.isArray(v) ? v.map(canon)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
export const samePractice = (a, b) => JSON.stringify(canon(a ?? null)) === JSON.stringify(canon(b ?? null));

export const deskPracticeRules = [
  {
    id: 'desk-practice-policy',
    faculty: 'work',
    why: 'a desk character practises its spells between customers, above the reserve its services need',
    // ENABLED WHENEVER THE SECTION EXISTS, NOT ONLY WHEN IT IS ON: switching a desk off has to
    // reach the keeper too, or `on: false` would leave it drilling on the last orders it got.
    enabled: doctrine => doctrine?.desk_practice != null,
    offWhy: 'no desk_practice section',
    decide(obs, doctrine) {
      if (!isDeskCharacter(obs, doctrine)) return null;
      const live = obs.keeper?.policy?.practiceSpells ?? obs.policy?.practiceSpells ?? null;
      if (cfg(doctrine).on !== true) {
        if (live == null) return null;
        return { kind: 'orders', orders: { action: 'start', practice_spells: null },
          why: 'desk_practice is off, so stop practising at the desk', evidence: { keeper_has: live } };
      }
      const wanted = wantedPractice(doctrine);
      if (samePractice(live, wanted)) return null;
      const spells = [].concat(wanted.spells ?? []).map(s => (typeof s === 'string' ? s : s?.name)).join(', ');
      return {
        kind: 'orders',
        orders: { action: 'start', practice_spells: wanted },
        why: `practise ${spells} at the desk between customers, keeping ` +
             `${wanted.reserve_casts ?? 2} casts of its dearest service in reserve (the harness derives the mana)`,
        evidence: { want: wanted, keeper_has: live },
      };
    },
  },
];
