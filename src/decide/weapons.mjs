// NAMED WEAPON POLICIES — one ranking, used for both choosing and provisioning.
//
// A priority list and a readiness threshold must come from the SAME ordering. If the
// keeper equips from one list while the moot qualifies against another, a character can
// be reported ready while deliberately wielding the weapon the shift considers worse.

const NOVICE_DAMAGE_ORDER = [
  // Generated from m59-harness/compendium/weapons/index.html: novice damage maximum,
  // descending, then name for deterministic ties. Keep this snapshot here rather than
  // importing across repositories; DUM and the harness are deliberately on separate clocks.
  'scimitar',
  'axe',
  'mystic sword', 'nerudite sword', 'spiritual hammer', 'sword of riija', 'sword of the hunt',
  'battle bow', 'bow', 'crossbow', 'gold sword', 'hammer', 'long sword', 'longbow',
  'magic bow', 'nerudite bow', 'practice bow', 'ranged weapon',
  'black dagger', 'dark blade of roq', 'mace', 'short sword',
];

const without = (xs, omitted) => xs.filter(x => !omitted.has(x));

export const WEAPON_PRESETS = Object.freeze({
  strongestToWeakest: Object.freeze({
    id: 'strongestToWeakest',
    title: 'strongest->weakest',
    why: 'generic-target order from the compendium, sorted by novice maximum damage',
    tiers: NOVICE_DAMAGE_ORDER.map(name => ({ id: name, names: [name] })),
  }),
  // SHORT SWORD FIRST, THEN ANYTHING. The point of the crypt shift is to train short sword
  // fighting on the creature that drops short swords, so the preferred weapon is the one
  // the skill is for rather than the one that hits hardest — a short sword is LAST in the
  // novice damage order, and choosing it is a deliberate trade of damage now for a
  // proficiency later.
  //
  // "Anything else" is the whole remaining order rather than an empty hand: an unarmed
  // character punches monsters and does not error, so a preset that ran out of tiers would
  // fail exactly the silent way this fleet keeps being bitten by. Casting one is the
  // Create Weapons strategy's job and stays independent of this ranking.
  shortSwording: Object.freeze({
    id: 'shortSwording',
    title: 'shortSwording',
    why: 'crypt shift order: the short sword the skill is for, then every other weapon',
    tiers: [
      { id: 'short sword', names: ['short sword'] },
      { id: 'other', names: without(NOVICE_DAMAGE_ORDER, new Set(['short sword'])) },
    ],
  }),
  vsSkeletons: Object.freeze({
    id: 'vsSkeletons',
    title: 'vsSkeletons',
    why: 'skeleton shift order: Hammer, then Mace, then Axe, then every other weapon',
    tiers: [
      { id: 'hammer', names: ['hammer', 'spiritual hammer'] },
      { id: 'mace', names: ['mace'] },
      { id: 'axe', names: ['axe'] },
      { id: 'other', names: without(NOVICE_DAMAGE_ORDER,
          new Set(['hammer', 'spiritual hammer', 'mace', 'axe'])) },
    ],
  }),
});

// WHICH ORDER SUITS WHICH QUARRY, FROM THE MONSTERS' OWN RESISTANCE TABLES.
//
// A weapon's damage TYPE is what a monster resists, not its name or its damage figure:
// `piAttack_type` on the weapon against `plResistances` on the creature. Short sword,
// long sword, mystic sword and gold sword are all ATCK_WEAP_THRUST; axe and scimitar are
// SLASH; hammer and mace are BLUDGEON (shrtswrd.kod:56, axe.kod:55, hammer.kod:53).
//
//   skeleton            PIERCE 70, THRUST 70, BLUDGEON -20        skel.kod:75
//   battered skeleton   inherits Skeleton                          batrskel.kod:11
//   zombie              no weapon resistances at all               zombie.kod:74
//   fungus beast        PIERCE 60, THRUST 60                       fungbst.kod
//   groundworm larva    BLUDGEON -30 (vulnerable)                  grdworm.kod
//
// A skeleton takes 30% from a thrusting sword and 120% from a hammer — a FOUR-FOLD
// difference, which is why vsSkeletons exists and why it is the default here.
//
// THE ZOMBIE IS THE EXCEPTION AND NOT FOR THE OBVIOUS REASON. It resists no weapon type,
// so a short sword is not BETTER against one — it is merely not worse. What that buys is
// free proficiency: the short sword is last in the novice damage order and the skill only
// improves by being used, so a quarry that punishes nothing is the one chance to train it
// at no cost. Against anything on the list above it would be a real loss.
export const QUARRY_PRESET = Object.freeze({
  zombie: 'shortSwording',
  skeleton: 'vsSkeletons',
  'battered skeleton': 'vsSkeletons',
  'fungus beast': 'vsSkeletons',
  'groundworm larva': 'vsSkeletons',
});

/** The order this quarry deserves, or null when nothing is known about it. */
export const presetForQuarry = quarry =>
  QUARRY_PRESET[String(quarry ?? '').trim().toLowerCase()] ?? null;

const aliases = new Map([
  ['strongesttoweakest', 'strongestToWeakest'],
  ['strongest->weakest', 'strongestToWeakest'],
  ['default', 'strongestToWeakest'],
  ['shortswording', 'shortSwording'],
  ['short-swording', 'shortSwording'],
  ['vsskeletons', 'vsSkeletons'],
]);

const norm = v => String(v ?? '').trim().toLowerCase();

function customPreset(name, definition) {
  if (!Array.isArray(definition) || !definition.length)
    throw new Error(`custom weapon preset "${name}" must be a non-empty list of names or name tiers`);
  const tiers = definition.map((entry, i) => {
    const names = (Array.isArray(entry) ? entry : [entry]).map(String).filter(Boolean);
    if (!names.length) throw new Error(`custom weapon preset "${name}" tier ${i + 1} is empty`);
    return { id: norm(names[0]), names };
  });
  return { id: name, title: name, why: 'doctrine-defined weapon priority', tiers };
}

export function weaponPreset(name = 'strongestToWeakest', customPresets = {}) {
  if (customPresets && Object.hasOwn(customPresets, name))
    return customPreset(name, customPresets[name]);
  const key = aliases.get(norm(name).replace(/\s+/g, '')) ?? name;
  const preset = WEAPON_PRESETS[key];
  if (!preset)
    throw new Error(`unknown weapon preset "${name}"; available: ${Object.keys(WEAPON_PRESETS).join(', ')}`);
  return preset;
}

export const keeperWeaponPriority = (presetName, customPresets = {}) =>
  weaponPreset(presetName, customPresets).tiers.flatMap(t => t.names).filter(n => n !== '*');

const LOOKS_LIKE_WEAPON = /\b(axe|blade|bow|crossbow|dagger|hammer|mace|scimitar|sword|weapon)\b/i;

export function weaponRank(name, presetName = 'strongestToWeakest', customPresets = {}) {
  if (!name) return Number.POSITIVE_INFINITY; // None is always worst.
  const n = norm(name);
  const preset = weaponPreset(presetName, customPresets);
  for (let i = 0; i < preset.tiers.length; i++) {
    const tier = preset.tiers[i];
    if (tier.names.some(x => norm(x) === n)) return i;
  }
  // vsSkeletons intentionally says "swords and other weapons" after Axe. A newly
  // introduced weapon therefore belongs in that tier instead of becoming equivalent
  // to no weapon. The generic preset remains closed over the compendium snapshot.
  const other = preset.tiers.findIndex(t => t.id === 'other' || t.names.includes('*'));
  return other >= 0 && LOOKS_LIKE_WEAPON.test(name) ? other : Number.POSITIVE_INFINITY;
}

export function thresholdRank(threshold, presetName = 'strongestToWeakest', customPresets = {}) {
  const preset = weaponPreset(presetName, customPresets);
  const n = norm(threshold);
  const byTier = preset.tiers.findIndex(t => norm(t.id) === n);
  const rank = byTier >= 0 ? byTier : weaponRank(threshold, presetName, customPresets);
  if (!Number.isFinite(rank))
    throw new Error(`weapon threshold "${threshold}" is not in preset ${preset.id}`);
  return rank;
}

export const passesWeaponThreshold = (name, presetName, threshold, customPresets = {}) =>
  weaponRank(name, presetName, customPresets) <=
    thresholdRank(threshold, presetName, customPresets);

const WEIGHT = new Map([
  ['mace', 60], ['hammer', 80], ['spiritual hammer', 80], ['axe', 90],
]);

export function roomForWeapon(row, name = 'axe') {
  const room = row.carry?.room_for;
  if (!room) return false; // unknown is not room; the harness withholds inexact totals.
  const weight = WEIGHT.get(norm(name)) ?? 90;
  return room.weight >= weight && room.bulk >= weight;
}

const qualifying = (row, preset, threshold, customPresets) =>
  (row.items ?? []).filter(i => i?.id != null && !i.broken &&
    passesWeaponThreshold(i.name, preset, threshold, customPresets))
    .sort((a, b) => weaponRank(a.name, preset, customPresets) -
                     weaponRank(b.name, preset, customPresets) || a.id - b.id);

/**
 * Plan exact handovers and casts from a fully enriched, co-located fleet observation.
 * Pure: the result of a cast is learned only on the next observation.
 */
export function planWeaponProvisioning(rows = [], options = {}) {
  const customPresets = options.presets ?? {};
  const preset = weaponPreset(options.preset, customPresets).id;
  const threshold = options.threshold;
  thresholdRank(threshold, preset, customPresets); // fail loudly before producing a partial plan

  const state = rows.map(row => ({ row, weapons: qualifying(row, preset, threshold, customPresets) }));
  const recipients = state.filter(x => !x.weapons.length);
  const donors = state.filter(x => x.weapons.length > 1).map(x => ({
    ...x,
    // Keep the best one; hand out the worst qualifying spare first.
    spares: x.weapons.slice(1).sort((a, b) =>
      weaponRank(b.name, preset, customPresets) - weaponRank(a.name, preset, customPresets)),
  }));

  const transfers = [], needsRoom = [];
  for (const recipient of recipients) {
    let picked = null;
    for (const donor of donors) {
      // `supply who_travels:"neither"` is intentionally exact: maintenance must never
      // pull a fighter out of its room. A spare becomes shareable when the two units are
      // already together, otherwise casting is the fallback.
      if (donor.row.room !== recipient.row.room) continue;
      const i = donor.spares.findIndex(item => roomForWeapon(recipient.row, item.name));
      if (i >= 0) { picked = { donor, item: donor.spares.splice(i, 1)[0] }; break; }
    }
    if (picked) {
      transfers.push({
        do: 'give-weapon', from: picked.donor.row.agent, to: recipient.row.agent,
        what: [{ id: picked.item.id, amount: 1 }], weapon: picked.item.name,
        why: `${recipient.row.agent} is below the inclusive ${threshold} threshold for ${preset}`,
      });
    } else if (!roomForWeapon(recipient.row, threshold)) {
      needsRoom.push({ agent: recipient.row.agent, carry: recipient.row.carry ?? null,
        why: `cannot prove there is room for a ${threshold}; unknown or insufficient room is never treated as yes` });
    }
  }

  const remaining = recipients.filter(r => !transfers.some(t => t.to === r.row.agent));
  const deficit = remaining.length;
  const cast = deficit && options.cast_when_mana !== false
    ? state.filter(x => (x.row.provides ?? []).some(s => norm(s) === 'create weapon') &&
                        (x.row.mana?.value ?? 0) >= (options.mana_cost ?? 15) &&
                        roomForWeapon(x.row, 'axe'))
           .map(x => ({ do: 'cast-create-weapon', agent: x.row.agent,
             why: `${deficit} qualifying weapon(s) still needed; cast whenever mana and pack room permit` }))
    : [];

  return {
    preset, threshold,
    ready: state.filter(x => x.weapons.length).map(x => x.row.agent),
    recipients: recipients.map(x => x.row.agent),
    transfers, cast, needs_room: needsRoom, deficit,
    priority: keeperWeaponPriority(preset, customPresets),
  };
}
