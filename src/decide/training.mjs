// WHICH WEAPON THIS CHARACTER SHOULD BE TRAINING WITH, RIGHT NOW.
//
// The armed half of a training bout has to hold something whose proficiency can still
// improve, and "still" is the whole problem: an armed proficiency improves ONLY while its
// ability is below the target's level (stroke.kod:98-121). Cross that line and the
// character keeps swinging, keeps killing, and learns nothing — with no message, no event
// and no change on any board.
//
// Measured on prod 2026-09-08, which is why this file exists: one character's short sword
// fighting had reached exactly 50 against a level-50 fungus beast, so its armed half was
// dead. It was still alternating that against its fists and still reading healthy. Its
// hammer wielding was at 7 and its axe at 3 — both level-3 Weaponcraft skills with the
// whole range ahead of them, and neither was being used.
//
// So the rule is: of the weapon proficiencies this character HOLDS and can still advance
// against this quarry, take the one at the highest Weaponcraft level. Highest level rather
// than lowest ability, because the levels are a ladder — the level-3 skills are the ones
// that gate hammer, axe and sword, and a point spent there is worth more than a point in
// mace fighting, which counts toward nothing.

// The Weaponcraft ladder, and the weapon each proficiency is trained WITH.
//
// Levels are read from kod: profmace.kod:1, profshsw.kod:34 and brawling.kod:35 are 2,
// dodge.kod:36 is 2 (`viSkill_Level`, capital L — a case-sensitive grep misses it),
// profaxe/profhamr/profswrd are 3, profscim is 4, archery is 5.
//
// `weapon: null` means the skill is not trained by holding anything — brawling is the
// unarmed half and dodge is passive, so neither can ever be the ARMED choice.
export const WEAPONCRAFT = Object.freeze([
  { skill: 'mace fighting',        level: 1, weapon: 'mace' },
  { skill: 'punch',                level: 1, weapon: null },
  { skill: 'slash',                level: 1, weapon: null },
  { skill: 'block',                level: 1, weapon: null },
  { skill: 'short sword fighting', level: 2, weapon: 'short sword' },
  { skill: 'brawling',             level: 2, weapon: null },
  { skill: 'dodge',                level: 2, weapon: null },
  { skill: 'axe wielding',         level: 3, weapon: 'axe' },
  { skill: 'hammer wielding',      level: 3, weapon: 'hammer' },
  { skill: 'swordsmanship',        level: 3, weapon: 'long sword' },
  { skill: 'sword wielding',       level: 3, weapon: 'long sword' },
  { skill: 'fencing',              level: 3, weapon: 'long sword' },
  { skill: 'scimitar wielding',    level: 4, weapon: 'scimitar' },
]);

// WHAT BARE HANDS ARE WORTH, WHICH IS THE FLOOR EVERY ARMED CHOICE HAS TO BEAT.
//
// Brawling is Weaponcraft LEVEL 2 (brawling.kod:35) and has no cap — the unarmed improve
// path carries no `ability < target_level` test at all (unarmed.kod:56-66). So bare hands
// are always an available, always-legal training option worth a level-2 point.
//
// Mace fighting is level 1. A character swinging a mace is therefore training something
// worth STRICTLY LESS than the fists it could be using instead, and `PlayerCanLearn` reads
// the top three level-2 abilities and nothing below (player.kod:10778-10923) — so a mace
// point counts toward the level-3 unlock exactly zero. This fleet's best skill is mace
// fighting at 40-58 across twenty-one characters, which is the trap: it looks like the
// obvious weapon to train and is the one weapon that cannot help.
//
// Read from the table rather than written as `2`, so the rung and the ladder stay one fact.
const UNARMED_LEVEL = WEAPONCRAFT.find(e => e.skill === 'brawling')?.level ?? 2;

const norm = s => String(s ?? '').trim().toLowerCase();
const BY_SKILL = new Map(WEAPONCRAFT.map(r => [r.skill, r]));

/** The ability this character holds in a skill, or null when nothing said. */
export function abilityOf(row, skill) {
  const list = row?.progress?.skills ?? row?.skills;
  if (!Array.isArray(list)) return null;
  const hit = list.find(x => norm(x.name) === norm(skill));
  if (!hit) return null;
  const v = Number(hit.ability ?? hit.percent ?? hit.value);
  return Number.isFinite(v) ? v : null;
}

/**
 * The weapon to train with against a quarry of this level, or null when none qualifies.
 *
 * UNKNOWN ABILITY IS NOT PERMISSION. A skill the observation could not answer for is
 * skipped rather than assumed low — picking a weapon on the strength of a missing field is
 * how a character ends up training something it finished weeks ago, and the whole point of
 * this selector is that it is checkable.
 *
 * @returns {{weapon: string, skill: string, level: number, ability: number}|null}
 */
export function trainingWeaponFor(row, targetLevel) {
  const cap = Number(targetLevel);
  if (!Number.isFinite(cap)) return null;
  // WHAT IS ACTUALLY IN THE PACK, when the pack was readable at all.
  //
  // The proficiency and the steel are two different questions and this used to ask only the
  // first. `prepareTrainingStyle` REFUSES a bout whose weapon it cannot produce — "fighting
  // with a fallback weapon would corrupt the split" — so naming a weapon the character does
  // not carry does not degrade to a worse bout, it cancels the bout, and the character then
  // swings whatever it happens to hold with no training accounting at all.
  //
  // Measured 2026-09-08, with every character told to train `short sword`: THREE of twenty-
  // one were carrying one. Twelve carried a mace, hammer or axe; six carried nothing. Create
  // Weapon is why — it rolls a ladder rather than granting a choice (creaweap.kod:66-107) and
  // short sword is the narrow 20-29 band — so a fleet that conjures its own weapons cannot be
  // told which one to hold.
  //
  // For the twelve, swinging the mace they DO have is worth nothing here: mace fighting is
  // Weaponcraft level 1 and the level-3 unlock counts only level-2 abilities. Bare hands are
  // worth more than a mace, because brawling IS level 2 and has no cap. So a weapon the
  // character cannot hold is not a candidate, and when none is left the caller drops the
  // whole bout to `unarmed` — which needs no supply chain at all.
  //
  // `pack_items: null` means the pack was not readable, NOT that it is empty (normalize.mjs
  // keeps that distinction deliberately). An unreadable pack must not disarm anybody, so the
  // filter applies only when there is a list to apply it to.
  const pack = Array.isArray(row?.pack_items) ? row.pack_items : null;
  const holds = pack == null ? null : new Set(pack.map(i =>
    norm(typeof i === 'string' ? i : (i?.name ?? ''))).filter(Boolean));
  const carried = weapon => {
    if (holds == null) return true;                    // unreadable: do not decide on it
    const want = norm(weapon);
    if (norm(row?.wielding) === want) return true;     // in hand counts even if the pack lags
    for (const name of holds) if (name.includes(want)) return true;
    return false;
  };

  const candidates = [];
  for (const entry of WEAPONCRAFT) {
    if (!entry.weapon) continue;                       // unarmed or passive: never the armed half
    const ability = abilityOf(row, entry.skill);
    if (ability == null) continue;                     // not held, or not reported
    if (ability >= cap) continue;                      // capped against THIS quarry
    if (!carried(entry.weapon)) continue;              // the skill without the steel is no bout
    if (entry.level < UNARMED_LEVEL) continue;         // worth less than bare hands — see below
    candidates.push({ ...entry, ability });
  }
  if (!candidates.length) return null;
  // Highest Weaponcraft level first; among equals prefer the one with the most room left,
  // so a character with hammer 7 and axe 3 trains the axe and both keep climbing.
  candidates.sort((a, b) => b.level - a.level || a.ability - b.ability);
  const best = candidates[0];
  return { weapon: best.weapon, skill: best.skill, level: best.level, ability: best.ability };
}

/**
 * The hardest quarry a station will actually hunt, which is what caps the armed half.
 *
 * The station may name several; the ceiling that matters is the HIGHEST, because a
 * proficiency that can still advance on the toughest thing in the room can advance on
 * everything else there too.
 */
export function stationTargetLevel(hunts, quarryLevels) {
  const levels = [].concat(hunts ?? [])
    .map(q => Number(quarryLevels?.[norm(q)]))
    .filter(Number.isFinite);
  return levels.length ? Math.max(...levels) : null;
}
