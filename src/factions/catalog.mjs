// SOURCE-DERIVED FACTION JOIN QUESTS.
//
// questengine.kod defines exactly one join template per liege. The lists here are the
// durable-goal contract exposed to the strategy game and the acquisition choices used
// by the pure rule table. Monster sources come from the same treasure tables compiled
// into m59-harness/substrate/m59-spawns.json.

export const FACTION_IDS = Object.freeze({
  DUKE: 'duke',
  PRINCESS: 'princess',
  REBEL: 'rebel',
});

export const QUEST_LIMIT_MS = 60 * 60_000;
export const SOLDIER_STAGE_LIMIT_MS = 3 * 60 * 60_000;
export const NATURAL_TOWN_WAIT_MS = 30 * 60_000;

export const FACTION_CATALOG = Object.freeze([
  Object.freeze({
    id: FACTION_IDS.DUKE,
    title: 'Duke',
    leader: 'Duke Akardius',
    room: 952,
    summary: 'Bring the Duke one randomly requested gem.',
    assignments: Object.freeze(['sapphire', 'ruby', 'emerald', 'diamond']),
  }),
  Object.freeze({
    id: FACTION_IDS.PRINCESS,
    title: 'Princess',
    leader: 'Princess Kateriina',
    room: 852,
    summary: 'Deliver her official letter to Priestess Xiana, Lady Aftyn, or Herbutte.',
    assignments: Object.freeze(['letter to Priestess Xiana', 'letter to Lady Aftyn',
      'letter to Herbutte']),
  }),
  Object.freeze({
    id: FACTION_IDS.REBEL,
    title: 'Rebels (Jonas)',
    leader: "Jonas D'Accor",
    room: 371,
    summary: 'Bring Jonas one randomly requested piece of equipment.',
    // Scimitar occurs twice in questengine.kod's cargo list; expose that weighting
    // honestly instead of silently de-duplicating it.
    assignments: Object.freeze(['plate armor', 'simple helm', "knight's shield",
      'gauntlets', 'mystic sword', 'scimitar', 'scimitar']),
  }),
]);

// ---------------------------------------------------------------------------
// LOYALTY SERVICE — the subscription, not the sign-up.
//
// A member that has not served its liege for 20 hours is warned, and at 24 hours it is
// expelled (`FACTION_WARN_TIME`/`FACTION_RESIGN_TIME`, blakston.khd:2325). That leaves a
// FOUR-HOUR window, and the quest it is spent on has a ONE-HOUR timer of its own whose
// failure penalty is `QN_PRIZE_FACTION_NEUTRAL` — expulsion, immediately.
//
// So the order of operations is the whole design, and it is the opposite of the join
// quest's. Join: ask, then go and find what was asked for. Loyalty: BE HOLDING IT
// ALREADY, then ask. Asking first converts a comfortable four-hour deadline into a tight
// one-hour one for no gain, and if the shopping trip goes wrong the character loses the
// membership it was trying to keep. The harness refuses the request for that reason; this
// table is what lets DUM satisfy the precondition before it asks.
export const LOYALTY_LIMIT_MS = 60 * 60_000;

export const LOYALTY_CATALOG = Object.freeze({
  // Node 197 -> 198 (questengine.kod:5671-5704). Same room, same NPC, no delivery leg.
  rebel: Object.freeze({
    id: 'rebel', leader: "Jonas D'Accor", room: 371, automated: true,
    summary: 'Say "loyalty" to Jonas while carrying one piece of equipment he accepts.',
    accepts: Object.freeze(['helm', "knight's shield", 'gauntlets', 'long sword',
      'mystic sword', 'scimitar', 'nerudite sword']),
  }),
  // Node 8 -> 9 (questengine.kod:2536-2575). The Princess supplies the letter, so there is
  // nothing to carry in — but there IS a delivery leg to one of five named NPCs.
  princess: Object.freeze({
    id: 'princess', leader: 'Princess Kateriina', room: 852, automated: true,
    summary: 'Say "loyalty" to the Princess and deliver the letter she hands over.',
    accepts: Object.freeze(['letter']),
    supplied_by_liege: true,
  }),
  // Node 5 -> 6 -> 7. Not automated — the middle leg names a different townsperson each
  // time, and answering it would mean a speech allowlist covering three towns.
  duke: Object.freeze({
    id: 'duke', leader: 'Duke Akardius', room: 952, automated: false,
    summary: 'Three legs, the middle one a different townsperson each time. Operator work.',
    accepts: Object.freeze([]),
  }),
});

export const loyaltySpec = value =>
  LOYALTY_CATALOG[factionId(value, { optional: true }) ?? ''] ?? null;

// WHERE THE PAYMENT COMES FROM, AND WHY IT IS A SHOP RATHER THAN A HUNT.
//
// A loyalty item may be looted as well as bought, and for a deadline this tight buying is
// the only source worth planning around: `acquisitionSource` below offers a 5%-per-kill
// hunt, which is a fine answer for a durable goal and a terrible one for four hours.
//
// Rook in Cor Noth (room 154) is the entry that matters. He is `CorNothSergeant`, which
// does NOT declare `vbSellFromInventory = TRUE` — only `kcshopk.kod:54` and `izzio.kod:54`
// do — so his list is assembled on demand and he cannot run out of long swords. Izzio
// stocks two of these and is exactly the merchant that CAN be empty, and wanders besides,
// so he is recorded second and never planned against.
export const LOYALTY_MARKETS = Object.freeze({
  'long sword': Object.freeze([
    Object.freeze({ merchant: 'Rook', room: 154, finite_stock: false, wanders: false }),
    Object.freeze({ merchant: 'Izzio', room: 593, finite_stock: true, wanders: true }),
  ]),
  helm: Object.freeze([
    Object.freeze({ merchant: 'Izzio', room: 593, finite_stock: true, wanders: true }),
  ]),
  'nerudite sword': Object.freeze([
    Object.freeze({ merchant: "Ixla cha'Totlak", room: 2003, finite_stock: false, wanders: false }),
  ]),
});

/**
 * The one thing to buy, and where, to satisfy a loyalty debt — or null when nothing on
 * this liege's list can be bought at a counter that cannot be empty.
 *
 * Deliberately refuses a merchant with finite stock or a wandering one: "the shop had
 * none" is a sentence spoken to the room and never an error on the wire, so a plan
 * resting on one reports success and comes home empty with the hour gone.
 */
export function loyaltyPurchase(faction) {
  const spec = loyaltySpec(faction);
  if (!spec?.automated || spec.supplied_by_liege) return null;
  for (const item of spec.accepts) {
    const seller = (LOYALTY_MARKETS[item] ?? []).find(m => !m.finite_stock && !m.wanders);
    if (seller) return { item, ...seller };
  }
  return null;
}

/** Anything in this pack the liege would accept. Always an array — never null. */
export function loyaltyPayment(faction, items = []) {
  const spec = loyaltySpec(faction);
  if (!spec?.automated) return [];
  return (items ?? []).filter(item =>
    spec.accepts.includes(String(item?.name ?? item ?? '').trim().toLowerCase()));
}

export const SOLDIER_CATALOG = Object.freeze({
  duke: Object.freeze([
    Object.freeze({ target: 'rebel soldier', rooms: Object.freeze([568, 557, 547]) }),
    Object.freeze({ target: "soldier of the Princess' army", rooms: Object.freeze([593, 583, 603]) }),
  ]),
  princess: Object.freeze([
    Object.freeze({ target: "soldier of the Duke's army", rooms: Object.freeze([586, 596, 585]) }),
    Object.freeze({ target: 'rebel soldier', rooms: Object.freeze([568, 557, 547]) }),
  ]),
  rebel: Object.freeze([
    Object.freeze({ target: "soldier of the Princess' army", rooms: Object.freeze([593, 583, 603]) }),
    Object.freeze({ target: "soldier of the Duke's army", rooms: Object.freeze([586, 596, 585]) }),
  ]),
});

const BY_ID = new Map(FACTION_CATALOG.map(faction => [faction.id, faction]));
const ALIASES = Object.freeze({ jonas: 'rebel', rebels: 'rebel', kateriina: 'princess',
  akardius: 'duke' });

export function factionId(value, { optional = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (optional) return null;
    throw new Error('choose duke, princess, or rebel');
  }
  const raw = String(value).trim().toLowerCase();
  const id = ALIASES[raw] ?? raw;
  if (!BY_ID.has(id)) throw new Error(`unknown faction "${value}"`);
  return id;
}

export const factionDefinition = value => BY_ID.get(factionId(value)) ?? null;

// Best practical source first, with level and per-kill treasure chance. A rule still
// refuses a source above the unit's configured threat allowance; a durable goal waits
// for growth or a carried/fleet-supplied copy rather than ordering a suicidal hunt.
const SOURCES = Object.freeze({
  sapphire: [{ hunt: 'fungus beast', room: 563, level: 50, chance: 10 }],
  emerald: [{ hunt: 'fungus beast', room: 563, level: 50, chance: 6 }],
  ruby: [{ hunt: 'mummy', room: 1006, level: 25, chance: 15 },
    { hunt: 'spider', room: 27, level: 50, chance: 2 }],
  diamond: [{ hunt: 'spider', room: 27, level: 50, chance: 2 },
    { hunt: 'skeleton', room: 38, level: 75, chance: 6 }],
  scimitar: [{ hunt: 'orc', room: 27, level: 45, chance: 16 }],
  "knight's shield": [{ hunt: 'battered skeleton', room: 39, level: 60, chance: 5 },
    { hunt: 'cave orc', room: 2500, level: 80, chance: 1 }],
  'simple helm': [{ hunt: 'cave orc', room: 2500, level: 80, chance: 5 }],
  gauntlets: [{ hunt: 'orc wizard', room: 2501, level: 80, chance: 4 },
    { hunt: 'troll', room: 526, level: 90, chance: 6 }],
  'plate armor': [{ hunt: 'lupogg', room: 108, level: 105, chance: 1 }],
  'mystic sword': [{ hunt: 'lupogg', room: 108, level: 105, chance: 1 }],
});

export function acquisitionSource(item, level, maxThreatOver = 6) {
  const ceiling = Number(level ?? 0) + Math.max(0, Number(maxThreatOver ?? 0));
  return (SOURCES[String(item ?? '').toLowerCase()] ?? [])
    .filter(source => source.level <= ceiling)
    .sort((a, b) => b.chance - a.chance || a.level - b.level)[0] ?? null;
}

export const acquisitionSources = item => [...(SOURCES[String(item ?? '').toLowerCase()] ?? [])];
