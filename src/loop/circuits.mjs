// Long town circuits have one owner per character, while the fleet keeps ticking.
// Every action still goes through the paced broker and the ordinary leased runner.
import { runErrand, readErrand } from '../act/errands.mjs';

export class CircuitJobs {
  constructor(ctx, { execute = runErrand, now = () => Date.now() } = {}) {
    this.ctx = ctx;
    this.execute = execute;
    this.now = now;
    this.jobs = new Map();
  }
  has(agent) { return this.jobs.has(agent); }
  async start(intent) {
    const agent = intent.orders?.agent;
    if (!this.ctx.commit || !agent || this.has(agent)) return false;
    const control = new AbortController();
    const job = { control, promise: null };
    this.jobs.set(agent, job);
    job.promise = this.finish(intent, control.signal).finally(() => {
      this.jobs.delete(agent);
      this.ctx.expediteFleet = true;
    });
    this.ctx.expediteFleet = true;
    return true;
  }
  async finish(intent, signal) {
    const ctx = this.ctx;
    const line = { kind: 'background-errand', agent: intent.orders.agent,
      intent, started_at: this.now() };
    try {
      const applied = await this.execute(ctx.broker, intent,
        { commit: true, holder: ctx.holder, signal });
      line.applied = applied;
      // Other characters may have finished since dispatch; merge against NOW.
      const learned = readErrand(applied, { at: this.now(), memory: ctx.memory?.read() ?? {} });
      if (learned) {
        ctx.memory?.patch(learned.topic, learned.patch);
        line.memory_patch = learned;
      }
      if (applied.stopped) ctx.journal.finding(applied.agent,
        `the ${applied.errand} errand stopped early: ${applied.stopped}`, { sent: applied.sent });
    } catch (e) {
      line.error = e.message;
      ctx.journal.finding(line.agent, 'background town errand failed: ' + e.message);
    }
    line.at = this.now();
    ctx.journal.write(line);
  }
  async stop() {
    for (const job of this.jobs.values()) job.control.abort();
    await Promise.all([...this.jobs.values()].map(job => job.promise));
  }
}
