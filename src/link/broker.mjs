// THE ONLY THING IN THIS REPOSITORY THAT TOUCHES THE HARNESS.
//
// One JSON-RPC client against a broker that is ALREADY RUNNING. There is deliberately
// no spawn path, no lifecycle management and no fleet file reading anywhere in here,
// and adding any of the three is the single most damaging change that could be made
// to this repository.
//
// The reason is written down in the harness's own instructions: `m59-broker.mjs` with
// no arguments serves MCP *and resumes the fleet*, so a second one is refused the lock,
// comes up healthy and EMPTY, and answers every question about a fleet of nobody while
// the real one plays on. A bot that manages its own broker is a bot that will one day
// report a perfectly healthy fleet of zero characters.
//
// So: attach, or fail. The failure is loud and says what to start.

import { deny } from './surface.mjs';

export class BrokerError extends Error {
  constructor(tool, message, { retriable = false } = {}) {
    super(`${tool}: ${message}`);
    this.name = 'BrokerError';
    this.tool = tool;
    this.retriable = retriable;
  }
}

export class Broker {
  /**
   * @param {object} opts
   * @param {string} opts.controlUrl   e.g. http://127.0.0.1:8901
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.callsPerSecond] fleet-wide ceiling; see below
   * @param {boolean} [opts.dryRun]   when true, every write is refused and described
   * @param {(entry:object)=>void} [opts.onCall] called with every attempt, for the journal
   */
  constructor({ controlUrl, timeoutMs = 30_000, callsPerSecond = 4,
                dryRun = true, onCall = () => {} }) {
    this.url = controlUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.dryRun = dryRun;
    this.onCall = onCall;
    this.id = 0;
    // A SINGLE FILE OF CALLS, PACED.
    //
    // The server drops incoming packets past INCOMING_PACKET_THROTTLE (5/second) and
    // does so SILENTLY — the harness found a character parked on an exit square
    // because its `go` was sent inside a second it had spent walking. A fleet-wide bot
    // is the one component positioned to breach that for twenty-one characters at
    // once, and the symptom would be actions that simply never happened.
    //
    // Serialising is also what makes the journal a true order of events rather than
    // an interleaving.
    this.minGapMs = 1000 / callsPerSecond;
    this.chain = Promise.resolve();
    this.lastAt = 0;
    this.stats = { calls: 0, failures: 0, refused: 0, dry: 0 };
  }

  /** GET /health. Read-only, allowed in every mode, and the basis of the fleet guard. */
  async health() {
    const r = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new BrokerError('health', `HTTP ${r.status}`);
    return r.json();
  }

  /**
   * Call a harness tool. Writes are refused in dry-run and reported as `{dry_run: true}`
   * so a plan can still describe exactly what it would have sent.
   */
  call(tool, args = {}, { timeoutMs = null } = {}) {
    const refusal = deny(tool, args);
    if (refusal) {
      this.stats.refused++;
      const e = new BrokerError(tool, refusal);
      this.onCall({ tool, args, outcome: 'refused', why: refusal });
      return Promise.reject(e);
    }
    const run = async () => {
      const wait = this.minGapMs - (Date.now() - this.lastAt);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.lastAt = Date.now();
      return this.#send(tool, args, timeoutMs);
    };
    this.chain = this.chain.then(run, run);
    return this.chain;
  }

  async #send(tool, args, timeoutMs = null) {
    const began = Date.now();
    const body = JSON.stringify({
      jsonrpc: '2.0', id: ++this.id,
      method: 'tools/call', params: { name: tool, arguments: args },
    });
    let r;
    try {
      r = await fetch(`${this.url}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        // A PER-CALL OVERRIDE, AND ONLY UPWARDS. The harness's calls are not all the same
        // kind of thing: most answer out of the broker's own memory in milliseconds,
        // while `travel` and `walk_to` are a character WALKING at roughly a second a
        // square. Timing one of those out does not cancel it — the character keeps
        // walking and DUM stops watching, which is the worst of the two outcomes. A step
        // may therefore ask for longer; it may not ask for shorter, because a short
        // timeout is the failure this exists to prevent.
        signal: AbortSignal.timeout(Math.max(this.timeoutMs, timeoutMs ?? 0)),
      });
    } catch (e) {
      this.stats.failures++;
      // A CONNECTION REFUSED IS NOT A BUG IN THE ARGUMENTS, and the message should not
      // read like one. This is by far the most common failure and it has exactly one
      // remedy.
      const why = /fetch failed|ECONNREFUSED|timed out|aborted/i.test(e.message)
        ? `no broker answering on ${this.url}. DUM attaches to a running broker and ` +
          `never starts one — check with: node ../m59-harness/tools/m59-which.mjs`
        : e.message;
      this.onCall({ tool, args, outcome: 'unreachable', why, ms: Date.now() - began });
      throw new BrokerError(tool, why, { retriable: true });
    }
    if (!r.ok) {
      this.stats.failures++;
      const text = await r.text().catch(() => '');
      this.onCall({ tool, args, outcome: 'http', why: `HTTP ${r.status} ${text}`.trim() });
      throw new BrokerError(tool, `HTTP ${r.status} ${text}`.trim(), { retriable: r.status >= 500 });
    }
    const j = await r.json();
    if (j.error) {
      this.stats.failures++;
      this.onCall({ tool, args, outcome: 'rpc-error', why: JSON.stringify(j.error) });
      throw new BrokerError(tool, JSON.stringify(j.error));
    }
    // The harness wraps its answer in MCP content. Unwrap once, here, so that nothing
    // above this file has ever seen an MCP envelope — that separation is what lets the
    // rule table be tested against plain fixtures.
    const text = j.result?.content?.[0]?.text;
    if (j.result?.isError) {
      this.stats.failures++;
      this.onCall({ tool, args, outcome: 'tool-error', why: text });
      throw new BrokerError(tool, String(text));
    }
    this.stats.calls++;
    this.onCall({ tool, args, outcome: 'ok', ms: Date.now() - began });
    try { return JSON.parse(text); } catch { return text; }
  }

  /**
   * A write. In dry-run this returns a description instead of sending, which is what
   * makes `plan` show the exact call rather than a paraphrase of it.
   */
  async write(tool, args = {}, { why = null } = {}) {
    if (this.dryRun) {
      this.stats.dry++;
      this.onCall({ tool, args, outcome: 'dry-run', why });
      return { dry_run: true, tool, args, why };
    }
    return this.call(tool, args);
  }
}
