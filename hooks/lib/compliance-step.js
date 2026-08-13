import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
    lines.push(`If the user says this was a false alarm, tell them to reply "誤判 ${checkId}".`);
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
      banner: '[OwnMind] compliance check is off for this session (lint disabled or warn mode)',
    };
  }
  // v1.26.171: an unconfigured machine used to return silent `none`, which reads exactly
  // like "checked and passed" — the impersonation this product forbids.
  if (!apiKey || !apiUrl) {
    return {
      action: 'notice',
      noticeKey: 'not-checked:no-credentials',
      banner: '[OwnMind] this machine has no credentials, so this turn was NOT checked',
    };
  }

  // A machine that never synced cannot check anything, and saying nothing there reads exactly
  // like "no rule applies to this turn".
  if (!bundle || bundle.present !== true) {
    return {
      action: 'notice',
      noticeKey: 'not-checked:never-synced',
      banner: '[OwnMind] this machine has never synced its rules, so this turn was NOT checked',
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
    return {
      action: 'notice',
      // One key for every failure reason: timeout and the backoff it triggers are the same
      // outage, and a key that flaps between them would re-announce on every flap.
      noticeKey: 'not-checked:check-failed',
      banner: `[OwnMind] compliance check did not run (${check.reason || 'unknown'}) - this turn was NOT checked`,
    };
  }
  // v1.26.171: 'skipped' means the SERVER declined to check (enforcement mode off for the
  // account, or it selected nothing). The off state was arriving with `enabled:false`,
  // being discarded, and reading like a clean verdict.
  if (check.outcome === 'skipped' && check.enabled === false) {
    return {
      action: 'notice',
      noticeKey: 'off:server',
      banner: '[OwnMind] enforcement is switched off for this account, so this turn was NOT checked',
    };
  }
  if (check.outcome !== 'violation' || !check.violations?.length) {
    return { action: 'none' };
  }

  const idNote = check.check_id ? ` [check ${check.check_id}: say "誤判 ${check.check_id}" if this is wrong]` : '';

  if (blockCount >= MAX_COMPLIANCE_BLOCKS) {
    return {
      action: 'notice',
      banner: `[OwnMind] the reply still breaks ${check.violations.length} rule(s) after `
        + `${blockCount} rewrites - showing you instead of asking again${idNote}`,
    };
  }

  return {
    action: 'exit2',
    stderr: formatViolationFeedback(check.violations, { checkId: check.check_id }),
    banner: `[OwnMind] compliance: ${check.violations.length} rule violation(s) sent back to the AI${idNote}`,
  };
}
