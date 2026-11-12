// THE SUPERVISOR GATE: A STATION OR RUNG WHOSE ORDERS NEED A PROCESS THAT IS NOT RUNNING.
//
// Pure. The supervisors' states arrive on the observation (`obs.supervisors`, a by-id map
// written by the tick from src/supervise/registry.mjs), exactly as the clock and the memory
// do, so a withheld station is reproducible from its journal line alone.
//
// Only a `must` dependency withholds. A `must` that is `running` or `started` lets the
// orders through — `started` because the supervisor was just launched and its first
// heartbeat is seconds away, and withholding through that gap would make every restart of
// DUM stall the stations for a pass for no reason. An `optional` one never withholds; its
// absence is a throttled warning and nothing else.
//
// UNKNOWN IS NOT DOWN, EXCEPT FOR A `must`. With no supervisor observation at all (a test
// fixture, a plan run that did not check), a `must` dependency is treated as down: sending
// a singer's audience to a room nobody is singing in is exactly the failure this exists to
// prevent, and an unread state must not be the way past it.

const UP = new Set(['running', 'started']);

/**
 * @param {string[]|undefined} requires   ids from `requires_supervisors`
 * @param {object|null} supervisors       obs.supervisors — {id: {state, need, why}}
 * @param {object} doctrine
 * @returns {{ok: boolean, down: string[], why: string|null}}
 */
export function supervisorGate(requires, supervisors, doctrine = {}) {
  const ids = [].concat(requires ?? []).filter(Boolean);
  if (!ids.length) return { ok: true, down: [], why: null };
  const declared = doctrine.supervisors ?? {};
  const down = [];
  const whys = [];
  for (const id of ids) {
    const need = declared[id]?.need === 'must' ? 'must' : 'optional';
    if (need !== 'must') continue;
    const s = supervisors?.[id] ?? null;
    if (s && UP.has(s.state)) continue;
    down.push(id);
    whys.push(`${id} is ${s?.state ?? 'unchecked'}${s?.why ? ` (${s.why})` : ''}`);
  }
  return down.length
    ? { ok: false, down, why: `supervisor_withheld: ${whys.join('; ')}` }
    : { ok: true, down: [], why: null };
}

/**
 * Every station and rung the current supervisor states withhold, for the journal.
 * @returns {Array<{where: string, down: string[], why: string}>}
 */
export function withheldTargets(doctrine = {}, supervisors = null) {
  const out = [];
  (doctrine.shift?.stations ?? []).forEach((st, i) => {
    const g = supervisorGate(st?.requires_supervisors, supervisors, doctrine);
    if (!g.ok) out.push({ where: `shift.stations[${i}]`, room: st?.room ?? null, down: g.down, why: g.why });
  });
  (doctrine.goals?.ladder ?? []).forEach((rung, i) => {
    const g = supervisorGate(rung?.requires_supervisors, supervisors, doctrine);
    if (!g.ok) out.push({ where: `goals.ladder[${i}]`, rung: rung?.id ?? null, down: g.down, why: g.why });
  });
  return out;
}
