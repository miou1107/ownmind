import { Router } from 'express';
import { query as defaultQuery } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { callLLMSwitch } from '../lib/llm-narrative.js';
import { createJudgeCaller } from '../lib/enforcement/judge-llm.js';
import { buildReadableWhere } from '../utils/memory-visibility.js';
import { attachStandardFragments } from '../utils/standard-fragments.js';
import { selectRules } from '../lib/enforcement/select-rules.js';
import { buildJudgeMessages, normaliseVerdicts } from '../lib/enforcement/judge-prompt.js';

/**
 * Per-turn compliance check.
 *
 * The client sends what the assistant just said; this decides whether it broke any of the
 * user's rules, in time for the assistant to correct itself rather than for the user to
 * notice. A separate model does the deciding, because the assistant being checked had
 * already read the same rules and broke them anyway - self-checking is the thing that failed.
 *
 * The account switch is read first, before anything expensive. An account that is off costs
 * one indexed lookup, no tokens and no measurable latency, which is what makes it safe to
 * ship the client half to everybody while one account is enrolled.
 */

// 4 seconds. The client waits on this and the user waits on the client, so this is time
// somebody feels on every checked turn. A judge that has not answered by then is recorded as
// failed and the turn goes through.
const JUDGE_TIMEOUT_MS = 4_000;

const JUDGED_TYPES = ['iron_rule', 'team_standard', 'principle', 'coding_standard'];

/**
 * `callLLMSwitch` resolves to the PARSED object and throws on anything that is not JSON.
 * Measured against a stub server, not assumed: an earlier draft read `.content` here, got
 * undefined on every call, and would have recorded every check as failed while its tests -
 * which injected a string-returning stub - stayed green.
 */
/**
 * A factory rather than a constant so this seam can be exercised.
 *
 * Every route test injects its own `llmFn`, which means the adapter below — the `{parsed,
 * served}` shape, the `onServed` closure, the warning wiring — had no test at all. That is the
 * same shape as the defect the comment above describes: a seam nobody ran, with a green suite.
 */
export function createDefaultJudge({ fetchImpl, apiKey = () => process.env.LLM_SWITCH_API_KEY, warn } = {}) {
  return createJudgeCaller({
    timeoutMs: JUDGE_TIMEOUT_MS,
    callLLM: async ({ model, temperature, timeoutMs, messages }) => {
      let served;
      const parsed = await callLLMSwitch({
        apiKey: apiKey(),
        messages,
        ...(fetchImpl ? { fetchImpl } : {}),
      model,
      temperature,
      timeoutMs,
      // One replay, inside the same budget. There is no second-choice judge any more, so this
      // is what a refusal gets — and it is the case retrying is actually for: measured on this
      // gateway, the same body was refused four times in one window and then accepted on all
      // six replays. The delay is short because the whole budget is four seconds; the default
      // three-second pause would spend it on waiting.
      retries: 1,
      retryDelayMs: 250,
      overallTimeoutMs: timeoutMs,
        onServed: (m) => { served = m; },
      });
      return { parsed, served };
    },
    // Not fatal, and not silent either: the pin is the only thing keeping an OCR model out of
    // this seat, and a pin the switch ignores has to be visible to whoever reads the logs
    // rather than discovered again in six weeks.
    onSubstitution: (asked, served) => {
      (warn || logger.warn?.bind(logger))?.('compliance: judge model substituted by the switch', { asked, served });
    },
  });
}

const defaultLlm = createDefaultJudge();

export function createComplianceRouter({ queryFn = defaultQuery, llmFn = defaultLlm } = {}) {
  const router = Router();

  router.post('/check', async (req, res) => {
    const startedAt = Date.now();
    const userId = req.user?.id;
    const {
      session_id: sessionId,
      turn_index: turnIndex,
      assistant_text: assistantText,
      user_prompts: userPrompts,
      repo_remote: repoRemote,
      trigger,
      mode: requestedMode,
    } = req.body || {};

    // v1.30.11. `mode: 'select'` answers the first half of this route's job — which rules
    // apply to this turn, and what they say — and stops there.
    //
    // The judge is moving onto the user's own Claude Code subscription — the owner's standing
    // instruction — which means it has to run on their machine, because that is where the
    // quota is, and it must not reach the llm switch at all. The rules are not
    // there: measured 2026-08-16, the client's cache holds 318 selectors and zero rule text.
    // Shipping the corpus to every machine is a far bigger change than moving the judging, so
    // the work splits where the cost does — matching stays here, judging goes there.
    //
    // Anything that is not exactly 'select' takes the old path unchanged. A release that
    // moves the judge must not change what a client that has not upgraded yet receives.
    const selectOnly = requestedMode === 'select';

    if (!sessionId || typeof assistantText !== 'string' || assistantText.trim() === '') {
      return res.status(400).json({ error: 'session_id and assistant_text are required' });
    }

    let mode = 'off';
    try {
      const result = await queryFn('SELECT enforcement_mode FROM users WHERE id = $1', [userId]);
      mode = result.rows[0]?.enforcement_mode || 'off';
    } catch (err) {
      logger.warn?.('compliance: mode lookup failed', { err: err.message });
      return res.json({ enabled: false, outcome: 'failed', violations: [] });
    }
    if (mode !== 'check') {
      return res.json({ enabled: false, outcome: 'skipped', violations: [] });
    }

    const record = async (outcome, considered, verdicts) => {
      try {
        const result = await queryFn(
          `INSERT INTO compliance_checks
             (user_id, session_id, turn_index, rules_considered, verdicts, latency_ms, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [userId, sessionId, Number.isFinite(turnIndex) ? turnIndex : null,
            JSON.stringify(considered), JSON.stringify(verdicts),
            Date.now() - startedAt, outcome],
        );
        return result.rows[0]?.id ?? null;
      } catch (err) {
        logger.warn?.('compliance: record failed', { err: err.message });
        return null;
      }
    };

    let memories = [];
    try {
      // buildReadableWhere, not `user_id = $1`. Team standards are readable across accounts,
      // and the standard this feature exists to enforce belongs to a colleague - measured
      // against a real database, an owner-scoped query cannot see it at all.
      const result = await queryFn(
        `SELECT m.id, m.type, m.code, m.title, m.content, m.tags, m.metadata
           FROM memories m
          WHERE m.status = 'active'
            AND m.type = ANY($2)
            AND ${buildReadableWhere({ alias: 'm', userParam: '$1' })}`,
        [userId, JUDGED_TYPES],
      );
      // Fragments carry the prohibition lists. A summary without them is the shape of the
      // incident: the rule arrives with the part that forbids the action missing.
      memories = await Promise.all(
        result.rows.map((row) => attachStandardFragments(row, { query: queryFn, userId })),
      );
    } catch (err) {
      logger.warn?.('compliance: rule fetch failed', { err: err.message });
      const id = await record('failed', [], []);
      return res.json({ enabled: true, outcome: 'failed', violations: [], check_id: id });
    }

    const { selected, dropped } = selectRules(memories, {
      assistantText,
      userPrompts: Array.isArray(userPrompts) ? userPrompts : [],
      repoRemote: repoRemote || null,
      // A string or a list, both kept. A reply is the assistant talking and usually
      // reporting as well, so the client sends both labels - and coercing a list to '' here
      // dropped every tag-selected rule on the floor. Verified against production: the check
      // came back 'skipped' on a reply that plainly broke a rule tagged trigger:always.
      trigger: Array.isArray(trigger) ? trigger : (typeof trigger === 'string' ? trigger : ''),
    });
    // What was looked at is recorded even on a clean verdict: "the rule was never selected"
    // and "the rule was selected and misjudged" need different fixes, and afterwards they are
    // indistinguishable without this. Rules that did not fit the budget are recorded too - a
    // coverage gap nobody wrote down is one nobody can act on.
    const considered = {
      judged: selected.map((r) => ({ id: r.id, type: r.type, title: r.title })),
      dropped_for_budget: dropped,
    };

    if (selected.length === 0) {
      const id = await record('skipped', considered, []);
      // `rules: []` on the select path, and absent on the judging path. The client is about to
      // decide whether to spend the user's quota; "nothing applied" and "something went wrong"
      // must not arrive looking the same, and an absent field reads as neither.
      return res.json({
        enabled: true, outcome: 'skipped', violations: [], check_id: id,
        ...(selectOnly && { rules: [] }),
      });
    }

    if (selectOnly) {
      // Opened, not closed: the row exists so the verdict has something to be recorded
      // against when it arrives from the client, minutes or a turn later. `pending` is a
      // state the schema did not have, and it needs one — a row with no outcome would be
      // counted as a check that ran and found nothing.
      const id = await record('pending', considered, []);
      return res.json({
        enabled: true,
        outcome: 'pending',
        violations: [],
        check_id: id,
        // judgeText is what the client cannot reconstruct: it holds selectors, not bodies.
        rules: selected.map((r) => ({
          id: r.id, type: r.type, code: r.code || null, title: r.title, judgeText: r.judgeText,
        })),
      });
    }

    let judged;
    try {
      judged = await llmFn(buildJudgeMessages({
        rules: selected, assistantText, userPrompts: userPrompts || [],
      }));
    } catch (err) {
      // Includes the model answering in prose: callLLMSwitch throws rather than handing back
      // text. Recorded as failed, never as clean.
      logger.warn?.('compliance: judge call failed', { err: err.message });
      const id = await record('failed', considered, []);
      return res.json({ enabled: true, outcome: 'failed', violations: [], check_id: id });
    }

    const { verdicts, parseFailed } = normaliseVerdicts(judged);
    if (parseFailed) {
      const id = await record('failed', considered, []);
      return res.json({ enabled: true, outcome: 'failed', violations: [], check_id: id });
    }

    const byId = new Map(selected.map((r) => [r.id, r]));
    const violations = verdicts
      .filter((v) => v.violated && byId.has(v.ruleId))
      .map((v) => {
        const rule = byId.get(v.ruleId);
        return {
          ruleId: v.ruleId,
          ruleType: rule.type,
          ruleTitle: rule.title,
          ruleCode: rule.code || null,
          evidence: v.evidence,
          fix: v.fix,
        };
      });

    const outcome = violations.length > 0 ? 'violation' : 'clean';
    const id = await record(outcome, considered, verdicts);
    return res.json({ enabled: true, outcome, violations, check_id: id });
  });

  /**
   * One click from the pilot user: was this finding right?
   *
   * Without it the false-positive rate cannot be computed at all, and the rollout criteria
   * would come down to whether the last few findings felt reasonable.
   */
  router.post('/feedback', async (req, res) => {
    const { check_id: checkId, verdict } = req.body || {};
    if (!checkId || !['correct', 'false_positive'].includes(verdict)) {
      return res.status(400).json({ error: 'check_id and verdict (correct|false_positive) are required' });
    }
    try {
      await queryFn(
        'UPDATE compliance_checks SET user_feedback = $1 WHERE id = $2 AND user_id = $3',
        [verdict, checkId, req.user?.id],
      );
      return res.json({ ok: true });
    } catch (err) {
      logger.warn?.('compliance: feedback failed', { err: err.message });
      return res.status(500).json({ error: 'failed to record feedback' });
    }
  });

  return router;
}

const router = Router();
router.use(auth);
router.use(createComplianceRouter());
export default router;
