import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Looks up a compliance notice through t(), but this module's own notices are what tell the
 * user whether a turn was actually checked — that lookup must never depend on the same i18n
 * module it would be reporting on. A dynamic import here (not a static one at module scope)
 * means a broken hooks/lib/i18n.js only ever degrades one notice's text to its English
 * fallback; it cannot take the whole compliance step down, which would silently skip
 * checking the turn — the exact impersonation this step exists to prevent. Duplicated (not
 * shared) in hooks/lib/action-gate-cli.js, hooks/ownmind-iron-rule-check.js and
 * hooks/ownmind-reply-lint.js, same as the notice strings themselves.
 */
async function complianceNotice(key, fallback, params = {}) {
  try {
    const { t } = await import('./i18n.js');
    return t(key, params);
  } catch {
    return fallback;
  }
}

/**
 * Record why a check did not run, on the same fail-open terms as the notice lookup above.
 *
 * Dynamically imported for the same reason: this step is what tells the user whether their
 * turn was checked, and a broken diagnosis module must never be able to take it down — that
 * would trade a missing log line for a silently unchecked turn.
 */
async function recordCheckFailure(entry) {
  try {
    const { logCheckFailure } = await import('./check-failure-log.js');
    logCheckFailure(entry);
  } catch { /* the check itself still ran and still reports; only the diagnosis is lost */ }
}

/**
 * The per-turn compliance check, as a decision function.
 *
 * It lives here rather than inline in the stop hook because pasted-in code cannot be unit
 * tested, and the first draft of this feature referenced a constant that did not exist
 * (`LINT_DISABLED`; the hook's is `DISABLED`) inside a `catch` that swallowed the
 * ReferenceError. It would have shipped, passed review, and never once run. So the decision
 * is made here, with the network injected, and the hook only carries out what comes back.
 *
 * Everything it returns is advice: `action` tells the caller what to do, and the caller owns
 * the process. Nothing in here exits or writes to a terminal.
 */

/**
 * How many times one session's replies may be pushed back for a rule violation.
 *
 * Past this the finding goes to the user instead. An assistant that cannot satisfy the judge
 * and a judge that will not yield would otherwise trade turns until somebody interrupts, and
 * a loop is a worse failure than an uncorrected reply.
 */
export const MAX_COMPLIANCE_BLOCKS = 2;

function blockCountFile(sessionId) {
  return path.join(os.homedir(), '.ownmind', 'state', `compliance-blocks-${sessionId || 'unknown'}.json`);
}

/**
 * Its own counter, deliberately.
 *
 * The lint counter is shared by every validator and accumulates to a threshold of four; a
 * rule violation queued behind three unrelated ones would reach the assistant after the
 * damage. This one counts only pushbacks caused by rules.
 */
export function readComplianceBlockCount(sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(blockCountFile(sessionId), 'utf8'));
    return Number.isFinite(parsed?.count) ? parsed.count : 0;
  } catch {
    return 0;
  }
}

export function incrementComplianceBlockCount(sessionId) {
  try {
    const file = blockCountFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ count: readComplianceBlockCount(sessionId) + 1 }), 'utf8');
  } catch { /* a counter that cannot be persisted costs one extra round, nothing worse */ }
}

/**
 * Does anything in the cached rule set bear on this turn?
 *
 * Run locally so a turn that matches nothing costs no network call and no latency, which is
 * most turns. It mirrors the server's selection deliberately: if the two ever disagree, the
 * server is the one that decides, and this only ever declines to ask.
 */
export function anySelectorMatches(selectors, { assistantText, userPrompts, repoRemote, trigger }) {
  const hay = [assistantText || '', ...(userPrompts || [])].join('\n').toLowerCase();
  return (selectors || []).some((rule) => {
    if (!rule) return false;
    if (rule.always_check === true) return true;
    if (rule.repo_match && typeof repoRemote === 'string' && repoRemote.includes(rule.repo_match)) {
      return true;
    }
    if (Array.isArray(rule.keywords)
      && rule.keywords.some((k) => typeof k === 'string' && k && hay.includes(k.toLowerCase()))) {
      return true;
    }
    if (Array.isArray(rule.tags)) {
      if (rule.tags.includes('trigger:always')) return true;
      // A reply is several things at once - it is the assistant talking, and often reporting
      // on work as well - so the caller passes every label that fits and any of them counts.
      const triggers = Array.isArray(trigger) ? trigger : [trigger].filter(Boolean);
      return triggers.some((t) => rule.tags.includes(`trigger:${t}`));
    }
    return false;
  });
}

/**
 * What the assistant reads on stderr: the rule, its own words, and what to do instead.
 *
 * v1.26.171: also the check id. The stderr renders to the user as the block reason — the one
 * channel proven to reach a human — so the 誤判 handle has to ride here, not in a banner.
 */
export function formatViolationFeedback(violations, { checkId } = {}) {
  const lines = ['[OwnMind] This reply breaks rules you are required to follow:'];
  for (const v of violations) {
    const kind = v.ruleType === 'team_standard' ? 'Team standard' : 'Rule';
    lines.push(`  - ${kind} ${v.ruleId}${v.ruleCode ? ` (${v.ruleCode})` : ''}: ${v.ruleTitle}`);
    lines.push(`    Your words: "${v.evidence}"`);
    if (v.fix) lines.push(`    Do this instead: ${v.fix}`);
    if (v.ruleType === 'team_standard') {
      lines.push('    This is a team standard, not one of the user\'s own rules: their say-so');
      lines.push('    does not waive it. Ask them to reply with 「確認」 if they want it overridden.');
    }
  }
  lines.push('Rewrite the reply so it complies. Do not argue with the rule.');
  if (checkId) {
    // v1.30.1: this used to stop at "tell them to reply 誤判 N", and nothing downstream did
    // anything with that reply — the endpoint that records it (POST /api/compliance/feedback)
    // had no caller outside its own test. So the notice asked the user for something that went
    // nowhere, and the false-positive rate, which is the stated threshold for turning
    // enforcement on for anyone else, could never be computed. The instruction now names the
    // tool that records it.
    lines.push(
      `If the user says this was a false alarm, tell them to reply "誤判 ${checkId}". `
      + `When they do, call ownmind_report_check_feedback with check_id ${checkId} and `
      + 'verdict "false_positive" — their reply is only recorded if you make that call.',
    );
  }
  return lines.join('\n');
}

/**
 * @param {object} ctx
 * @returns {Promise<{action: 'exit2'|'notice'|'none', stderr?: string, banner?: string}>}
 */
export async function runComplianceStep(ctx) {
  const {
    disabled, mode, apiKey, apiUrl, sessionId,
    assistantText, userPrompts, repoRemote, trigger,
    bundle,
    blockCount = 0,
    requestCheckImpl,
  } = ctx;

  // Degraded is acceptable. Silent is not: a check that is switched off must never be
  // indistinguishable from a check that passed.
  if (disabled || mode === 'warn') {
    return {
      action: 'notice',
      noticeKey: 'off:warn-mode',
      banner: await complianceNotice(
        'compliance.off.warnMode',
        '[OwnMind] 🟡 In this conversation OwnMind only warns; it never asks the AI to rewrite.',
      ),
    };
  }
  // v1.26.171: an unconfigured machine used to return silent `none`, which reads exactly
  // like "checked and passed" — the impersonation this product forbids.
  if (!apiKey || !apiUrl) {
    return {
      action: 'notice',
      noticeKey: 'not-checked:no-credentials',
      banner: await complianceNotice(
        'compliance.notChecked.noCredentials',
        "[OwnMind] 🔴 This computer is not signed in to OwnMind, so OwnMind did not check the AI's reply.",
      ),
    };
  }

  // A machine that never synced cannot check anything, and saying nothing there reads exactly
  // like "no rule applies to this turn".
  if (!bundle || bundle.present !== true) {
    return {
      action: 'notice',
      noticeKey: 'not-checked:never-synced',
      banner: await complianceNotice(
        'compliance.notChecked.neverSynced',
        "[OwnMind] 🔴 This computer has not downloaded your rules yet, so OwnMind did not check the AI's reply. Start a new conversation and it will fetch them.",
      ),
    };
  }

  if (!anySelectorMatches(bundle.selectors, { assistantText, userPrompts, repoRemote, trigger })) {
    return { action: 'none' };
  }

  const check = await requestCheckImpl({
    apiUrl,
    apiKey,
    payload: {
      session_id: sessionId,
      assistant_text: assistantText,
      user_prompts: userPrompts || [],
      repo_remote: repoRemote || null,
      trigger: trigger || '',
    },
  });

  if (check.outcome === 'failed') {
    // v1.30.2: the reason is written down here and nowhere else. The notice cannot carry it —
    // 'http 401', 'timeout' and 'unknown' are the internal vocabulary the message rules ban,
    // and the version that spliced it into the sentence is what those rules were written
    // against. Taking it out left it with no sink at all, which made a revoked key and a
    // two-second blip the same event as far as anyone diagnosing the machine could tell.
    await recordCheckFailure({
      sessionId,
      failure: check.failure || 'unknown',
      reason: check.reason || 'unknown',
      checkId: check.check_id ?? null,
    });

    // A key the server will not accept is the one failure that never heals: waiting does
    // nothing, and only the user can fix it. It gets its own notice key as well as its own
    // sentence, or the throttle reads the move between the two states as "no change, stay
    // quiet" and the user keeps being told to wait for an outage that is not one.
    if (check.failure === 'unauthorized') {
      return {
        action: 'notice',
        noticeKey: 'not-checked:signed-out',
        banner: await complianceNotice(
          'compliance.notChecked.signedOut',
          "[OwnMind] 🔴 OwnMind does not recognise this computer any more, so OwnMind did not check the AI's reply. You need to sign in again: run the install command again with new sign-in details.",
        ),
      };
    }

    // The server answered and could not finish — its rule fetch failed, or the judge did.
    // "Could not reach its server" is simply false there, and it is the likeliest failure in
    // production, so it would have been the wrong sentence on the most common cause. It asks
    // nothing of the user, unlike the rejected key: there is nothing on this machine to fix.
    if (check.failure === 'server-declined') {
      return {
        action: 'notice',
        noticeKey: 'not-checked:server-declined',
        banner: await complianceNotice(
          'compliance.notChecked.serverDeclined',
          "[OwnMind] 🔴 OwnMind did not finish checking the AI's reply this time, so it did not check it. The problem is at OwnMind's end and usually clears on its own; nothing for you to do.",
        ),
      };
    }

    return {
      action: 'notice',
      // One key for every remaining failure reason: a timeout and the backoff it triggers are
      // the same outage, and a key that flaps between them would re-announce on every flap.
      noticeKey: 'not-checked:check-failed',
      banner: await complianceNotice(
        'compliance.notChecked.checkFailed',
        "[OwnMind] 🔴 OwnMind could not reach its server this time, so it did not check the AI's reply.",
      ),
    };
  }
  // v1.26.171: 'skipped' means the SERVER declined to check (enforcement mode off for the
  // account, or it selected nothing). The off state was arriving with `enabled:false`,
  // being discarded, and reading like a clean verdict.
  if (check.outcome === 'skipped' && check.enabled === false) {
    return {
      action: 'notice',
      noticeKey: 'off:server',
      banner: await complianceNotice(
        'compliance.off.server',
        "[OwnMind] 🔴 Rule checking is switched off for your account, so OwnMind did not check the AI's reply.",
      ),
    };
  }
  if (check.outcome !== 'violation' || !check.violations?.length) {
    return { action: 'none' };
  }

  const idNote = check.check_id
    ? await complianceNotice(
      'compliance.idNote',
      ` (if OwnMind got it wrong, reply 誤判 ${check.check_id})`,
      { checkId: check.check_id },
    )
    : '';

  if (blockCount >= MAX_COMPLIANCE_BLOCKS) {
    return {
      action: 'notice',
      banner: await complianceNotice(
        'compliance.blockCapReached',
        `[OwnMind] 🟡 The AI's reply still breaks ${check.violations.length} of your rules after `
          + `${blockCount} rewrites, so OwnMind has stopped sending it back and is showing it to you.${idNote}`,
        { count: check.violations.length, blockCount, idNote },
      ),
    };
  }

  return {
    action: 'exit2',
    stderr: formatViolationFeedback(check.violations, { checkId: check.check_id }),
    banner: await complianceNotice(
      'compliance.pushedBack',
      `[OwnMind] 🟢 The AI's reply breaks ${check.violations.length} of your rules, so OwnMind has told the AI to rewrite it.${idNote}`,
      { count: check.violations.length, idNote },
    ),
  };
}
