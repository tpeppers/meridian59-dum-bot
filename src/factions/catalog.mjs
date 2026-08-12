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
