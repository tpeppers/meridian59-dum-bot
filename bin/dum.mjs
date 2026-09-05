#!/usr/bin/env node
// DUM — a Deterministic Unattended Mover for Meridian 59.
//
//   node bin/dum.mjs doctor                                 can I see a broker, whose fleet is it
//   node bin/dum.mjs rules                                  the decision table, in order
//   node bin/dum.mjs explain --doctrine doctrines/x.jsonc   every effective value and where it came from
//   node bin/dum.mjs plan --doctrine doctrines/x.jsonc      one pass, sending nothing
//   node bin/dum.mjs run  --doctrine doctrines/x.jsonc --commit
//
// `--dry-run` IS THE DEFAULT AND `--commit` IS THE ONLY WAY OUT OF IT. Not a
// convenience: the fleet this is pointed at is on a shared server with real players on
// it, the roster files are the only record of the account passwords, and a loop that
// runs every thirty seconds is not something anyone reads the output of. So the safe
// mode is the one you get by forgetting.

import { loadDoctrine, flatten, getDotted } from '../src/config/load.mjs';
import { feastStatsLine } from '../src/decide/rules/feast.mjs';
import { Broker } from '../src/link/broker.mjs';
import { checkFleet } from '../src/link/guard.mjs';
import { ALLOWED, READ, WRITE, NOT_YET } from '../src/link/surface.mjs';
import { characterRules, fleetRules } from '../src/decide/index.mjs';
import { Journal } from '../src/record/journal.mjs';
import { Memory } from '../src/record/memory.mjs';
import { StrategyStore } from '../src/record/strategies.mjs';
import { FactionGoalStore } from '../src/record/factions.mjs';
import { DetailStats } from '../src/record/detail-stats.mjs';
import { StrategyControlServer } from '../src/link/strategy-control.mjs';
import { existsSync, readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pass } from '../src/loop/tick.mjs';
import { run } from '../src/loop/run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('-')) ?? 'help';
const cliFlag = (name, dflt = null) => {
  const i = argv.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
};
const has = name => argv.includes('--' + name);

// ---------------------------------------------------------------- this machine's answers
//
// A COMMAND LINE THAT HAS TO BE REMEMBERED IS A COMMAND LINE THAT GETS TYPED WRONG.
//
// Everything this tool needs to run — which doctrine, which fleet, where the broker is,
// where the log goes — is the same on any given machine every single time, and none of it
// belongs in git: a doctrine path under doctrines/local/ and a fleet name are both things
// tools/dum-guard.mjs refuses to let into this repository, for the same reason the roster
// files are gitignored in the harness.
//
// So they live in `dum.local.json` beside this repository's root, gitignored, and the
// command line overrides any of them. `dum.local.example.json` is the committed shape.
// Nothing here is required: with no file and no flags, `plan` still runs against whatever
// broker is on the default port, which is the "just works" case.
const LOCAL_FILE = resolve(HERE, '..', 'dum.local.json');
const local = (() => {
  try {
    if (!existsSync(LOCAL_FILE)) return {};
    const v = JSON.parse(readFileSync(LOCAL_FILE, 'utf8'));
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  } catch (e) {
    // Loud once, and carry on. A local file that will not parse must not stop the fleet
    // being driven; it must also not be silently ignored, which is how a machine ends up
    // running yesterday's doctrine and nobody knows why.
    process.stderr.write(`dum.local.json did not parse (${e.message}) — using defaults\n`);
    return {};
  }
})();

// CLI first, then this machine's file, then the built-in default. Same order as everything
// else here: most explicit wins.
const flag = (name, dflt = null) => {
  const fromCli = cliFlag(name, null);
  if (fromCli !== null) return fromCli;
  const key = name.replace(/-/g, '_');
  if (local[key] !== undefined && local[key] !== null) return local[key];
  return dflt;
};

// ---------------------------------------------------------------- the log, without asking
//
// A BOT WHOSE LOG WENT TO THE TERMINAL THAT STARTED IT HAS NO LOG. The harness learned this
// the expensive way — a broker was found running with its whole ancestry dead and its output
// going to a temp directory that gets cleaned up — and the answer there was the same as here:
// write it down by default, somewhere predictable, without being asked.
//
// `--log <path>` chooses one; `--no-log` turns it off; otherwise a committed run writes to
// <log_dir>/dum-<fleet>-<stamp>.log. Planning does not, because a plan is a thing you read.
function openLog(fleetName) {
  if (has('no-log')) return null;
  const explicit = flag('log', null);
  const dir = String(flag('log-dir', 'var'));
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  const path = (explicit && explicit !== true) ? String(explicit)
    : resolve(HERE, '..', dir, `dum-${fleetName || 'fleet'}-${stamp}.log`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const out = createWriteStream(path, { flags: 'a' });
    for (const stream of ['stdout', 'stderr']) {
      const original = process[stream].write.bind(process[stream]);
      process[stream].write = (chunk, enc, cb) => {
        // Strip the colour codes on the way to disk: a log full of escape sequences is a
        // log nobody greps twice.
        try { out.write(String(chunk).replace(/\x1b\[[0-9;]*m/g, '')); } catch { /* keep going */ }
        return original(chunk, enc, cb);
      };
    }
    return path;
  } catch (e) {
    process.stderr.write(`could not open a log (${e.message}) — printing only\n`);
    return null;
  }
}

const tty = process.stdout.isTTY;
const c = {
  ok: s => tty ? `\x1b[32m${s}\x1b[0m` : s,
  bad: s => tty ? `\x1b[31m${s}\x1b[0m` : s,
  warn: s => tty ? `\x1b[33m${s}\x1b[0m` : s,
  dim: s => tty ? `\x1b[2m${s}\x1b[0m` : s,
  b: s => tty ? `\x1b[1m${s}\x1b[0m` : s,
};

// ---------------------------------------------------------------- shared setup

function doctrine() {
  const file = flag('doctrine');
  const overrides = {};
  // --set a.b=c, repeatable. The provenance record calls these "command line", which
  // is the point: a value someone passed once is distinguishable from one a file chose.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--set') continue;
    const [k, ...rest] = String(argv[i + 1] ?? '').split('=');
    if (!k || !rest.length) throw new Error('--set wants key=value, e.g. --set cadence.character_ms=5000');
    const raw = rest.join('=');
    overrides[k] = raw === 'true' ? true : raw === 'false' ? false
                 : raw === 'null' ? null
                 : (raw !== '' && !Number.isNaN(Number(raw))) ? Number(raw) : raw;
  }
  if (flag('control')) overrides['link.control_url'] = String(flag('control'));
  // --fleet NAMES THE ROSTER, AND NAMING IT IS THE WHOLE SAFETY.
  //
  // It is not a filter and it does not enumerate anybody: DUM already drives every character
  // the broker holds when no --agent scope is given, so "attach to this fleet" is exactly
  // "check the broker is holding this fleet, then run". The check is the point — `checkFleet`
  // refuses when the broker is holding a different roster, which is the one mistake that
  // operates on twenty-one characters nobody meant to touch and reports success doing it.
  if (flag('fleet')) overrides['fleet'] = String(flag('fleet'));
  // --yield-to rest_below,max_carry,roam — fields something else owns. Validated
  // against ORDER_FIELDS, because a typo would silently NOT yield the field.
  if (flag('yield-to'))
    overrides['yield_to'] = String(flag('yield-to')).split(',').map(s => s.trim()).filter(Boolean);
  // Per-agent overrides (doctrine.agents.<name>) only make sense for a single named character;
  // a two-character scope carries no one set of overrides, so pass none in that case.
  const scope = agentScope();
  return loadDoctrine({ file: file === true ? null : file, overrides,
                        agent: scope && scope.length === 1 ? scope[0] : null });
}

const agentFlag = () => { const a = flag('agent'); return a === true ? null : a; };
// --agent accepts one name or a comma-list. It scopes the whole run: the per-character rows AND
// any fleet-scoped intent (the sell circuit, a faction request) that names an agent outside it.
const agentScope = () => { const a = agentFlag(); return a ? a.split(',').map(s => s.trim()).filter(Boolean) : null; };

function context({ config, commit }) {
  const journal = new Journal({
    dir: config.record.dir,
    full: config.record.full_observations,
    enabled: commit,           // planning prints; only a committed run writes to disk
  });
  // READ IN BOTH MODES, WRITTEN IN ONE. A plan that could not see what DUM remembers
  // would report "the crate may be up" every time it was run, which is a plan of a
  // different fleet. Writing is a different question: a plan changes nothing in the
  // world, so it must not change what DUM believes about it either.
  const memory = new Memory({
    dir: config.record.memory_dir, fleet: config.fleet, enabled: commit,
  });
  const strategies = new StrategyStore({
    dir: config.record.strategy_dir, fleet: config.fleet,
    defaults: config.strategies.defaults, settings: config.strategies.settings, enabled: commit,
  });
  const factions = new FactionGoalStore({
    dir: config.record.faction_dir, fleet: config.fleet, enabled: commit,
  });
  const detailStats = new DetailStats({
    dir: config.record.strategy_stats_dir, enabled: commit,
  });
  const broker = new Broker({
    controlUrl: config.link.control_url,
    timeoutMs: config.link.timeout_ms,
    callsPerSecond: config.link.calls_per_second,
    dryRun: !commit,
    onCall: e => journal.write({ kind: 'call', ...e }),
  });
  // The same loopback server carries strategy assignments and durable faction goals.
  // Factions are independent of the optional strategy catalogue, so a committed DUM
  // run must expose this control plane even when strategies.enabled is false.
  const strategyServer = commit
    ? new StrategyControlServer({ store: strategies, factions, journal, detailStats,
        resolveItems: items => broker.call('resolve_item_names', { items }),
        resolveFactionStatuses: async agents => Object.fromEntries(await Promise.all(
          agents.map(async agent => [agent, await broker.call('faction_status', { agent })]))),
        url: config.link.strategy_control_url }) : null;
  // WHO DUM IS, ON THE WIRE. One string, computed once, because it is an identity the
  // harness checks rather than a label: only the holder of a claim may declare that
  // character busy or free it again, so a second spelling of this would be a second
  // process as far as the broker is concerned — able to claim, unable to release.
  const holder = `dum/${config.name}@pid-${process.pid}`;
  return { broker, config, journal, memory, strategies, factions, detailStats, strategyServer,
           commit, holder, only: agentScope() };
}

// ---------------------------------------------------------------- doctor

async function doctor() {
  const { config, warnings } = doctrine();
  console.log(c.b('doctrine ') + config.name + (config.fleet ? `  fleet=${c.ok(config.fleet)}` : c.warn('  no fleet named')));
  for (const w of warnings) console.log(c.warn('warning  ') + w);

  const { broker } = context({ config, commit: false });
  const g = await checkFleet(broker, config, { commit: false });

  console.log(c.b('broker   ') + (g.held
    ? `${c.ok('UP')} pid ${g.pid ?? '?'}, holding ${c.ok(g.held)}, ${g.sessions} session(s)`
    : c.bad('not answering')));
  for (const n of g.notes) console.log('         ' + c.warn(n));

  // WHAT DUM WOULD BE ALLOWED TO CALL, checked against what the broker actually
  // exposes. A tool DUM depends on that is not there is the thing that turns into a
  // rule that quietly never fires.
  if (g.held) {
    let names = null;
    try {
      const r = await fetch(`${broker.url}/`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      names = new Set((j.result?.tools ?? []).map(t => t.name));
    } catch { /* an older broker may not answer tools/list; that is not fatal */ }
    if (names) {
      const missing = [...ALLOWED].filter(t => !names.has(t)).sort();
      console.log(c.b('surface  ') + `${READ.size} read, ${WRITE.size} write, ${NOT_YET.size} declined`);
      if (missing.length)
        console.log('         ' + c.warn(`not on this broker: ${missing.join(', ')} — ` +
          `any rule that needs one of these will silently never fire`));
      else console.log('         ' + c.ok('every tool DUM may call exists on this broker'));
    }
  }

  console.log(c.b('claim    ') + Object.entries(config.claim)
    .filter(([k]) => !k.startsWith('i_') && k !== 'lease_ms')
    .map(([k, v]) => `${k}=${v === 'bot' ? c.ok(v) : c.dim(v)}`).join(' '));

  if (!g.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------- rules

function showRules() {
  for (const [label, set] of [['character', characterRules], ['fleet', fleetRules]]) {
    console.log(c.b(`\n${label} rules, in order — first match wins`));
    set.rules.forEach((r, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${c.b(r.id)}  ${c.dim('[' + r.faculty + ']')}`);
      console.log(`      ${r.why}`);
    });
    if (!set.rules.length) console.log(c.dim('  (none)'));
  }
  console.log('');
}

// ---------------------------------------------------------------- explain

function explain() {
  const { config, provenance, layers } = doctrine();
  console.log(c.b('layers, innermost first'));
  layers.forEach(l => console.log('  ' + l));
  console.log(c.b('\neffective values') + c.dim('  (only those a layer above the defaults set are highlighted)'));
  for (const key of flatten(config)) {
    const from = provenance.get(key) ?? '?';
    const value = JSON.stringify(getDotted(config, key));
    const line = `  ${key.padEnd(38)} ${String(value).padEnd(28)} ${c.dim('<- ' + from)}`;
    console.log(from === 'built-in defaults' ? c.dim(line) : line);
  }
}

// ---------------------------------------------------------------- plan / run

async function plan() {
  const { config, warnings } = doctrine();
  for (const w of warnings) console.log(c.warn('warning  ') + w);
  const ctx = context({ config, commit: false });
  const g = await checkFleet(ctx.broker, config, { commit: false });
  for (const n of g.notes) console.log(c.warn('note     ') + n);
  if (!g.held) { console.log(c.bad('nothing to plan against.')); process.exitCode = 1; return; }

  const result = await pass(ctx, { only: agentScope(), decideFleet: true });
  printPass(result);
}

async function commitRun() {
  const { config } = doctrine();
  const ctx = context({ config, commit: true });
  // The precondition. Throws on a mismatch rather than warning, because the caller of
  // this is a loop and nobody reads a loop's warnings.
  await checkFleet(ctx.broker, config, { commit: true });
  // Opened AFTER the fleet check, so a run that refuses does not leave an empty log behind
  // to be mistaken for one that started.
  const logPath = openLog(config.fleet);
  console.log(c.b(`running "${config.name}" against fleet ${c.ok(config.fleet)} — ` +
                  `journal: ${config.record.dir}`));
  if (logPath) console.log(c.dim(`log: ${logPath}`));
  console.log(c.dim('Ctrl-C finishes the current tick, releases the claim, and stops.'));
  await run(ctx, { onPass: printPass });
}

function printPass(result) {
  const f = result.fleet;
  // THE FEAST'S RUNNING TOTALS, ON BY DEFAULT. The hall is the fleet's only free food and
  // it took a day of wrong answers to get one slice out of it — mostly because nothing
  // counted anything, so "did a courier actually take food" was answered by reading a
  // keeper's pack by hand. One line, printed whenever there is anything to say.
  const feastLine = feastStatsLine(result.memory?.feast ?? {});
  if (feastLine) console.log(c.b('feast    ') + feastLine);
  if (f?.stood_down) { console.log(c.warn('fleet    stood down: ') + f.stood_down); return; }
  if (f?.error) console.log(c.bad('fleet    ') + f.error);
  else {
    const o = f?.observation ?? {};
    // A FLEET RULE THAT DECLINED AND SAID WHY IS THE MOST USEFUL LINE ON THIS BOARD.
    // "(no fleet decision)" is true of a bot that is working and of one that is wedged,
    // and the clock-gated rules — the crate is the first — are precisely the ones whose
    // silence a human cannot tell apart from a bug. See `kind: 'pass'` in decide/engine.
    const spoke = (f?.considered ?? []).filter(v => v.why && v.verdict !== 'fired');
    console.log(c.b('fleet    ') + `${o.in_game ?? 0} in game, ${o.stalled ?? 0} stalled` +
                (f.intent ? `  ->  ${c.ok(f.intent.rule)}: ${f.intent.why}` : c.dim('  (no fleet decision)')));
    for (const v of spoke) console.log('         ' + c.dim(`${v.rule}: ${v.why}`));
    if (f?.applied?.sent) console.log('         ' + c.dim(JSON.stringify(f.applied.sent)));
    if (f?.memory_patch)
      console.log('         ' + c.warn(`remembered: ${f.memory_patch.read.why}`));
  }
  for (const line of result.characters ?? []) {
    if (line.error) { console.log(`${c.bad(pad(line.agent))} ${line.error}`); continue; }
    if (!line.intent) {
      // WHY THE DECLINED RULES ARE PRINTED. "Nothing happened" is the answer most of
      // the time and it is the one nobody can debug. Showing the first non-trivial
      // verdict turns it into a sentence.
      const notable = (line.considered ?? []).find(v => v.verdict === 'off' || v.verdict === 'error');
      console.log(`${c.dim(pad(line.agent))} ${c.dim(notable ? `${notable.rule}: ${notable.why}` : 'nothing to decide')}`);
      continue;
    }
    const mark = line.intent.kind === 'report' ? c.warn('!') : line.applied?.kind === 'no-change' ? c.dim('=') : c.ok('>');
    console.log(`${c.b(pad(line.agent))} ${mark} ${line.intent.rule}: ${line.intent.why}`);
    if (line.applied?.sent) console.log(`${' '.repeat(12)}${c.dim(JSON.stringify(line.applied.sent))}`);
    if (line.verified?.verified === false) console.log(`${' '.repeat(12)}${c.bad(line.verified.why)}`);
  }
}
const pad = s => String(s ?? '?').padEnd(11).slice(0, 11);

// ---------------------------------------------------------------- dispatch

const HELP = `
DUM — a Deterministic Unattended Mover for Meridian 59.

  doctor    can I see a broker, and is it holding the fleet this doctrine names
  rules     the decision table, in order, with each rule's reason
  explain   every effective configuration value and which layer set it
  plan      one pass against the live fleet, sending nothing
  run       the loop. Needs --commit, and --commit needs a matching fleet

  --fleet <name>            attach to the fleet the broker is holding, and REFUSE if it is
                            holding a different one. Not a filter: with no --agent scope DUM
                            already drives every character that broker holds
  --doctrine <file.jsonc>   which doctrine to load
  --agent <name[,name]>     restrict the run to these characters (overrides apply only when one)
  --set key.path=value      override one leaf, recorded as "command line"
  --yield-to a,b,c          order fields something else owns — DUM will not write them
  --control <url>           broker control URL (default http://127.0.0.1:8901)
  --log <path>              where a committed run writes. Default <log_dir>/dum-<fleet>-<stamp>.log
  --no-log                  print only
  --commit                  actually send. Without it nothing is written, anywhere

NONE OF THESE ARE REQUIRED. dum.local.json at the repository root supplies this machine's
answers — doctrine, fleet, control, log_dir — and any flag above overrides it. It is
gitignored, because a doctrine path and a fleet name are both things dum-guard refuses to
let into this repository. dum.local.example.json is the shape.

    node bin/dum.mjs plan            # against whatever the local file says
    node bin/dum.mjs run --commit    # the same, for real, logging to var/

DUM attaches to a broker that is already running. It never starts one, never stops
one, and never calls the harness's 'leave' tool.
`;

try {
  switch (cmd) {
    case 'doctor': await doctor(); break;
    case 'rules': showRules(); break;
    case 'explain': explain(); break;
    case 'plan': await plan(); break;
    case 'run':
      if (!has('commit')) {
        console.log(c.warn('`run` without --commit is `plan` in a loop, which is rarely what anyone wants.'));
        console.log(c.warn('Use `plan` for one pass, or pass --commit and mean it.'));
        process.exitCode = 2;
        break;
      }
      await commitRun();
      break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error(c.bad(e.message));
  process.exitCode = 1;
}
