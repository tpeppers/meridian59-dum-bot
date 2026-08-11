// APPEND-ONLY, ONE LINE PER TICK PER CHARACTER, GITIGNORED.
//
// Every line carries five things, and the set is chosen so that a decision can be
// re-run from its own record without the game:
//
//   observation   what DUM saw
//   considered    every rule and its verdict, including the ones that declined
//   intent        what it decided, with the rule's own reason
//   sent          what was actually written, after the diff
//   verified      whether a fresh read agreed
//
// THE DECLINED RULES ARE THE PART PEOPLE LEAVE OUT AND THE PART THAT MATTERS. Most
// ticks decide nothing, which is correct, and "nothing happened" is precisely the
// answer that cannot be debugged after the fact. A silent bot and a wedged bot look
// identical on a board; they look nothing alike in this file.
//
// It is also the substrate for the comparison this repository exists for. The llm-bot
// keeps a verified state/action/result ledger for the same reason, and a DUM run and an
// LLM run over the same doctrine produce comparable lines — same observation shape,
// same verified-delta, one with a model in the loop and one without. That comparison is
// the whole experiment and it needs both sides writing the same thing down.
//
// NAMES. Lines carry character names, which is why the directory is gitignored. Nothing
// here is ever committed. See CLAUDE.md rule 4.

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class Journal {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {boolean} [opts.full] keep the whole observation on every line
   * @param {boolean} [opts.enabled] false for `plan`, which prints instead of writing
   */
  constructor({ dir, full = true, enabled = true }) {
    this.dir = resolve(dir);
    this.full = full;
    this.enabled = enabled;
    this.lines = [];
    if (this.enabled) mkdirSync(this.dir, { recursive: true });
  }

  /** One file per day. Small enough to read, large enough to hold a session. */
  #file(at) {
    return join(this.dir, `dum-${new Date(at).toISOString().slice(0, 10)}.ndjson`);
  }

  /**
   * @param {object} entry
   * @param {string} entry.kind  'tick' | 'fleet-tick' | 'call' | 'startup' | 'finding'
   */
  write(entry) {
    const line = {
      at: entry.at ?? Date.now(),
      ...entry,
    };
    if (!this.full && line.observation) {
      // Keep only what a rule actually read. Smaller, and enough to re-run the rule —
      // but not enough to answer a question nobody thought to ask, which is why `full`
      // is the default.
      line.observation = { agent: line.observation.agent, at: line.observation.at };
    }
    this.lines.push(line);
    if (!this.enabled) return line;
    try {
      appendFileSync(this.#file(line.at), JSON.stringify(line) + '\n');
    } catch (e) {
      // A JOURNAL THAT CANNOT WRITE MUST NOT STOP THE BOT, and must not be silent about
      // it either. Losing the record is bad; losing the fleet because the disk filled up
      // is worse.
      process.stderr.write(`journal: could not write (${e.message}) — continuing unrecorded\n`);
    }
    return line;
  }

  /** Findings: the things a human should look at. Also written to the ndjson. */
  finding(agent, why, evidence = {}) {
    return this.write({ kind: 'finding', agent, why, evidence });
  }

  /** Current-process intervention counters for the local fleet command post. */
  observability() {
    const ticks = this.lines.filter(line => line.kind === 'tick' || line.kind === 'fleet-tick');
    const triggered = ticks.filter(line => line.intent && !['none', 'pass'].includes(line.intent.kind));
    const byRule = new Map(), byKind = new Map();
    for (const line of triggered) {
      const rule = line.intent.rule ?? 'unattributed';
      const kind = line.intent.kind ?? 'unknown';
      byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    const sorted = map => [...map].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const first = this.lines[0]?.at ?? null;
    const last = this.lines.at(-1)?.at ?? null;
    return {
      since: first,
      through: last,
      ticks: ticks.length,
      character_ticks: ticks.filter(line => line.kind === 'tick').length,
      fleet_ticks: ticks.filter(line => line.kind === 'fleet-tick').length,
      interventions_triggered: triggered.length,
      interventions_applied: triggered.filter(line => line.applied?.acted === true).length,
      interventions_no_change: triggered.filter(line => line.applied?.kind === 'no-change').length,
      verification_failures: this.lines.filter(line => line.verified?.verified === false).length,
      findings: this.lines.filter(line => line.kind === 'finding').length,
      errors: this.lines.filter(line => line.error || ['pass-failed', 'claim-failed', 'heartbeat-failed'].includes(line.kind)).length,
      by_rule: sorted(byRule),
      by_kind: sorted(byKind),
    };
  }

  /** Everything written this run, for `plan` to print. */
  all() { return this.lines; }
}
