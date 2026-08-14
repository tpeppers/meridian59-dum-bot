#!/usr/bin/env node
// REFUSE TO PUBLISH A CHARACTER, AN ACCOUNT, A PASSWORD, A SERVER, OR A FLEET.
//
//   node tools/dum-guard.mjs [--staged] [--verbose]
//
// This repository is public and the fleet it drives is on a shared server. The rule is
// that nothing identifying that fleet is committed: not a character name, not an
// account handle, not a password, not the server address, not the fleet's name.
//
// It is a good rule because it needs no judgement — and a rule that depends on somebody
// remembering it at the moment they are pleased with a sentence is not enforced, it is
// merely stated. So this checks, and it is meant to be run before every push.
//
// LIFTED FROM m59-bard's bard-guard.mjs, which is where the idea and most of the
// reasoning come from. Three things are different, and each is because DUM is a
// different shape:
//
//   * BARD HAS SNAPSHOTS AND DUM HAS NONE. Bard reads the names out of its own
//     gitignored snapshots. DUM writes no snapshots, so it reads the roster the harness
//     keeps and the snapshots the bard keeps — whichever are present on this machine —
//     and unions them.
//   * IT CHECKS SECRETS, NOT JUST NAMES. The harness roster carries the account and its
//     password, which the bard's snapshots do not. A password in a public repository is
//     worse than a character name by a wide margin, so if the roster is readable those
//     values go into the forbidden set too. They are never printed, only matched.
//   * IT CHECKS FLEET NAMES. `prod` names this machine's live roster. It is not a
//     secret, and it is also not something a public doctrine has any reason to contain:
//     a stranger cloning this repository has no such fleet, so a doctrine naming one is
//     either useless to them or a description of ours.
//
// AND THE RULE IT INHERITS UNCHANGED: no roster means REFUSE, not pass. A check with
// nothing to check against reports "0 hits" and is worth nothing, and that reading is
// indistinguishable from a real pass at the moment you most want to trust it.
//
// Read-only. Touches no broker, no server and no game.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = f => argv.includes('--' + f);
const rel = p => path.relative(ROOT, p).replace(/\\/g, '/');

// Where a roster might live, relative to this map. Both are gitignored in their own
// repositories and neither is required — but at least one must be found.
const SOURCES = [
  { kind: 'harness roster', dir: path.resolve(ROOT, '../m59-harness/substrate/fleets') },
  { kind: 'bard snapshot', dir: path.resolve(ROOT, '../m59-bard/snapshots') },
  { kind: 'dum journal', dir: path.resolve(ROOT, 'var/journal') },
];

// Five classes, because they are matched differently and reported differently.
//
//   secret     an account password. Bounded, matched EVERYWHERE including code, and
//              never printed — only its file and line are.
//   character  an in-world name. Matched everywhere, with ONE exception: the NATO
//              phonetic alphabet, which names nobody and collides with ordinary words.
//   handle     an agent/account name. Only a couple of characters long, so bounded
//              and checked in prose and data rather than in source.
//   fleet      a roster name. Bounded and prose-only, for the same reason.
//   host       a server address. Matched everywhere; an IP cannot be a coincidence.
//
// WHY SECRETS ARE BOUNDED RATHER THAN MATCHED AS SUBSTRINGS, which looks like a
// weakening and is not. On this fleet an account's password is the same short token as
// its handle, so an unbounded match hits every hex string and every identifier that
// happens to contain those two characters — and this file's own first run proved the
// point by flagging four lines of its own documentation. The rule that survives is:
// bounded like a handle, but checked in source too, which is strictly stronger than the
// handle rule and produces no noise.
//
// THE SAME RUN ALSO FOUND THAT THE DOCUMENTATION ITSELF WAS THE LEAK. This comment used
// to illustrate "short handles" with two real ones, which on this fleet are two real
// passwords. There are no literal examples here now, and that is why.
// THE NATO PHONETIC ALPHABET IS NOT AN IDENTITY.
//
// A character called Alpha or Delta names nobody: the set is fixed, public, twenty-six
// words long, and chosen precisely because it carries no information. Publishing one
// tells a reader that a fleet exists, which the repository says on its front page.
//
// They have to be exempt rather than merely tolerated, because every one of them is also
// an ordinary English word that appears throughout source and prose — `echo` in a shell
// script, `delta` in a comment about timing. A roster using them turned this guard into
// eleven false positives across files nobody had touched, and a guard that cries wolf on
// its own documentation is one people start passing --no-verify to. That is a worse
// outcome than the leak it was protecting against.
//
// This exempts the NAME only. The account, password and host of a NATO-named character
// are as secret as anybody's and are still matched everywhere.
const NATO_PHONETIC = new Set([
  'alfa', 'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
  'india', 'juliett', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
  'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
  'x-ray', 'yankee', 'zulu',
]);
const isNato = (name) => NATO_PHONETIC.has(String(name ?? '').trim().toLowerCase());

const found = { secret: new Set(), character: new Set(), handle: new Set(),
                fleet: new Set(), host: new Set() };
const readFrom = [];

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// A HOST THAT IS LOOPBACK IS NOT A LEAK. One of the fleets on this machine is a local
// server, so its roster's host is 127.0.0.1 — which is also DUM's own documented
// default. Flagging it would put a false positive in every clean run, and a guard that
// cries wolf on its own defaults is a guard people learn to skip.
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|localhost)$/i;

// ---- the harness's rosters: the only record of the account passwords.
{
  const dir = SOURCES[0].dir;
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter(f => /\.json$/.test(f))) {
      const roster = readJson(path.join(dir, f));
      if (!roster || typeof roster !== 'object') continue;
      // NOT EVERY .json IN THAT DIRECTORY IS A ROSTER. The harness writes sidecars
      // beside them — `<fleet>.keeper-active.json` and friends — whose top-level keys
      // are `pid`, `beat_at`, `agents`. Treating those keys as account handles put
      // "pid" and "fleet" into the forbidden set, which then matched sixty lines of
      // this repository's own prose. A guard that fires on the word "fleet" in a
      // document about fleets teaches people to pass --no-verify.
      //
      // So: a file is a roster only if something in it has credentials, and only the
      // entries that do are read.
      const entries = Object.entries(roster).filter(([, row]) => row?.credentials);
      if (!entries.length) continue;
      found.fleet.add(f.replace(/\.json$/, ''));
      for (const [agent, row] of entries) {
        const c = row.credentials;
        if (agent) found.handle.add(agent);
        if (c.account) found.handle.add(c.account);
        if (c.character && !isNato(c.character)) found.character.add(c.character);
        if (c.password) found.secret.add(c.password);
        if (c.host && !LOOPBACK.test(String(c.host))) found.host.add(c.host);
      }
      readFrom.push(`${rel(path.join(dir, f))} (${entries.length} account(s))`);
    }
  }
}

// ---- the bard's snapshots: EVERY one, not the latest.
//
// A character logged off when a snapshot ran has no name in it, so checking only the
// latest stops looking for exactly the characters that were absent. A name that has
// ever been in this fleet must never be in a tracked file.
{
  const root = SOURCES[1].dir;
  if (fs.existsSync(root)) {
    for (const fleet of fs.readdirSync(root)) {
      const dir = path.join(root, fleet);
      if (!fs.statSync(dir).isDirectory()) continue;
      found.fleet.add(fleet);
      let n = 0;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const s = readJson(path.join(dir, f));
        for (const c of s?.characters ?? []) {
          if (c.character && !isNato(c.character)) found.character.add(c.character);
          if (c.agent) found.handle.add(c.agent);
          n++;
        }
      }
      if (n) readFrom.push(`${rel(dir)} (${n} sheet(s))`);
    }
  }
}

// ---- DUM's own journal, which names characters and is gitignored for that reason.
{
  const dir = SOURCES[2].dir;
  if (fs.existsSync(dir)) {
    let n = 0;
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ndjson'))) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const rows = j.observation?.characters ?? [j.observation ?? {}];
        for (const c of rows) {
          if (c?.character) { found.character.add(c.character); n++; }
          if (c?.agent) found.handle.add(c.agent);
        }
      }
    }
    if (n) readFrom.push(`${rel(dir)} (${n} row(s))`);
  }
}

const total = Object.values(found).reduce((t, s) => t + s.size, 0);
if (!total) {
  console.error('dum-guard: REFUSE — no roster, snapshot or journal found on this machine.');
  console.error('');
  console.error('  This is NOT a pass. A check with nothing to check against reports zero hits,');
  console.error('  and that reading is indistinguishable from a real one at exactly the moment');
  console.error('  you most want to trust it.');
  console.error('');
  for (const s of SOURCES) console.error(`  looked in  ${rel(s.dir)}`);
  console.error('');
  console.error('  If this is a fresh clone with no fleet beside it, there is nothing to leak and');
  console.error('  nothing to verify — say so deliberately rather than running this and believing it.');
  process.exit(2);
}

// ---- what git would publish
const tracked = execFileSync('git', ['-C', ROOT, ...(has('staged')
    ? ['diff', '--cached', '--name-only'] : ['ls-files'])],
  { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);

if (!tracked.length) {
  console.error(`dum-guard: nothing ${has('staged') ? 'staged' : 'tracked'} — nothing to check.`);
  process.exit(2);
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anywhere = set => set.size
  ? new RegExp(`(${[...set].map(esc).join('|')})`, 'gi') : null;
// Bounded: a two-character token must not match inside a hex string or mid-word.
const bounded = set => set.size
  ? new RegExp(`(?<![\\w-])(${[...set].map(esc).join('|')})(?![\\w-])`, 'g') : null;

const RULES = [
  // Bounded, but checked in source as well as prose — see the note at the top. A
  // password is never printed, even when it is found; the file and line are enough to
  // fix it and printing it would put the secret in a terminal scrollback and a CI log.
  { kind: 'secret', re: bounded(found.secret), everywhere: true, redact: true },
  { kind: 'host', re: anywhere(found.host), everywhere: true },
  // A character name is matched everywhere, without exception. Quoting a harness commit
  // message does not make it exempt — that is the most likely way for one to get in.
  { kind: 'character', re: anywhere(found.character), everywhere: true },
  // Handles and fleet names are short enough to collide with ordinary words and with
  // this repository's own identifiers, so they are checked in prose and data only.
  { kind: 'handle', re: bounded(found.handle), everywhere: false },
  { kind: 'fleet', re: bounded(found.fleet), everywhere: false },
];

const isCode = f => /\.(mjs|js|ts)$/.test(f);
const hits = [];
for (const f of tracked) {
  const abs = path.join(ROOT, f);
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) continue;
  const text = fs.readFileSync(abs, 'utf8');
  text.split(/\r?\n/).forEach((line, i) => {
    for (const r of RULES) {
      if (!r.re) continue;
      if (!r.everywhere && isCode(f)) continue;
      for (const m of line.matchAll(r.re))
        hits.push({ f, line: i + 1, kind: r.kind,
                    what: r.redact ? '<redacted>' : m[1] });
    }
  });
}

const summary = Object.entries(found)
  .filter(([, s]) => s.size).map(([k, s]) => `${s.size} ${k}(s)`).join(', ');

if (!hits.length) {
  console.error(`dum-guard: clean — ${tracked.length} ${has('staged') ? 'staged' : 'tracked'} ` +
                `file(s) checked against ${summary}.`);
  if (has('verbose')) for (const s of readFrom) console.error(`  from  ${s}`);
  process.exit(0);
}

console.error(`dum-guard: REFUSE — ${hits.length} hit(s) in ${has('staged') ? 'staged' : 'tracked'} files.\n`);
for (const h of hits.slice(0, 40)) console.error(`  ${h.f}:${h.line}  ${h.kind} "${h.what}"`);
if (hits.length > 40) console.error(`  ... and ${hits.length - 40} more`);
console.error('');
console.error('  The systems are forever; the fleet is not. Rewrite the line, or move the detail');
console.error('  into a file that is gitignored — doctrines/local/ exists for exactly this.');
console.error('  A doctrine that must name a character is a local doctrine.');
process.exit(1);
