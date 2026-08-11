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
  SPREAD_OUT: 'spread-out',
  SELL_AND_BANK: 'sell-and-bank',
  ACCUMULATE_IN_VAULT: 'accumulate-in-vault',
  FARM_CLEANUP: 'farm-cleanup',
  FARM_DELIVERY: 'farm-delivery',
  DETAILED_STATS: 'detailed-strategy-stats',
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
  Object.freeze({
    id: STRATEGY_IDS.SPREAD_OUT,
    title: 'Spread Out',
    group: 'Fleet placement',
    purpose: 'Room and safe-wall occupancy',
    requirements: ['At least one allowed room'],
    description: 'Assign selected units across allowed rooms and fill distinct safe walls before sharing them. Disabled units retain no DUM room pin or wall occupancy cap.',
    settings: Object.freeze([
      Object.freeze({ id: 'max_bots_per_safe_spot', title: 'Max bots per safe spot',
        type: 'integer', min: 1, default: 3,
        description: 'Historical keeper cap: fill every wall once, then twice, up to three per wall.' }),
      Object.freeze({ id: 'max_bots_per_room', title: 'Max bots per room',
        type: 'integer', min: 1, default: 4,
        description: 'Historical harness spread cap. Units beyond configured room capacity remain unpinned.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.SELL_AND_BANK,
    title: 'Sell Loot and Bank Surplus',
    group: 'Economy',
    purpose: 'Pack and purse maintenance',
    requirements: ['A reachable trusted buyer or bank'],
    description: 'Configure when the keeper leaves to sell, how much cash it banks, and how much spending money it retains.',
    settings: Object.freeze([
      Object.freeze({ id: 'bank_above', title: 'Bank above', type: 'number', min: 0,
        default: 3000, description: 'Walk to a bank once carried shillings exceed this amount.' }),
      Object.freeze({ id: 'walking_money', title: 'Walking money', type: 'number', min: 0,
        default: 1000, description: 'Cash retained after depositing surplus.' }),
      Object.freeze({ id: 'max_carry', title: 'Maximum carried stacks', type: 'integer', min: 1,
        default: 50, description: 'Secondary pack ceiling after weight and bulk.' }),
      Object.freeze({ id: 'sell_at_load', title: 'Sell at load', type: 'number', min: 0, max: 1,
        default: 0.95, description: 'Leave for market at this weight-or-bulk fraction.' }),
      Object.freeze({ id: 'sell_when_broke', title: 'Sell when broke', type: 'boolean',
        default: false, description: 'Also convert a useful pack to cash outside timed combat windows.' }),
      Object.freeze({ id: 'broke_under', title: 'Broke under', type: 'number', min: 0,
        default: 500, description: 'Cash plus bank balance considered broke.' }),
      Object.freeze({ id: 'broke_stacks', title: 'Broke pack stacks', type: 'integer', min: 1,
        default: 8, description: 'Minimum non-money stacks before a poverty-triggered market trip.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.ACCUMULATE_IN_VAULT,
    title: 'Accumulate items in vault',
    group: 'Economy',
    purpose: 'Protected collection storage',
    requirements: ['Selected items in the pack', 'Enough shillings for the vault fee', 'A town trip through Barloque'],
    description: 'Never eat, sell, gift, or discard the selected items. Deposit them with the mainland vaultman whenever an ordinary town loop passes through Barloque.',
    settings: Object.freeze([
      Object.freeze({ id: 'items', title: 'Items to accumulate', type: 'item-list',
        default: Object.freeze([
          'dark angel feather',
          'inky cap mushroom',
          'blue dragon scale',
          'arrow',
          'nerudite arrow',
        ]), max_items: 24,
        description: 'Choose one or more compendium items. Matching monster drops are highlighted automatically.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.FARM_CLEANUP,
    title: 'Farm clean-up',
    group: 'Fleet coordination',
    purpose: 'Consolidated return trips',
    requirements: ['A sell-triggered town trip', 'Gettable drops in the farming room'],
    description: 'Before a seller leaves the farm, discard confirmed broken or junk gear, collect protected vault items first, then take the most valuable sound gear, food, reagents, and sale stock the pack can hold.',
    settings: Object.freeze([
      Object.freeze({ id: 'max_floor_items', title: 'Maximum floor items', type: 'integer', min: 1, max: 40,
        default: 12, description: 'Maximum ranked floor objects attempted before the seller departs.' }),
      Object.freeze({ id: 'keep_free_stacks', title: 'Keep free stacks', type: 'integer', min: 0, max: 12,
        default: 1, description: 'Leave this many configured stack slots free for travel or merchant results.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.FARM_DELIVERY,
    title: 'Farm delivery',
    group: 'Fleet coordination',
    purpose: 'Shared field resupply',
    requirements: ['A town-returning courier', 'A reachable apothecary', 'Shillings above the walking reserve'],
    description: 'One returning seller polls active farmers in its destination room, buys their herb and elderberry shortfalls, and gives each farmer its requested share. Undeliverable stock stays with the courier.',
    settings: Object.freeze([
      Object.freeze({ id: 'herbs_per_farmer', title: 'Herbs per farmer', type: 'integer', min: 0, max: 100,
        default: 20, description: 'Maximum herb shortfall carried for each active farmer on one trip.' }),
      Object.freeze({ id: 'elderberries_per_farmer', title: 'Elderberries per farmer', type: 'integer', min: 0, max: 100,
        default: 10, description: 'Maximum elderberry shortfall carried for each active farmer on one trip.' }),
      Object.freeze({ id: 'max_recipients', title: 'Maximum recipients', type: 'integer', min: 1, max: 12,
        default: 4, description: 'Maximum farmers supplied by one courier trip.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.DETAILED_STATS,
    title: 'Detailed strategy stats',
    group: 'Observability',
    purpose: 'Rotating activity records and drill-ins',
    requirements: ['Local disk space for a short rotating log'],
    description: 'Opt into drillable crate, travel, fighting, trading, vault, and food-production records. Lightweight fleet counters remain available when this is off.',
    settings: Object.freeze([
      Object.freeze({ id: 'retention_hours', title: 'Retain detailed records (hours)',
        type: 'number', min: 1, max: 168, default: 24,
        description: 'Detailed records older than this are excluded and their daily spool files are retired.' }),
      Object.freeze({ id: 'default_window_hours', title: 'Default dashboard window (hours)',
        type: 'number', min: 0.25, max: 168, default: 2,
        description: 'Initial look-back used by the DUM bot and Harness tabs.' }),
      ...['crate_check', 'travel', 'fighting', 'trading', 'vault_accumulation', 'create_food',
          'farm_cleanup', 'farm_delivery']
        .map(id => Object.freeze({ id, title: id.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' '),
          type: 'boolean', default: true,
          description: `Collect drillable ${id.replaceAll('_', ' ')} records while this strategy is enabled.` })),
    ]),
  }),
]);

const KNOWN = new Set(STRATEGY_CATALOG.map(s => s.id));
const BY_ID = new Map(STRATEGY_CATALOG.map(s => [s.id, s]));

export function validateStrategyIds(ids = []) {
  if (!Array.isArray(ids)) throw new Error('strategies must be a list');
  const clean = [...new Set(ids.map(String))];
  const unknown = clean.filter(id => !KNOWN.has(id));
  if (unknown.length)
    throw new Error(`unknown DUM strateg${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}`);
  return clean;
}

export function validateStrategySettings(id, values = {}, { partial = false } = {}) {
  const definition = BY_ID.get(String(id));
  if (!definition) throw new Error(`unknown DUM strategy: ${id}`);
  if (values == null || typeof values !== 'object' || Array.isArray(values))
    throw new Error(`strategy settings for ${id} must be an object`);
  const fields = new Map((definition.settings ?? []).map(f => [f.id, f]));
  const out = partial ? {} : Object.fromEntries([...fields].map(([key, f]) => [key, f.default]));
  for (const [key, value] of Object.entries(values)) {
    const field = fields.get(key);
    if (!field) throw new Error(`${id} has no setting named ${key}`);
    if (field.type === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`${id}.${key} must be true or false`);
    } else if (field.type === 'item-list') {
      if (!Array.isArray(value)) throw new Error(`${id}.${key} must be a list of item names`);
      const clean = [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
      if (clean.some(v => v.length > 80)) throw new Error(`${id}.${key} item names must be 80 characters or fewer`);
      if (clean.length > (field.max_items ?? 24))
        throw new Error(`${id}.${key} may contain at most ${field.max_items ?? 24} items`);
      out[key] = clean;
      continue;
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${id}.${key} must be a number`);
      if (field.type === 'integer' && !Number.isInteger(value))
        throw new Error(`${id}.${key} must be an integer`);
      if (field.min != null && value < field.min)
        throw new Error(`${id}.${key} must be at least ${field.min}`);
      if (field.max != null && value > field.max)
        throw new Error(`${id}.${key} must be at most ${field.max}`);
    }
    out[key] = value;
  }
  return out;
}

export function validateStrategySettingsMap(settings = {}) {
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error('strategies.settings must be an object');
  return Object.fromEntries(Object.entries(settings).map(([id, values]) =>
    [id, validateStrategySettings(id, values, { partial: true })]));
}

export function enabledStrategyIds(observation = {}, doctrine = {}, agent = null) {
  const assigned = observation.strategies?.agents?.[agent];
  return new Set(validateStrategyIds(Array.isArray(assigned)
    ? assigned : (doctrine.strategies?.defaults ?? [])));
}

export const strategyEnabled = (observation, doctrine, agent, id) =>
  enabledStrategyIds(observation, doctrine, agent).has(id);

export function strategySettings(observation, doctrine, agent, id) {
  const doctrineValues = doctrine.strategies?.settings?.[id] ?? {};
  const assignedValues = observation.strategies?.settings?.[agent]?.[id] ?? {};
  return validateStrategySettings(id, { ...doctrineValues, ...assignedValues });
}

export function strategyRows(observation, doctrine, id) {
  return (observation.characters ?? []).filter(r => r.in_game &&
    strategyEnabled(observation, doctrine, r.agent, id));
}
