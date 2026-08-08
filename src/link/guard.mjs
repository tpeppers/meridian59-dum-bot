// WHICH FLEET AM I ABOUT TO ACT ON, AND IS IT THE ONE THAT IS RUNNING?
//
// This is `m59-which.mjs` asked from the bot's side, and it exists for the same
// recorded reason: a fleet tool that is silent about which fleet it addresses operates
// on the wrong one quietly, and every step reports success. The harness's version of
// that mistake stopped a live 46-session broker and would have restored a different
// roster against a server that was down.
//
// A bot makes that worse in one specific way. A human running a command sees the
// output. A loop running every thirty seconds does not, so the check has to be a
// PRECONDITION of committing rather than a line in a log.
//
// The rule:
//   * planning never needs a fleet — it reads and prints, and reading the wrong fleet
//     is a wasted minute rather than an incident;
//   * committing requires that the doctrine names a fleet AND that the broker's
//     /health reports it is holding that exact fleet.
//
// Nothing here reads a roster file. DUM has no business knowing where those live.

export class FleetMismatch extends Error {
  constructor(wanted, held, extra = '') {
    super(`the broker is holding "${held}" but this doctrine acts on "${wanted}". ` +
          `Anything committed now targets the wrong fleet, quietly.` + (extra ? ` ${extra}` : ''));
    this.name = 'FleetMismatch';
    this.wanted = wanted;
    this.held = held;
  }
}

/**
 * @param {import('./broker.mjs').Broker} broker
 * @param {object} config effective doctrine
 * @param {object} [opts]
 * @param {boolean} [opts.commit] true when about to act rather than plan
 * @returns {Promise<{ok: boolean, held: string|null, sessions: number, pid: number|null,
 *                    root: string|null, notes: string[]}>}
 */
export async function checkFleet(broker, config, { commit = false } = {}) {
  const notes = [];
  let health = null;
  try {
    health = await broker.health();
  } catch (e) {
    // NOTHING LISTENING IS AN ORDINARY ANSWER, not an exception to be dressed up. It
    // is also the whole diagnosis, so say the remedy rather than the stack.
    return {
      ok: false, held: null, sessions: 0, pid: null, root: null,
      notes: [`no broker answering on ${broker.url} — DUM attaches to a running broker ` +
              `and never starts one (${e.message})`],
    };
  }

  const held = health.fleet || 'default';
  const sessions = health.sessions?.length ?? health.session_count ?? 0;
  const root = health.root ?? null;

  if (root && !String(root).replace(/[\\/]+$/, '').endsWith('m59-harness'))
    notes.push(`the broker's root is ${root}, which does not look like an m59-harness ` +
               `checkout — DUM may be talking to a different project's broker`);

  if (sessions === 0)
    // The exact shape of the second-broker failure: healthy, and holding nobody.
    notes.push('the broker is holding zero sessions. A broker that was refused the ' +
               'roster lock comes up healthy and EMPTY, and answers every question ' +
               'about a fleet of nobody while the real one plays on');

  if (!config.fleet) {
    if (commit)
      throw new Error('this doctrine names no fleet, so it can be planned and cannot be ' +
                      'committed. Set `fleet:` in the doctrine and mean it');
    notes.push(`no fleet named in the doctrine — planning against whatever is running ` +
               `("${held}")`);
    return { ok: true, held, sessions, pid: health.pid ?? null, root, notes };
  }

  if (config.fleet !== held) {
    if (commit) throw new FleetMismatch(config.fleet, held);
    notes.push(new FleetMismatch(config.fleet, held).message + ' (planning only, so nothing was sent)');
    return { ok: false, held, sessions, pid: health.pid ?? null, root, notes };
  }

  return { ok: true, held, sessions, pid: health.pid ?? null, root, notes };
}
