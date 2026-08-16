#!/usr/bin/env node
/**
 * The judge, running after the turn is over.
 *
 * Spawned detached by the Stop hook, which returns without waiting — measured, that hook
 * would otherwise hold the user for 29–54 seconds after every reply, against a client that
 * gives up at 5 and then silences the check for five minutes.
 *
 * Verified against the real harness before this was written: a detached child spawned from
 * the installed Stop hook survives the hook returning, reparented to init.
 *
 * WHAT IT DOES, in order, and why each step can fail without the others noticing:
 *
 *   1. asks the server which rules apply and for their text (the client holds selectors, not
 *      bodies), which also opens the row this verdict will be recorded against
 *   2. runs the judge on the user's own Claude Code subscription
 *   3. writes the verdict where the next turn will find it
 *   4. tells the server what the verdict was, so the audit row stops being `pending`
 *
 * Step 3 comes before step 4 deliberately. The verdict is for the user; the audit row is for
 * whoever reads the database later. If the network has gone away by the time this finishes —
 * which is likely, since it finishes long after the turn — the user still gets their answer.
 *
 * NOTHING HERE HAS ANYWHERE TO REPORT TO. It has no stdout anyone reads and no exit code
 * anyone checks. So every failure ends as a verdict file saying what failed, because a check
 * that did not run must not be indistinguishable from a reply with nothing wrong.
 */

import process from 'node:process';
import { judgeLocally } from './local-judge.js';
import { takeJob, writeVerdict } from './verdict-store.js';

/** Long enough for a slow gateway, short enough not to sit forever on a dead network. */
const HTTP_TIMEOUT_MS = 15_000;

async function post(url, apiKey, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`http ${res.status}`);
    // Carried so the caller can tell a rejected key from an outage. They ask different things
    // of the user — sign in again, versus do nothing — and only one of them heals on its own.
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function runJudgeJob(job, deps = {}) {
  const { judge = judgeLocally, postImpl = post, write = writeVerdict } = deps;
  const { sessionId, apiUrl, apiKey } = job;

  // 1. Which rules apply, and what do they say.
  let selection;
  try {
    selection = await postImpl(`${apiUrl}/api/compliance/check`, apiKey, {
      mode: 'select',
      session_id: sessionId,
      turn_index: job.turnIndex ?? null,
      assistant_text: job.assistantText,
      user_prompts: job.userPrompts || [],
      repo_remote: job.repoRemote || null,
      trigger: job.trigger || '',
    });
  } catch (err) {
    const rejected = err?.status === 401 || err?.status === 403;
    write(sessionId, {
      outcome: 'failed',
      failure: rejected ? 'unauthorized' : 'server-unreachable',
      reason: `could not ask which rules apply: ${err?.message || err}`,
      violations: [],
    });
    return;
  }

  // The account is off, or nothing applied to this turn. Either way there is nothing to
  // judge and nothing to say — but the row, if one was opened, is already settled by the
  // server, so there is nothing to resolve either.
  if (selection?.enabled === false || selection?.outcome === 'skipped') return;

  // 2. Judge it, here, on this user's own subscription.
  const verdict = await judge({
    rules: selection.rules || [],
    assistantText: job.assistantText,
    userPrompts: job.userPrompts || [],
  });

  // 3. The user's answer first — the network is the thing most likely to be gone by now.
  write(sessionId, {
    outcome: verdict.outcome,
    violations: verdict.violations,
    failure: verdict.failure || null,
    reason: verdict.reason || null,
    check_id: selection.check_id ?? null,
    latency_ms: verdict.latencyMs,
  });

  // 4. Close the audit row. A row left `pending` is a check nobody can prove ran, which is
  // the number that will say whether any of this worked.
  if (Number.isInteger(selection.check_id)) {
    try {
      await postImpl(`${apiUrl}/api/compliance/resolve`, apiKey, {
        check_id: selection.check_id,
        outcome: verdict.outcome,
        verdicts: verdict.verdicts || [],
        latency_ms: verdict.latencyMs,
      });
    } catch { /* the user has their verdict; the audit row stays pending and countable */ }
  }
}

async function main() {
  const jobFile = process.argv[2];
  if (!jobFile) process.exit(0);
  const job = takeJob(jobFile);
  if (!job || !job.sessionId || !job.assistantText) process.exit(0);
  try {
    await runJudgeJob(job);
  } catch (err) {
    // The last resort. Something here threw where nothing was supposed to, and the turn it
    // belongs to ended long ago — so the only way to say so is the verdict file itself.
    try {
      writeVerdict(job.sessionId, {
        outcome: 'failed',
        failure: 'judge-crashed',
        reason: String(err?.message || err).slice(0, 200),
        violations: [],
      });
    } catch { /* nothing left to try */ }
  }
  process.exit(0);
}

// Only when run as a program, so importing it for tests does not start a judge.
if (process.argv[1] && process.argv[1].endsWith('run-local-judge.js')) {
  main();
}
