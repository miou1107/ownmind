/**
 * Starting the judge and not waiting for it.
 *
 * This is the whole reason the reply check stopped being synchronous. Measured: the judge
 * takes 29–54 seconds on the user's own subscription, against a client that gives up at 5 and
 * then silences the check for five minutes. Nobody waits half a minute after every reply, so
 * the Stop hook starts the work and returns, and the next turn collects whatever landed.
 *
 * Verified against the real harness before this existed: a detached child spawned from the
 * installed Stop hook survives the hook returning, reparented to init. That was not a safe
 * assumption — a harness that cleaned up its hooks' process groups would have sunk the design.
 *
 * `detached: true` with `stdio: 'ignore'` and `unref()` is what makes the exit immediate:
 * nothing is left holding the event loop, and nothing is left writing to a pipe whose reader
 * has gone.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJob } from './verdict-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object}   opts
 * @param {string}   opts.sessionId
 * @param {string}   opts.assistantText   the reply to audit
 * @param {string[]} [opts.userPrompts]
 * @param {string}   opts.apiUrl
 * @param {string}   opts.apiKey
 * @param {string}   [opts.repoRemote]
 * @param {number}   [opts.turnIndex]
 * @param {Function} [opts.spawnImpl]
 * @param {Function} [opts.writeJobImpl]
 * @param {string}   [opts.runnerPath]
 * @returns {{started: boolean, reason?: string}} never throws — the caller is a hook on the
 *   critical path of every reply, and a judge that could not be started is a turn that goes
 *   on without one, not a turn that breaks.
 */
export function startLocalJudge({
  sessionId,
  assistantText,
  userPrompts = [],
  apiUrl,
  apiKey,
  repoRemote = null,
  turnIndex = null,
  spawnImpl = spawn,
  writeJobImpl = writeJob,
  runnerPath = path.join(here, 'run-local-judge.js'),
} = {}) {
  if (!sessionId || !assistantText || !apiUrl || !apiKey) {
    return { started: false, reason: 'nothing to judge, or nowhere to ask' };
  }

  const jobFile = writeJobImpl(sessionId, {
    sessionId, assistantText, userPrompts, apiUrl, apiKey, repoRemote, turnIndex,
  });
  if (!jobFile) return { started: false, reason: 'the job could not be written' };

  try {
    const child = spawnImpl(process.execPath, [runnerPath, jobFile], {
      detached: true,
      // Ignored, not inherited. Inheriting would keep the hook's stdout open, and a hook
      // whose stdout is still open is a hook the harness is still waiting on — which is the
      // one thing this must not do.
      stdio: 'ignore',
    });
    child.unref();
    return { started: true };
  } catch (err) {
    return { started: false, reason: `the judge could not be started: ${err?.message || err}` };
  }
}
