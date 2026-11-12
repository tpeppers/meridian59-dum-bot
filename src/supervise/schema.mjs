// VALIDATION FOR `supervisors`, `supervisor_*` AND `requires_supervisors`.
//
// Kept in its own file and called from config/schema.mjs with one line, so the shift and
// ladder validation there stay untouched. The rule is that file's rule: refuse what would
// otherwise be SILENTLY wrong. A `requires_supervisors` naming an id nobody declared gates
// nothing, so a station that was meant to wait for its singer would deploy without one and
// the doctrine would read as if it waited.

import { NEEDS, PIN_MODES } from './registry.mjs';

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string' && v.trim().length > 0;

export function validateSupervisors(c, say) {
  const sups = c.supervisors ?? {};
  if (!isObj(sups)) { say('supervisors', 'must be an object of {<id>: {need, entry, pin, ...}}'); return; }

  for (const [id, d] of Object.entries(sups)) {
    const at = `supervisors.${id}`;
    if (!/^[\w.-]+$/.test(id)) say(at, 'an id names files (<id>.supervisor.json, <id>.stop), so letters, digits, . _ - only');
    if (!isObj(d)) { say(at, 'must be an object'); continue; }
    if (!NEEDS.includes(d.need)) say(`${at}.need`, `must be one of ${NEEDS.join(', ')}`);
    if (!str(d.entry)) say(`${at}.entry`, 'must name the supervisor\'s .mjs, e.g. "private:supervisors/x.mjs"');
    if (d.need === 'must' && !str(d.pin))
      say(`${at}.pin`, 'a `must` supervisor needs a pin — DUM starts it, and starting code nobody ' +
          'named is how yesterday\'s supervisor comes back after a revert');
    if (d.pin !== undefined && d.pin !== null && !str(d.pin)) say(`${at}.pin`, 'must be a commit sha or ref');
    if (d.pin_mode !== undefined && !PIN_MODES.includes(d.pin_mode))
      say(`${at}.pin_mode`, `must be one of ${PIN_MODES.join(', ')}`);
    if (d.pin_paths !== undefined && (!Array.isArray(d.pin_paths) || !d.pin_paths.every(str)))
      say(`${at}.pin_paths`, 'must be a list of paths relative to the supervisor\'s repository');
    if (d.args !== undefined && (!Array.isArray(d.args) || !d.args.every(a => typeof a === 'string')))
      say(`${at}.args`, 'must be a list of strings');
    if (d.env !== undefined && (!isObj(d.env) || !Object.values(d.env).every(v => typeof v === 'string')))
      say(`${at}.env`, 'must be an object of string values');
    for (const k of ['start', 'restart_on_mismatch', 'enabled'])
      if (d[k] !== undefined && typeof d[k] !== 'boolean') say(`${at}.${k}`, 'must be true or false');
    for (const k of ['repo', 'cwd', 'state_dir'])
      if (d[k] !== undefined && d[k] !== null && !str(d[k])) say(`${at}.${k}`, 'must be a path');
    const known = new Set(['need', 'entry', 'repo', 'pin', 'pin_mode', 'pin_paths', 'cwd', 'env', 'args',
      'start', 'restart_on_mismatch', 'state_dir', 'enabled', 'why']);
    const unknown = Object.keys(d).filter(k => !known.has(k));
    if (unknown.length) say(at, `unknown key(s) ${unknown.join(', ')} — a misspelt key here is a setting that silently does nothing`);
  }

  if (c.supervisor_state_dir != null && !str(c.supervisor_state_dir))
    say('supervisor_state_dir', 'must be a directory path, or null for <dum>/var/supervisors');
  if (c.supervisor_roots != null && (!isObj(c.supervisor_roots) || !Object.values(c.supervisor_roots).every(str)))
    say('supervisor_roots', 'must be an object of {<name>: <directory>}');
  if (c.supervisor_check_ms != null && (!Number.isFinite(c.supervisor_check_ms) || c.supervisor_check_ms < 1000))
    say('supervisor_check_ms', 'must be at least 1000');

  const refs = (list, where) => {
    if (list === undefined) return;
    if (!Array.isArray(list) || !list.every(str)) { say(where, 'must be a list of supervisor ids'); return; }
    const missing = list.filter(id => !Object.hasOwn(sups, id));
    if (missing.length)
      say(where, `names ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not declared under ` +
          '`supervisors` — an undeclared dependency gates nothing, and the station would deploy as if it had waited');
  };
  (Array.isArray(c.shift?.stations) ? c.shift.stations : [])
    .forEach((st, i) => refs(st?.requires_supervisors, `shift.stations[${i}].requires_supervisors`));
  (Array.isArray(c.goals?.ladder) ? c.goals.ladder : [])
    .forEach((r, i) => refs(r?.requires_supervisors, `goals.ladder[${i}].requires_supervisors`));
}
