// THE LONG LOOP'S CLAIMS OUTLIVE A BROKER PROCESS, BUT THE BROKER'S CLAIMS DO NOT.
// Offline: the fake broker below is the restart boundary and no fleet is contacted.

const test = globalThis.__dumTest;

import { heartbeatClaims } from '../src/loop/run.mjs';

const eq = (a, b, m) => { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const ok = (v, m) => { if (!v) throw new Error(m); };

test('run: heartbeat reacquires faculties forgotten by a restarted broker', async () => {
  const calls = [], journal = [];
  const broker = { call: async (_tool, args) => {
    calls.push(args);
    if (args.action === 'heartbeat') return { renewed: [] };
    return { granted: ['work', 'movement', 'economy'], refused: [] };
  } };
  const mine = new Map([['role-a', ['work', 'movement', 'economy']]]);

  await heartbeatClaims(broker, mine, {
    holder: 'dum/test@pid-1', leaseMs: 600_000,
    journal: { write: row => journal.push(row) },
  });

  eq(calls.map(x => x.action).join(','), 'heartbeat,claim', 'detect, then restore');
  ok(journal.some(x => x.kind === 'claim-lost'), 'the lost broker state is visible');
  ok(journal.some(x => x.kind === 'claim-restored'), 'and so is the repair');
  eq(mine.get('role-a').join(','), 'work,movement,economy', 'the desired claim remains for future retries');
});

test('run: a complete heartbeat does not send another claim', async () => {
  const calls = [];
  const broker = { call: async (_tool, args) => {
    calls.push(args);
    return { renewed: ['work', 'movement'] };
  } };
  await heartbeatClaims(broker, new Map([['role-a', ['work', 'movement']]]), {
    holder: 'dum/test@pid-1', leaseMs: 600_000, journal: { write: () => {} },
  });
  eq(calls.length, 1, 'one heartbeat only');
  eq(calls[0].action, 'heartbeat', 'no redundant claim');
});
