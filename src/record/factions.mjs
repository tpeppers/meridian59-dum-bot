// DURABLE PER-UNIT FACTION GOALS.
//
// Like strategy assignments, these are live operational state and may identify local
// roster handles, so they live only under gitignored var/. Unlike a strategy checkbox,
// a faction goal has progress: queued -> acquiring -> complete, with the server's random
// quest assignment stored between DUM passes and process restarts.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitise } from './memory.mjs';
import { FACTION_CATALOG, QUEST_LIMIT_MS, SOLDIER_STAGE_LIMIT_MS, LOYALTY_LIMIT_MS, factionId }
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

// KEEPING A FACTION IS A THIRD KIND OF GOAL, AND ITS CLOCK IS THE SERVER'S, NOT OURS.
//
// A join goal is a standing wish an operator expressed, and so is a soldier goal. A
// LOYALTY goal is neither: it is created by something the SERVER said, it has a deadline
// nobody here chose, and it ends by itself whether or not anything is done about it.
//
// So it carries two clocks and they must not be collapsed into one. `due_at` is the
// four-hour grace that began with the warning — when the membership goes if nothing is
// done. `deadline_at` is the one-hour quest timer that begins with the liege's REPLY, and
// which is a shorter, harsher clock accepted deliberately in exchange for a chance. One
// field for both would lose the difference between "there is still time to start" and
// "the attempt in flight is running out", which are opposite instructions.
const LOYALTY_STATUSES = new Set(['owed', 'acquiring', 'serving', 'complete', 'failed', 'cancelled']);

const cleanLoyaltyGoal = value => {
  if (!value || typeof value !== 'object') return null;
  let faction;
  try { faction = factionId(value.faction); } catch { return null; }
  return {
    faction, status: LOYALTY_STATUSES.has(value.status) ? value.status : 'owed',
    warned_at: Number(value.warned_at) || null,
    due_at: Number(value.due_at) || null,
    deadline_at: Number(value.deadline_at) || null,
    retry_after: Number(value.retry_after) || null,
    attempts: Math.max(0, Number(value.attempts) || 0),
    item: typeof value.item === 'string' ? value.item : null,
    target: typeof value.target === 'string' ? value.target : null,
    target_room: Number.isInteger(value.target_room) ? value.target_room : null,
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
    if (!existsSync(this.path)) return { version: 2, agents: {}, soldiers: {}, loyalty: {} };
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'));
      return { version: 2, agents: Object.fromEntries(Object.entries(raw?.agents ?? {})
        .map(([agent, goal]) => [String(agent), cleanGoal(goal)]).filter(([, goal]) => goal)),
        soldiers: Object.fromEntries(Object.entries(raw?.soldiers ?? {})
          .map(([agent, goal]) => [String(agent), cleanSoldierGoal(goal)]).filter(([, goal]) => goal)),
        loyalty: Object.fromEntries(Object.entries(raw?.loyalty ?? {})
          .map(([agent, goal]) => [String(agent), cleanLoyaltyGoal(goal)]).filter(([, goal]) => goal)) };
    } catch (error) {
      if (!this.warned) {
        process.stderr.write(`factions: ${this.path} did not parse (${error.message}) - using no goals\n`);
        this.warned = true;
      }
      return { version: 2, agents: {}, soldiers: {}, loyalty: {} };
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
      loyalty: Object.fromEntries(agents.filter(Boolean)
        .map(agent => [agent, state.loyalty?.[agent] ?? null])),
      updated_at: state.updated_at ?? null };
  }

  /**
   * Open, refresh or close a loyalty goal from what the harness observed.
   *
   * THE SERVER OPENS THIS GOAL, NOT AN OPERATOR — so unlike `set`, this is driven by the
   * debt on the board rather than by a selection. A debt that goes away (served, or the
   * membership lost) closes the goal; a debt that persists refreshes the deadline it was
   * given without disturbing an attempt already in flight.
   */
  syncLoyalty(agent, debt, { at = this.now() } = {}) {
    if (!this.enabled) throw new Error('faction goal store is read-only');
    const state = this.read();
    state.loyalty ??= {};
    const current = state.loyalty[agent] ?? null;

    if (!debt) {
      // No debt and an attempt that had reached the liege means it worked. An attempt
      // that never got that far is just closed — but 'complete' is reserved for the
      // former, because a board that reports a success nobody watched is worse than one
      // that reports nothing.
      if (!current) return null;
      // A goal that already reached a terminal state keeps it. `complete` and `failed`
      // are the two records worth having — one says the service was watched succeeding,
      // the other that the membership was revoked — and overwriting either with the
      // generic `cancelled` on the next tick would erase exactly the outcome.
      if (['complete', 'failed', 'cancelled'].includes(current.status)) return current;
      state.loyalty[agent] = cleanLoyaltyGoal({ ...current,
        status: current.status === 'serving' ? 'complete' : 'cancelled',
        completed_at: at, deadline_at: null, retry_after: null });
      this.write(state);
      return state.loyalty[agent];
    }

    // A SOLDIER'S WARNING NEVER BECOMES A DEADLINE, so it is not work. Recorded as owed
    // with no `due_at` so an operator can still see it, and every rule skips it.
    const next = cleanLoyaltyGoal(current
      ? { ...current, due_at: debt.due_at ?? null, warned_at: debt.warned_at ?? current.warned_at }
      : { faction: debt.faction, status: 'owed', warned_at: debt.warned_at ?? at,
          due_at: debt.due_at ?? null, attempts: 0 });
    if (!next) return null;
    state.loyalty[agent] = next;
    this.write(state);
    return next;
  }

  patchLoyalty(agent, values = {}) {
    if (!this.enabled) throw new Error('faction goal store is read-only');
    const state = this.read(), current = state.loyalty?.[agent];
    if (!current) return null;
    const next = cleanLoyaltyGoal({ ...current, ...values });
    if (!next) return null;
    state.loyalty[agent] = next;
    this.write(state);
    return next;
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

  /**
   * What a loyalty errand achieved, read off the harness's answer rather than off the
   * fact that a call was made.
   *
   * EVERY REFUSAL HERE IS A SENTENCE OR A SILENCE, NEVER AN ERROR — the merchant that had
   * none, the liege who was too far to hear, the offer the NPC did not take. So each
   * branch keys on the field the harness set by MEASURING (`bought` from the pack,
   * `assigned` from the parsed reply, `served` from the confirmation) and treats a call
   * that merely completed as a failure with a reason.
   */
  recordLoyaltyErrand(applied, { at = this.now() } = {}) {
    const current = this.read().loyalty?.[applied.agent];
    if (!current) return null;
    const result = (applied.results ?? []).find(row => row.tool === 'faction_loyalty')?.result ?? null;
    const failed = reason => this.patchLoyalty(applied.agent, { status: 'owed',
      attempts: current.attempts + 1, retry_after: at + 5 * 60_000,
      last_error: reason ?? errandFailure(applied, 'the loyalty errand stopped before the liege') });

    if (!result) return failed(null);

    if (applied.errand === 'loyalty-acquire')
      return result.bought
        ? this.patchLoyalty(applied.agent, { status: 'owed', retry_after: null, last_error: null })
        : failed(result.reason ?? result.note ?? 'nothing was bought');

    if (applied.errand === 'loyalty-request') {
      if (!result.assigned) return failed(result.reason ?? result.note ??
        'the word was spoken and no assignment came back');
      // THE ONE-HOUR CLOCK STARTS HERE, and it is a different clock from the four-hour
      // grace this goal was opened with. Both are kept.
      return this.patchLoyalty(applied.agent, { status: 'serving',
        attempts: current.attempts + 1, item: result.assigned.item,
        target: result.assigned.target, target_room: result.assigned.room,
        deadline_at: at + (result.assigned.time_limit_ms ?? LOYALTY_LIMIT_MS),
        retry_after: null, last_error: null,
        previous: applied.context?.previous ?? current.previous });
    }

    if (applied.errand === 'loyalty-offer') {
      if (result.served) return this.patchLoyalty(applied.agent, { status: 'complete',
        completed_at: at, deadline_at: null, retry_after: null, last_error: null });
      // A REVOKED MEMBERSHIP IS TERMINAL AND MUST NOT BE RETRIED. The quest node is gone,
      // the character is neutral, and another trip to the liege would ask a stranger for
      // work. `failed` is a resting state, not a backoff.
      if (result.failed) return this.patchLoyalty(applied.agent, { status: 'failed',
        completed_at: at, deadline_at: null, retry_after: null,
        last_error: 'the liege revoked the membership' });
      return failed(result.reason ?? result.note ?? 'the offer was not accepted');
    }

    return null;
  }

  recordErrand(applied, { at = this.now() } = {}) {
    if (!applied?.acted) return null;
    if (applied.errand?.startsWith('loyalty-')) return this.recordLoyaltyErrand(applied, { at });
    if (!['faction-request', 'faction-offer', 'soldier-request',
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
