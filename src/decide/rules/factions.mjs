// JOINING A FACTION IS A DURABLE GOAL, NOT A BUTTON-SHAPED MACRO.
//
// The server chooses the quest only after the liege hears "join", and the player then
// has one hour to finish it. The control plane therefore stores progress outside this
// pure rule. This file only turns the current observation + stored goal into the next
// bounded action: request, acquire, or offer.

import { NATURAL_TOWN_WAIT_MS, acquisitionSource, factionDefinition }
  from '../../factions/catalog.mjs';

const itemName = item => String(item?.name ?? '').trim().toLowerCase();

const previousOrders = row => {
  const policy = row.policy ?? {};
  return {
    mode: row.mode ?? 'farm',
    hunt: policy.hunt ?? row.hunting ?? null,
    assigned_room: policy.assignedRoom ?? row.assigned_room ?? null,
    purpose: policy.purpose ?? null,
    roam: policy.roam ?? null,
    max_threat_over: policy.maxThreatOver ?? null,
    protect_items: policy.protectedItems ?? [],
  };
};

const restoreStep = (agent, previous, why) => ({
  tool: 'autopilot',
  args: { agent, action: 'start', ...previous },
  allow_null: true,
  always: true,
  why,
});

const goalRows = observation => (observation.characters ?? []).flatMap(row => {
  const goal = observation.factions?.agents?.[row.agent];
  return goal && !['complete', 'cancelled'].includes(goal.status) ? [{ row, goal }] : [];
});

const soldierRows = observation => (observation.characters ?? []).flatMap(row => {
  const goal = observation.factions?.soldiers?.[row.agent];
  return goal && !['complete', 'cancelled'].includes(goal.status) ? [{ row, goal }] : [];
});

// A faction acquisition temporarily owns the unit's quarry and room; soldier service
// owns them while hunting and reporting. Standing fleet maintenance must leave those
// policies alone or the character is sent back and forth between its ordinary farm and
// the quest destination on successive fleet/character ticks.
export function activeFactionWork(observation, rowOrAgent) {
  const agent = typeof rowOrAgent === 'string' ? rowOrAgent : rowOrAgent?.agent;
  if (!agent) return false;
  const join = observation.factions?.agents?.[agent];
  const soldier = observation.factions?.soldiers?.[agent];
  const stillTimed = goal => !goal?.deadline_at || !observation.at || observation.at < goal.deadline_at;
  return (join?.status === 'acquiring' && stillTimed(join)) ||
    (['hunting', 'reporting'].includes(soldier?.status) && stillTimed(soldier));
}

export const factionFleetRules = [
  {
    id: 'report-soldier-service', faculty: 'work', scope: 'fleet',
    why: 'a promoted candidate has defeated the assigned opposing troop and must report to the liege',
    decide(observation) {
      for (const { row, goal } of soldierRows(observation)) {
        if (goal.status !== 'reporting' || (goal.retry_after && observation.at < goal.retry_after)) continue;
        if (row.commitment || row.parked || row.piloted) continue;
        const faction = factionDefinition(goal.faction), previous = goal.previous ?? previousOrders(row);
        return { kind: 'errand', orders: { errand: 'soldier-report', agent: row.agent,
          label: `report soldier service to ${faction.leader}`, context: { previous }, steps: [
            { tool: 'travel', args: { agent: row.agent, to: faction.room }, timeout_ms: 300_000,
              estimate_ms: 150_000, expect: 'arrived', why: `return to ${faction.leader}` },
            { tool: 'faction_soldier', args: { agent: row.agent, action: 'report', faction: goal.faction },
              collect: 'messages', estimate_ms: 10_000, why: 'report the completed troop assignment' },
            restoreStep(row.agent, previous, 'restore the work interrupted by soldier service'),
          ] }, why: `report the defeat of ${goal.target} to ${faction.leader}`,
          evidence: { agent: row.agent, faction: goal.faction, target: goal.target } };
      }
      return null;
    },
  },
  {
    id: 'hunt-soldier-target', faculty: 'work', scope: 'fleet',
    why: 'a soldier candidate has a source-assigned opposing faction troop to defeat',
    decide(observation) {
      for (const { row, goal } of soldierRows(observation)) {
        if (goal.status !== 'hunting' || !goal.target || !goal.rooms?.length) continue;
        if (goal.deadline_at && observation.at >= goal.deadline_at) continue;
        if (goal.retry_after && observation.at < goal.retry_after) continue;
        if (row.commitment || row.parked || row.piloted || row.health?.pct < 0.8) continue;
        const room = goal.rooms[goal.room_index % goal.rooms.length];
        return { kind: 'errand', orders: { errand: 'soldier-hunt', agent: row.agent,
          label: `soldier trial: ${goal.target}`, steps: [
            { tool: 'travel', args: { agent: row.agent, to: room }, timeout_ms: 300_000,
              estimate_ms: 150_000, expect: 'arrived', why: `patrol faction flag room ${room}` },
            { tool: 'faction_soldier', args: { agent: row.agent, action: 'hunt',
                faction: goal.faction, target: goal.target }, estimate_ms: 150_000,
              why: `fight only the exact assigned ${goal.target}` },
          ] }, why: `patrol room ${room} for ${goal.target}`,
          evidence: { agent: row.agent, faction: goal.faction, target: goal.target,
            room, deadline_at: goal.deadline_at } };
      }
      return null;
    },
  },
  {
    id: 'request-soldier-service', faculty: 'work', scope: 'fleet',
    why: 'an eligible faction member has a durable order to become a soldier',
    decide(observation) {
      for (const { row, goal } of soldierRows(observation)) {
        const expired = goal.deadline_at && observation.at >= goal.deadline_at;
        if (goal.status !== 'queued' && !expired) continue;
        if (goal.retry_after && observation.at < goal.retry_after) continue;
        if (row.commitment || row.parked || row.piloted || row.health?.pct < 0.8 || (row.level ?? 0) < 75) continue;
        const faction = factionDefinition(goal.faction), previous = goal.previous ?? previousOrders(row);
        return { kind: 'errand', orders: { errand: 'soldier-request', agent: row.agent,
          label: `ask ${faction.leader} for soldier service`, context: { previous }, steps: [
            { tool: 'travel', args: { agent: row.agent, to: faction.room }, timeout_ms: 300_000,
              estimate_ms: 150_000, expect: 'arrived', why: `go to ${faction.leader}` },
            { tool: 'faction_soldier', args: { agent: row.agent, action: 'request', faction: goal.faction },
              collect: 'messages', estimate_ms: 10_000,
              why: 'say exactly "I want to be a soldier." and record the assigned troop' },
          ] }, why: expired ? 'the three-hour soldier stage expired; request a fresh trial'
            : `ask ${faction.leader} to become a soldier`,
          evidence: { agent: row.agent, faction: goal.faction, level: row.level } };
      }
      return null;
    },
  },
  {
    id: 'complete-faction-join',
    // This is quest work, not conversation: the text is fixed in the harness primitive,
    // no reply is composed, and general say remains outside DUM's surface.
    faculty: 'work',
    scope: 'fleet',
    why: 'a selected unit is carrying the exact item its faction join quest requested',
    decide(observation) {
      for (const { row, goal } of goalRows(observation)) {
        if (goal.status !== 'acquiring' || !goal.item || !goal.target || !goal.target_room) continue;
        if (goal.deadline_at && observation.at >= goal.deadline_at) continue;
        if (goal.retry_after && observation.at < goal.retry_after) continue;
        if (row.commitment || row.parked || row.piloted) continue;
        const item = (row.items ?? []).find(candidate => itemName(candidate) === goal.item.toLowerCase());
        if (!item) continue;
        const previous = goal.previous ?? previousOrders(row);
        return {
          kind: 'errand',
          orders: {
            errand: 'faction-offer', agent: row.agent,
            label: `join ${factionDefinition(goal.desired).title}`,
            context: { faction: goal.desired, previous },
            steps: [
              { tool: 'travel', args: { agent: row.agent, to: goal.target_room },
                timeout_ms: 300_000, estimate_ms: 150_000, expect: 'arrived',
                why: `take ${goal.item} to ${goal.target}` },
              { tool: 'faction_join', args: { agent: row.agent, action: 'offer',
                  faction: goal.desired, item: item.id, target: goal.target },
                collect: 'messages', estimate_ms: 10_000,
                why: `offer the assigned ${goal.item} to ${goal.target}` },
              restoreStep(row.agent, { ...previous,
                protect_items: [...new Set([...(previous.protect_items ?? []), goal.item])] },
                'the faction errand is finished; restore the orders it interrupted'),
            ],
          },
          why: `offer ${goal.item} to ${goal.target}, then restore the unit's previous work`,
          evidence: { agent: row.agent, desired: goal.desired, item: goal.item,
            target: goal.target, deadline_at: goal.deadline_at },
        };
      }
      return null;
    },
  },
  {
    id: 'request-faction-join',
    faculty: 'work',
    scope: 'fleet',
    why: 'a selected unit has reached a natural break in its work and may ask its chosen liege to join',
    decide(observation) {
      const now = observation.at;
      const waiting = [];
      for (const { row, goal } of goalRows(observation)) {
        const expired = goal.status === 'acquiring' && goal.deadline_at && now >= goal.deadline_at;
        if (goal.status !== 'queued' && !expired) continue;
        if (goal.retry_after && now < goal.retry_after) continue;
        if (row.commitment || row.parked || row.piloted || row.health?.pct < 0.8) continue;
        // The source's ordinary eligibility path is base max health >= 40. A level-five
        // spell at 40% also qualifies, but that paid ability read is left to the server:
        // under-40 units wait instead of being walked across the world on a guess.
        if ((row.level ?? 0) < 40) continue;
        const servicedAfterOrder = (row.town_service_at ?? 0) >= (goal.requested_at ?? now);
        const naturallyFree = row.mode !== 'farm';
        const waitedLongEnough = now - (goal.requested_at ?? now) >= NATURAL_TOWN_WAIT_MS;
        if (!servicedAfterOrder && !naturallyFree && !waitedLongEnough) {
          waiting.push(row.agent);
          continue;
        }
        const faction = factionDefinition(goal.desired);
        const previous = goal.previous ?? previousOrders(row);
        return {
          kind: 'errand',
          orders: {
            errand: 'faction-request', agent: row.agent,
            label: `ask ${faction.leader} to join`,
            context: { faction: goal.desired, previous },
            steps: [
              { tool: 'travel', args: { agent: row.agent, to: faction.room },
                timeout_ms: 300_000, estimate_ms: 150_000, expect: 'arrived',
                why: `go to ${faction.leader}` },
              { tool: 'faction_join', args: { agent: row.agent, action: 'request',
                  faction: goal.desired }, collect: 'messages', estimate_ms: 10_000,
                why: 'say the fixed join phrase and record the exact assigned quest' },
            ],
          },
          why: expired
            ? `the one-hour ${faction.title} assignment expired; request a fresh one`
            : servicedAfterOrder
            ? `the keeper completed its sell/bank town loop; now ask ${faction.leader} to join`
            : `the faction order has waited for a work boundary; now ask ${faction.leader} to join`,
          evidence: { agent: row.agent, desired: goal.desired,
            requested_at: goal.requested_at, town_service_at: row.town_service_at ?? null,
            waited_ms: now - (goal.requested_at ?? now) },
        };
      }
      return waiting.length ? { kind: 'pass',
        why: `${waiting.length} faction goal(s) are waiting for the next completed town service` } : null;
    },
  },
];

export const factionCharacterRules = [{
  id: 'release-faction-cargo-protection',
  faculty: 'work',
  why: 'a completed or cancelled faction goal no longer needs its temporary cargo protection',
  decide(observation) {
    const goal = observation.factions?.agents?.[observation.agent];
    if (!goal || !['complete', 'cancelled'].includes(goal.status)) return null;
    const wanted = goal.previous?.protect_items ?? [];
    const live = observation.policy?.protectedItems ?? [];
    if (live.length === wanted.length && live.every((value, index) => value === wanted[index])) return null;
    return { kind: 'orders', orders: { action: 'start', protect_items: wanted },
      why: `release temporary cargo protection after the faction goal was ${goal.status}` };
  },
}, {
  id: 'acquire-faction-item',
  faculty: 'work',
  why: 'the unit has an active one-hour faction quest and must acquire its exact requested item',
  decide(observation, doctrine) {
    const goal = observation.factions?.agents?.[observation.agent];
    if (!goal || goal.status !== 'acquiring' || !goal.item) return null;
    // An expired server quest no longer owns the character's quarry. The fleet request
    // rule will obtain a fresh assignment; until then ordinary doctrine may farm rather
    // than hunting cargo the recipient can no longer accept.
    if (goal.deadline_at && observation.at && observation.at >= goal.deadline_at) return null;
    if ((observation.items ?? []).some(item => itemName(item) === goal.item.toLowerCase())) return null;
    // Princess supplies the letter herself. If it is missing, another hunt cannot
    // recreate it; let the offer fail visibly and the durable goal request a new quest.
    if (goal.item.toLowerCase() === 'letter') return { kind: 'pass',
      why: 'the Princess-issued letter is no longer in the pack; wait for this attempt to be retried' };
    const allowance = observation.policy?.maxThreatOver ?? doctrine.prey?.max_threat_over ?? 6;
    const source = acquisitionSource(goal.item, observation.level, allowance);
    if (!source) return { kind: 'pass',
      why: `no known ${goal.item} source is within ${allowance} levels of this unit; ` +
           'the durable goal will remain while the unit grows or receives the item' };
    const policy = observation.policy ?? {};
    const cargoProtected = (policy.protectedItems ?? [])
      .some(name => String(name).toLowerCase() === goal.item.toLowerCase());
    if (observation.mode === 'farm' && policy.hunt === source.hunt &&
        policy.assignedRoom === source.room && policy.purpose === 'faction-quest' &&
        cargoProtected) return null;
    return {
      kind: 'orders',
      orders: { action: 'start', mode: 'farm', hunt: source.hunt,
        assigned_room: source.room, purpose: 'faction-quest', roam: false,
        max_threat_over: Math.max(Number(allowance) || 0, source.level - (observation.level ?? 0)),
        protect_items: [...new Set([...(policy.protectedItems ?? []), goal.item])] },
      why: `hunt ${source.hunt} in room ${source.room} for ${goal.item} ` +
           `(${source.chance}% per treasure roll), then take it to ${goal.target}`,
      evidence: { desired: goal.desired, item: goal.item, deadline_at: goal.deadline_at,
        source },
    };
  },
}];

// Keep perishable in-progress work ahead of maintenance, while a new request waits until
// the ordinary farm baseline exists. This distinction prevents a stopped/rejoined unit
// from preserving `mode: waiting` as the work to restore after a long faction errand.
const REQUEST_RULE_IDS = new Set(['request-soldier-service', 'request-faction-join']);
export const factionActiveFleetRules = factionFleetRules.filter(rule => !REQUEST_RULE_IDS.has(rule.id));
export const factionRequestFleetRules = factionFleetRules.filter(rule => REQUEST_RULE_IDS.has(rule.id));

export { previousOrders };
