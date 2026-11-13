// THE SPELL-TRAINING PLAN — a station whose occupants stand still, keep their allies
// buffed, and drill every spell they still have something to learn in.
//
// WHY A STATION `plan` AND NOT A RULE OF ITS OWN. Who trains is the same question the hunting
// shift already answers: a max-health band, `only` / `except`, first match wins, and the
// supervisor gate a sibling station uses. A separate rule would need its own copy of that
// membership, and two copies of "who is where" disagree the first time one is edited. So the
// shift places the character and this module only answers what the ORDERS for a placed
// character are. Everything here is pure: the spell list it reads was put on the fleet row by
// src/sense/observe.mjs `enrichSpellTraining`, joined with the kod spell catalogue there.
//
// WHAT IT SENDS, every pass, diffed (rules/shift.mjs):
//   mode survive, assigned_room = the station, confine_rooms [station], roam false,
//   farm_strategy null, mollusk_cover_recovery false, town_trips false,
//   practice_spells — what this character can still learn, by doctrine priority then lowest
//                     ability first,
//   buff_allies     — the ally buffs the keeper knows how to cast, so a trainer keeps
//                     protecting farmers after every drill has maxed.
//
// AND WHAT IT ASKS THE COURIER FOR (`spellTrainingRequests`), written by
// src/act/reagent-requests.mjs, which owns the never-lower / remove-own-stale rules.

import { bandAdmits, admitsAgent, shiftAssignments, ownedDrift } from '../rules/shift.mjs';

export const PLAN_SPELL_TRAINING = 'spell-training';
export const PLANS = Object.freeze([PLAN_SPELL_TRAINING]);

// The personal enchantments the keeper's buffAllies can cast (autopilot/social.mjs
// `static BUFFS`). Anything else named in buff_allies is ignored by the keeper, silently.
export const KEEPER_BUFFS = Object.freeze(['super strength', 'bless', 'magic shield']);

// Cast at a fleet-mate rather than at self: the Kraanan personal enchantments that are
// worth more on the person standing next to you than on the caster. The keeper's
// `fleetmate` practice target picks a fleet-mate in the room, least recently cast on first,
// and never a stranger (autopilot/desk-practice.mjs). A doctrine may replace the list.
export const DEFAULT_FLEETMATE_SPELLS = Object.freeze([
  'magic shield', 'bless', 'super strength', 'free action', 'resist poison', 'night vision',
]);

// NEVER DRILLED, whatever the doctrine says. Blink and rescue move the caster — a drill that
// teleports a character off its station is a journey nobody planned; feign death logs it
// out; invisibility changes what the fleet's own ally test sees; Kara'hol's curse and gaze of
// the basilisk are cast AT somebody. `spell_training.never` adds to this (a doctrine names the
// rest of the Riija disguises there).
export const DEFAULT_NEVER = Object.freeze([
  'blink', 'rescue', 'feign death', 'invisibility',
  'karahols curse', "kara'hols curse", 'gaze of the basilisk',
]);

// What a drill may be: enchantments on a person (self or a fleet-mate) and the touch
// attacks, which enchant the caster. A bare `Spell` is anything from create weapon to summon
// cow and a room enchantment changes the room for everybody, so neither is guessed at.
export const PRACTICE_PARENTS = Object.freeze([
  'PersonalEnchantment', 'ResistanceEnchantment', 'TouchAttackSpell',
]);

export const MAXED = 99;

const norm = v => String(v ?? '').trim().toLowerCase();
const normSpell = v => norm(v).replace(/[’]/g, "'");

/** The doctrine's spell-training block, with this character's override laid on top. */
export function trainingSettings(doctrine = {}, row = {}) {
  const base = doctrine.spell_training ?? {};
  const names = new Set([norm(row.agent), norm(row.character)].filter(Boolean));
  const over = Object.entries(base.characters ?? {})
    .find(([k]) => names.has(norm(k)))?.[1] ?? {};
  const list = v => Array.isArray(v) ? v.map(normSpell).filter(Boolean) : null;
  return {
    never: new Set([...DEFAULT_NEVER, ...(list(base.never) ?? []), ...(list(over.never) ?? [])]),
    priority: list(over.priority) ?? list(base.priority) ?? [],
    fleetmate: new Set(list(over.fleetmate_spells) ?? list(base.fleetmate_spells) ?? DEFAULT_FLEETMATE_SPELLS),
    fleetmateMinVigor: Number(over.fleetmate_min_vigor ?? base.fleetmate_min_vigor ?? 16),
    buff: list(over.buff),             // exact list, replaces the computed one
    practice: list(over.practice),     // exact list, replaces the computed one
    requestCap: over.request_cap ?? base.request_cap ?? 100,
    requestForBuffs: (over.request_for_buffs ?? base.request_for_buffs) !== false,
    manaFloor: over.mana_floor ?? base.mana_floor ?? null,
    gapMs: over.gap_ms ?? base.gap_ms ?? null,
    buffGapMs: over.buff_gap_ms ?? base.buff_gap_ms ?? 20_000,
    reserveCasts: over.reserve_casts ?? base.reserve_casts ?? null,
    restSeconds: over.rest_seconds ?? base.rest_seconds ?? null,
  };
}

const abilityOf = s => Number.isFinite(Number(s?.ability)) && s?.ability !== null ? Number(s.ability) : null;

/**
 * Why a known spell is not drilled, or null when it may be. Exported so the evidence a pass
 * journals and the test that pins the exclusions read one answer.
 */
export function exclusion(spell, settings) {
  const name = normSpell(spell?.name);
  if (!name) return 'unnamed';
  if (settings.never.has(name) || settings.never.has(name.replace(/'/g, ''))) return 'never drilled';
  // `Number(null)` is 0, so null has to be refused by name or every uncatalogued spell is free.
  if (spell.mana == null || !Number.isFinite(Number(spell.mana)))
    return 'no mana/reagent data in the spell catalogue';
  if (spell.harmful === true) return 'needs a creature target';
  if (spell.parent && !PRACTICE_PARENTS.includes(spell.parent))
    return `a ${spell.parent} is not cast on a person`;
  return null;
}

function targetFor(name, spell, settings) {
  if (settings.fleetmate.has(name))
    return { name, target: 'fleetmate', min_vigor: settings.fleetmateMinVigor };
  const t = Number(spell?.targets);
  if (Number.isFinite(t)) return { name, target: t > 0 ? 'self' : 'none' };
  return { name, target: 'self' };
}

/**
 * The plan for one character on a spell-training station, or `{ unread }` when the spell list
 * was not read this pass — a missing list is a question, not an empty book, and answering it
 * with "nothing to practise" would switch a working drill off.
 */
export function spellTrainingPlan(row = {}, station = {}, doctrine = {}) {
  const known = Array.isArray(row.spells_known) ? row.spells_known : null;
  if (!known) return { unread: row.spells_error ?? 'the spell list was not read this pass' };
  const settings = trainingSettings(doctrine, row);
  const room = Number(station.room);
  const byName = new Map(known.map(s => [normSpell(s.name), s]));

  const excluded = [];
  const practiceable = [];
  for (const s of known) {
    const why = exclusion(s, settings);
    if (why) excluded.push({ name: normSpell(s.name), why });
    else practiceable.push(s);
  }
  const rank = name => { const i = settings.priority.indexOf(name); return i < 0 ? Infinity : i; };
  const computed = practiceable
    .filter(s => (abilityOf(s) ?? 0) < MAXED)
    .sort((a, b) => rank(normSpell(a.name)) - rank(normSpell(b.name)) ||
      (abilityOf(a) ?? 0) - (abilityOf(b) ?? 0) || normSpell(a.name).localeCompare(normSpell(b.name)))
    .map(s => normSpell(s.name));
  const practiceNames = settings.practice ?? computed;
  // MAXED IS ABOUT THE LIST THIS CHARACTER ACTUALLY DRILLS. An override names exactly what
  // to train, so it is maxed when every one of those is known and at 99; otherwise when
  // nothing practiceable is left below 99 — and a character that knows nothing practiceable
  // is NOT maxed, because "go and buy the next spell" for a character whose book is empty
  // or unreadable is a walk decided on a missing field.
  const maxed = settings.practice
    ? settings.practice.length > 0 && settings.practice.every(n => (abilityOf(byName.get(n)) ?? -1) >= MAXED)
    : practiceable.length > 0 && computed.length === 0;

  const spells = practiceNames.map(n => targetFor(n, byName.get(n), settings));

  const buffNames = settings.buff ?? KEEPER_BUFFS.filter(n => byName.has(n));
  const buffCosts = buffNames.map(n => byName.get(n)?.mana).filter(m => m != null && Number.isFinite(Number(m))).map(Number);
  const manaFloor = Number.isFinite(Number(settings.manaFloor)) && settings.manaFloor !== null
    ? Number(settings.manaFloor)
    : (buffCosts.length ? Math.max(...buffCosts) + 4 : 0);

  const practice_spells = spells.length ? {
    enabled: true, spells, rooms: [room], mana_floor: manaFloor,
    ...(settings.gapMs != null ? { gap_ms: Number(settings.gapMs) } : {}),
    ...(settings.reserveCasts != null ? { reserve_casts: Number(settings.reserveCasts) } : {}),
    ...(settings.restSeconds != null ? { rest_seconds: Number(settings.restSeconds) } : {}),
  } : null;
  // Built in the shape the harness STORES it (m59-broker.mjs: enabled, spells, a clamped
  // gap_ms), so the diff against the live policy is exact. An empty list is null and never
  // `{enabled: true}`: the keeper reads a missing `spells` as "every buff it knows".
  const buff_allies = buffNames.length ? {
    enabled: true, spells: [...buffNames],
    gap_ms: Math.max(2000, Math.min(600_000, Math.floor(Number(settings.buffGapMs) || 20_000))),
  } : null;

  // A TRAINER MAY ALSO FARM (operator 2026-11-13: "have Zoot help out fighting creatures while waiting between
  // casts"). A station that names `farm_strategy` keeps the drill and the buffs but hunts under that strategy file
  // between casts, which then owns the confinement and the hunt; without it the trainer stands still as before.
  const farm = typeof station?.farm_strategy === 'string' && station.farm_strategy.trim() ? station.farm_strategy.trim() : null;
  return {
    room, maxed, excluded, practice: practiceNames, buffs: buffNames, mana_floor: manaFloor, farm,
    orders: farm ? {
      mode: 'farm', to: room, farm_strategy: farm, town_trips: false, practice_spells, buff_allies,
    } : {
      mode: 'survive', to: room, confine_rooms: [room], roam: false, farm_strategy: null,
      mollusk_cover_recovery: false, town_trips: false, practice_spells, buff_allies,
    },
    requests: reagentRequestsFor(row, practiceNames, buffNames, settings, byName),
  };
}

/** `{item: count}` for what this character's drill and buffs consume, each up to its cap. */
function reagentRequestsFor(row, practiceNames, buffNames, settings, byName) {
  const wanted = practiceNames.filter(n => {
    const s = byName.get(n);
    return s && (abilityOf(s) ?? 0) < MAXED;
  });
  if (settings.requestForBuffs) for (const n of buffNames) if (!wanted.includes(n)) wanted.push(n);
  const capFor = item => {
    const c = settings.requestCap;
    if (c && typeof c === 'object') return Number(c[item] ?? c.default ?? 100);
    return Number(c);
  };
  const out = {};
  for (const n of wanted) {
    for (const [item] of (byName.get(n)?.reagents ?? [])) {
      const cap = capFor(item);
      if (Number.isFinite(cap) && cap > 0) out[item] = Math.max(out[item] ?? 0, Math.floor(cap));
    }
  }
  return out;
}

export const isTrainingStation = st => st?.plan === PLAN_SPELL_TRAINING;

/** Characters whose spell list is worth reading this pass: any a training station could admit. */
export function trainingCandidates(rows = [], doctrine = {}) {
  const stations = (doctrine.shift?.on === true ? doctrine.shift.stations ?? [] : []).filter(isTrainingStation);
  if (!stations.length) return [];
  return rows.filter(r => r.in_game && stations.some(st => bandAdmits(st, r.level) && admitsAgent(st, r)));
}

/**
 * Who the shift actually places on a spell-training station this pass, with their plan.
 * The same allocation the shift deploys from, so the requests and the learning hand-off
 * can never disagree with where a character was sent.
 */
export function trainingAssignments(observation = {}, doctrine = {}) {
  if (doctrine.shift?.on !== true) return [];
  const live = (observation.characters ?? []).filter(r => r.in_game);
  if (!live.some(r => trainingCandidates([r], doctrine).length)) return [];
  return shiftAssignments(live, doctrine, observation)
    .filter(a => isTrainingStation(a.station))
    .map(a => ({ ...a, plan: spellTrainingPlan(a.row, a.station, doctrine) }));
}

/**
 * The courier lines this doctrine wants, `{agent: {item: count}}`, and the scope they were
 * decided over. An agent in scope with no line wants nothing (any line DUM wrote for it is
 * stale); an agent out of scope is left exactly as it is.
 */
export function spellTrainingRequests(observation = {}, doctrine = {}) {
  const desired = {};
  const unread = [];
  for (const a of trainingAssignments(observation, doctrine)) {
    if (a.plan.unread) { unread.push(a.row.agent); continue; }
    if (Object.keys(a.plan.requests).length) desired[a.row.agent] = a.plan.requests;
  }
  // AN UNREAD CHARACTER IS OUT OF SCOPE, not in scope with nothing wanted: a failed read must
  // not remove the requests that are feeding its drill.
  const scope = (observation.characters ?? []).filter(r => r.in_game && !unread.includes(r.agent))
    .map(r => r.agent);
  return { desired, scope, unread };
}

/**
 * Spell trainers that have maxed everything they drill AND already hold their station orders.
 *
 * SETTLED FIRST, FOR TWO REASONS. The learning errand walks the character home to
 * `policy.assignedRoom`, so a trainer whose station has not been deployed yet would be walked
 * back to wherever it was before. And one decision per character per pass: a trainer that
 * both needs a deploy and is ready to learn would have the learning intent claim it, and the
 * shift -- one intent for the whole fleet -- would then wait a pass for everybody. Deploy
 * first, learn on a later pass.
 */
export function trainingWantsLearning(observation = {}, doctrine = {}) {
  return trainingAssignments(observation, doctrine)
    .filter(a => !a.plan.unread && a.plan.maxed && ownedDrift(a.row, a.plan.orders).length === 0)
    .map(a => a.row.agent);
}

