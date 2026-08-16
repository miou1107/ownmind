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
import { replyExcerpt, takeJob, writeVerdict } from './verdict-store.js';
import { redact, toReason } from './redact.js';

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
  const { sessionId, turnId, apiUrl, apiKey } = job;
  // Carried into every record. A verdict that lands two turns late has to say which reply it
  // is about, or the correction is applied to a reply that was never judged.
  const excerpt = replyExcerpt(job.assistantText);

  // EVERY PATH OUT OF HERE WRITES. The parent left a `pending` marker before spawning this
  // process, and a marker nobody resolves becomes "the judge never came back" three minutes
  // later — which is a true sentence about a dead judge and a false one about a check that
  // was simply not wanted.
  const settle = (record) => write(sessionId, turnId, { violations: [], reply_excerpt: excerpt, ...record });

  // 1. Which rules apply, and what do they say.
  let selection;
  try {
    selection = await postImpl(`${apiUrl}/api/compliance/check`, apiKey, {
      mode: 'select',
      session_id: sessionId,
      // The reply and the prompts leave the machine here. Redacted on the way out, the same
      // way the client this replaced did it: an AI reply quoting a config file or a curl
      // command carries whatever the user was working on.
      assistant_text: redact(job.assistantText),
      user_prompts: (job.userPrompts || []).map(redact),
      repo_remote: job.repoRemote || null,
      trigger: job.trigger || '',
    });
  } catch (err) {
    const rejected = err?.status === 401 || err?.status === 403;
    settle({
      outcome: 'failed',
      failure: rejected ? 'unauthorized' : 'server-unreachable',
      reason: toReason(`could not ask which rules apply: ${err?.message || err}`),
    });
    return;
  }

  // THE SERVER ANSWERED AND COULD NOT FINISH. Checked before `enabled`, and deliberately:
  // its rule fetch failing answers `{enabled: true, outcome: 'failed'}` with NO rules, and
  // its account lookup failing answers `{enabled: false, outcome: 'failed'}`. Reading
  // `enabled` first made the first case fall through to a judge with an empty rule list —
  // which returns 'skipped', which is silence — and the second case say "you switched rule
  // checking off", which is a false statement about the user's own settings.
  if (selection?.outcome === 'failed') {
    settle({
      outcome: 'failed',
      failure: 'server-declined',
      reason: 'the server could not finish working out which rules apply',
      check_id: selection.check_id ?? null,
    });
    return;
  }

  // The account has rule checking switched off. The product calls this its loudest state and
  // the first version made it its quietest: this returned without writing, so the user was
  // told nothing at all and the marker expired as a failure that had not happened.
  if (selection?.enabled === false) {
    settle({ outcome: 'disabled', check_id: selection.check_id ?? null });
    return;
  }

  // Nothing applied to this turn, which is most turns. Silent to the user, but the marker
  // still has to be resolved — and the row, if one was opened, the server already settled.
  if (selection?.outcome === 'skipped') {
    settle({ outcome: 'skipped', check_id: selection.check_id ?? null });
    return;
  }

  // A 200 that carries neither rules nor a recognised outcome. Judging an empty rule list
  // returns 'skipped', and 'skipped' is silence — so an answer this code does not understand
  // must not be allowed to become "checked, nothing wrong".
  if (!Array.isArray(selection?.rules)) {
    settle({
      outcome: 'failed',
      failure: 'server-declined',
      reason: toReason(`the server answered without a rule list: ${JSON.stringify(selection)}`),
      check_id: selection?.check_id ?? null,
    });
    return;
  }

  // 2. Judge it, here, on this user's own subscription.
  const verdict = await judge({
    rules: selection.rules || [],
    assistantText: job.assistantText,
    userPrompts: job.userPrompts || [],
  });

  // 3. The user's answer first — the network is the thing most likely to be gone by now.
  settle({
    outcome: verdict.outcome,
    violations: verdict.violations,
    failure: verdict.failure || null,
    reason: verdict.reason ? toReason(verdict.reason) : null,
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
      writeVerdict(job.sessionId, job.turnId, {
        outcome: 'failed',
        failure: 'judge-crashed',
        reason: toReason(err?.message || err),
        reply_excerpt: replyExcerpt(job.assistantText),
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
