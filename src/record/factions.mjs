// DURABLE PER-UNIT FACTION GOALS.
//
// Like strategy assignments, these are live operational state and may identify local
// roster handles, so they live only under gitignored var/. Unlike a strategy checkbox,
// a faction goal has progress: queued -> acquiring -> complete, with the server's random
// quest assignment stored between DUM passes and process restarts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitise } from './memory.mjs';
import { FACTION_CATALOG, QUEST_LIMIT_MS, SOLDIER_STAGE_LIMIT_MS, factionId }
  from '../factions/catalog.mjs';

const STATUSES = new Set(['queued', 'acquiring', 'complete', 'cancelled']);
const SOLDIER_STATUSES = new Set(['queued', 'hunting', 'reporting', 'complete', 'cancelled']);

// Failed trips to a liege must not become a five-minute full-map commute forever. A
// queued unit farms between bounded retries; subsequent failures back off to four hours.
export const factionRequestRetryMs = attempts => Math.min(4 * 60 * 60_000,
  30 * 60_000 * (2 ** Math.max(0, Number(attempts) || 0)));

const errandFailure = (applied, fallback) => applied?.stopped ??
  (applied?.results ?? []).map(row => row?.result?.error ?? row?.result?.reason ?? row?.why)
    .find(Boolean) ?? fallback;

const cleanGoal = value => {
  if (!value || typeof value !== 'object') return null;
  let desired;
  try { desired = factionId(value.desired); } catch { return null; }
  const status = STATUSES.has(value.status) ? value.status : 'queued';
  return {
    desired, status,
    requested_at: Number(value.requested_at) || null,
    retry_after: Number(value.retry_after) || null,
    attempts: Math.max(0, Number(value.attempts) || 0),
    item: typeof value.item === 'string' ? value.item : null,
    target: typeof value.target === 'string' ? value.target : null,
    target_room: Number.isInteger(value.target_room) ? value.target_room : null,
    deadline_at: Number(value.deadline_at) || null,
    previous: value.previous && typeof value.previous === 'object' ? value.previous : null,
    completed_at: Number(value.completed_at) || null,
    last_error: typeof value.last_error === 'string' ? value.last_error : null,
  };
};

const cleanSoldierGoal = value => {
  if (!value || typeof value !== 'object') return null;
  let faction;
  try { faction = factionId(value.faction); } catch { return null; }
  return {
    faction, status: SOLDIER_STATUSES.has(value.status) ? value.status : 'queued',
    requested_at: Number(value.requested_at) || null,
    retry_after: Number(value.retry_after) || null,
    attempts: Math.max(0, Number(value.attempts) || 0),
    stage_index: Math.max(0, Number(value.stage_index) || 0),
    target: typeof value.target === 'string' ? value.target : null,
    rooms: Array.isArray(value.rooms) ? value.rooms.map(Number).filter(Number.isInteger) : [],
    room_index: Math.max(0, Number(value.room_index) || 0),
    deadline_at: Number(value.deadline_at) || null,
    previous: value.previous && typeof value.previous === 'object' ? value.previous : null,
    completed_at: Number(value.completed_at) || null,
    last_error: typeof value.last_error === 'string' ? value.last_error : null,
  };
};

export class FactionGoalStore {
  constructor({ dir = 'var/factions', fleet = null, enabled = true, now = () => Date.now() } = {}) {
    this.dir = resolve(dir);
    this.fleet = fleet ?? 'unnamed';
    this.enabled = enabled;
    this.now = now;
    this.path = join(this.dir, `${sanitise(this.fleet)}.json`);
    this.warned = false;
  }

  read() {
    if (!existsSync(this.path)) return { version: 2, agents: {}, soldiers: {} };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      return { version: 2, agents: Object.fromEntries(Object.entries(raw?.agents ?? {})
        .map(([agent, goal]) => [String(agent), cleanGoal(goal)]).filter(([, goal]) => goal)),
        soldiers: Object.fromEntries(Object.entries(raw?.soldiers ?? {})
          .map(([agent, goal]) => [String(agent), cleanSoldierGoal(goal)]).filter(([, goal]) => goal)) };
    } catch (error) {
      if (!this.warned) {
        process.stderr.write(`factions: ${this.path} did not parse (${error.message}) - using no goals\n`);
        this.warned = true;
      }
      return { version: 2, agents: {}, soldiers: {} };
    }
  }

  write(state) {
    if (!this.enabled) throw new Error('faction goal store is read-only');
    state.updated_at = this.now();
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
    renameSync(tmp, this.path);
  }

  snapshot(agents = []) {
    const state = this.read();
    return { version: 2, agents: Object.fromEntries(agents.filter(Boolean)
      .map(agent => [agent, state.agents?.[agent] ?? null])),
      soldiers: Object.fromEntries(agents.filter(Boolean)
        .map(agent => [agent, state.soldiers?.[agent] ?? null])),
      updated_at: state.updated_at ?? null };
  }

  states(agents = []) {
    const snapshot = this.snapshot(agents);
    const visible = Object.fromEntries(Object.entries(snapshot.agents)
      .map(([agent, goal]) => [agent, goal?.status === 'cancelled' ? null : goal]));
    const counts = Object.fromEntries(FACTION_CATALOG.map(faction => [faction.id,
      agents.filter(agent => visible[agent]?.desired === faction.id).length]));
    const soldiers = Object.fromEntries(Object.entries(snapshot.soldiers ?? {})
      .map(([agent, goal]) => [agent, goal?.status === 'cancelled' ? null : goal]));
    return { catalogue: FACTION_CATALOG, goals: visible, soldier_goals: soldiers,
      counts, selected: agents.length };
  }

  set(agents = [], desired = null) {
    if (!this.enabled) throw new Error('faction goal store is read-only');
    const who = [...new Set(agents.map(String).filter(Boolean))];
    if (!who.length) throw new Error('at least one selected unit is required');
    const faction = factionId(desired, { optional: true });
    const state = this.read();
    const now = this.now();
    for (const agent of who) {
      if (!faction) {
        const current = state.agents[agent];
        if (current) state.agents[agent] = cleanGoal({ ...current, status: 'cancelled',
          item: null, target: null, target_room: null, deadline_at: null,
          retry_after: null, last_error: null });
        else delete state.agents[agent];
      }
      else state.agents[agent] = cleanGoal({ desired: faction, status: 'queued',
        requested_at: now, attempts: 0 });
    }
    this.write(state);
    return this.states(who);
  }

  patch(agent, values = {}) {
    if (!this.enabled) throw new Error('faction goal store is read-only');
    const state = this.read();
    const current = state.agents?.[agent];
    if (!current) return null;
    const next = cleanGoal({ ...current, ...values });
    if (!next) return null;
    state.agents[agent] = next;
    this.write(state);
    return next;
  }

  setSoldier(agents = [], memberships = {}) {
    if (!this.enabled) throw new Error('faction goal store is read-only');
    const who = [...new Set(agents.map(String).filter(Boolean))];
    if (!who.length) throw new Error('at least one selected unit is required');
    const state = this.read(), now = this.now();
    state.soldiers ??= {};
    for (const agent of who) {
      const membership = memberships[agent];
      const faction = factionId(membership?.faction);
      state.soldiers[agent] = cleanSoldierGoal({ faction, status: 'queued',
        requested_at: now, attempts: 0 });
    }
    this.write(state);
    return this.states(who);
  }

  patchSoldier(agent, values = {}) {
    if (!this.enabled) throw new Error('faction goal store is read-only');
    const state = this.read(), current = state.soldiers?.[agent];
    if (!current) return null;
    const next = cleanSoldierGoal({ ...current, ...values });
    if (!next) return null;
    state.soldiers[agent] = next;
    this.write(state);
    return next;
  }

  recordErrand(applied, { at = this.now() } = {}) {
    if (!applied?.acted || !['faction-request', 'faction-offer', 'soldier-request',
      'soldier-hunt', 'soldier-report'].includes(applied.errand)) return null;
    if (applied.errand.startsWith('soldier-')) {
      const result = (applied.results ?? []).find(row => row.tool === 'faction_soldier')?.result ?? null;
      const current = this.read().soldiers?.[applied.agent];
      if (!current) return null;
      if (!result || result.faction !== current.faction) {
        const status = applied.errand === 'soldier-request' ? 'queued'
          : applied.errand === 'soldier-hunt' ? 'hunting' : 'reporting';
        return this.patchSoldier(applied.agent, { status,
          retry_after: at + (applied.errand === 'soldier-request'
            ? factionRequestRetryMs(current.attempts) : 5 * 60_000),
          attempts: current.attempts + (applied.errand === 'soldier-request' ? 1 : 0),
          last_error: errandFailure(applied, 'soldier errand stopped before the faction action') });
      }
      if (result.complete || result.soldier) return this.patchSoldier(applied.agent, {
        status: 'complete', completed_at: at, deadline_at: null, retry_after: null,
        last_error: null,
      });
      if (applied.errand === 'soldier-request') {
        if (result.assigned) return this.patchSoldier(applied.agent, {
          status: 'hunting', attempts: current.attempts + 1,
          stage_index: result.assigned.stage_index ?? 0, target: result.assigned.target,
          rooms: result.assigned.rooms ?? [], room_index: 0,
          deadline_at: at + SOLDIER_STAGE_LIMIT_MS, retry_after: null,
          previous: applied.context?.previous ?? current.previous, last_error: null,
        });
        return this.patchSoldier(applied.agent, { status: 'queued',
          retry_after: at + factionRequestRetryMs(current.attempts), attempts: current.attempts + 1,
          last_error: result.reason ?? result.note ?? 'the liege gave no soldier assignment' });
      }
      if (applied.errand === 'soldier-hunt') {
        if (result.killed) return this.patchSoldier(applied.agent, {
          status: 'reporting', retry_after: null, last_error: null,
        });
        const nextRoom = current.rooms.length ? (current.room_index + 1) % current.rooms.length : 0;
        return this.patchSoldier(applied.agent, { status: 'hunting', room_index: nextRoom,
          retry_after: at + 2 * 60_000,
          last_error: result.reason ?? 'the assigned faction troop was not found or defeated' });
      }
      if (result.assigned) return this.patchSoldier(applied.agent, {
        status: 'hunting', stage_index: result.assigned.stage_index ?? current.stage_index + 1,
        target: result.assigned.target, rooms: result.assigned.rooms ?? [], room_index: 0,
        deadline_at: at + SOLDIER_STAGE_LIMIT_MS, retry_after: null, last_error: null,
      });
      return this.patchSoldier(applied.agent, { status: 'reporting',
        retry_after: at + 5 * 60_000,
        last_error: result.reason ?? result.note ?? 'the liege did not acknowledge the soldier report' });
    }
    const result = (applied.results ?? []).find(row => row.tool === 'faction_join')?.result ?? null;
    const current = this.read().agents?.[applied.agent];
    if (!current) return null;
    if (!result || result.faction !== current.desired) {
      const requesting = applied.errand === 'faction-request';
      return this.patch(applied.agent, {
        status: requesting ? 'queued' : 'acquiring',
        retry_after: at + (requesting ? factionRequestRetryMs(current.attempts) : 5 * 60_000),
        attempts: current.attempts + (requesting ? 1 : 0),
        last_error: errandFailure(applied, 'faction errand stopped before the faction action'),
      });
    }
    if (applied.errand === 'faction-request') {
      if (result.assigned) return this.patch(applied.agent, {
        status: 'acquiring', attempts: current.attempts + 1,
        item: result.assigned.item, target: result.assigned.target,
        target_room: result.assigned.room, deadline_at: at + QUEST_LIMIT_MS,
        previous: applied.context?.previous ?? current.previous,
        retry_after: null, last_error: null,
      });
      return this.patch(applied.agent, { status: 'queued',
        retry_after: at + factionRequestRetryMs(current.attempts),
        attempts: current.attempts + 1,
        last_error: result.reason ?? result.note ?? 'the liege gave no join assignment' });
    }
    if (result.joined) return this.patch(applied.agent, {
      status: 'complete', completed_at: at, deadline_at: null, retry_after: null,
      last_error: null,
    });
    if (result.accepted === false) return this.patch(applied.agent, {
      status: 'acquiring', retry_after: at + 5 * 60_000,
      last_error: result.reason ?? result.note ?? 'the recipient did not take the quest item',
    });
    return this.patch(applied.agent, { status: 'queued', retry_after: at + 5 * 60_000,
      item: null, target: null, target_room: null, deadline_at: null,
      last_error: result.reason ?? result.note ?? 'the quest item left the pack without membership confirmation' });
  }
}
