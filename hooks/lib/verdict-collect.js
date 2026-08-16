/**
 * Picking up a verdict that arrived after the turn it belongs to.
 *
 * The judge runs detached and takes 29–54 seconds, which is usually less than the time a
 * person spends reading a reply and typing the next thing. So by the next turn the answer is
 * normally waiting, and this is where it is collected.
 *
 * A decision function, not a hook: the caller owns stdout and the process. The first draft of
 * the compliance step was pasted inline into a hook, referenced a constant that did not
 * exist, and the ReferenceError was swallowed by a catch — it would have shipped and never
 * once run.
 */

import { takeVerdict } from './verdict-store.js';

/**
 * Looks a notice up through t(), and falls back to the exact English literal.
 *
 * Dynamically imported for the reason every notice in this codebase is: these lines are what
 * tell the user whether their turn was checked, and a broken message layer must not be able
 * to take that down.
 */
async function notice(key, fallback, params = {}) {
  try {
    const { t } = await import('./i18n.js');
    const rendered = t(key, params);
    return typeof rendered === 'string' && rendered !== key ? rendered : fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {Function} [opts.take] injectable for tests
 * @returns {Promise<{action: 'none'}|{action: 'notice', banner: string, forAssistant?: string}>}
 */
export async function collectVerdict({ sessionId, take = takeVerdict } = {}) {
  const verdict = take(sessionId);

  // Nothing waiting. The judge is still running, or this turn was never judged. Either way
  // there is nothing to say — and this is the common case, so it must cost nothing.
  if (!verdict) return { action: 'none' };

  if (verdict.outcome === 'failed') {
    // A key the server will not accept is the one failure waiting never fixes, and only the
    // user can. It kept its own sentence when the judge moved off the server; collapsing it
    // into "could not check" would tell someone to sit tight through an outage that is not one.
    const banner = verdict.failure === 'unauthorized'
      ? await notice(
        'compliance.notChecked.signedOut',
        "[OwnMind] 🔴 OwnMind does not recognise this computer any more, so OwnMind did not check the AI's reply. You need to sign in again: run the install command again with new sign-in details.",
      )
      : await notice(
        'verdict.notChecked',
        "[OwnMind] 🔴 OwnMind could not check the AI's last reply.\n"
        + '  Re-running the OwnMind update script usually repairs it; until then nothing is checking the AI against your rules.',
      );
    return {
      action: 'notice',
      banner,
      // The assistant gets the detail the user's line deliberately does not carry: `no-cli`,
      // `timeout` and the rest are the internal vocabulary the message rules ban.
      forAssistant: `[OwnMind] The reply check did not run for your previous reply `
        + `(${verdict.failure || 'unknown'}${verdict.reason ? `: ${verdict.reason}` : ''}). `
        + 'Tell the user this, in the language you are speaking with them.',
    };
  }

  if (verdict.outcome !== 'violation' || !verdict.violations?.length) {
    // Checked, nothing wrong. Silence is the everyday path and stays free.
    return { action: 'none' };
  }

  const lines = verdict.violations.map((v) => {
    const name = [v.ruleCode, v.ruleTitle].filter(Boolean).join(': ');
    return `  - ${name}\n    evidence: ${v.evidence}\n    fix: ${v.fix}`;
  });

  // The handle for saying it got this wrong. Without it the false-positive rate — the stated
  // threshold for turning enforcement on for anybody besides its author — cannot be counted,
  // because nothing else in the product records a disagreement.
  const checkId = verdict.check_id;
  const idNote = checkId
    ? await notice('compliance.idNote', ` (if OwnMind got it wrong, reply 誤判 ${checkId})`, { checkId })
    : '';

  return {
    action: 'notice',
    banner: await notice(
      'verdict.violation',
      `[OwnMind] 🟢 OwnMind checked the AI's last reply and one of your rules was not met: ${verdict.violations[0].ruleTitle}\n`
      + '  OwnMind has handed this to the AI and it will correct itself this turn. Nothing for you to do.',
      { title: verdict.violations[0].ruleTitle },
    ) + idNote,
    // Written as an instruction rather than a report: the turn this belongs to is over, so
    // the only thing that can act on it is the reply about to be written.
    forAssistant: `[OwnMind] Your previous reply broke ${verdict.violations.length === 1 ? 'a rule' : 'rules'} `
      + 'the user wrote. This is not a request to apologise or to explain yourself — it is the '
      + 'correction to apply from here on:\n'
      + `${lines.join('\n')}\n`
      + 'Follow it in this reply. Do not restate the finding back to the user; they have already been shown it.'
      + (checkId
        ? `\nIf the user says this was a false alarm, call ownmind_report_check_feedback with `
          + `check_id ${checkId} and verdict "false_positive" — their reply is only recorded if `
          + 'you make that call.'
        : ''),
  };
}
