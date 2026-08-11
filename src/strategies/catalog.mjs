// DUM STRATEGIES ARE INDEPENDENT CAPABILITIES, NOT A SINGLE MODE.
//
// The harness has a `strategy` field of its own, but that field chooses one farming
// pattern (baseline/wellfed/etc.). DUM's strategies are deliberately different: a unit
// may opt into any number of them at once. The catalogue is also the UI contract exposed
// by the local strategy-control server, so titles, grouping and requirements live here
// rather than being copied into every control surface.

export const STRATEGY_IDS = Object.freeze({
  CREATE_WEAPONS: 'create-weapons',
  VS_SKELETONS: 'vs-skeletons',
  CHECK_CV_CRATE: 'check-cv-crate',
  CREATE_FOOD: 'create-food',
});

export const STRATEGY_CATALOG = Object.freeze([
  Object.freeze({
    id: STRATEGY_IDS.CREATE_WEAPONS,
    title: 'Create Weapons to keep Equipped',
    group: 'Kraanan upkeep',
    purpose: 'Equipment maintenance',
    requirements: ['Kraanan: Create Weapon', '15 mana per cast', 'Pack room for the result'],
    description: 'Equip by the active weapon priority, share qualifying spares with nearby fleetmates, and cast until the configured threshold is met.',
  }),
  Object.freeze({
    id: STRATEGY_IDS.CREATE_FOOD,
    title: 'Create Food to keep Fed',
    group: 'Kraanan upkeep',
    purpose: 'Vigor maintenance',
    requirements: ['Kraanan: Create Food', '10 mana per cast', '2 elderberry + 2 herbs'],
    description: 'When the unit has no meal aboard, turn its own reagents into food so the keeper can maintain combat vigor.',
  }),
  Object.freeze({
    id: STRATEGY_IDS.VS_SKELETONS,
    title: 'vsSkeletons',
    group: 'Combat doctrine',
    purpose: 'Weapon selection',
    requirements: ['No skill required'],
    description: 'Prefer Hammer, then Mace, then Axe, then swords and other weapons, with an empty hand last.',
  }),
  Object.freeze({
    id: STRATEGY_IDS.CHECK_CV_CRATE,
    title: 'Check CV Crate',
    group: 'Castle Victoria operations',
    purpose: 'Timed fleet errand',
    requirements: ['At least 30 maximum health', 'Castle Victoria quorum', 'Another eligible finder in rotation'],
    description: 'Rotate eligible Castle Victoria units through the Underbasement crate when its hidden timer may be ready.',
  }),
]);

const KNOWN = new Set(STRATEGY_CATALOG.map(s => s.id));

export function validateStrategyIds(ids = []) {
  if (!Array.isArray(ids)) throw new Error('strategies must be a list');
  const clean = [...new Set(ids.map(String))];
  const unknown = clean.filter(id => !KNOWN.has(id));
  if (unknown.length)
    throw new Error(`unknown DUM strateg${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}`);
  return clean;
}

export function enabledStrategyIds(observation = {}, doctrine = {}, agent = null) {
  const assigned = observation.strategies?.agents?.[agent];
  return new Set(validateStrategyIds(Array.isArray(assigned)
    ? assigned : (doctrine.strategies?.defaults ?? [])));
}

export const strategyEnabled = (observation, doctrine, agent, id) =>
  enabledStrategyIds(observation, doctrine, agent).has(id);

export function strategyRows(observation, doctrine, id) {
  return (observation.characters ?? []).filter(r => r.in_game &&
    strategyEnabled(observation, doctrine, r.agent, id));
}
