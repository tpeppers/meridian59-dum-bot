// OPT-IN, SHORT-LIVED STRATEGY FACTS.
//
// The ordinary journal answers why DUM decided something and is intentionally complete.
// This spool answers a different question: what did the enabled strategies accomplish in
// the last few hours? It keeps small, purpose-built records, expires each line by the
// retention selected for that unit, and is safe to render as click-through summaries.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
         renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STRATEGY_IDS, strategyEnabled, strategySettings, strategyRows }
  from '../strategies/catalog.mjs';
import { createFoodReadiness } from '../decide/rules/food.mjs';

const HOUR = 3_600_000;
const FILE = /^strategy-stats-(\d{4}-\d{2}-\d{2})\.ndjson$/;
const fileFor = (dir, at) => join(dir, `strategy-stats-${new Date(at).toISOString().slice(0, 10)}.ndjson`);

const inventoryRows = result => Array.isArray(result?.items) ? result.items : [];
const itemAmounts = rows => {
  const out = new Map();
  for (const item of rows ?? []) {
    const name = String(item?.name ?? '').trim();
    if (name) out.set(name, (out.get(name) ?? 0) + (Number(item.amount) || 1));
  }
  return out;
};

export function inventoryGain(before = [], after = []) {
  const a = itemAmounts(before), b = itemAmounts(after), gained = [];
  for (const [name, amount] of b) {
    const delta = amount - (a.get(name) ?? 0);
    if (delta > 0) gained.push({ name, amount: delta });
  }
  return gained.sort((x, y) => x.name.localeCompare(y.name));
}

export class DetailStats {
  constructor({ dir = 'var/strategy-stats', enabled = true, now = () => Date.now() } = {}) {
    this.dir = resolve(dir);
    this.enabled = enabled;
    this.now = now;
    this.lastRotation = 0;
    if (enabled) mkdirSync(this.dir, { recursive: true });
  }

  write(entry) {
    if (!this.enabled) return null;
    const at = entry.at ?? this.now();
    const retention = Math.max(1, Math.min(168, Number(entry.retention_hours) || 24));
    const line = { ...entry, at, retention_hours: retention };
    try {
      appendFileSync(fileFor(this.dir, at), JSON.stringify(line) + '\n');
      if (at - this.lastRotation >= HOUR) this.rotate(at);
    } catch (error) {
      process.stderr.write(`strategy stats: could not write (${error.message}) - continuing\n`);
    }
    return line;
  }

  // A line expires by its own configured retention. Daily files are only a spool shape;
  // rewriting the at-most-eight recent files is what makes "24h" a real disk lifetime
  // rather than merely a dashboard filter.
  rotate(at = this.now()) {
    this.lastRotation = at;
    if (!existsSync(this.dir)) return;
    for (const name of readdirSync(this.dir).filter(file => FILE.test(file))) {
      const path = join(this.dir, name);
      const kept = readFileSync(path, 'utf8').split('\n').filter(Boolean).filter(raw => {
        try {
          const row = JSON.parse(raw);
          return row.at + Math.max(1, Math.min(168, Number(row.retention_hours) || 24)) * HOUR >= at;
        } catch { return false; }
      });
      if (!kept.length) { unlinkSync(path); continue; }
      const next = kept.join('\n') + '\n';
      const current = readFileSync(path, 'utf8');
      if (next === current) continue;
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, next);
      renameSync(tmp, path);
    }
  }

  read({ hours = 2, at = this.now() } = {}) {
    if (!existsSync(this.dir)) return [];
    const windowHours = Math.max(0.25, Math.min(168, Number(hours) || 2));
    const cutoff = at - windowHours * HOUR;
    const rows = [];
    for (const name of readdirSync(this.dir).filter(file => FILE.test(file)).sort().slice(-8)) {
      for (const raw of readFileSync(join(this.dir, name), 'utf8').split('\n')) {
        if (!raw) continue;
        try {
          const row = JSON.parse(raw);
          if (row.at >= cutoff && row.at + (Number(row.retention_hours) || 24) * HOUR >= at)
            rows.push(row);
        } catch { /* one torn line must not blank the whole report */ }
      }
    }
    return rows.sort((a, b) => a.at - b.at);
  }

  settings(observation, config, agent) {
    if (!strategyEnabled(observation, config, agent, STRATEGY_IDS.DETAILED_STATS)) return null;
    return strategySettings(observation, config, agent, STRATEGY_IDS.DETAILED_STATS);
  }

  captureCrate(line, config) {
    if (line.applied?.errand !== 'crate-check') return;
    const agent = line.applied.agent;
    const character = line.observation?.characters?.find(row => row.agent === agent)?.character ?? null;
    const settings = this.settings(line.observation, config, agent);
    if (!settings?.crate_check) return;
    const before = line.applied.results?.find(row => row.label === 'crate-before');
    const after = line.applied.results?.find(row => row.label === 'crate-after');
    const reward = inventoryGain(inventoryRows(before?.result), inventoryRows(after?.result));
    const read = line.memory_patch?.read ?? {};
    this.write({ category: 'crate-check', event: 'check', agent, character, at: line.at,
      retention_hours: settings.retention_hours,
      reached: read.reached ?? null, found: read.found ?? false, reward,
      transcript: line.applied.transcript ?? [], stopped: line.applied.stopped ?? null });
  }

  captureFood(line, config) {
    const obs = line.observation;
    if (!obs?.characters) return;
    // A higher-priority fleet rule may have fired before food was reached. That is not
    // a failed food attempt and must not inflate the resource-block denominator.
    if (!(line.considered ?? []).some(row => row.rule === 'create-food-to-keep-fed')) return;
    const selected = strategyRows(obs, config, STRATEGY_IDS.CREATE_FOOD);
    const calls = (line.applied?.results ?? []).filter(row => row.tool === 'cast' &&
      /create food/i.test(row.args?.spell ?? ''));
    for (const row of selected) {
      const settings = this.settings(obs, config, row.agent);
      if (!settings?.create_food) continue;
      const readiness = createFoodReadiness(row, config.food);
      if (!readiness.short) continue;
      const call = calls.find(value => value.args?.agent === row.agent);
      this.write({ category: 'create-food', event: call ? 'attempt' : 'blocked',
        agent: row.agent, character: row.character ?? null, at: line.at,
        retention_hours: settings.retention_hours,
        readiness, cast: call?.result ?? null,
        created: Array.isArray(call?.result?.created) ? call.result.created : [] });
    }
  }

  captureFleetTick(line, config) {
    if (!this.enabled || !line?.observation) return;
    this.captureCrate(line, config);
    this.captureFood(line, config);
  }

  report({ hours = 2 } = {}) {
    const events = this.read({ hours });
    const crate = events.filter(row => row.category === 'crate-check');
    const food = events.filter(row => row.category === 'create-food');
    const blocked = new Map();
    for (const row of food.filter(value => value.event === 'blocked'))
      for (const reason of row.readiness?.blocked_by ?? [])
        blocked.set(reason, (blocked.get(reason) ?? 0) + 1);
    return {
      window_hours: Math.max(0.25, Math.min(168, Number(hours) || 2)),
      retention: 'per selected unit; 24h by default',
      crate: {
        checks: crate.length, finds: crate.filter(row => row.found).length,
        rewards: crate.flatMap(row => row.reward ?? []).reduce((n, item) => n + item.amount, 0),
        records: crate.slice().reverse().slice(0, 200),
      },
      create_food: {
        attempts: food.filter(row => row.event === 'attempt').length,
        produced: food.flatMap(row => row.created ?? []).reduce((n, item) => n + (Number(item.amount) || 1), 0),
        blocked: food.filter(row => row.event === 'blocked').length,
        blocked_by: [...blocked].map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
        records: food.slice().reverse().slice(0, 200),
      },
    };
  }
}
