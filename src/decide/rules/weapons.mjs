import { keeperWeaponPriority, planWeaponProvisioning } from '../weapons.mjs';
import { STRATEGY_IDS, strategyEnabled } from '../../strategies/catalog.mjs';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) &&
  a.length === b.length && a.every((x, i) => x === b[i]);

const selectedFor = (fleetObs, doctrine, id) => (fleetObs.characters ?? [])
  .filter(r => r.in_game && strategyEnabled(fleetObs, doctrine, r.agent, id));

export const weaponFleetRules = [{
  id: 'maintain-qualifying-weapons',
  faculty: 'economy',
  scope: 'fleet',
  why: 'weapon selection and weapon creation are independent strategies: apply each ' +
       'unit\'s named priority, pool co-located qualifying spares, then have capable ' +
       'casters make weapons until the configured cutoff is met',
  enabled: doctrine => doctrine.strategies?.enabled === true ||
    doctrine.weapons?.provision?.enabled === true,
  offWhy: 'DUM strategies and legacy weapon provisioning are both off',

  decide(fleetObs, doctrine) {
    const cfg = doctrine.weapons;
    const live = (fleetObs.characters ?? []).filter(r => r.in_game);
    if (!live.length) return { kind: 'pass', why: 'nobody in game' };

    const create = selectedFor(fleetObs, doctrine, STRATEGY_IDS.CREATE_WEAPONS);
    const skeleton = selectedFor(fleetObs, doctrine, STRATEGY_IDS.VS_SKELETONS);
    // Backward compatibility for doctrines written before composable strategies.
    const creators = create.length || fleetObs.strategies
      ? create : (cfg.provision?.enabled ? live : []);
    const involved = [...new Map([...creators, ...skeleton].map(r => [r.agent, r])).values()];
    if (!involved.length) return { kind: 'pass', why: 'no live unit has a weapon strategy enabled' };

    if (cfg.provision?.staging_only !== false && creators.length) {
      const room = cfg.provision.room;
      const here = live.filter(r => r.room === room);
      if (here.length !== live.length)
        return { kind: 'pass', why: `${here.length}/${live.length} are in staging room ${room}; ` +
          'legacy provisioning never chases or interrupts fighters' };
    }

    const policies = involved.flatMap(r => {
      const preset = strategyEnabled(fleetObs, doctrine, r.agent, STRATEGY_IDS.VS_SKELETONS)
        ? 'vsSkeletons' : cfg.preset;
      const priority = keeperWeaponPriority(preset, cfg.presets);
      return sameList(r.policy?.weaponPriority, priority) ? [] : [{
        do: 'weapon-policy', agent: r.agent, priority,
        why: `equip by named preset ${preset}`,
      }];
    });

    if (!creators.length) {
      if (!policies.length) return { kind: 'pass', why: 'all selected units already hold their weapon priority' };
      return { kind: 'act', plan: policies,
        why: `applied weapon selection priority to ${policies.length} selected unit(s)` };
    }

    const unread = creators.filter(r => !Array.isArray(r.items) || !r.carry ||
      !Array.isArray(r.provides));
    if (unread.length)
      return { kind: 'report', why: `cannot provision: inventory, carry room, or spells unreadable for ` +
        unread.map(r => r.agent).join(', '), evidence: { unread: unread.map(r => r.agent) } };

    const groups = new Map();
    for (const row of creators) {
      const preset = strategyEnabled(fleetObs, doctrine, row.agent, STRATEGY_IDS.VS_SKELETONS)
        ? 'vsSkeletons' : cfg.preset;
      if (!groups.has(preset)) groups.set(preset, []);
      groups.get(preset).push(row);
    }

    const results = [...groups].map(([preset, rows]) => planWeaponProvisioning(rows, {
      preset, presets: cfg.presets, threshold: cfg.provision.threshold,
      cast_when_mana: cfg.provision.cast_when_mana, mana_cost: cfg.provision.mana_cost,
    }));
    const transfers = results.flatMap(r => r.transfers);
    const cast = results.flatMap(r => r.cast);
    const needsRoom = results.flatMap(r => r.needs_room);
    const equip = transfers.map(t => ({ do: 'equip-best', agent: t.to,
      why: `equip the received ${t.weapon}` }));
    const holds = cfg.provision?.staging_only !== false
      ? creators.filter(r => r.mode !== 'idle').map(r => ({ do: 'hold', agent: r.agent,
          why: 'legacy provisioning occurs only at staging' })) : [];
    const plan = [...holds, ...policies, ...transfers, ...equip, ...cast];
    const deficits = results.reduce((n, r) => n + r.deficit, 0);

    if (!plan.length)
      return { kind: 'pass', why: `${creators.length - deficits}/${creators.length} selected unit(s) ` +
        `meet the inclusive ${cfg.provision.threshold} threshold` };

    return { kind: 'act', plan, notes: needsRoom,
      why: `${creators.length - deficits}/${creators.length} meet inclusive ` +
        `${cfg.provision.threshold}; ${transfers.length} handoff(s), ${cast.length} Create Weapon cast(s)` +
        (needsRoom.length ? `; ${needsRoom.length} must make pack room` : '') };
  },
}];
