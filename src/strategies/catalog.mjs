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
  SHORT_SWORDING: 'short-swording',
  CHECK_CV_CRATE: 'check-cv-crate',
  CREATE_FOOD: 'create-food',
  SPREAD_OUT: 'spread-out',
  SELL_AND_BANK: 'sell-and-bank',
  SUPPLY_LIMITED_FARMING: 'supply-limited-farming',
  GUILD_TITHE: 'guild-tithe',
  MAX_WEAPONS: 'max-weapons',
  BUY_FOOD: 'buy-food',
  BUY_WEAPONS: 'buy-weapons',
  BUY_REAGENTS: 'buy-reagents',
  ACCUMULATE_IN_VAULT: 'accumulate-in-vault',
  FARM_CLEANUP: 'farm-cleanup',
  FARM_DELIVERY: 'farm-delivery',
  DETAILED_STATS: 'detailed-strategy-stats',
  PLAY_FACTION_GAMES: 'play-faction-games',
  AUTO_LEVEL_PLANNED: 'auto-level-planned-school',
});

export const STRATEGY_CATALOG = Object.freeze([
  Object.freeze({
    id: STRATEGY_IDS.AUTO_LEVEL_PLANNED,
    title: 'Auto-level next planned spell/skill school when available',
    group: 'Character development',
    purpose: 'Planned ability acquisition',
    requirements: ['An acquisition queue saved by the compendium planner',
      'The first unfinished queue level is currently learnable',
      'A catalogue-backed teacher and enough purse or banked shillings'],
    description: 'At a quiet fleet boundary, buy one ability from the first unfinished planner queue level, verify it, and leave later levels closed until every ability in the current level is known.',
    settings: Object.freeze([
      Object.freeze({ id: 'max_parallel', title: 'Maximum simultaneous learning errands',
        type: 'integer', min: 1, max: 4, default: 2,
        description: 'Bound teacher trips started by one fleet pass so learning cannot monopolise the broker pacer.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.PLAY_FACTION_GAMES,
    title: 'Play faction games',
    group: 'Faction operations',
    purpose: 'Explicit opt-in Council-token PvP',
    requirements: ['Observed faction membership', 'Freshly verified opposing token carrier',
      'Ordinary combat readiness'],
    description: 'Inspect nearby players for a visible Council token, fight only verified carriers from another faction, recover a dropped token, and deliver it to the unit\'s own liege when no positively verified weak councilor is known.',
  }),
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
    id: STRATEGY_IDS.SHORT_SWORDING,
    title: 'Short swording',
    group: 'Combat doctrine',
    purpose: 'Equipment loadout — train the short sword on what drops short swords',
    requirements: ['short sword fighting (weaponcraft 2)', 'An engagement ceiling that admits the prey'],
    description: 'Hunt the Marion crypts wielding a short sword by preference and anything else when ' +
      'none is to hand. Pinned to the crypt rooms with roaming off, because the room one door away ' +
      'generates thrashers at level 150.\n' +
      'A STATUE IS NOT A STANDING QUARRY, and this description used to say it was. Room 2601 places ' +
      '37 of them and 2600 one — but only from `FirstUserEntered`, and `PlaceStatues` returns early ' +
      'while any statue is still in the room (marcryp2.kod:161-168). A fleet that occupies the room ' +
      'never empties it, so once they are dead they never come back. Worse, nothing would say so: ' +
      'the keeper\'s "this room cannot produce our prey" check reads the SPAWN TABLE, which lists ' +
      'statues in 2601 for ever, so a character would stand among the corpses hunting nothing and go ' +
      'on reporting itself healthy. They are an opening bonus of ~38 kills, taken by retaliation.\n' +
      'The standing quarry is a GENERATOR. 2601 runs skeletons at 80%, cap 25, level 75 — renewable, ' +
      'and above every character here, so it still advances them. 2600 runs spectral mummies at ' +
      '100%, cap 10, level 40 — those advance nobody past 40 max health, but they are the only thing ' +
      'in the crypt that drops the short sword this strategy is named for (ShortSword 5%, LongSword ' +
      '4%, MetalShield 3%) and both create-food reagents besides.',
    settings: Object.freeze([
      Object.freeze({ id: 'rooms', title: 'Crypt rooms', type: 'number-list', default: [2601, 2600],
        description: '2600 The crypt in Marion generates spectral mummies at 100%, cap 10; statues ' +
          'respawn in 2600 and 2601. Room 2602 is one door off and generates thrashers at level 150 ' +
          '— it is deliberately not in this list and roaming is off so nothing wanders into it.' }),
      // ORDER IS PREFERENCE, AND ONLY A GENERATOR MAY APPEAR HERE. `statue` is deliberately
      // absent: naming it would pin a character to a quarry that stops existing after the
      // first pass through and never reports it. The first entry a unit's engagement
      // ceiling admits wins, and the room follows from the quarry rather than the other
      // way round — so changing this to `spectral mummy` moves the fleet to 2600 by itself.
      Object.freeze({ id: 'hunt', title: 'Quarry', type: 'item-list',
        default: ['skeleton', 'spectral mummy'],
        description: 'A skeleton is level 75, so a character engages one only when its ceiling ' +
          'admits it — at the default 150% that means 50 max health or better. Anything smaller ' +
          'falls through to the spectral mummy in 2600, which advances nobody past 40 but drops ' +
          'the short sword. Statues are not listed: they do not come back once cleared.' }),
      Object.freeze({ id: 'town_trips', title: 'Allow town trips', type: 'boolean', default: true,
        description: 'The crypt supplies weapons, shields, armour and both create-food reagents, but ' +
          'not a vendor or a bank — so selling, banking and restocking still happen. Turning this off ' +
          'pins a character to the crypt until its pack is full and then leaves it there.' }),
    ]),
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
    id: STRATEGY_IDS.SUPPLY_LIMITED_FARMING,
    title: 'Supply-Limited Farming',
    group: 'Economy',
    purpose: 'Leave the farm rooms when the work runs out, not when the pack fills',
    requirements: ['Sell Loot and Bank Surplus, whose market trigger this overrides',
                   'Reagent floor and ceiling set in the character loadout'],
    description:
      'Stop treating a part-full pack as a reason to walk to a market. The keeper already ' +
      'handles fullness where the character stands: makeRoom() sells to any local buyer and ' +
      'otherwise drops the biggest pile of junk, keeping money, gems and anything in use — ' +
      'and since a gem is 1 bulk against a mushroom\'s 5, what survives that is the loot ' +
      'worth carrying home anyway. Being out of elderberry and herbs IS a reason: with no ' +
      'create food, vigor stops at the 80 the resting cap reaches and the character fights ' +
      'badly until somebody restocks it. So the reagent floor becomes the trip trigger and ' +
      'the load fraction stops being one.',
    settings: Object.freeze([
      Object.freeze({ id: 'sell_at_load', title: 'Sell at load', type: 'number', min: 0, max: 1,
        default: 0.95,
        description: 'Overrides the Sell Loot value. Deliberately high — this is the trigger ' +
                     'being switched off, not tuned. Not 1.0, because a pack with no room at ' +
                     'all cannot loot what it kills.' }),
      Object.freeze({ id: 'reagent_floor', title: 'Reagent floor', type: 'integer', min: 0,
        default: 6,
        description: 'Castings left in the pack before a supply trip. THE LOADOUT OWNS THIS ' +
                     'NUMBER — the keeper reads carry floors from substrate/loadouts, not from ' +
                     'an order, so this setting records the intent and the loadout enforces it.' }),
      Object.freeze({ id: 'reagent_ceiling', title: 'Reagent ceiling', type: 'integer', min: 1,
        default: 200,
        description: 'What one supply trip refills to, also owned by the loadout. 200 is 100 ' +
                     'castings — hours of farming — and the depth is close to free: the trip is ' +
                     'the expensive part and what it carries home is not. Peak reagent bulk is ' +
                     'at the START of a session, when the pack is otherwise empty because the ' +
                     'character has just sold, and it burns down as loot comes in, so reagents ' +
                     'and loot never compete for the same space. Cost per casting does not ' +
                     'change with depth, so the only thing depth buys or loses is trips.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.GUILD_TITHE,
    title: 'Guild Tithe',
    group: 'Economy',
    purpose: 'Guild rent support',
    requirements: ['Guild membership', 'A completed town-sale trip',
      'Verified sale proceeds above the walking-money reserve'],
    description: 'After selling in town, pay Frular up to the configured daily amount from that trip\'s proceeds. Partial payments carry forward to later sale trips; verified daily totals survive restarts.',
    settings: Object.freeze([
      Object.freeze({ id: 'daily_amount', title: 'Daily tithe', type: 'integer', min: 0,
        default: 2000,
        description: 'Maximum shillings each character contributes per local calendar day from town-sale proceeds.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.MAX_WEAPONS,
    title: 'Max Weapons',
    group: 'Equipment maintenance',
    purpose: 'Merchant pack cleanup',
    requirements: ['A reachable trusted buyer'],
    description: 'Keep equipped weapons plus the best spares under the configured total, and sell every excess weapon during merchant visits.',
    settings: Object.freeze([
      Object.freeze({ id: 'max_weapons', title: 'Maximum weapons', type: 'integer', min: 0,
        default: 2, description: 'Total weapons retained after selling, including anything currently equipped.' }),
    ]),
  }),
  Object.freeze({
    id: STRATEGY_IDS.BUY_FOOD,
    title: 'Buy Food',
    group: 'Purchases',
    purpose: 'Prepared-food restocking',
    requirements: ['A reachable food merchant', 'Spendable shillings'],
    description: 'Permit food purchases during town loops, including food-only trips and withdrawals made specifically to pay for food.',
  }),
  Object.freeze({
    id: STRATEGY_IDS.BUY_WEAPONS,
    title: 'Buy Weapons',
    group: 'Purchases',
    purpose: 'Paid permanent rearming',
    requirements: ['A reachable smith', 'Spendable shillings'],
    description: 'Permit rearming and outfitting automation to buy weapons. Creating, looting, equipping, and fleet handoffs remain independent.',
  }),
  Object.freeze({
    id: STRATEGY_IDS.BUY_REAGENTS,
    title: 'Buy Reagents',
    group: 'Purchases',
    purpose: 'Spell and delivery restocking',
    requirements: ['A reachable reagent merchant', 'Spendable shillings'],
    description: 'Permit personal reagent top-ups and paid Farm Delivery cargo. Carried reagent spares may still be shared when disabled.',
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
          'Inky-cap mushroom',
          'blue dragon scale',
          'arrows',
          'nerudite arrows',
        ]), max_items: 24,
        description: 'Choose complete compendium item names. Punctuation and plurals are normalised; partial names are rejected. Matching monster drops are highlighted automatically.' }),
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
      Object.freeze({ id: 'per_farmer_default', title: 'Other items per farmer', type: 'integer', min: 0, max: 100,
        default: 10, description: 'Cap per farmer for anything else a loadout asks for. The two reagents above keep their own caps; this covers every other shortfall the fleet board can now state.' }),
      Object.freeze({ id: 'radius_rooms', title: 'Delivery radius (rooms)', type: 'integer', min: 0, max: 3,
        default: 2, description: 'How far off the destination a courier will walk to hand goods to a farmer who wants them. 0 keeps delivery to the destination room only.' }),
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
    } else if (field.type === 'number-list') {
      // ROOM NUMBERS, AND THE VALIDATOR HAD NO TYPE FOR THEM. Two settings declared
      // `type: 'list'`, which no branch here handled, so they fell through to the numeric
      // check and every doctrine that set one was refused with "must be a number". Nobody
      // noticed because nothing read the strategy they belonged to. Integers are enforced
      // rather than coerced: a room number with a decimal point matches no room, and
      // silently rounding it would send a fleet somewhere nobody typed.
      if (!Array.isArray(value)) throw new Error(`${id}.${key} must be a list of numbers`);
      const clean = value.map(Number);
      if (clean.some(v => !Number.isInteger(v)))
        throw new Error(`${id}.${key} must contain only whole numbers`);
      if (clean.length > (field.max_items ?? 24))
        throw new Error(`${id}.${key} may contain at most ${field.max_items ?? 24} entries`);
      out[key] = clean;
      continue;
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

// THE HUNTING ROOMS, AS DATA, WITH ONLY THEIR GENERATORS IN THEM.
//
// `generates` lists what the room PRODUCES on a timer, so a quarry can be resolved to a
// room rather than a room to a quarry. Statues are not here for the reason the Short
// swording description gives at length: they are placed once and never replaced while
// anybody is standing there, so a room listing one would claim to generate something it
// will not.
//
// `threat` is the strongest thing that can be IN the room, which is not the same as the
// quarry and must not be confused with it. The keeper's ceiling gates the whole room, so
// sizing it to the quarry is how a unit ends up rejecting the room it was sent to — 2600
// generates level-40 mummies and has a level-75 statue standing in it.
//
// A ROOM THAT IS NOT IN THIS TABLE CANNOT BE ASSIGNED, which is the guard rail: 2602
// (thrashers, level 150, one door from 2601) and 552 (mollusk creature, level 150, and it
// also generates frogmen, so it is exactly the room somebody would reach for) are both
// absent on purpose and asking for either resolves to nothing.
export const HUNT_ROOMS = Object.freeze({
  576: Object.freeze({ room: 576, name: "The King's Way", threat: 70,
    generates: Object.freeze(['frogman', 'centipede']) }),
  // 2601 IS PERMANENTLY DEAD AND THE SPAWN TABLE CANNOT TELL. It is removed rather than
  // demoted, because `huntingGrounds` ranks it the BEST skeleton room in the game — 80% at
  // a shared cap of 25 — and any keeper allowed to consider it walks back to it.
  //
  // Measured 2026-08-14 by looking at the room: 26 statues standing in it, of which
  // TWENTY-THREE expose only `look` and no `attack`. They are Monster instances on the
  // server, so they count toward `piMonster_count` and hold the room over its cap for
  // ever; they are unkillable from the wire, so no amount of clearing helps; and
  // `PlaceStatues` refuses to reset the room while any statue remains, so it never
  // recovers. Nine characters sat on safe walls in it for hours producing nothing.
  //
  // The lesson is bigger than one room: the spawn table describes what a room GENERATES,
  // not what is standing in it, and a room can be permanently full of something that
  // never appears in it.
  2600: Object.freeze({ room: 2600, name: 'The crypt in Marion', threat: 75,
    generates: Object.freeze(['spectral mummy']) }),
  // Castle Victoria. 38 is the main room and 39 is the floor above it; 41, the
  // Underbasement one door below, generates narthyl worms at level 120 and is absent for
  // the same reason 2602 and 552 are.
  //
  // A BATTERED SKELETON IS LEVEL 60 AND MOST OF THIS FLEET IS 60, so 39 advances almost
  // nobody — a kill pays only while the creature's level is strictly above max health.
  // It is listed because it is a legitimate overflow, not because it is good.
  38: Object.freeze({ room: 38, name: 'Castle Victoria', threat: 75,
    generates: Object.freeze(['skeleton', 'zombie']) }),
  39: Object.freeze({ room: 39, name: 'Upstairs in Castle Victoria', threat: 60,
    generates: Object.freeze(['battered skeleton', 'zombie']) }),
  // THE GRAVEYARD OF TOS IS ONLY A ROOM FOR 35 MINUTES IN EVERY 120. `TryCreateMonster`
  // is gated on the game hour and generates NOTHING outside the window, so a shift parked
  // here by day is standing in an empty field — which is why a station on this room must
  // carry `when: 'night'` and why the doctrine schema refuses one that does not.
  //
  // And the mix is worth knowing before choosing it: the skeleton is 15% and the zombie
  // 85%. The skeleton is level 75 and advances everyone here; the zombie is 55 and
  // advances nobody past 55. So this is a rich window rather than a rich room.
  70: Object.freeze({ room: 70, name: 'The Graveyard of Tos', threat: 75, night_only: true,
    generates: Object.freeze(['skeleton', 'zombie']) }),
  // THE FLOOR. A character that has been ground down far enough refuses everything in the
  // castle — at 36 max health the ceiling is 54, and even the zombies upstairs are 55 — so
  // without somewhere gentler it is left unplaced and wanders.
  //
  // 544 is the gentlest room in the world that still PAYS such a character: a fungus beast
  // is level 50 against difficulty 1, which is an attack rating of 210 and the softest
  // fight in the game, and 50 is comfortably above a decayed character's max health so the
  // kills still advance it. The groundworm larva sharing the room is level 35 at 285. It
  // also has five safe squares that have held and never failed, which is more than the
  // castle rooms between them can say.
  544: Object.freeze({ room: 544, name: 'Valley of Ileria', threat: 50,
    generates: Object.freeze(['fungus beast', 'groundworm larva']) }),
});

// Kept for the crypt-only callers and tests that name it.
export const CRYPT_ROOMS = HUNT_ROOMS;

// Level of each quarry, for the engagement-ceiling test. Kept beside the rooms because
// both are read together and a level with two homes ends up with two answers.
export const QUARRY_LEVEL = Object.freeze({
  frogman: 70, centipede: 30, zombie: 55,
  'fungus beast': 50, 'groundworm larva': 35,
  skeleton: 75, 'battered skeleton': 60, 'spectral mummy': 40,
});
export const CRYPT_QUARRY_LEVEL = QUARRY_LEVEL;

// THE HARNESS'S OWN RULE, RESTATED RATHER THAN GUESSED AT. `refuseEngagement` refuses a
// creature whose level exceeds round(max_health * 1.5). A unit sent to hunt something it
// will refuse stands in the room doing nothing and looks exactly like one that is working.
export const engagementCeiling = maxHealth => Math.round((Number(maxHealth) || 0) * 1.5);

/** Can this unit work this station — the quarry AND everything else in the room? */
export function admits(maxHealth, room, quarry) {
  const entry = HUNT_ROOMS[room];
  const level = QUARRY_LEVEL[quarry];
  const ceiling = engagementCeiling(maxHealth);
  if (!entry || level == null || !ceiling) return false;
  if (!entry.generates.includes(quarry)) return false;
  return level <= ceiling && entry.threat <= ceiling;
}

/**
 * The room a unit should work and the quarry it should hunt there, or null when its
 * engagement ceiling admits nothing on offer.
 */
export function cryptAssignment(hunt = [], rooms = [], maxHealth = 0) {
  for (const quarry of hunt) {
    const room = rooms.map(Number).find(id => admits(maxHealth, id, quarry));
    if (room != null) return { quarry, ...HUNT_ROOMS[room] };
  }
  return null;
}
