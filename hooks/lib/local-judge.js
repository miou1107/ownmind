/**
 * The judge, run on this machine against the user's own Claude Code subscription.
 *
 * WHY IT IS HERE AND NOT ON THE SERVER. The owner's standing instruction is that anything
 * OwnMind asks a model to decide is spent from the user's own subscription, never the llm
 * switch. A subscription lives on the machine that holds its credentials, so the judging has
 * to live there too. The switch path was also failing about half the time — 474 of 1006
 * checks, and 6 of 12 direct gateway calls came back `502 All 2 provider attempts failed`.
 *
 * WHAT WAS MEASURED before this was written:
 *
 *   - `claude -p` answers headlessly and spends the subscription
 *   - a real payload (8 rules, a long reply) takes ~18s on haiku and ~43s on sonnet; a bare
 *     "reply OK" takes 10.5s, so roughly ten of those seconds are startup
 *   - a prompt beginning `---` is parsed as a FLAG. That is not a style preference — it is
 *     how the first probe of this died, with `error: unknown option '--- RULE 795: …'`
 *
 * WHICH IS WHY the prompt goes on stdin, and there is a test that fails if it moves to argv.
 *
 * THE ONE RULE EVERY FAILURE PATH FOLLOWS: a judge that did not run must never come back
 * looking like a reply that broke no rules. An empty violations list is a finding about the
 * reply; `outcome: 'failed'` is a fact about the check. They are different answers and the
 * caller is entitled to tell them apart.
 */

import { spawn } from 'node:child_process';
import { redact } from './redact.js';
import {
  JUDGE_SYSTEM,
  buildJudgeUserPrompt,
  parseJudgeAnswer,
  normaliseVerdicts,
} from '../../shared/judge-prompt.js';

/**
 * Long enough for the slowest measured run, and no longer.
 *
 * haiku answered a production-sized payload in 18s and, once, 57s. Nobody waits on this —
 * the caller starts it and returns — so the budget exists to stop a wedged process living
 * forever, not to keep a user's attention.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * The smallest model that can do this job, because it runs on every checked turn.
 *
 * Measured on a production-sized payload: haiku 18s, sonnet 43s. Judging a reply against
 * written rules is a reading task, not a reasoning one, and the user pays for the difference
 * out of their own quota.
 */
const DEFAULT_MODEL = 'haiku';

/** How much of an unusable answer to keep, so the next one can be diagnosed from the log. */
const EXCERPT_CHARS = 200;

/**
 * Judge one reply against the rules the server said apply to it.
 *
 * @param {object}   opts
 * @param {Array}    opts.rules           from the server's select-only response; each needs
 *                                        `id` and `judgeText`
 * @param {string}   opts.assistantText   the reply being audited
 * @param {string[]} [opts.userPrompts]
 * @param {string}   [opts.model]
 * @param {number}   [opts.timeoutMs]
 * @param {string}   [opts.claudeBin]     overridable so tests do not spend 18s and real quota
 * @param {Function} [opts.spawnImpl]
 * @returns {Promise<{outcome: 'clean'|'violation'|'skipped'|'failed',
 *                    violations: Array, failure?: string, reason?: string, latencyMs: number}>}
 */
export async function judgeLocally({
  rules,
  assistantText,
  userPrompts = [],
  model = DEFAULT_MODEL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  claudeBin = 'claude',
  spawnImpl = spawn,
} = {}) {
  const startedAt = Date.now();
  const done = (out) => ({ violations: [], latencyMs: Date.now() - startedAt, ...out });

  // No rules applied to this turn. Launching the CLI to be told so costs the user ~18s of
  // their own quota for an answer already known — and calling the result "clean" would claim
  // a check that never happened.
  if (!Array.isArray(rules) || rules.length === 0) return done({ outcome: 'skipped' });

  const prompt = buildJudgeUserPrompt({ rules, assistantText, userPrompts });
  const argv = [
    '-p',
    '--model', model,
    // Named, not left to the default. A judge that can edit files is not a judge, and an
    // empty tool list is also the fastest possible start: there is nothing to load.
    '--allowed-tools', '',
    // The flag this whole thing turned out to depend on. Without it the nested CLI loads the
    // user's own environment — their CLAUDE.md, their rules, their skills, and OwnMind's own
    // hooks. Measured on the first real run: asked to audit a reply against rule 795, it read
    // 795 as applying to ITSELF and answered
    //
    //     問題在第 42 行。\n\n**Why I made the mistake:** I added an explanatory header…
    //
    // — the assistant apologising, not the judge judging. Unparseable, and it would have been
    // recorded as a check that failed for no discoverable reason.
    //
    // The second half is worse and does not show up as an error at all: OwnMind's Stop hook
    // is registered globally, so a judge launched from a Stop hook would fire another Stop
    // hook, which would launch another judge. Safe mode is what keeps this from recursing.
    // Auth, model selection and the built-in tools still work, which is all a judge needs.
    '--safe-mode',
    // Nothing here is a conversation worth resuming, and one file per checked turn adds up.
    '--no-session-persistence',
    '--system-prompt', JUDGE_SYSTEM,
  ];

  let result;
  try {
    result = await run(spawnImpl, claudeBin, argv, prompt, timeoutMs);
  } catch (err) {
    // ENOENT here is the CLI not being on this machine, which is a different problem from the
    // CLI refusing — different cause, different repair, so a different answer.
    const noCli = err?.code === 'ENOENT';
    return done({
      outcome: 'failed',
      failure: noCli ? 'no-cli' : 'spawn',
      reason: noCli ? `${claudeBin} is not on this machine` : `could not start ${claudeBin}: ${err?.message || err}`,
    });
  }

  if (result.timedOut) {
    return done({
      outcome: 'failed',
      failure: 'timeout',
      reason: `the judge did not answer within ${timeoutMs}ms`,
    });
  }
  if (result.code !== 0) {
    // A CLI that refuses is not a CLI that is missing, and one particular refusal is worth
    // separating: measured 2026-08-16, a machine whose Claude Code is not signed in exits 1
    // with "Not logged in · Please run /login". Left in the general bucket the user is told to
    // re-run the OwnMind update script — which installs OwnMind and cannot log anybody in, so
    // they would be given a repair that cannot work, every tenth turn, indefinitely.
    const said = `${result.stderr || ''}\n${result.stdout || ''}`;
    const loggedOut = /not logged in|please run \/login/i.test(said);
    return done({
      outcome: 'failed',
      failure: loggedOut ? 'not-logged-in' : 'exit',
      reason: `the judge exited ${result.code}: ${excerpt(result.stderr || result.stdout)}`,
    });
  }

  const parsed = parseJudgeAnswer(result.stdout);
  const { verdicts, parseFailed } = normaliseVerdicts(parsed);
  if (!parsed || parseFailed) {
    return done({
      outcome: 'failed',
      failure: 'unparseable',
      reason: `the judge did not answer in the shape it was asked for: ${excerpt(result.stdout)}`,
    });
  }

  // The judge quotes the reply back as evidence, and that quote goes to the server when the
  // audit row is closed. The reply itself is redacted on the way out — this is the same text
  // arriving by a second road, so it gets the same treatment. Without it, a reply containing
  // `api_key=…` on the line a rule was broken on would send that line verbatim.
  const safe = (v) => ({ ...v, evidence: redact(v.evidence), fix: redact(v.fix) });

  const byId = new Map(rules.map((r) => [r.id, r]));
  const violations = verdicts
    .filter((v) => v.violated && byId.has(v.ruleId))
    .map((v) => {
      const rule = byId.get(v.ruleId);
      return {
        ruleId: v.ruleId,
        ruleType: rule.type || null,
        // From the rule, never from the model. A judge inventing a title would put words the
        // user never wrote into a message telling them their rule was broken.
        ruleTitle: rule.title || '',
        ruleCode: rule.code || null,
        evidence: redact(v.evidence),
        fix: redact(v.fix),
      };
    });

  return done({
    outcome: violations.length > 0 ? 'violation' : 'clean',
    violations,
    verdicts: verdicts.map(safe),
  });
}

function excerpt(text) {
  return String(text ?? '').trim().slice(0, EXCERPT_CHARS);
}

/**
 * Spawn, feed stdin, collect stdout, and stop it if it overruns.
 *
 * Rejects only when the process could not be started at all; anything the process itself does
 * — including exiting non-zero — comes back as a result for the caller to classify.
 */
function run(spawnImpl, bin, argv, stdin, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(bin, argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => finish(resolve, { code, stdout, stderr, timedOut }));

    // EPIPE if the child died before reading — which the close handler above already covers,
    // so it must not become an unhandled error here.
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}
