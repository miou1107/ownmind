/**
 * Picking up verdicts that arrived after the turns they belong to.
 *
 * The judge runs detached and takes 29–54 seconds, which is usually less than the time a
 * person spends reading a reply and typing the next thing. So by the next turn the answer is
 * normally waiting, and this is where it is collected.
 *
 * VERDICTS, PLURAL. A judge slower than the user leaves two waiting, and the first version
 * could only carry one — the older one was overwritten before anybody read it. Everything
 * that has landed is delivered, and each one says which reply it is about, because "your last
 * reply" stops being true the moment a verdict is a turn late.
 *
 * WHAT IS NOT SAID MATTERS AS MUCH. A judge still within its time is silence, because most
 * turns are that. A judge past its time is a notice, because a check that was started and
 * never came back is a turn nobody checked — and the failure this whole feature exists to
 * remove is that being indistinguishable from a reply with nothing wrong.
 *
 * A decision function, not a hook: the caller owns stdout and the process. The first draft of
 * the compliance step was pasted inline into a hook, referenced a constant that did not
 * exist, and the ReferenceError was swallowed by a catch — it would have shipped and never
 * once run.
 *
 * KNOWN LIMITATION, written down so it is not rediscovered as a bug. Collection only happens
 * on the next `UserPromptSubmit`, so the LAST reply of a conversation is never collected: a
 * rule broken there is judged, recorded, and never shown to anybody. Delivering it would mean
 * opening the next conversation with a note about the previous one, which is a product
 * decision rather than a fix, so it is not made here. The verdict is not lost — it sits in
 * the state directory until the seven-day sweep.
 */

import {
  listVerdicts, readVerdict, removeVerdict, sweepStaleSessions, JUDGE_DEADLINE_MS,
} from './verdict-store.js';

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
 * Record why a check did not run, where somebody diagnosing the machine can read it.
 *
 * The user's line deliberately carries no error vocabulary — `no-cli`, `timeout` and the rest
 * are exactly what the message rules ban — so without this the detail has no sink at all, and
 * a revoked key and a two-second blip look the same to whoever is asked to explain it.
 */
async function defaultLogFailure(entry) {
  try {
    const { logCheckFailure } = await import('./check-failure-log.js');
    logCheckFailure(entry);
  } catch { /* the verdict still reaches the user; only the diagnosis is lost */ }
}

/**
 * Throttling, in its own namespace.
 *
 * The Stop hook runs `decideNotice` for this same session on every turn with the state IT
 * knows about — whether a judge was started. This is a different state machine on a different
 * hook, and sharing one slot would make each read the other's key as a state change: the user
 * would be told checking had recovered, then failed, on alternate turns, forever.
 */
async function defaultSpeak(sessionId, noticeKey) {
  try {
    const { decideNotice } = await import('./notice-throttle.js');
    return decideNotice(`${sessionId}#verdict`, noticeKey);
  } catch {
    // A throttle that cannot be consulted over-speaks. That is the safe direction for a
    // channel whose failure mode was silence.
    return true;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {Function} [opts.list]        injectable for tests
 * @param {Function} [opts.remove]
 * @param {Function} [opts.speak]       (noticeKey) => boolean, for state-shaped notices
 * @param {Function} [opts.logFailure]
 * @param {Function} [opts.now]
 * @param {number}   [opts.deadlineMs]
 * @returns {Promise<{action: 'none'}|{action: 'notice', banner: string, forAssistant: string}>}
 */
export async function collectVerdict({
  sessionId,
  list = listVerdicts,
  remove = removeVerdict,
  speak = null,
  logFailure = defaultLogFailure,
  reread = readVerdict,
  sweep = sweepStaleSessions,
  now = Date.now,
  deadlineMs = JUDGE_DEADLINE_MS,
} = {}) {
  const decide = speak || ((key) => defaultSpeak(sessionId, key));

  const waiting = list(sessionId);
  // Nothing waiting. The judge is still running, or this turn was never judged. Either way
  // there is nothing to say — and this is the common case, so it must cost nothing.
  if (!waiting.length) return { action: 'none' };

  const banners = [];
  const contexts = [];
  // A turn that produced a real verdict is a turn the check ran on. Recorded so the throttle
  // can return to a healthy state; without it the state stays stuck on the last failure key,
  // and a genuinely NEW failure of the same kind reads as "no change" and is suppressed.
  let checkRan = false;

  for (const entry of waiting) {
    const { turnId } = entry;
    let record = entry.record;

    if (record?.outcome === 'pending') {
      const age = now() - (Number.isFinite(record.started_at) ? record.started_at : 0);
      // Still within its time. Leave the marker exactly where it is — taking it would throw
      // away the verdict that is about to land in it.
      if (age < deadlineMs) continue;

      // Read once more before writing it off. The listing and this line are not one
      // operation, and the judge writes by renaming onto exactly this path — so a judge that
      // finished in between would have its finding deleted here and announced as a judge that
      // never came back. Measured budget is 115s against a 180s deadline; that gap is not
      // wide enough to leave the race open.
      const fresh = reread(sessionId, turnId);
      // Gone entirely: another window on this session took it, or the sweep did. Announcing
      // "the judge never came back" there is a false alarm about a verdict that was, in all
      // likelihood, delivered by whoever took it — the same distinction listVerdicts makes
      // twenty lines away, which this had been missing.
      if (fresh === undefined) continue;
      if (fresh && fresh.outcome !== 'pending') {
        record = fresh;                       // it landed after all — fall through and deliver
      } else {
        remove(sessionId, turnId);
        await logFailure({ sessionId, failure: 'judge-vanished', reason: `no verdict within ${deadlineMs}ms`, checkId: null });
        if (await decide('not-checked:judge-vanished')) {
          banners.push(await notice(
            'verdict.didNotFinish',
            "[OwnMind] 🔴 OwnMind started checking one of the AI's replies and never heard back, so that reply was not checked against your rules.\n"
            + '  The next reply is checked from scratch. If this keeps happening, run the OwnMind update script.',
          ));
          contexts.push(assistantLine(
            'A reply check was started and never finished, so one of your earlier replies was not checked '
            + 'against the user\'s rules.', record,
          ));
        }
        continue;
      }
    }

    const outcome = record?.outcome;

    remove(sessionId, turnId);

    if (outcome === 'disabled') {
      // The loudest state the product has, and the first version made it the quietest: the
      // judge returned without writing anything at all.
      if (await decide('off:server')) {
        banners.push(await notice(
          'compliance.off.server',
          "[OwnMind] 🔴 Rule checking is switched off for your account, so OwnMind did not check the AI's reply.",
        ));
      }
      continue;
    }

    if (outcome === 'failed') {
      await logFailure({
        sessionId,
        failure: record.failure || 'unknown',
        reason: record.reason || 'unknown',
        checkId: record.check_id ?? null,
      });
      const { key, banner } = await failureNotice(record);
      if (await decide(key)) {
        banners.push(banner);
        contexts.push(assistantLine(
          `The reply check did not run (${record.failure || 'unknown'}${record.reason ? `: ${record.reason}` : ''}).`,
          record,
        ));
      }
      continue;
    }

    // 'skipped' is a turn no rule applied to, which is most turns. Silent, but its marker has
    // to be cleared — done above — or the deadline turns every ordinary turn into a failure.
    //
    // And it is NOT evidence that checking works. The server decided nothing applied, so the
    // judge was never launched; counting it as healthy announced 🟢 "OwnMind is checking your
    // replies again" on a machine with no Claude Code on it, and alternated with the 🔴 on
    // every turn a rule DID apply — which defeats the throttle as well as being untrue.
    if (outcome === 'skipped') continue;

    // A verdict the judge actually produced. This is the only thing that proves the check
    // works end to end on this machine.
    checkRan = true;

    if (outcome !== 'violation' || !record.violations?.length) continue;

    banners.push(await violationBanner(record));
    contexts.push(violationContext(record));
  }

  // Recovery, announced once. `decide(null)` is what decides that, and it has a side effect:
  // it moves the throttle back to the healthy state. So it is called on EVERY turn that knows
  // the check is healthy, including turns that also carried a finding — guarding it behind
  // "no other banners" left the throttle parked on the last failure key, and the next failure
  // of that same kind then read as "no change, stay quiet" and went unannounced. That is a
  // turn that was not checked and nobody told, which is the failure this file exists for.
  if (checkRan) {
    const announce = await decide(null);
    if (announce && !banners.length) {
      banners.push(await notice(
        'verdict.recovered',
        "[OwnMind] 🟢 OwnMind is checking the AI's replies against your rules again. Nothing for you to do.",
      ));
    }
  }

  try { sweep(); } catch { /* housekeeping never costs a verdict */ }

  if (!banners.length && !contexts.length) return { action: 'none' };
  return {
    action: 'notice',
    banner: banners.join('\n'),
    forAssistant: contexts.join('\n\n'),
  };
}

/**
 * Which sentence a failure gets, and which throttle key it counts against.
 *
 * Each of these asks something different of the user — sign in again, install Claude Code,
 * sit tight — so they cannot share a sentence, and they cannot share a key either: a key that
 * flapped between two states would read every move as "no change, stay quiet".
 */
async function failureNotice(record) {
  if (record.failure === 'unauthorized') {
    return {
      key: 'not-checked:signed-out',
      banner: await notice(
        'compliance.notChecked.signedOut',
        "[OwnMind] 🔴 OwnMind does not recognise this computer any more, so OwnMind did not check the AI's reply. You need to sign in again: run the install command again with new sign-in details.",
      ),
    };
  }
  if (record.failure === 'no-cli') {
    // The generic line tells the user to re-run the update script. That installs OwnMind; it
    // cannot install the CLI the judge runs on, so it was a repair that could never repair
    // this — printed every tenth turn, indefinitely.
    return {
      key: 'not-checked:no-cli',
      banner: await notice(
        'verdict.notChecked.noCli',
        "[OwnMind] 🔴 OwnMind checks the AI's replies by asking Claude Code on this computer, and it could not find it, so that reply was not checked.\n"
        + '  Install Claude Code on this computer and make sure typing claude in a terminal starts it.',
      ),
    };
  }
  if (record.failure === 'not-logged-in') {
    return {
      key: 'not-checked:not-logged-in',
      banner: await notice(
        'verdict.notChecked.notLoggedIn',
        "[OwnMind] 🔴 Claude Code on this computer is not signed in, so OwnMind could not have it check the AI's reply.\n"
        + '  Sign in to Claude Code again and checking comes back on its own.',
      ),
    };
  }
  if (record.failure === 'server-declined') {
    // The server answered and could not finish — its rule fetch failed, or its account
    // lookup did. "Could not reach its server" is simply false about it, and it points the
    // reader at their own network. It asks nothing of them: there is nothing here to fix.
    return {
      key: 'not-checked:server-declined',
      banner: await notice(
        'verdict.notChecked.serverDeclined',
        "[OwnMind] 🔴 OwnMind could not work out which of your rules applied to the AI's reply, so that reply was not checked.\n"
        + "  The problem is at OwnMind's end and usually clears on its own; nothing for you to do.",
      ),
    };
  }
  // 'spawn' is every non-ENOENT failure to start it: no permission on the binary, a broken
  // shim. Claude Code's end, like the refusals below, so it takes the same sentence rather
  // than the generic one that sends the reader to OwnMind's updater.
  if (record.failure === 'exit' || record.failure === 'spawn') {
    // Everything else Claude Code refuses for: a usage limit reached, a model not available,
    // a configuration it will not accept. All of them are at Claude Code's end, and pointing
    // the user at OwnMind's updater sends them to the wrong machine entirely.
    return {
      key: 'not-checked:cli-refused',
      banner: await notice(
        'verdict.notChecked.cliRefused',
        "[OwnMind] 🔴 OwnMind asked Claude Code on this computer to check the AI's reply and it would not, so that reply was not checked.\n"
        + '  Try running claude yourself in a terminal: whatever it says there is what OwnMind ran into.',
      ),
    };
  }
  return {
    key: 'not-checked:check-failed',
    banner: await notice(
      'verdict.notChecked',
      "[OwnMind] 🔴 OwnMind could not check one of the AI's earlier replies, so that reply was not checked against your rules.\n"
      + '  Re-running the OwnMind update script usually repairs it; until then nothing is checking the AI against your rules.',
    ),
  };
}

/**
 * What the user is told about a reply that broke rules.
 *
 * 🟡, not 🟢, and it says why. This path runs after the user has already read the reply — it
 * cannot stop anything, it can only tell the AI. The product's own rule is that a mechanism
 * which only reminds has to say it only reminds; the first version said "it will correct
 * itself this turn. Nothing for you to do", which is a promise nothing here can keep.
 */
async function violationBanner(record) {
  const count = record.violations.length;
  const first = record.violations[0].ruleTitle;
  const checkId = record.check_id;
  // The handle for saying it got this wrong. Without it the false-positive rate — the stated
  // threshold for turning enforcement on for anybody besides its author — cannot be counted,
  // because nothing else in the product records a disagreement.
  const idNote = checkId
    ? await notice('compliance.idNote', ` (if OwnMind got it wrong, reply 誤判 ${checkId})`, { checkId })
    : '';
  return await notice(
    'verdict.violation',
    `[OwnMind] 🟡 OwnMind checked one of the AI's earlier replies and it breaks ${count} of your rules, starting with ${first}\n`
    + '  OwnMind has passed this to the AI, which should correct itself from here. This is a reminder, not a block: OwnMind cannot make it comply, so check that it did.',
    { count, title: first },
  ) + idNote;
}

/**
 * The instruction the assistant reads.
 *
 * Written as an instruction rather than a report: the turn this belongs to is over, so the
 * only thing that can act on it is the reply about to be written. It names the reply, because
 * a verdict that arrives two turns late used to say "your previous reply" — which is a
 * different reply, and the correction went to the wrong one and stayed offset from then on.
 */
function violationContext(record) {
  const lines = record.violations.map((v) => {
    const name = [v.ruleCode, v.ruleTitle].filter(Boolean).join(': ');
    return `  - ${name}\n    evidence: ${v.evidence}\n    fix: ${v.fix}`
      // A team standard belongs to the company, not to the person in this conversation, so
      // "the user said it was fine" is not a waiver. The synchronous path said this and the
      // async one did not; without it the AI learns it can be talked out of somebody else's
      // rule by the one person who cannot lift it.
      + (v.ruleType === 'team_standard'
        ? '\n    This is a team standard, not one of the user\'s own rules: their say-so does not'
          + '\n    waive it. Ask them to reply with 「確認」 if they want it overridden.'
        : '');
  });
  const checkId = record.check_id;
  return `${assistantLine(
    `An earlier reply of yours broke ${record.violations.length === 1 ? 'a rule' : 'rules'} the user wrote.`,
    record,
  )}\n`
    + 'This is not a request to apologise or to explain yourself — it is the correction to apply '
    + 'from here on:\n'
    + `${lines.join('\n')}\n`
    + 'Follow it in this reply. Do not restate the finding back to the user; they have already been shown it.'
    + (checkId
      ? `\nIf the user says this was a false alarm, call ownmind_report_check_feedback with `
        + `check_id ${checkId} and verdict "false_positive" — their reply is only recorded if `
        + 'you make that call.'
      : '');
}

/** Every line to the assistant names which reply it is about, or it is about the wrong one. */
function assistantLine(sentence, record) {
  const excerpt = record?.reply_excerpt;
  return `[OwnMind] ${sentence}`
    + (excerpt ? `\nThe reply in question began: "${excerpt}"` : '')
    + (excerpt ? '' : '\nOwnMind could not record which reply; treat it as one of your recent ones.');
}
