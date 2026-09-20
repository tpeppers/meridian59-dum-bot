// RE-READ THE DOCTRINE WITHOUT KILLING THE PROCESS — and say honestly what that cannot do.
//
// THE ERRAND IT EXISTS FOR, 2026-09-20. A character had to be taken off DUM so an external
// drill could hold its body. The lever is `not_ours`, one line in a doctrine file, and it is
// read fresh on every pass — but the doctrine itself was only ever read at startup, so a
// one-word edit needed the whole bot killed and restarted. Restarting DUM re-asserts the
// posture of every character in the fleet, which is a large, disruptive act to publish one
// name. The machinery to avoid it was already here and unused: `bin/dum.mjs` passes
// `restartConfig: () => doctrine().config`, a live function that re-reads the file, and
// nothing ever applied its result — it powered a PREVIEW, with the comment "a GET never
// replaces the running defaults".
//
// WHY MUTATION IN PLACE, WHICH LOOKS LIKE THE WRONG INSTINCT. There are two readers of the
// config object and they disagree about when they read it:
//
//   src/loop/run.mjs:82    `const { config, journal } = ctx` — destructured ONCE, and its
//                          loop still reads `config.cadence.fleet_ms` every pass
//   src/loop/tick.mjs:39   `const { broker, config } = ctx` — destructured on EVERY call
//
// Replacing `ctx.config` would update the tick and leave the run loop reading the old object
// for ever — a half-applied reload, which is worse than none because nothing would say so.
// Both hold the SAME object, so assigning onto it is the one move both readers see.
//
// AND THE HONEST HALF: NOT EVERYTHING CAN BE RELOADED, SO THE ONES THAT CANNOT ARE REFUSED
// RATHER THAN APPLIED. A key that is read once at startup into some other structure — the
// journal's directory, the claim's lease, the holder string every claim is stamped with —
// would be written into the config, change nothing, and read back as applied. That is the
// failure this repository keeps paying for: a value that looks present and is not. So those
// keys are listed by name, with the reason, and a reload that sees one changed reports it as
// `restart_required` and leaves the live value alone.
//
// It follows that this is not a substitute for a restart; it is a way to make most doctrine
// edits not NEED one, and to tell you precisely when one is still needed.

/**
 * Keys the tick re-reads off `ctx.config` on every pass, so assigning them takes effect on
 * the next pass with no restart. Each is cited to where it is read.
 */
export const LIVE_RELOADABLE = Object.freeze([
  'not_ours',    // tick.mjs:140 — observeFleet drops these rows before any consumer sees them
  'yield_to',    // tick.mjs:89, :307 — passed into apply() per intent
  'graveyard',   // tick.mjs:137, :209
  'moot',        // tick.mjs:211
  'feast',       // tick.mjs:234
  'factions',    // tick.mjs:168
  'weapons',     // tick.mjs:211-219
  'shift',       // tick.mjs:187 — stations are read fresh, not captured
  'cadence',     // tick.mjs:282 and run.mjs:198, which is why this must mutate in place
]);

/**
 * Keys that are read ONCE at startup into something this cannot reach. Changing one is a
 * real change that needs a restart, and saying so is the whole point of the pairing.
 */
export const RESTART_ONLY = Object.freeze({
  name: 'the holder string `dum/<name>@pid-<pid>` is built once (run.mjs:112) and every claim ' +
        'is stamped with it — only the holder may free a character, so a second spelling ' +
        'would strand every claim this process already owns',
  fleet: 'the fleet identity keys the strategy store and the journal, both opened at startup',
  claim: 'the faculty list and lease_ms are read into the claim loop once (run.mjs:105, :113)',
  record: 'the Journal opens its directory at construction',
  link: 'this server is already listening on that URL; a new one needs a new listener',
  strategies: 'only `strategies.enabled` is read per pass — the STORE is built at startup from ' +
              'defaults and settings, so applying this would change the flag and not the ' +
              'strategies, which is a half-applied reload wearing a success',
});

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * What a reload WOULD do. Pure: no mutation, no I/O — so a caller can ask before committing,
 * and so this is testable without a running bot.
 */
export function planReload(live = {}, next = {}) {
  const applied = [], restart_required = [], unchanged = [];
  for (const key of LIVE_RELOADABLE) {
    if (same(live[key], next[key])) unchanged.push(key);
    else applied.push(key);
  }
  for (const [key, why] of Object.entries(RESTART_ONLY))
    if (!same(live[key], next[key])) restart_required.push({ key, why });
  // A key in neither list is one nobody has classified. It is REPORTED rather than applied or
  // dropped, because an unclassified key that silently did nothing is exactly how a setting
  // ends up being believed in for a year without ever having been read.
  const known = new Set([...LIVE_RELOADABLE, ...Object.keys(RESTART_ONLY)]);
  const unclassified = [...new Set([...Object.keys(live), ...Object.keys(next)])]
    .filter(k => !known.has(k) && !same(live[k], next[k]));
  return { applied, restart_required, unclassified, unchanged };
}

/**
 * Apply a reload to the LIVE config object, in place. Returns the same report `planReload`
 * gives, after the fact.
 */
export function applyReload(live, next) {
  const plan = planReload(live, next);
  for (const key of plan.applied) live[key] = next[key];
  return plan;
}
