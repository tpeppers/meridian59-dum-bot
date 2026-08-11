// PER-UNIT STRATEGY ASSIGNMENTS.
//
// This is operational state, not doctrine: the website may change it while DUM is
// running, and the next fleet tick must see the change without a restart. It therefore
// lives under var/ (gitignored), one file per fleet, and is snapshotted into the fleet
// observation before pure decision rules run.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitise } from './memory.mjs';
import { STRATEGY_CATALOG, validateStrategyIds, validateStrategySettings,
         validateStrategySettingsMap } from '../strategies/catalog.mjs';

export class StrategyStore {
  constructor({ dir = 'var/strategies', fleet = null, defaults = [], settings = {}, enabled = true } = {}) {
    this.dir = resolve(dir);
    this.fleet = fleet ?? 'unnamed';
    this.defaults = validateStrategyIds(defaults);
    this.settings = validateStrategySettingsMap(settings);
    this.enabled = enabled;
    this.path = join(this.dir, `${sanitise(this.fleet)}.json`);
    this.warned = false;
  }

  read() {
    if (!existsSync(this.path)) return { version: 2, agents: {}, settings: {} };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      const agents = {};
      for (const [agent, ids] of Object.entries(raw?.agents ?? {}))
        agents[String(agent)] = validateStrategyIds(ids);
      const settings = {};
      for (const [agent, byStrategy] of Object.entries(raw?.settings ?? {}))
        settings[String(agent)] = validateStrategySettingsMap(byStrategy);
      return { version: 2, agents, settings, updated_at: raw?.updated_at ?? null };
    } catch (e) {
      if (!this.warned) {
        process.stderr.write(`strategies: ${this.path} did not parse (${e.message}) - ` +
          `using doctrine defaults until it is repaired\n`);
        this.warned = true;
      }
      return { version: 2, agents: {}, settings: {} };
    }
  }

  effective(agent, state = this.read()) {
    return Array.isArray(state.agents?.[agent]) ? state.agents[agent] : [...this.defaults];
  }

  effectiveSettings(agent, id, state = this.read()) {
    return validateStrategySettings(id, {
      ...(this.settings[id] ?? {}), ...(state.settings?.[agent]?.[id] ?? {}),
    });
  }

  snapshot(agents = []) {
    const state = this.read();
    return {
      version: 2,
      agents: Object.fromEntries(agents.filter(Boolean).map(agent =>
        [agent, this.effective(agent, state)])),
      settings: Object.fromEntries(agents.filter(Boolean).map(agent => [agent,
        Object.fromEntries(STRATEGY_CATALOG.map(s =>
          [s.id, this.effectiveSettings(agent, s.id, state)]))])),
      updated_at: state.updated_at ?? null,
    };
  }

  states(agents = []) {
    const snapshot = this.snapshot(agents);
    const total = agents.length;
    const ids = new Set(STRATEGY_CATALOG.map(s => s.id));
    const states = {};
    for (const id of ids) {
      const enabled = agents.filter(agent => snapshot.agents[agent]?.includes(id)).length;
      const values = agents.map(agent => snapshot.settings?.[agent]?.[id] ?? {});
      const keys = new Set(values.flatMap(Object.keys));
      const settings = {}, mixed_settings = [];
      for (const key of keys) {
        const first = values[0]?.[key];
        if (values.every(v => sameSetting(v[key], first))) settings[key] = first;
        else mixed_settings.push(key);
      }
      states[id] = { state: enabled === 0 ? 'none' : enabled === total ? 'all' : 'some',
        enabled, total, settings, mixed_settings };
    }
    return { snapshot, states };
  }

  update(agents = [], changes = {}, settings = {}) {
    if (!this.enabled) throw new Error('strategy store is read-only');
    const who = [...new Set(agents.map(String).filter(Boolean))];
    if (!who.length) throw new Error('at least one selected unit is required');
    const ids = validateStrategyIds(Object.keys(changes));
    const settingIds = validateStrategyIds(Object.keys(settings));
    if (!ids.length && !settingIds.length)
      throw new Error('at least one strategy toggle or setting change is required');
    for (const id of ids)
      if (typeof changes[id] !== 'boolean') throw new Error(`strategy change ${id} must be true or false`);
    const cleanSettings = Object.fromEntries(settingIds.map(id =>
      [id, validateStrategySettings(id, settings[id], { partial: true })]));

    const state = this.read();
    for (const agent of who) {
      const next = new Set(this.effective(agent, state));
      for (const id of ids) changes[id] ? next.add(id) : next.delete(id);
      state.agents[agent] = validateStrategyIds([...next]);
      state.settings ??= {};
      state.settings[agent] ??= {};
      for (const [id, values] of Object.entries(cleanSettings))
        state.settings[agent][id] = { ...(state.settings[agent][id] ?? {}), ...values };
    }
    state.updated_at = Date.now();
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, this.path);
    return this.states(who);
  }
}

const sameSetting = (a, b) => Object.is(a, b) ||
  (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]));
