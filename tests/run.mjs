#!/usr/bin/env node
// OFFLINE. NO BROKER, NO SERVER, NO NETWORK.
//
//   node tests/run.mjs            everything
//   node tests/run.mjs ladder     only files matching
//
// Safe at any time, including while a live fleet is playing. That is a property worth
// stating out loud rather than assuming: the harness's own suite is split into the
// tests that are safe and the ones that join characters, and the split matters because
// "run the tests" is a thing people do without thinking about which fleet is up.
//
// Nothing here imports src/link/broker.mjs's send path, and every fixture is a plain
// object. If a test in this directory ever needs a running broker it belongs somewhere
// else and under a different name.

import { readdirSync } from 'node:fs';
// pathToFileURL, NOT a bare path. On Windows `import('C:\\x\\y.mjs')` is read as a URL
// with the scheme "c:", and the loader refuses it — so the whole suite fails to start
// with an error about URL schemes that says nothing about tests.
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] ?? '';

const results = [];
let current = null;

/** Registered by each test file. */
export function test(name, fn) {
  results.push({ file: current, name, fn });
}

globalThis.__dumTest = test;

const files = readdirSync(here)
  .filter(f => f.startsWith('test-') && f.endsWith('.mjs'))
  .filter(f => !filter || f.includes(filter))
  .sort();

for (const f of files) {
  current = f;
  await import(pathToFileURL(join(here, f)).href);
}

let pass = 0;
const failures = [];
for (const r of results) {
  try {
    await r.fn();
    pass++;
  } catch (e) {
    failures.push({ ...r, error: e });
  }
}

const tty = process.stdout.isTTY;
const green = s => tty ? `\x1b[32m${s}\x1b[0m` : s;
const red = s => tty ? `\x1b[31m${s}\x1b[0m` : s;

for (const f of failures) {
  console.log(red(`FAIL  ${f.file}  ${f.name}`));
  console.log(`      ${f.error.message.split('\n').join('\n      ')}`);
}
console.log(`\n${files.length} file(s), ${results.length} test(s): ` +
  `${green(pass + ' passed')}${failures.length ? ', ' + red(failures.length + ' failed') : ''}`);
process.exit(failures.length ? 1 : 0);
