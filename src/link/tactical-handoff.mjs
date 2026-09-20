// Temporary, per-agent reservations. No doctrine edits and no process lifecycle.
// The broker calls enter() at actual dispatch, AFTER pacing. Tickets prevent a
// queued pre-handoff decision from waking up and writing after a later resume.
import { WRITE } from './surface.mjs';

const ensure = (ok, why) => { if (!ok) throw new Error(`tactical handoff: ${why}`); };
export class TacticalHandoff {
  constructor({ fleet, pid, health, yieldAgent, forgetAgent, now = Date.now }) {
    Object.assign(this, { fleet, pid, health, yieldAgent, forgetAgent, now });
    this.holds = new Map();
    this.epochs = new Map();
    this.active = new Map();
    this.closed = false;
  }
  prune() {
    for (const [agent, hold] of this.holds)
      if (hold.until <= this.now()) this.remove(agent);
  }
  remove(agent) {
    this.holds.delete(agent);
    this.epochs.set(agent, (this.epochs.get(agent) ?? 0) + 1);
    this.forgetAgent(agent);
  }
  ticket(tool, args) {
    this.prune();
    if (!WRITE.has(tool)) return null;
    const agents = typeof args.agent === 'string' ? [args.agent]
      : Array.isArray(args.agents) && args.agents.every(x => typeof x === 'string') ? args.agents : null;
    return { agents, epochs: agents?.map(a => this.epochs.get(a) ?? 0),
      allEpochs: JSON.stringify([...this.epochs]) };
  }
  enter(ticket) {
    if (!ticket) return () => {};
    this.prune();
    const agents = ticket.agents ?? ['*'];
    ensure(!this.closed, 'controller is stopping');
    if (!ticket.agents) ensure(!this.holds.size && ticket.allEpochs === JSON.stringify([...this.epochs]),
      'fleet-wide write crossed a reservation');
    else for (let i = 0; i < agents.length; i++) {
      const a = agents[i];
      ensure(!this.holds.has(a) && (this.epochs.get(a) ?? 0) === ticket.epochs[i],
        'selected agent is reserved or this queued decision predates the handoff');
    }
    for (const a of agents) this.active.set(a, (this.active.get(a) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      for (const a of agents) this.active.set(a, Math.max(0, (this.active.get(a) ?? 0) - 1));
    };
  }
  reserved(agent) { this.prune(); return this.holds.has(agent); }
  async request(body) {
    this.prune();
    const { action, order_id: id, binding: b } = body;
    ensure(!this.closed && b && b.fleet === this.fleet && body.dum_pid === this.pid,
      'DUM process/fleet identity changed');
    ensure(typeof b.agent === 'string' && b.agent.length > 0 &&
      typeof b.character === 'string' && Number.isSafeInteger(b.broker_pid) &&
      /^[a-f0-9]{32}$/.test(id ?? ''), 'invalid binding');
    const prior = this.holds.get(b.agent);
    const fingerprint = JSON.stringify(b);
    if (action === 'release') {
      if (!prior) return { released: true };
      ensure(prior.id === id && prior.fingerprint === fingerprint, 'reservation belongs to another order');
      ensure(prior.ready, 'handoff is still in progress');
      this.remove(b.agent);
      return { released: true };
    }
    ensure(action === 'yield' || action === 'heartbeat', 'unknown action');
    if (prior) {
      ensure(prior.id === id && prior.fingerprint === fingerprint && prior.ready,
        'agent is already reserved or yielding');
      ensure(!prior.failed, 'the original yield was not confirmed');
      // 45s exceeds the commander's maximum 30s lease plus bounded cleanup.
      prior.until = this.now() + 45_000;
      return { yielded: true, expires_at: prior.until };
    }
    ensure(action === 'yield', 'reservation expired; heartbeat cannot reacquire it');
    const hold = { id, fingerprint, until: this.now() + 45_000, ready: false };
    this.holds.set(b.agent, hold);
    this.epochs.set(b.agent, (this.epochs.get(b.agent) ?? 0) + 1);
    try {
      // No waiting behind a long errand, and no cancellation of its unrelated job.
      ensure(!(this.active.get(b.agent) > 0) && !(this.active.get('*') > 0), 'DUM has an in-flight write; try again once it finishes');
      const health = await this.health();
      ensure(health.fleet === b.fleet && health.pid === b.broker_pid, 'attached broker identity changed');
      ensure(this.holds.get(b.agent) === hold && hold.until > this.now(), 'reservation expired during attestation');
      await this.yieldAgent(b.agent);
      ensure(this.holds.get(b.agent) === hold && hold.until > this.now(), 'reservation expired during yield');
      this.forgetAgent(b.agent);
      hold.ready = true;
      return { yielded: true, expires_at: hold.until };
    } catch (error) {
      // A timed-out yield may still be executing remotely. Preserve the reservation
      // until expiry instead of immediately permitting conflicting DUM writes.
      hold.ready = true;
      hold.failed = true;
      throw error;
    }
  }
  close() { this.closed = true; }
}
