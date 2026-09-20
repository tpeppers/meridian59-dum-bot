// Pure filtering happens BEFORE first-match wins, as well as at dispatch.
// Otherwise a pinned threshold would keep a maintenance rule winning forever.
const meta = new Set(['agent', 'action', 'why', 'batch']);
const norm = k => k.replaceAll('_', '').toLowerCase();
export function humanIntent(intent, obs) {
  const controls = obs.human_controls ?? {};
  const agents = new Set([intent.agent, intent.orders?.agent,
    ...(intent.orders?.batch ?? []).map(o => o.agent),
    ...(intent.plan ?? []).flatMap(s => [s.agent, s.args?.agent, s.from, s.to])].filter(a => typeof a === 'string'));
  if (['errand', 'act'].includes(intent.kind) && [...agents].some(a => controls[a]?.confine_rooms?.length)) return null;
  if (intent.kind !== 'orders' || intent.plan) return intent;
  const clean = (orders, agent) => {
    const pins = controls[agent] ?? {};
    if (!Object.keys(pins).length) return orders;
    const row = obs.agent === agent ? obs : (obs.characters ?? []).find(r => r.agent === agent);
    const policy = row?.keeper?.policy;
    const values = policy ? Object.fromEntries(Object.entries(policy).map(([k, v]) => [norm(k), v])) : null;
    const out = Object.fromEntries(Object.entries(orders).filter(([k, v]) => meta.has(k) ||
      (!Object.hasOwn(pins, k) && (!values || JSON.stringify(values[norm(k)]) !== JSON.stringify(v)))));
    return Object.keys(out).some(k => !meta.has(k)) ? out : null;
  };
  if (intent.orders?.batch) {
    const batch = intent.orders.batch.map(o => clean(o, o.agent)).filter(Boolean);
    return batch.length ? { ...intent, orders: { ...intent.orders, batch } } : null;
  }
  const orders = clean(intent.orders ?? {}, intent.agent);
  return orders ? { ...intent, orders } : null;
}
