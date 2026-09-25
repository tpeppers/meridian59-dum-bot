// UKGOTH TROLLS — hunt trolls on MAGIC weapons, and get them made magic at the stage room.
//
// The strategy's description in strategies/catalog.mjs carries the argument; this is the table.
// In one line: a troll resists ATCK_WEAP_NONMAGIC 80 (troll.kod:64-67), so a mundane weapon
// lands a fifth, Kraanan's enchant weapon clears the flag (waench.kod:108-109), and a unit is
// sent into Ukgoth only while the weapon in its hand is READ as magic and it carries spares that
// are too. Nothing forces a weapon family: the keeper's `prefer_magic_weapon` is a tie-break
// inside whatever the unit trains.
//
// THREE THINGS PER PASS, and never more than one of the expensive one:
//
//   deploy      a qualifying unit to the troll room: hunt the generated quarry, roam off, prefer
//               magic, the strategy's flee/rest lines. Diffed, so a unit already there costs
//               nothing.
//   stage       a unit that does not qualify (or whose weapons nobody has read yet) waits at the
//               stage room — one easy hop from Ukgoth, and where the dedicators are — idle, with
//               the magic tie-break already on so a returned weapon is wielded at once.
//   dedicate    AT MOST ONE owner -> dedicator -> owner round, when both stand in the stage room
//               and the dedicator has the mana. Reagents come from a co-located depot if the
//               dedicator has none. A 30-second trance is the whole pass for the fleet table, so
//               one is the bound (errands.mjs: "IT BLOCKS THE PASS").
//
// PURE, like every rule here: no clock, no I/O. Whether a dedication landed is learned from the
// next board, where the keeper's own look says so.

import { STRATEGY_IDS, strategyRows, strategySettings, admits } from '../../strategies/catalog.mjs';
import { magicWeaponMet } from './shift.mjs';
import { activeFactionWork } from './factions.mjs';
import { takeable } from '../engine.mjs';

const DEDICATE = Object.freeze({ spell: 'enchant weapon', mana: 17,
  reagents: Object.freeze([['elderberry', 3], ['orc tooth', 1]]) });

const norm = v => String(v ?? '').trim().toLowerCase();
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]));

/** How many of a named item a row carries, from the free board. Unknown is 0 here: it only gates offers. */
export const carried = (row, name) => (row?.pack_items ?? [])
  .filter(i => norm(i.name) === norm(name))
  .reduce((n, i) => n + (Number(i.amount) || 0), 0);

const hasReagents = row => DEDICATE.reagents.every(([n, k]) => carried(row, n) >= k);
const knowsDedication = row => (row?.provides ?? []).some(s => norm(s) === DEDICATE.spell);

/** Is this unit ready for the troll room, and if not, why not — in words a journal can hold. */
export function trollReadiness(row, settings) {
  const mh = Number(row?.max_health);
  if (!Number.isFinite(mh)) return { ready: false, why: 'max health unknown' };
  if (mh < settings.min_max_health)
    return { ready: false, size: false, why: `max health ${mh} is under ${settings.min_max_health}` };
  if (!settings.hunt.every(q => admits(mh, settings.room, q)))
    return { ready: false, size: false, why: `the engagement ceiling at ${mh} does not admit ${settings.hunt.join(', ')} in ${settings.room}` };
  if (!row?.weapon_magic)
    return { ready: false, size: true, why: 'the harness reports no weapon_magic for this unit (an older broker?) — refused, not assumed' };
  if (!magicWeaponMet({ wielded: true, spares: settings.magic_spares }, row)) {
    const wm = row.weapon_magic;
    return { ready: false, size: true, why: `wielding ${wm.wielded?.name ?? 'nothing'} ` +
      `(${wm.wielded?.class ?? 'unread'}), ${wm.magic_spares ?? 0}/${settings.magic_spares} magic spare(s)` +
      (wm.unknown ? `, ${wm.unknown} weapon(s) not yet read` : '') };
  }
  return { ready: true, size: true, why: 'wielding a magic weapon with enough magic spares' };
}

/** The weapon a dedication round should take: a spare known mundane, real before conjured. */
export function dedicationTarget(row) {
  const ws = (row?.weapon_magic?.weapons ?? []).filter(w => w.id != null && w.id >= 0 &&
    w.bypasses_nonmagic === false && w.made !== true);
  const madeOk = (row?.weapon_magic?.weapons ?? []).filter(w => w.id != null && w.id >= 0 &&
    w.bypasses_nonmagic === false && w.made === true);
  // A CONJURED WEAPON IS DEDICATED ONLY WHEN NOTHING REAL IS TO HAND: it deletes itself after
  // power x 2 minutes (iamade.kod) and the enchantment dies with it.
  // ONLY A SPARE. A weapon in hand would have to be unwielded before the hand-over and the
  // owner would stand bare in the stage room for the length of a trance; dedicating the spare
  // instead means the keeper's magic tie-break swaps it in on return, and the old one becomes
  // the next round's spare. A unit carrying a single weapon needs a second (Create Weapons).
  const pool = [...ws, ...madeOk].filter(w => !w.wielded);
  return (ws.find(w => !w.wielded) ?? pool[0]) ?? null;
}

const deployOrders = (settings) => ({
  to: settings.room, hunt: settings.hunt, roam: false,
  flee_below: settings.flee_below, rest_below: settings.rest_below,
  prefer_magic_weapon: true, purpose: 'advance', goals: [{ kind: 'hp' }],
});

const deployed = (row, o) => {
  const p = row.policy ?? {};
  return row.mode === 'farm' && p.assignedRoom === o.to && sameList(p.hunt, o.hunt) &&
    p.roam === false && p.preferMagicWeapon === true &&
    p.fleeBelow === o.flee_below && p.restBelow === o.rest_below;
};
const staged = (row, room) => {
  const p = row.policy ?? {};
  return row.mode === 'idle' && p.assignedRoom === room && p.roam === false &&
    p.preferMagicWeapon === true;
};

export const trollFleetRules = [{
  id: 'ukgoth-trolls',
  faculty: 'movement',
  scope: 'fleet',
  why: 'units on the Ukgoth Trolls strategy hunt trolls only on weapons read as magic, and are ' +
       'held and dedicated at the stage room until they are',
  enabled: doctrine => doctrine.strategies?.enabled === true,
  offWhy: 'DUM strategies are disabled',

  decide(fleetObs, doctrine) {
    const selected = strategyRows(fleetObs, doctrine, STRATEGY_IDS.UKGOTH_TROLLS);
    if (!selected.length) return { kind: 'pass', why: 'Ukgoth Trolls is off for every live unit' };

    const plan = [], notes = [];
    let busy = 0, holding = 0, working = 0;
    const needers = [];
    for (const row of selected) {
      if (!takeable(row) || row.parked || row.piloted || activeFactionWork(fleetObs, row)) {
        busy += 1; continue;
      }
      const s = strategySettings(fleetObs, doctrine, row.agent, STRATEGY_IDS.UKGOTH_TROLLS);
      const r = trollReadiness(row, s);
      if (r.ready) {
        const o = deployOrders(s);
        if (deployed(row, o)) { working += 1; continue; }
        plan.push({ do: 'deploy', agent: row.agent, ...o,
          why: `${r.why}: hunt ${o.hunt.join(', ')} in ${o.to}, roaming off, preferring magic` });
        continue;
      }
      // NOT READY. Too small is not this strategy's business beyond saying so — it does not park
      // a unit that could not use the room anyway. Too mundane is: stage it for a dedication.
      if (r.size === false) { notes.push({ agent: row.agent, why: r.why }); continue; }
      holding += 1;
      if (!staged(row, s.stage_room)) {
        plan.push({ do: 'stand-down', agent: row.agent, assigned_room: s.stage_room, roam: false,
          moved: row.room !== s.stage_room,
          why: `not ready for trolls (${r.why}); wait at stage room ${s.stage_room}` });
        plan.push({ do: 'magic-policy', agent: row.agent,
          why: 'prefer the enchanted twin the moment a dedication hands it back' });
      }
      if (s.dedicate && row.room === s.stage_room) needers.push({ row, s });
    }

    // ONE DEDICATION ROUND, IN THE STAGE ROOM, WHEN ALL THREE PARTIES ARE THERE.
    const round = planDedication(needers, fleetObs.characters ?? []);
    if (round.plan.length) plan.push(...round.plan);
    else if (round.why) notes.push({ why: round.why });

    if (!plan.length)
      return { kind: 'pass', why: `${working} in the troll room, ${holding} held at the stage room` +
        (busy ? `, ${busy} busy` : '') + (round.why ? `; ${round.why}` : '') };
    return { kind: 'act', plan, notes,
      why: `${plan.filter(p => p.do === 'deploy').length} deploy(s), ` +
        `${plan.filter(p => p.do === 'stand-down').length} to the stage room` +
        (round.plan.length ? `, one dedication (${round.summary})` : '') };
  },
}];

/**
 * The one dedication this pass, or none with the reason. Pure.
 *
 * The owner's weapon goes to a dedicator in the SAME room (a hand-over is one room — the
 * ghost raid lost four dedications to "not in the room"), the dedicator casts at the weapon by
 * id, and the weapon goes back whether or not the cast landed. A depot top-up comes first when
 * the dedicator is short of reagents.
 */
export function planDedication(needers = [], rows = []) {
  if (!needers.length) return { plan: [], why: null };
  for (const { row, s } of needers) {
    const w = dedicationTarget(row);
    if (!w) continue;
    const here = rows.filter(r => r.in_game && r.room === s.stage_room && r.agent !== row.agent &&
      takeable(r) && !r.piloted);
    const casters = here.filter(r => knowsDedication(r) && (r.mana?.value ?? 0) >= DEDICATE.mana)
      .sort((a, b) => Number(hasReagents(b)) - Number(hasReagents(a)) ||
        (b.mana?.value ?? 0) - (a.mana?.value ?? 0));
    const d = casters[0];
    if (!d) continue;
    const plan = [];
    if (!hasReagents(d)) {
      const depot = here.filter(r => r.agent !== d.agent && hasReagents(r))
        .sort((a, b) => carried(b, 'orc tooth') - carried(a, 'orc tooth'))[0];
      if (!depot) return { plan: [], why: `${d.agent} could dedicate but nobody in ${s.stage_room} ` +
        'holds 3 elderberry and 1 orc tooth to hand it' };
      for (const [item, n] of DEDICATE.reagents) {
        const short = Math.max(0, n - carried(d, item));
        if (short) plan.push({ do: 'give-reagent', from: depot.agent, to: d.agent, item, amount: short,
          why: `${d.agent} needs ${n} ${item} for one dedication` });
      }
    }
    plan.push(
      { do: 'give-weapon', from: row.agent, to: d.agent, what: [{ id: w.id, amount: 1 }], weapon: w.name,
        why: `${row.agent}'s ${w.name} is read as mundane; ${d.agent} dedicates it to Kraanan` },
      { do: 'cast-enchant-weapon', agent: d.agent, target: w.id,
        why: `enchant weapon on ${row.agent}'s ${w.name}: trolls resist NONMAGIC 80` },
      { do: 'give-weapon', from: d.agent, to: row.agent, what: [{ id: w.id, amount: 1 }], weapon: w.name,
        why: 'the weapon goes back whether or not the dedication landed' },
      { do: 'equip-best', agent: row.agent, why: 'wield the dedicated weapon (prefer_magic_weapon breaks the tie)' },
    );
    return { plan, summary: `${row.agent}'s ${w.name} by ${d.agent}`, why: null };
  }
  const anyTarget = needers.some(({ row }) => dedicationTarget(row));
  return { plan: [], why: anyTarget
    ? 'no dedicator in the stage room with 17 mana who knows enchant weapon'
    : 'no unit at the stage room carries a weapon read as mundane to dedicate (unread ones are looked at by the keeper first; a unit with one weapon needs a spare — Create Weapons)' };
}
