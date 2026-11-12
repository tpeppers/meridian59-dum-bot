// THE COURIER REQUEST FILE, AND WHOSE LINES IN IT ARE WHOSE.
//
// The harness's courier reads one shared file, `{agent: {item: count}}`, and delivers toward
// those counts. DUM is one of several writers: operators type lines into it by hand, other
// supervisors keep their own characters' lines in it. So the spell-training plan writes it
// under three rules, and this file is where all three live:
//
//   1. NEVER LOWER SOMEBODY ELSE'S NUMBER. A line DUM did not write that already asks for
//      more than DUM would is left exactly as it is, and DUM does not claim it.
//   2. TAKE BACK ONLY WHAT IT WROTE. When no drill needs an item any more, DUM removes the
//      line it wrote -- and if it had RAISED somebody else's smaller number to write it, it
//      puts that number back. If the value on disk is no longer the one DUM wrote, somebody
//      changed it since, and it is theirs now: left alone, and forgotten by DUM.
//   3. NEVER TOUCH AN AGENT OUTSIDE THIS PASS'S SCOPE. A character that was not observed, or
//      whose spell list could not be read, keeps every line it has.
//
// What DUM wrote is kept in DUM's own var/ (record.spell_training_dir), never in the shared
// file: a marker inside it would be a field the courier has to know to ignore.
//
// The write is atomic (temp file + rename) and has no BOM: a courier reading a half-written
// file mid-lap reads "nobody wants anything", and a BOM is the one byte that makes a strict
// JSON reader refuse a file every other tool opens happily.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { sanitise } from '../record/memory.mjs';

const clone = v => JSON.parse(JSON.stringify(v ?? {}));

/**
 * Pure. Merge the wanted lines into the current file.
 *
 * @param {object} current  the request file as read, {agent: {item: count}}
 * @param {object} desired  {agent: {item: count}} for agents in scope that want something
 * @param {object} owned    what DUM wrote before: {agent: {item: {count, was}}}
 * @param {Iterable<string>} scope  agents decided over this pass
 * @returns {{next: object, owned: object, changes: object[]}}
 */
export function mergeRequests(current = {}, desired = {}, owned = {}, scope = []) {
  const next = clone(current);
  const mine = clone(owned);
  const changes = [];
  const inScope = new Set(scope);
  for (const agent of Object.keys(desired)) inScope.add(agent);

  for (const agent of inScope) {
    const want = desired[agent] ?? {};
    const had = mine[agent] ?? {};
    const line = next[agent] && typeof next[agent] === 'object' ? next[agent] : {};
    const ours = {};

    for (const [item, rawCount] of Object.entries(want)) {
      const count = Math.floor(Number(rawCount));
      if (!Number.isFinite(count) || count <= 0) continue;
      const onDisk = Number.isFinite(Number(line[item])) ? Number(line[item]) : null;
      const prev = had[item];
      const stillOurs = prev && onDisk === prev.count;
      if (onDisk === null || stillOurs) {
        // Empty, or the number we wrote last time: ours to set, up or down.
        if (onDisk !== count) changes.push({ agent, item, from: onDisk, to: count, why: onDisk === null ? 'requested' : 'adjusted' });
        line[item] = count;
        ours[item] = { count, was: stillOurs ? (prev.was ?? null) : null };
      } else if (onDisk >= count) {
        // Somebody else's, and already at least as much: theirs, untouched, unclaimed.
      } else {
        // Somebody else's smaller number: raised, and the old one remembered.
        changes.push({ agent, item, from: onDisk, to: count, why: 'raised' });
        line[item] = count;
        ours[item] = { count, was: onDisk };
      }
    }

    // What we wrote before and no drill needs now.
    for (const [item, prev] of Object.entries(had)) {
      if (ours[item]) continue;
      if (want[item] != null && Number(want[item]) > 0) continue;   // still wanted; someone else's now
      const onDisk = Number.isFinite(Number(line[item])) ? Number(line[item]) : null;
      if (onDisk !== prev.count) continue;                          // changed since: theirs now
      if (prev.was == null) { delete line[item]; changes.push({ agent, item, from: onDisk, to: null, why: 'no longer needed' }); }
      else { line[item] = prev.was; changes.push({ agent, item, from: onDisk, to: prev.was, why: 'restored' }); }
    }

    if (Object.keys(line).length) next[agent] = line;
    else if (next[agent] !== undefined && Object.keys(had).length) delete next[agent];
    if (Object.keys(ours).length) mine[agent] = ours; else delete mine[agent];
  }
  return { next, owned: mine, changes };
}

const readJson = (path, dflt) => {
  if (!path || !existsSync(path)) return dflt;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  return text.trim() ? JSON.parse(text) : dflt;
};

/** Write `value` as JSON to `path` atomically, UTF-8 without a BOM. */
export function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.dum-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8' });
  renameSync(tmp, path);
}

export const statePath = (dir, fleet) => join(resolve(dir), `${sanitise(fleet ?? 'unnamed')}.json`);

/**
 * Read, merge and (when committing) write. Also keeps the "said once" notes the plan journals
 * (a trainer at 99 everywhere with nothing to buy) in the same state file.
 *
 * Returns what changed, or would have; never throws for a missing file. A request file that
 * will not PARSE is refused rather than overwritten -- that is somebody's hand-edit mid-save,
 * and replacing it with DUM's half would delete everybody else's lines.
 */
export function syncReagentRequests({ file, stateFile, desired, scope, commit = false, notes = null }) {
  if (!file) return { skipped: 'no courier request file configured (spell_training.requests_file)' };
  let current;
  try { current = readJson(file, {}); }
  catch (e) { return { skipped: `the request file did not parse (${e.message}); not overwritten` }; }
  if (!current || typeof current !== 'object' || Array.isArray(current))
    return { skipped: 'the request file is not an {agent: {item: count}} object; not overwritten' };
  let state;
  try { state = readJson(stateFile, {}); } catch { state = {}; }
  const { next, owned, changes } = mergeRequests(current, desired, state.owned ?? {}, scope);

  // NOTES: agent -> reason, kept until the reason goes away, so a finding is journalled once.
  const prevNotes = state.notes ?? {};
  const newNotes = {};
  const fresh = [];
  for (const [agent, why] of Object.entries(notes ?? {})) {
    newNotes[agent] = why;
    if (prevNotes[agent] !== why) fresh.push({ agent, why });
  }
  // Notes for agents out of scope are kept, not re-announced when they come back.
  for (const [agent, why] of Object.entries(prevNotes))
    if (!new Set(scope).has(agent) && newNotes[agent] === undefined) newNotes[agent] = why;

  const stateChanged = JSON.stringify(owned) !== JSON.stringify(state.owned ?? {}) ||
    JSON.stringify(newNotes) !== JSON.stringify(prevNotes);
  if (commit) {
    if (changes.length) writeJsonAtomic(file, next);
    if (changes.length || stateChanged) writeJsonAtomic(stateFile, { owned, notes: newNotes });
  }
  return { changes, written: commit && changes.length > 0, fresh_notes: fresh };
}
