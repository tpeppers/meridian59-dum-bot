// PER-UNIT STRATEGY ASSIGNMENTS.
//
// This is operational state, not doctrine: the website may change it while DUM is
// running, and the next fleet tick must see the change without a restart. It therefore
// lives under var/ (gitignored), one file per fleet, and is snapshotted into the fleet
// observation before pure decision rules run.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitise } from './memory.mjs';
import { STRATEGY_CATALOG, validateStrategyIds } from '../strategies/catalog.mjs';

export class StrategyStore {
  constructor({ dir = 'var/strategies', fleet = null, defaults = [], enabled = true } = {}) {
    this.dir = resolve(dir);
    this.fleet = fleet ?? 'unnamed';
    this.defaults = validateStrategyIds(defaults);
    this.enabled = enabled;
    this.path = join(this.dir, `${sanitise(this.fleet)}.json`);
    this.warned = false;
  }

  read() {
    if (!existsSync(this.path)) return { version: 1, agents: {} };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      const agents = {};
      for (const [agent, ids] of Object.entries(raw?.agents ?? {}))
        agents[String(agent)] = validateStrategyIds(ids);
      return { version: 1, agents, updated_at: raw?.updated_at ?? null };
    } catch (e) {
      if (!this.warned) {
        process.stderr.write(`strategies: ${this.path} did not parse (${e.message}) - ` +
          `using doctrine defaults until it is repaired\n`);
        this.warned = true;
      }
      return { version: 1, agents: {} };
    }
  }

  effective(agent, state = this.read()) {
    return Array.isArray(state.agents?.[agent]) ? state.agents[agent] : [...this.defaults];
  }

  snapshot(agents = []) {
    const state = this.read();
    return {
      version: 1,
      agents: Object.fromEntries(agents.filter(Boolean).map(agent =>
        [agent, this.effective(agent, state)])),
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
      states[id] = { state: enabled === 0 ? 'none' : enabled === total ? 'all' : 'some', enabled, total };
    }
    return { snapshot, states };
  }

  update(agents = [], changes = {}) {
    if (!this.enabled) throw new Error('strategy store is read-only');
    const who = [...new Set(agents.map(String).filter(Boolean))];
    if (!who.length) throw new Error('at least one selected unit is required');
    const ids = validateStrategyIds(Object.keys(changes));
    if (!ids.length) throw new Error('at least one strategy change is required');
    for (const id of ids)
      if (typeof changes[id] !== 'boolean') throw new Error(`strategy change ${id} must be true or false`);

    const state = this.read();
    for (const agent of who) {
      const next = new Set(this.effective(agent, state));
      for (const id of ids) changes[id] ? next.add(id) : next.delete(id);
      state.agents[agent] = validateStrategyIds([...next]);
    }
    state.updated_at = Date.now();
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, this.path);
    return this.states(who);
  }
}
