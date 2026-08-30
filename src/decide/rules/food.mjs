import { STRATEGY_IDS, strategyRows } from '../../strategies/catalog.mjs';

const FOOD = /inky.?cap|chocolate mint|wheel of cheese|turkey leg|mug of|meat pie|stew|loaf of bread|waterskin|slice of pork|bowl of soup|spideye|bunch of grapes|apple|edible mushroom|drumstick|goblet/i;
const ELDERBERRY = /elder\s?berry/i;
const HERB = /^herbs?$/i;

const amountOf = (items, re) => (items ?? []).filter(i => re.test(String(i.name ?? '')))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

export function createFoodReadiness(row, food) {
  const meals = amountOf(row.items, FOOD);
  const elderberry = amountOf(row.items, ELDERBERRY);
  const herbs = amountOf(row.items, HERB);
  const mana = row.mana?.value ?? 0;
  const hasSpell = (row.provides ?? []).some(s => String(s).toLowerCase() === 'create food');
  const short = meals < food.min_items;
  const blocked_by = [];
  if (short && !hasSpell) blocked_by.push('spell');
  if (short && mana < food.mana_cost) blocked_by.push('mana');
  if (short && elderberry < food.elderberry_per_cast) blocked_by.push('elderberry');
  if (short && herbs < food.herbs_per_cast) blocked_by.push('herbs');
  return { short, ready: short && !blocked_by.length, meals, mana, has_spell: hasSpell,
    reagents: { elderberry, herbs }, blocked_by };
}

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
    // ACT ON WHAT IS READABLE. A single unit whose inventory did not come back this tick — a
    // timed-out read on a busy shared broker, which at 21 characters happens on most ticks —
    // must NOT block Create Food for the twenty whose larders we CAN see. Bailing the whole rule
    // the moment ANY selected unit is unread is how the fleet made zero food for an afternoon
    // while every cook stood in a full apothecary with mana and reagents to spare. The unread
    // ones carry over to the next tick on their own. Only a fleet that is ENTIRELY blind is a
    // report; anything readable is worked. (Corrected 2026-08-29.)
    const readable = selected.filter(r => Array.isArray(r.items) && Array.isArray(r.provides));
    const unread = selected.filter(r => !readable.includes(r));
    const note = unread.length ? ` (${unread.length} unread this tick: ${unread.map(r => r.agent).join(', ')})` : '';
    if (!readable.length)
      return { kind: 'report', why: `cannot maintain food: inventory or spells unreadable for ` +
        unread.map(r => r.agent).join(', '), evidence: { unread: unread.map(r => r.agent) } };

    const f = doctrine.food;
    const readiness = new Map(readable.map(r => [r.agent, createFoodReadiness(r, f)]));
    const short = readable.filter(r => readiness.get(r.agent).short);
    const plan = short.filter(r => readiness.get(r.agent).ready)
      .map(r => ({ do: 'cast-create-food', agent: r.agent,
        why: `larder below ${f.min_items}; spend one verified reagent pair` }));

    if (!plan.length) {
      const missing = short.length;
      return { kind: 'pass', why: (missing
        ? `${missing} readable selected unit(s) have no meal, but none currently has the spell, ` +
          `${f.mana_cost} mana, and ${f.elderberry_per_cast} elderberry + ${f.herbs_per_cast} herbs`
        : `${readable.length}/${selected.length} readable selected unit(s) have food aboard`) + note };
    }
    return { kind: 'act', plan,
      why: `${short.length} readable larder(s) are below ${f.min_items}; ` +
        `${plan.length} verified Create Food cast(s)` + note };
  },
}];

export { amountOf as foodAmountOf };
