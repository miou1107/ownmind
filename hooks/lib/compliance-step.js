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
 * Everything that can be decided on this machine, before anything is asked of anyone.
 *
 * Shared by both callers: the turn either cannot be checked (each reason with its own
 * sentence and its own throttle key) or nothing in the cached rule set bears on it. Only past
 * this point does a check cost a network call, a subscription, or a second of anyone's time.
 *
 * @returns {Promise<object|null>} a result the caller should return as-is, or null to proceed.
 */
async function preflight({ disabled, mode, apiKey, apiUrl, bundle, assistantText, userPrompts, repoRemote, trigger }) {
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

  return null;
}

/**
 * Hand this turn to a judge running on the user's own subscription, and return.
 *
 * The judging itself takes 29–54 seconds — measured, real CLI, real payload — so nothing here
 * waits for it. What comes back is only whether a judge was started; the verdict reaches the
 * user through `verdict-collect.js` on the following turn.
 *
 * The trade is written down in the plan and repeated here because it is a real loss: the check
 * can no longer stop a reply before the user reads it. It buys a check that actually runs.
 *
 * @param {object} ctx
 * @returns {Promise<{action: 'notice'|'none', noticeKey?: string, banner?: string}>}
 */
export async function startComplianceCheck(ctx) {
  const stop = await preflight(ctx);
  if (stop) return stop;

  const { sessionId, assistantText, userPrompts, repoRemote, trigger, apiUrl, apiKey } = ctx;
  const started = ctx.startJudgeImpl({
    sessionId,
    assistantText,
    userPrompts: userPrompts || [],
    apiUrl,
    apiKey,
    repoRemote: repoRemote || null,
    trigger: trigger || '',
  });

  if (started?.started === true) return { action: 'none' };

  // Nothing will write a verdict file, so nothing downstream will ever notice this turn went
  // unchecked. This is the only place it can be said.
  return {
    action: 'notice',
    noticeKey: 'not-checked:judge-not-started',
    banner: await complianceNotice(
      'compliance.notChecked.judgeNotStarted',
      "[OwnMind] 🔴 OwnMind could not start checking the AI's reply, so this reply was not checked against your rules. Re-running the OwnMind update script usually repairs it.",
    ),
  };
}
