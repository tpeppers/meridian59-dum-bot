// THE KOD SPELL CATALOGUE, AS DUM READS IT.
//
// The protocol tells a client a spell's name, its school and how many targets it takes, and
// nothing about what it COSTS. The harness compiles that from the game's source into
// m59-spells.json (tools/m59-spells.mjs build): mana, reagents by kod class name, whether it
// is harmful, and the class it inherits from. The spell-training plan needs all four, so this
// reads that file -- a path on THIS machine, set in dum.local.json, never in a doctrine.
//
// Read here, in sense/, because it is I/O. The plan in decide/ only ever sees the result,
// joined onto each trainer's fleet row by observe.mjs `enrichSpellTraining`.

import { readFileSync, statSync } from 'node:fs';

// THE KOD SPELLS A REAGENT AS A CLASS, THE PACK AND THE COURIER AS AN ITEM NAME. The same
// mapping the harness's desk practice uses (m59-deskpractice.mjs reagentName): `Herbs` is the
// "herb" in a pack, `ElderBerry` the "elderberry", `Snack` the edible mushroom. Note that
// "mushroom" (the Mushroom class) is NOT "edible mushroom" -- a request file that mixed the
// two would feed the wrong drill.
const REAGENT_NAMES = { elderberry: 'elderberry', herbs: 'herb', snack: 'edible mushroom', orctooth: 'orc tooth' };
export function reagentName(cls) {
  const flat = String(cls ?? '').toLowerCase();
  if (REAGENT_NAMES[flat]) return REAGENT_NAMES[flat];
  return String(cls ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
}

const key = name => String(name ?? '').trim().toLowerCase().replace(/['’]/g, '');

/** Parse the catalogue's JSON into a Map keyed by lower-case, apostrophe-free spell name. */
export function parseSpellCatalogue(json) {
  const list = Array.isArray(json?.spells) ? json.spells : (Array.isArray(json) ? json : []);
  const out = new Map();
  for (const s of list) {
    if (!s?.name) continue;
    out.set(key(s.name), {
      name: String(s.name).toLowerCase(),
      mana: Number.isFinite(Number(s.mana)) ? Number(s.mana) : null,
      reagents: (s.reagents ?? []).map(r => [reagentName(r.item), Number(r.count) || 1]),
      harmful: s.harmful === true,
      parent: s.parent ?? null,
      school: s.school_name ?? null,
      level: s.level ?? null,
    });
  }
  return out;
}

export const catalogueEntry = (catalogue, name) => catalogue?.get(key(name)) ?? null;

const cache = new Map();   // path -> { mtimeMs, catalogue }

/** The catalogue at `path`, re-read only when the file changes. Null when unset or unreadable. */
export function loadSpellCatalogue(path) {
  if (!path) return null;
  try {
    const { mtimeMs } = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === mtimeMs) return hit.catalogue;
    const catalogue = parseSpellCatalogue(JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')));
    cache.set(path, { mtimeMs, catalogue });
    return catalogue;
  } catch {
    return null;
  }
}
