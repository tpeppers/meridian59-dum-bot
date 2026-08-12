// LOOPBACK-ONLY CONTROL PLANE FOR THE STRATEGY-GAME WEBSITE.
//
// The browser application never edits doctrine files and never imports this repository.
// It asks the DUM process that is actually directing the fleet. That keeps assignments
// hot-swappable, makes the catalogue self-describing, and fails closed when DUM is down.

import { createServer } from 'node:http';
import { STRATEGY_CATALOG, STRATEGY_IDS } from '../strategies/catalog.mjs';

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
};

const loopback = address => !address || address === '127.0.0.1' || address === '::1' ||
  address === '::ffff:127.0.0.1';

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('request body is too large');
  }
  return raw ? JSON.parse(raw) : {};
}

export class StrategyControlServer {
  constructor({ store, factions = null, journal = null, detailStats = null, resolveItems = null,
                resolveFactionStatuses = null,
                url = 'http://127.0.0.1:8916' }) {
    this.store = store;
    this.factions = factions;
    this.journal = journal;
    this.detailStats = detailStats;
    this.resolveItems = resolveItems;
    this.resolveFactionStatuses = resolveFactionStatuses;
    this.url = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname))
      throw new Error('strategy control must bind to loopback');
    this.server = null;
  }

  async start() {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      try {
        if (!loopback(req.socket.remoteAddress)) return json(res, 403, { error: 'loopback only' });
        const u = new URL(req.url ?? '/', this.url);
        if (u.pathname === '/health' && req.method === 'GET')
          return json(res, 200, { ok: true, fleet: this.store.fleet });
        if (u.pathname === '/observability' && req.method === 'GET') {
          const hours = Number(u.searchParams.get('hours') ?? 2);
          return json(res, 200, { fleet: this.store.fleet,
            metrics: this.journal?.observability?.() ?? null,
            details: this.detailStats?.report?.({ hours }) ?? null });
        }
        if (u.pathname === '/factions') {
          if (!this.factions) return json(res, 503, { error: 'faction goals are unavailable' });
          if (req.method === 'GET') {
            const agents = (u.searchParams.get('agents') ?? '').split(',')
              .map(s => s.trim()).filter(Boolean);
            const memberships = typeof this.resolveFactionStatuses === 'function'
              ? await this.resolveFactionStatuses(agents) : {};
            return json(res, 200, { ...this.factions.states(agents), memberships });
          }
          if (req.method === 'POST') {
            const body = await bodyOf(req);
            if (body.action === 'soldier') {
              if (typeof this.resolveFactionStatuses !== 'function')
                throw new Error('live faction membership lookup is unavailable');
              const agents = [...new Set((body.agents ?? []).map(String).filter(Boolean))];
              const memberships = await this.resolveFactionStatuses(agents);
              for (const agent of agents) {
                const status = memberships[agent];
                if (!['duke', 'princess', 'rebel'].includes(status?.faction))
                  throw new Error(`${agent} is not an observed member of a faction`);
                if ((status?.max_health ?? 0) < 75)
                  throw new Error(`${agent} needs at least 75 maximum health to become a soldier`);
                if (status?.soldier) throw new Error(`${agent} is already a faction soldier`);
              }
              return json(res, 200, { ok: true,
                ...this.factions.setSoldier(agents, memberships), memberships });
            }
            return json(res, 200, { ok: true,
              ...this.factions.set(body.agents, body.faction ?? null) });
          }
          return json(res, 405, { error: 'method not allowed' });
        }
        if (u.pathname !== '/strategies') return json(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const agents = (u.searchParams.get('agents') ?? '').split(',').map(s => s.trim()).filter(Boolean);
          const { states } = this.store.states(agents);
          return json(res, 200, { catalogue: STRATEGY_CATALOG, states, selected: agents.length });
        }
        if (req.method === 'POST') {
          const body = await bodyOf(req);
          const settings = await canonicalItemSettings(body.settings ?? {}, this.resolveItems);
          const { states } = this.store.update(body.agents, body.changes ?? {}, settings);
          return json(res, 200, { ok: true, catalogue: STRATEGY_CATALOG, states,
            selected: body.agents.length });
        }
        return json(res, 405, { error: 'method not allowed' });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
    await new Promise((resolveStart, reject) => {
      this.server.once('error', reject);
      this.server.listen(Number(this.url.port || 80), this.url.hostname.replace(/^\[|\]$/g, ''), resolveStart);
    });
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise(resolveStop => server.close(resolveStop));
  }
}

// Item identity belongs to the harness's generated datastore. Resolve this setting at
// the HTTP boundary before the synchronous strategy store writes anything, so an
// unknown or ambiguous name rejects the whole save rather than becoming a broken live
// policy that DUM retries on every pass.
export async function canonicalItemSettings(settings = {}, resolveItems = null) {
  const id = STRATEGY_IDS.ACCUMULATE_IN_VAULT;
  const values = settings?.[id];
  if (!values || !Object.hasOwn(values, 'items')) return settings;
  if (typeof resolveItems !== 'function')
    throw new Error('the local item resolver is unavailable; collection settings were not saved');
  const answer = await resolveItems(values.items);
  const items = Array.isArray(answer) ? answer : answer?.items;
  if (!Array.isArray(items)) throw new Error('the local item resolver returned no item list');
  return { ...settings, [id]: { ...values, items } };
}
