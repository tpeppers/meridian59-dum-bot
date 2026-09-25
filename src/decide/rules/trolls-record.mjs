// The Ukgoth courier's memory writer, on its own and importing NOTHING, because
// src/act/errands.mjs indexes every errand's recorder and importing rules/trolls.mjs from there
// closes a cycle (trolls -> factions -> ... -> config/schema -> act/orders) that leaves
// ORDER_FIELDS uninitialised at load. Pure.

/** What the courier errand leaves behind: when it last ran, so it cannot fire every pass. */
export function recordTrollCourier({ agent, at, stopped }) {
  const ok = !stopped;
  return { patch: { courier_last_at: at, courier_ok: ok, courier_by: agent },
           read: { ran: true, ok, agent, at, stopped: stopped ?? null } };
}
