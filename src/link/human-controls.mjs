// One reflective control model for the website, FleetScratch terminal and broker chat.
// Only explicit save changes files or keeper policy. Editors carry revision tokens.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { STRATEGY_CATALOG, validateStrategySettingsMap, validateStrategyIds } from '../strategies/catalog.mjs';
import { canonicalItemSettings } from './strategy-control.mjs';
import { applyReload } from './reload.mjs';
import { WRITE } from './surface.mjs';

const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const own = (o, k) => Object.hasOwn(o ?? {}, k);
export const normalizeField = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function strategyFields() {
  return STRATEGY_CATALOG.flatMap(s => [
    { id: `strategy.${s.id}.enabled`, title: `${s.title} enabled`, group: s.title,
      description: s.description, type: 'boolean', default: false },
    ...(s.settings ?? []).map(f => ({ ...f, id: `strategy.${s.id}.${f.id}`, group: s.title,
      minimum: f.min, maximum: f.max, maxItems: f.max_items,
      type: ['number-list', 'item-list'].includes(f.type) ? 'array' : f.type,
      ...(f.type === 'number-list' ? { items: { type: 'integer' } } : {}),
      ...(f.type === 'item-list' ? { items: { type: 'string' } } : {}) })),
  ]);
}

function strategyValues(snapshot, agent) {
  return Object.fromEntries(STRATEGY_CATALOG.flatMap(s => [
    [`strategy.${s.id}.enabled`, snapshot.agents[agent]?.includes(s.id) ?? false],
    ...Object.entries(snapshot.settings[agent]?.[s.id] ?? {}).map(([k, v]) => [`strategy.${s.id}.${k}`, v]),
  ]));
}

export class HumanControls {
  constructor({ broker, store, config, restartConfig = () => config, url, only = null }) {
    Object.assign(this, { broker, store, config, restartConfig, url, only });
    this.path = store.path.replace(/\.json$/, '.controls.json');
    this.overlays = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { version: 1, agents: {} };
    if (this.overlays.version !== 1 || !this.overlays.agents) throw new Error('invalid human control overlay');
    this.saving = new Set();
    this.inflight = new Map();
    this.queue = Promise.resolve();
  }
  async register() {
    return this.broker.call('dum_controls', { action: 'register', url: this.url, pid: process.pid, fleet: this.store.fleet });
  }
  pins(agent) { return Object.fromEntries(Object.entries(this.overlays.agents[agent] ?? {}).map(([k, v]) => [k, v.value])); }
  ownership() { return Object.fromEntries(Object.keys(this.overlays.agents).map(a => [a, this.pins(a)])); }
  enter(tool, args) {
    if (!WRITE.has(tool) || ['policy_control', 'dum_controls'].includes(tool) ||
        (tool === 'autopilot' && ['status', 'list', 'heartbeat', 'claim'].includes(args.action))) return () => {};
    const agents = args.agent ? [args.agent] : args.agents ?? ['*'];
    if (agents.some(a => this.saving.has(a)) || (agents.includes('*') && this.saving.size))
      throw new Error('operator is saving new orders');
    for (const a of agents) this.inflight.set(a, (this.inflight.get(a) ?? 0) + 1);
    return () => { for (const a of agents) this.inflight.set(a, Math.max(0, (this.inflight.get(a) ?? 0) - 1)); };
  }
  filterCall(tool, args) {
    if (['policy_control', 'dum_controls'].includes(tool)) return args;
    const agents = args.agent ? [args.agent] : args.agents ?? [];
    if (agents.some(a => this.saving.has(a))) throw new Error('operator is saving new orders; retry on the next pass');
    if (tool === 'autopilot' && ['start', 'policy', undefined].includes(args.action)) {
      const pins = this.pins(args.agent);
      const next = { ...args };
      for (const key of Object.keys(pins)) delete next[key];
      // An old strategy preset may also reset carry and vigor, so reassert pins last.
      if (next.strategy) Object.assign(next, pins);
      return next;
    }
    if (['travel', 'spread', 'walk_to', 'loot_run', 'learn_planned', 'rest_up'].includes(tool) &&
        agents.some(a => (this.pins(a).confine_rooms ?? []).length))
      throw new Error('operator room lock owns movement');
    return args;
  }
  /**
   * Re-read the doctrine from disk and apply what can be applied to the RUNNING config.
   *
   * This is the write half of `restartConfig`, which until now only ever powered a preview
   * — "a GET never replaces the running defaults", in `snapshot` below. `this.config` is the
   * same object `run.mjs` destructured once and `tick.mjs` re-destructures every pass, so
   * `applyReload` mutates it in place rather than replacing it; see the argument in
   * reload.mjs. Keys that cannot take effect without a restart are reported and deliberately
   * NOT written, because a value that looks applied and is not is the failure this control
   * plane exists to avoid.
   */
  reload() {
    const report = applyReload(this.config, this.restartConfig());
    return { ok: true, pid: process.pid, doctrine: this.config.name, ...report };
  }

  async snapshot(agents) {
    if (this.only?.length && agents?.some(a => !this.only.includes(a))) throw new Error('selected agent is outside this DUM scope');
    const policy = await this.broker.call('policy_control', { action: 'read', ...(agents?.length ? { agents } : this.only?.length ? { agents: this.only } : {}) });
    agents = policy.agents;
    const live = this.store.snapshot(agents);
    const nextConfig = this.restartConfig();
    // Preview using a detached view: a GET never replaces the running defaults.
    const restartView = Object.create(this.store);
    restartView.defaults = nextConfig.strategies.defaults;
    restartView.settings = nextConfig.strategies.settings;
    const saved = restartView.snapshot(agents, this.store.read());
    const fields = [...strategyFields(), ...policy.schema.map(f => ({ ...f, id: `order.${f.id}` })),
      { id: 'room_lock', title: 'Room lock', group: 'Movement', type: 'boolean',
        description: 'Confine this bot to its assigned farming room (or its current room if unassigned). Turning off clears confinement and returns movement to DUM.' }];
    const rows = Object.fromEntries(agents.map(agent => {
      const p = policy.rows[agent];
      const values = side => ({ ...strategyValues(side === 'live' ? live : saved, agent),
        ...Object.fromEntries(Object.entries(p[side === 'live' ? 'live' : 'restart'].values).map(([k, v]) => [`order.${k}`, v])),
        room_lock: !!p[side === 'live' ? 'live' : 'restart'].values.confine_rooms?.length });
      return [agent, { current: values('live'), restart: values('restart'), overrides: this.pins(agent),
        current_unset: (p.live.unset ?? []).map(k => `order.${k}`), restart_unset: (p.restart.unset ?? []).map(k => `order.${k}`),
        keeper_pid: p.keeper_pid, room: p.room, poor_farming: p.poor_farming }];
    }));
    const revision = hash({ pid: process.pid, policy: policy.revision, live, saved, overlays: this.overlays });
    return { version: 1, fleet: this.store.fleet, pid: process.pid, revision, agents, fields, rows,
      strategy_engine_enabled: this.config.strategies.enabled,
      templates: STRATEGY_CATALOG.map(s => ({ id: s.id, title: s.title, description: s.description,
        extends: `strategy:${s.id}`, fields: fields.filter(f => f.id.startsWith(`strategy.${s.id}.`)).map(f => f.id) })),
      restart_note: 'Restart values combine current doctrine files and saved keeper orders. Strategy rules may subsequently issue new orders as the world changes.' };
  }
  async save(body) {
    const run = async () => {
      const before = await this.snapshot(body.agents);
      if (body.fleet !== before.fleet || body.pid !== before.pid || body.revision !== before.revision)
        throw Object.assign(new Error('live state or restart files changed; reset to current before saving'), { status: 409 });
      const patch = body.patch ?? {}, inherit = body.inherit ?? [];
      if (!Object.keys(patch).length && !inherit.length) throw new Error('no staged changes');
      if (!Array.isArray(inherit) || inherit.some(k => !k.startsWith('order.'))) throw new Error('inherit accepts keeper order fields');
      for (const k of [...Object.keys(patch), ...inherit]) if (!before.fields.some(f => f.id === k)) throw new Error(`unknown setting ${k}`);
      if (inherit.some(k => own(patch, k))) throw new Error('a field cannot be set and inherited in the same save');
      const changes = {}, settings = {};
      for (const [key, value] of Object.entries(patch)) {
        if (key.startsWith('strategy.')) {
          const [, id, setting] = key.split('.');
          if (setting === 'enabled') { if (typeof value !== 'boolean') throw new Error(`${key} must be boolean`); changes[id] = value; }
          else (settings[id] ??= {})[setting] = value;
        }
      }
      validateStrategyIds(Object.keys(changes));
      validateStrategySettingsMap(settings);
      const cleanSettings = await canonicalItemSettings(settings, items => this.broker.call('resolve_item_names', { items }));
      const results = {};
      if (before.agents.some(a => this.inflight.get(a)) || this.inflight.get('*'))
        throw new Error('DUM is completing an order for a selected bot; retry Save once it finishes');
      if (own(patch, 'room_lock') && typeof patch.room_lock !== 'boolean') throw new Error('room_lock must be boolean');
      if (patch.room_lock && before.agents.some(a => !Number.isInteger(before.rows[a].current['order.assigned_room'] ?? before.rows[a].room)))
        throw new Error('cannot lock an unknown room');
      for (const a of before.agents) this.saving.add(a);
      try {
        for (const agent of before.agents) {
          const order = Object.fromEntries(Object.entries(patch).filter(([k]) => k.startsWith('order.')).map(([k, v]) => [k.slice(6), v]));
          for (const key of inherit) {
            const record = this.overlays.agents[agent]?.[key.slice(6)];
            if (record) {
              const field = before.fields.find(f => f.id === key);
              // Confinement and similar list controls encode an unconfigured list
              // as null in the keeper but use [] to clear it on the wire.
              order[key.slice(6)] = record.base === null && [].concat(field.type ?? []).includes('array') &&
                ![].concat(field.type ?? []).includes('null') ? [] : record.base;
            }
          }
          if (own(patch, 'room_lock')) {
            if (typeof patch.room_lock !== 'boolean') throw new Error('room_lock must be boolean');
            const room = before.rows[agent].current['order.assigned_room'] ?? before.rows[agent].room;
            if (patch.room_lock && !Number.isInteger(room)) throw new Error('cannot lock an unknown room');
            order.confine_rooms = patch.room_lock ? [room] : [];
          }
          try {
            if (Object.keys(order).length) {
              const current = await this.broker.call('policy_control', { action: 'read', agents: [agent] });
              const answer = await this.broker.call('policy_control', { action: 'save', agents: [agent], patch: order,
                expected_fleet: current.fleet, expected_pid: current.pid, expected_revision: current.revision });
              if (!answer.ok) throw new Error(answer.results[agent]?.error ?? 'keeper did not accept the patch');
              const pins = this.overlays.agents[agent] ??= {};
              for (const [key] of Object.entries(order)) {
                const actual = answer.rows[agent].live.values[key];
                if (inherit.includes(`order.${key}`) || (key === 'confine_rooms' && patch.room_lock === false)) delete pins[key];
                else pins[key] = { base: own(pins, key) ? pins[key].base : before.rows[agent].current[`order.${key}`], value: actual };
              }
            }
            if (Object.keys(changes).length || Object.keys(cleanSettings).length) this.store.update([agent], changes, cleanSettings);
            results[agent] = { ok: true };
          } catch (e) { results[agent] = { ok: false, error: e.message }; }
        }
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path + '.tmp', JSON.stringify(this.overlays, null, 2) + '\n');
        renameSync(this.path + '.tmp', this.path);
      } finally { for (const a of before.agents) this.saving.delete(a); }
      return { ...await this.snapshot(before.agents), ok: Object.values(results).every(r => r.ok), results };
    };
    const job = this.queue.then(run, run); this.queue = job.catch(() => {}); return job;
  }
}
