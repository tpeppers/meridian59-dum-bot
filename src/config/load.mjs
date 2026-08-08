// LAYERED DOCTRINE LOADING, AND A RECORD OF WHICH LAYER WON.
//
//   built-in defaults  <-  doctrine file  <-  per-character overrides  <-  CLI flags
//
// The layering is not the interesting part. The PROVENANCE is: every effective value
// carries the layer it came from, so "why is this character banking at 500" resolves
// to a file rather than to an argument. A fleet's settings drift by exactly this
// mechanism — somebody passes a flag once, it lands in a roster, and six weeks later
// nobody can say whether the number was chosen or inherited.
//
// See the harness's own note on `bankAbove`: "CHANGING THIS DOES NOT REACH KEEPERS
// THAT ALREADY EXIST", discovered by changing a default, restarting, and finding
// every keeper still reporting the old one. Provenance is how that is noticed on the
// day rather than in the postmortem.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { parseJsonc } from './jsonc.mjs';
import { freshDefaults } from './defaults.mjs';
import { validate } from './schema.mjs';

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-merge `patch` onto `base`, recording where each leaf came from.
 * Arrays REPLACE rather than concatenate: a doctrine that lists three rooms means
 * those three, and a merge that appended would make "fewer rooms" unexpressible.
 */
function mergeInto(base, patch, layer, provenance, path = []) {
  for (const [k, v] of Object.entries(patch)) {
    const here = [...path, k];
    if (isPlainObject(v) && isPlainObject(base[k])) {
      mergeInto(base[k], v, layer, provenance, here);
    } else {
      base[k] = structuredClone(v);
      provenance.set(here.join('.'), layer);
    }
  }
  return base;
}

/**
 * Follow a doctrine's `extends`, innermost first, so a base file's values are
 * overridden by the file that extends it. Cycles are an error rather than a hang.
 */
function readChain(file, seen = new Set()) {
  const abs = resolve(file);
  if (seen.has(abs)) throw new Error(`doctrine ${abs} extends itself (cycle)`);
  seen.add(abs);
  if (!existsSync(abs)) throw new Error(`no such doctrine: ${abs}`);
  const doc = parseJsonc(readFileSync(abs, 'utf8'), abs);
  const chain = [];
  if (doc.extends) {
    const parent = isAbsolute(doc.extends) ? doc.extends : resolve(dirname(abs), doc.extends);
    chain.push(...readChain(parent, seen));
  }
  delete doc.extends;
  chain.push({ file: abs, doc });
  return chain;
}

/**
 * Load a doctrine into an effective configuration.
 *
 * @param {object} opts
 * @param {string} [opts.file]      path to a .jsonc doctrine
 * @param {object} [opts.overrides] CLI-supplied leaves, e.g. { 'cadence.character_ms': 5000 }
 * @param {string} [opts.agent]     if set, per-character overrides for this agent are applied
 * @returns {{config: object, provenance: Map<string,string>, layers: string[], warnings: string[]}}
 */
export function loadDoctrine({ file = null, overrides = {}, agent = null } = {}) {
  const config = freshDefaults();
  const provenance = new Map();
  for (const key of flatten(config)) provenance.set(key, 'built-in defaults');

  const layers = ['built-in defaults'];
  const warnings = [];

  if (file) {
    for (const { file: f, doc } of readChain(file)) {
      // `characters` is not a config key — it is a map of per-agent patches, applied
      // after the flat body so that a character override always beats the fleet-wide
      // setting in the same file.
      const { characters = null, ...body } = doc;
      mergeInto(config, body, f, provenance);
      layers.push(f);
      if (characters && agent && characters[agent]) {
        mergeInto(config, characters[agent], `${f} [characters.${agent}]`, provenance);
        layers.push(`${f} [characters.${agent}]`);
      }
      if (characters && !agent) {
        // Worth saying out loud. Planning a whole fleet with a doctrine that has
        // per-character sections silently plans the fleet-wide half of it.
        warnings.push(`${f} has per-character sections (${Object.keys(characters).join(', ')}) ` +
                      `which are not applied without --agent`);
      }
    }
  }

  for (const [dotted, value] of Object.entries(overrides)) {
    setDotted(config, dotted, value);
    provenance.set(dotted, 'command line');
  }
  if (Object.keys(overrides).length) layers.push('command line');

  const problems = validate(config);
  if (problems.length) {
    throw new Error(`doctrine is not usable:\n  ` + problems.map(p =>
      `${p.where}: ${p.why}` + (provenance.has(p.where) ? `  <- ${provenance.get(p.where)}` : '')
    ).join('\n  '));
  }

  return { config, provenance, layers, warnings };
}

/** Every leaf key, dotted. Used to seed provenance and by `explain`. */
export function flatten(obj, path = [], out = []) {
  for (const [k, v] of Object.entries(obj)) {
    const here = [...path, k];
    if (isPlainObject(v)) flatten(v, here, out);
    else out.push(here.join('.'));
  }
  return out;
}

function setDotted(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts.at(-1)] = value;
}

/** Read one dotted key. Exported because the rule table reads doctrine this way. */
export function getDotted(obj, dotted, dflt = undefined) {
  let cur = obj;
  for (const p of dotted.split('.')) {
    if (!isPlainObject(cur) && !Array.isArray(cur)) return dflt;
    cur = cur[p];
    if (cur === undefined) return dflt;
  }
  return cur;
}
