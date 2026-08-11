import { STRATEGY_IDS, strategyRows } from '../../strategies/catalog.mjs';

const FOOD = /inky.?cap|chocolate mint|wheel of cheese|turkey leg|mug of|meat pie|stew|loaf of bread|waterskin|slice of pork|bowl of soup|spideye|bunch of grapes|apple|edible mushroom|drumstick|goblet/i;
const ELDERBERRY = /elder\s?berry/i;
const HERB = /^herbs?$/i;

const amountOf = (items, re) => (items ?? []).filter(i => re.test(String(i.name ?? '')))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

export const foodFleetRules = [{
  id: 'create-food-to-keep-fed',
  faculty: 'economy',
  scope: 'fleet',
  why: 'selected Kraanan cooks turn their own reagent pairs into food whenever their ' +
       'larder is empty, leaving the keeper to decide when the stomach and vigor need it',
  enabled: doctrine => doctrine.strategies?.enabled === true,
  offWhy: 'composable DUM strategies are off',

  decide(fleetObs, doctrine) {
    const selected = strategyRows(fleetObs, doctrine, STRATEGY_IDS.CREATE_FOOD);
    if (!selected.length) return { kind: 'pass', why: 'no live unit has Create Food to keep Fed enabled' };
    const unread = selected.filter(r => !Array.isArray(r.items) || !Array.isArray(r.provides));
    if (unread.length)
      return { kind: 'report', why: `cannot maintain food: inventory or spells unreadable for ` +
        unread.map(r => r.agent).join(', '), evidence: { unread: unread.map(r => r.agent) } };

    const f = doctrine.food;
    const short = selected.filter(r => amountOf(r.items, FOOD) < f.min_items);
    const plan = short.filter(r => r.provides.some(s => String(s).toLowerCase() === 'create food') &&
      (r.mana?.value ?? 0) >= f.mana_cost &&
      amountOf(r.items, ELDERBERRY) >= f.elderberry_per_cast &&
      amountOf(r.items, HERB) >= f.herbs_per_cast)
      .map(r => ({ do: 'cast-create-food', agent: r.agent,
        why: `larder below ${f.min_items}; spend one verified reagent pair` }));

    if (!plan.length) {
      const missing = short.length;
      return { kind: 'pass', why: missing
        ? `${missing} selected unit(s) have no meal, but none currently has the spell, ` +
          `${f.mana_cost} mana, and ${f.elderberry_per_cast} elderberry + ${f.herbs_per_cast} herbs`
        : `${selected.length}/${selected.length} selected unit(s) have food aboard` };
    }
    return { kind: 'act', plan,
      why: `${short.length} selected larder(s) are below ${f.min_items}; ` +
        `${plan.length} verified Create Food cast(s)` };
  },
}];

export { amountOf as foodAmountOf };
