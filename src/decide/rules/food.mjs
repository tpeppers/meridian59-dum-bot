import { STRATEGY_IDS, strategyRows } from '../../strategies/catalog.mjs';

export const FOOD = /inky.?cap|chocolate mint|wheel of cheese|turkey leg|mug of|meat pie|stew|loaf of bread|water ?skin|slice of pork|bowl of soup|spideye|spider eye|fortune cookie|bunch of grapes|apple|edible mushroom|drumstick|goblet/i;
const ELDERBERRY = /elder\s?berry/i;
const HERB = /^herbs?$/i;

const amountOf = (items, re) => (items ?? []).filter(i => re.test(String(i.name ?? '')))
  .reduce((n, i) => n + (Number(i.amount) || 1), 0);

// A protected meal is cargo, not fuel. Keep counting unknown inventories as unknown.
export function mealsAboard(row) {
  const list = Array.isArray(row?.items) ? row.items
    : Array.isArray(row?.pack_items) ? row.pack_items : null;
  const protectedNames = [...(row?.policy?.vaultItems ?? []),
    ...(row?.policy?.protectedItems ?? [])].map(s => String(s).toLowerCase());
  if (list) return amountOf(list.filter(i => !protectedNames.some(p =>
    String(i.name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') === p.replace(/[^a-z0-9]/g, ''))), FOOD);
  return typeof row?.has_food === 'boolean' ? (row.has_food ? 1 : 0) : null;
}

export function createFoodReadiness(row, food) {
  const meals = mealsAboard(row) ?? 0;
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
  enabled: doctrine => doctrine.strategies?.enabled === true || doctrine.food?.provision?.enabled === true,
  offWhy: 'composable DUM strategies and food provisioning are both off',

  decide(fleetObs, doctrine) {
    const f = doctrine.food ?? {};
    const prov = f.provision;
    const roomGated = prov?.enabled === true;
    // Provisioning carries its own larder floor, so a deep off-shift stockpile does not require
    // raising the fleet-wide default.
    const fEff = roomGated && prov.min_items != null ? { ...f, min_items: prov.min_items } : f;

    // WHO COOKS. In provision mode the cooks are the units STANDING IN THE STAGING ROOM that hold
    // the spell — room-gated exactly like weapons.provision. That is the whole point: the cook only
    // fires where the fleet gathers off-shift, never where the graveyard placement is moving people,
    // so it cannot win the fleet tick and STARVE the shift (which is what the create-food STRATEGY,
    // ungated, did — a scout reached the graveyard but nobody ever gathered). Otherwise the cooks
    // are the units that selected the Create Food strategy.
    const selected = roomGated
      ? (fleetObs.characters ?? []).filter(r => r.in_game && r.room === prov.room
          && (r.provides ?? []).some(s => String(s).toLowerCase() === 'create food'))
      : strategyRows(fleetObs, doctrine, STRATEGY_IDS.CREATE_FOOD);
    if (!selected.length) return { kind: 'pass', why: roomGated
      ? `no cook holding Create Food is at the staging room ${prov.room}`
      : 'no live unit has Create Food to keep Fed enabled' };

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
      // A report WINS the fleet tick and stops the table. In strategies mode that is fine — the
      // food rule sits high and surfacing "the fleet is blind" is worth a tick. But provisioning
      // sits BELOW the graveyard placement: a report there stops the shift over a single unreadable
      // staged cook, stranding the rest of the team outside the GY (measured). So provisioning PASSES
      // on a blind tick — the reason still lands in the audit — and retries next tick.
      return roomGated
        ? { kind: 'pass', why: `provision deferred: inventory or spells unreadable this tick for ` +
            unread.map(r => r.agent).join(', ') + ' — passing so it cannot starve the shift below' }
        : { kind: 'report', why: `cannot maintain food: inventory or spells unreadable for ` +
            unread.map(r => r.agent).join(', '), evidence: { unread: unread.map(r => r.agent) } };

    const readiness = new Map(readable.map(r => [r.agent, createFoodReadiness(r, fEff)]));
    const short = readable.filter(r => readiness.get(r.agent).short);
    const plan = short.filter(r => readiness.get(r.agent).ready)
      .map(r => ({ do: 'cast-create-food', agent: r.agent,
        why: `larder below ${fEff.min_items}; spend one verified reagent pair` }));

    if (!plan.length) {
      const missing = short.length;
      return { kind: 'pass', why: (missing
        ? `${missing} readable ${roomGated ? 'staged' : 'selected'} unit(s) have no meal, but none currently has the spell, ` +
          `${fEff.mana_cost} mana, and ${fEff.elderberry_per_cast} elderberry + ${fEff.herbs_per_cast} herbs`
        : `${readable.length}/${selected.length} readable ${roomGated ? 'staged' : 'selected'} unit(s) have food aboard`) + note };
    }
    return { kind: 'act', plan,
      why: `${short.length} readable larder(s) are below ${fEff.min_items}; ` +
        `${plan.length} verified Create Food cast(s)` + note };
  },
}];

export { amountOf as foodAmountOf };
