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
 *
 * THE MARKER IS WRITTEN HERE, BY THE PARENT, BEFORE THE SPAWN. A child that dies on the way
 * up writes nothing, and nothing written is what a clean reply also looks like — so the one
 * process that can record "a judge was started" is the one that started it.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listVerdicts, makeTurnId, removeVerdict, replyExcerpt, stateDir, textHash, writeJob, writeVerdict,
} from './verdict-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {object}   opts
 * @param {string}   opts.sessionId
 * @param {string}   opts.assistantText   the reply to audit
 * @param {string[]} [opts.userPrompts]
 * @param {string}   opts.apiUrl
 * @param {string}   opts.apiKey
 * @param {string}   [opts.repoRemote]
 * @param {string|string[]} [opts.trigger]
 * @param {string}   [opts.stateDirImpl]  injectable for tests
 * @param {Function} [opts.spawnImpl]
 * @param {string}   [opts.runnerPath]
 * @returns {{started: boolean, turnId?: string, reason?: string}} never throws — the caller is
 *   a hook on the critical path of every reply, and a judge that could not be started is a
 *   turn that goes on without one, not a turn that breaks.
 */
export function startLocalJudge({
  sessionId,
  assistantText,
  userPrompts = [],
  apiUrl,
  apiKey,
  repoRemote = null,
  trigger = '',
  stateDirImpl = null,
  spawnImpl = spawn,
  runnerPath = path.join(here, 'run-local-judge.js'),
} = {}) {
  if (!sessionId || !assistantText || !apiUrl || !apiKey) {
    return { started: false, reason: 'nothing to judge, or nowhere to ask' };
  }

  const dir = stateDirImpl || stateDir();

  // The same reply reaching this twice is not hypothetical: the Stop hook runs ahead of the
  // `stop_hook_active` return by design, so a turn another validator pushed back arrives here
  // again with the same text. A second judge for it spends the user's own subscription twice
  // and produces a second verdict saying what the first one already said.
  const hash = textHash(assistantText);
  const alreadyRunning = listVerdicts(sessionId, dir)
    .some((v) => v.record?.outcome === 'pending' && v.record?.text_hash === hash);
  if (alreadyRunning) return { started: true, alreadyRunning: true };

  const turnId = makeTurnId(assistantText);

  // Before the job, before the spawn. Ordering is the point: everything after this can fail
  // in a way that leaves no evidence, and this is the evidence.
  const marked = writeVerdict(sessionId, turnId, {
    outcome: 'pending',
    started_at: Date.now(),
    text_hash: hash,
    reply_excerpt: replyExcerpt(assistantText),
    violations: [],
  }, dir);
  if (!marked) return { started: false, reason: 'the state directory could not be written' };

  const jobFile = writeJob(sessionId, turnId, {
    sessionId, turnId, assistantText, userPrompts, apiUrl, apiKey, repoRemote, trigger,
  }, dir);
  if (!jobFile) {
    removeVerdict(sessionId, turnId, dir);
    return { started: false, reason: 'the job could not be written' };
  }

  try {
    const child = spawnImpl(process.execPath, [runnerPath, jobFile], {
      detached: true,
      // Ignored, not inherited. Inheriting would keep the hook's stdout open, and a hook
      // whose stdout is still open is a hook the harness is still waiting on — which is the
      // one thing this must not do.
      stdio: 'ignore',
    });
    child.unref();
    return { started: true, turnId };
  } catch (err) {
    // The hook is about to tell the user this failed. Leaving the marker would tell them a
    // second time three minutes later, naming a judge that was never started.
    removeVerdict(sessionId, turnId, dir);
    return { started: false, reason: `the judge could not be started: ${err?.message || err}` };
  }
}
