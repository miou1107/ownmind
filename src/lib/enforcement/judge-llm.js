/**
 * Who judges a reply, and what happens when they will not answer.
 *
 * Until v1.30.3 the judge asked the switch for `model: 'auto'`. Measured against the live
 * switch on 2026-08-15: its catalogue holds 71 entries including OCR, speech and embedding
 * models, and production logs show `mistral/mistral-ocr-3-0` serving compliance checks. An
 * OCR model cannot audit a reply, and the same reply came back clean on one turn and in
 * violation on the next because a different model answered each time.
 *
 * Under 'auto', 13 of 16 checks were served by mistral-small-latest, which flagged 8 of 8
 * replies written to follow the rules — a verdict that fires on everything carries no
 * information. The same eight samples through gpt-oss-120b flagged 1 of 4 good ones and caught
 * 3 of 3 bad ones. That is one eval set with hand-applied labels, so it is enough to prefer a
 * model and not enough to claim the problem is solved.
 *
 * Three consequences, all of them here rather than at the call site:
 *
 *   1. Asking for a model is not getting one. gemini-2.0-flash, llama-3.3-70b and gpt-4o were
 *      all answered by mistral-small-latest, HTTP 200, no hint of the substitution. So the
 *      served name is compared against the asked name every time — allowing for the provider
 *      prefix the switch puts on it (`openai/gpt-oss-120b`), because comparing the bare
 *      strings makes the warning fire on every honoured pin and therefore mean nothing.
 *   2. There is no second-choice model. mistral-small-latest is the one measured to flag
 *      everything, so falling back to it would hand the user a confident wrong verdict, in an
 *      unrecorded ratio, on the majority path — the same defect this release exists to remove,
 *      one layer further down. A check that does not run is visible, is recorded as failed,
 *      and is excluded from the false-positive count. That is the better failure.
 *   3. What a refusal deserves is another go at the same model, not a different judge. The
 *      switch's own 502s recover on replay (see llm-narrative.js), so the retry lives there,
 *      inside this budget.
 */

/**
 * In preference order. Only models the switch was measured to honour by name: everything else
 * silently becomes mistral-small-latest, which makes the pin a comment.
 *
 * One entry today, deliberately. The list stays a list because a second honoured model with a
 * measured false-alarm rate would belong in it; a model that has not been measured does not.
 */
export const JUDGE_MODELS = ['gpt-oss-120b'];

/** Matches src/routes/compliance.js. Somebody waits for this on every checked turn. */
const DEFAULT_TIMEOUT_MS = 4_000;

/**
 * Below this, an attempt cannot produce anything but a timeout.
 *
 * A `remaining > 0` guard let a second attempt start with 5ms left, which timed out and — being
 * the last error — replaced the informative `LLM upstream 502: <provider text>` in the log with
 * `timed out after 5ms`. Losing the diagnosis is the failure v1.30.2 was written to end.
 */
const MIN_USEFUL_MS = 750;

/** The switch answers `openai/gpt-oss-120b` for `gpt-oss-120b`. Same model, prefixed. */
function sameModel(asked, served) {
  const bare = (s) => String(s).split('/').pop().toLowerCase();
  return bare(asked) === bare(served);
}

/**
 * @param {object} deps
 * @param {(args: {model: string, temperature: number, timeoutMs: number, messages: object[]})
 *   => Promise<{parsed: unknown, served?: string}>} deps.callLLM
 * @param {string[]} [deps.models]
 * @param {number} [deps.timeoutMs] budget across every attempt, not per attempt
 * @param {(asked: string, served: string) => void} [deps.onSubstitution]
 * @param {() => number} [deps.now]
 * @returns {(messages: object[]) => Promise<unknown>} the parsed judge answer
 */
export function createJudgeCaller({
  callLLM,
  models = JUDGE_MODELS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onSubstitution,
  now = () => Date.now(),
}) {
  return async function judge(messages) {
    const startedAt = now();
    let lastError;

    for (const model of models) {
      const remaining = timeoutMs - (now() - startedAt);
      // Checked before starting, not after failing, and against a floor rather than zero.
      if (lastError && remaining < MIN_USEFUL_MS) break;

      try {
        const { parsed, served } = await callLLM({
          model,
          // Zero, not the 0.3 this inherited from the narrative writer, where variety is the
          // point. A judge that answers differently on the same text twice is not a judge.
          temperature: 0,
          timeoutMs: Math.max(MIN_USEFUL_MS, Math.min(timeoutMs, remaining)),
          messages,
        });
        if (served && !sameModel(model, served) && typeof onSubstitution === 'function') {
          onSubstitution(model, served);
        }
        return parsed;
      } catch (err) {
        // A TypeError here is this code being wrong, not the upstream being busy. Retrying it
        // against another model and filing it as "the judge refused" is how the first draft of
        // this whole feature nearly shipped dead: a ReferenceError inside a catch, every check
        // recorded as failed, the suite green.
        if (err instanceof TypeError || err instanceof ReferenceError) throw err;
        // Named, because neither `LLM upstream 502: …` nor `LLM request timed out after …`
        // says which model refused, and with more than one in the list the log could not tell.
        err.message = `[${model}] ${err.message}`;
        lastError = err;
      }
    }

    throw lastError || new Error('judge: no model was asked');
  };
}
