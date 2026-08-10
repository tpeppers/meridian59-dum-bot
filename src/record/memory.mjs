// WHAT DUM REMEMBERS BETWEEN TICKS — AND WHY THIS IS NOT THE JOURNAL.
//
// Everything else in this repository is stateless on purpose. A rule is
// `(observation, doctrine) => Intent | null`, the journal is append-only, and a tick
// that decides nothing leaves nothing behind. That is what makes a decision
// reproducible from one line six hours later.
//
// Some decisions are not answerable that way, and the crate under Castle Victoria is
// the first. Whether to walk somebody down there turns entirely on TWO FACTS ABOUT THE
// PAST that no read of the world can recover:
//
//   * when the room's timer was last reset — the server states this nowhere, it is
//     only inferable from having watched a find happen;
//   * who found last — `poLastFinder` lives on the room object and is refused
//     SILENTLY, so a character that checks twice in a row gets no message saying why.
//
// Neither is on the wire and neither is on the board. A decision that depends on them
// needs somewhere to put them.
//
// WHY NOT THE JOURNAL. It is one ndjson file per day, gitignored, and deliberately
// append-only. Reconstructing "when did we last find something" out of it means
// replaying an unbounded number of lines across an unknown number of days and hoping
// none were rotated away. A fact the NEXT decision reads is state, not record; the
// journal keeps saying what happened and this keeps the handful of things that are
// still true.
//
// UNKNOWN IS NOT ZERO, AND THE DIRECTION MATTERS. A missing or unreadable memory reads
// as "I do not know", never as "it has definitely not happened". For the crate that
// resolves to "the window may be open, go and look" — so losing this file costs one
// wasted walk to the basement. The opposite convention would have cost a fleet that
// either never checks or checks every five minutes for ever, and both of those look
// exactly like working correctly from a board.
//
// FLEET-SCOPED, because two doctrines pointed at two fleets are two different rooms
// with two different timers, and one file would have them overwriting each other's
// clock. Under `/var/`, which is gitignored, for the same reason the journal is: the
// contents name characters.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class Memory {
  /**
   * @param {object} opts
   * @param {string} opts.dir
   * @param {string|null} opts.fleet  which fleet this memory belongs to
   * @param {boolean} [opts.enabled]  false for `plan`, which reads and never writes
   */
  constructor({ dir, fleet = null, enabled = true }) {
    this.dir = resolve(dir);
    // A doctrine with no fleet cannot commit anything anyway (see config/defaults.mjs),
    // so its memory is a scratch file rather than a second fleet's.
    this.fleet = fleet ?? 'unnamed';
    this.enabled = enabled;
    this.path = join(this.dir, `${sanitise(this.fleet)}.json`);
    this.warned = false;
  }

  /**
   * Everything remembered, as one plain object keyed by topic.
   *
   * Read ONCE PER PASS by the tick and handed to the rules inside the observation —
   * which is how `src/decide/` stays pure while depending on the past. A rule that
   * called this directly would be reading a clock, and the whole test suite depends on
   * rules not doing that.
   */
  read() {
    if (!existsSync(this.path)) return {};
    try {
      const v = JSON.parse(readFileSync(this.path, 'utf8'));
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    } catch (e) {
      // A CORRUPT MEMORY IS AN EMPTY ONE, LOUDLY ONCE. Refusing to run would take the
      // fleet down over a file whose entire content is "we looked in a crate at 14:05".
      if (!this.warned) {
        process.stderr.write(`memory: ${this.path} did not parse (${e.message}) — ` +
                             `continuing as though nothing were remembered\n`);
        this.warned = true;
      }
      return {};
    }
  }

  /** One topic, or `{}`. */
  get(topic) { return this.read()[topic] ?? {}; }

  /**
   * Merge fields into one topic and write the whole file back.
   *
   * SHALLOW, one level under the topic, and that is deliberate: a deep merge makes
   * "clear this field" unexpressible, and every fact here is a scalar or a flat map.
   * Returns what the topic now holds, so the caller can journal it.
   */
  patch(topic, fields) {
    const all = this.read();
    const next = { ...(all[topic] ?? {}), ...fields };
    all[topic] = next;
    if (!this.enabled) return next;
    try {
      mkdirSync(this.dir, { recursive: true });
      // Write-then-rename. A crash halfway through a plain write leaves truncated JSON,
      // which reads as "nothing remembered" — safe, per the note at the top, but it
      // would silently throw away a find we paid a walk and a narthyl worm's worth of
      // risk to observe.
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
      renameSync(tmp, this.path);
    } catch (e) {
      process.stderr.write(`memory: could not write ${this.path} (${e.message}) — ` +
                           `this pass's finding is not remembered\n`);
    }
    return next;
  }
}

/** Fleet names come from a doctrine and end up in a path. Keep them to a filename. */
const sanitise = s => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 64) || 'unnamed';

export { sanitise };
