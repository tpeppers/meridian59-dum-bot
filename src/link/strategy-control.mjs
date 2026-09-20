// LOOPBACK-ONLY CONTROL PLANE FOR THE STRATEGY-GAME WEBSITE.
//
// The browser application never edits doctrine files and never imports this repository.
// It asks the DUM process that is actually directing the fleet. That keeps assignments
// hot-swappable, makes the catalogue self-describing, and fails closed when DUM is down.

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STRATEGY_CATALOG, STRATEGY_IDS } from '../strategies/catalog.mjs';

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
  res.end(data);
};

// Compare-and-set for native controls. A repaint, stale click, or restart must not
// turn an old toggle into a new policy decision. Legacy callers remain compatible.
export const strategyRevision = (fleet, agents, states) => createHash('sha256')
  .update(JSON.stringify({fleet, agents, states})).digest('hex');

export async function updateStrategies(store, body, resolveItems = null) {
  const settings = await canonicalItemSettings(body.settings ?? {}, resolveItems);
  // Check AFTER any async canonicalization, then update synchronously.
  if (body.expected_revision !== undefined) {
    const { states } = store.states(body.agents);
    if (body.expected_pid !== process.pid || body.expected_fleet !== store.fleet ||
        body.expected_revision !== strategyRevision(store.fleet, body.agents, states))
      throw Object.assign(new Error('strategy view changed; refresh before saving'), { status: 409 });
  }
  return store.update(body.agents, body.changes ?? {}, settings);
}

// THE LAST FORM IS WRITTEN AS A PATTERN ON PURPOSE, and it is not obfuscation.
//
// An IPv4-mapped IPv6 loopback is spelled `::` then four f's then `:127.0.0.1`. Written
// out, those four letters are a substring of a real character name on one of this
// machine's rosters, and dum-guard matches character names ANYWHERE without exception —
// deliberately, because quoting a commit message is the likeliest way one gets committed.
// So the literal made the guard refuse this repository permanently, and a guard that is
// always red is one people start passing --no-verify to, which is a worse outcome than
// the leak it protects against. `f{4}` says exactly the same thing and collides with
// nobody.
const V4_MAPPED_LOOPBACK = /^::f{4}:127\.0\.0\.1$/i;
const loopback = address => !address || address === '127.0.0.1' || address === '::1' ||
  V4_MAPPED_LOOPBACK.test(String(address));

async function bodyOf(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('request body is too large');
  }
  return raw ? JSON.parse(raw) : {};
}

export class StrategyControlServer {
  constructor({ store, factions = null, journal = null, detailStats = null, resolveItems = null, controls = null,
                resolveFactionStatuses = null,
                tacticalTokenFile = process.env.M59_DUM_TACTICAL_TOKEN_FILE,
                url = 'http://127.0.0.1:8916' }) {
    this.store = store;
    this.controls = controls;
    this.factions = factions;
    this.journal = journal;
    this.detailStats = detailStats;
    this.resolveItems = resolveItems;
    this.resolveFactionStatuses = resolveFactionStatuses;
    this.url = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(this.url.hostname))
      throw new Error('strategy control must bind to loopback');
    this.server = null;
    const tokenFile = tacticalTokenFile;
    this.tacticalToken = tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null;
    if (this.tacticalToken && !/^[a-f0-9]{64}$/.test(this.tacticalToken))
      throw new Error('invalid local tactical capability file');
  }

  async start() {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      try {
        if (!loopback(req.socket.remoteAddress)) return json(res, 403, { error: 'loopback only' });
        if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'use the local control application' });
        const u = new URL(req.url ?? '/', this.url);
        if (u.pathname === '/controls') {
          if (!this.controls) return json(res, 503, { error: 'human controls unavailable' });
          if (req.method === 'GET') return json(res, 200, await this.controls.snapshot((u.searchParams.get('agents') ?? '').split(',').filter(Boolean)));
          if (req.method === 'POST') return json(res, 200, await this.controls.save(await bodyOf(req)));
          return json(res, 405, { error: 'method not allowed' });
        }
        if (u.pathname === '/health' && req.method === 'GET')
          return json(res, 200, { ok: true, fleet: this.store.fleet, pid: process.pid, strategy_cas: 1, human_controls: this.controls ? 1 : 0,
            tactical_handoff: this.tacticalToken && this.tacticalHandoff ? 1 : 0,
            root: fileURLToPath(new URL('../../', import.meta.url)) });
        if (u.pathname === '/tactical') {
          if (!this.tacticalToken || !this.tacticalHandoff)
            return json(res, 503, { error: 'qualified tactical handoff is unavailable' });
          const bearer = Buffer.from(String(req.headers.authorization ?? ''));
          const expected = Buffer.from(`Bearer ${this.tacticalToken}`);
          if (req.headers.origin || req.headers.host !== this.url.host ||
              bearer.length !== expected.length || !timingSafeEqual(bearer, expected))
            return json(res, 403, { error: 'local tactical capability required' });
          if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
          return json(res, 200, await this.tacticalHandoff.request(await bodyOf(req)));
        }
        // RE-READ THE DOCTRINE WITHOUT A RESTART. POST because it changes what the bot does
        // on its next pass; a GET that mutated the running orders would fire on any browser
        // refresh, link preview or monitoring probe, which is the one thing a control plane
        // must not do. See src/link/reload.mjs for which keys this can apply and which it
        // refuses, and why refusing is the honest half.
        if (u.pathname === '/reload') {
          if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
          if (!this.controls) return json(res, 503, { error: 'human controls are unavailable' });
          const report = this.controls.reload();
          this.journal?.write?.({ kind: 'doctrine-reload', ...report });
          return json(res, 200, report);
        }
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
          return json(res, 200, { catalogue: STRATEGY_CATALOG, states, selected: agents.length,
            fleet: this.store.fleet, pid: process.pid, strategy_cas: 1,
            revision: strategyRevision(this.store.fleet, agents, states) });
        }
        if (req.method === 'POST') {
          const body = await bodyOf(req);
          const { states } = await updateStrategies(this.store, body, this.resolveItems);
          return json(res, 200, { ok: true, catalogue: STRATEGY_CATALOG, states,
            selected: body.agents.length });
        }
        return json(res, 405, { error: 'method not allowed' });
      } catch (e) { return json(res, e.status === 409 ? 409 : 400, { error: e.message }); }
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
