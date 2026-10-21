/**
 * hooks/lib/session-live-state.js — what must be true now, not when the cache was written.
 *
 * v1.33.0. The init payload is served from disk whenever the memory table has not moved
 * (hooks/lib/conditional-sync.js), and handoffs, task cards and consolidation questions all
 * move without it. Two consequences this module handles:
 *
 *   - pending handoffs are asked for on every start, from `/api/handoff/pending`, which every
 *     server version answers. The cache never holds `handoffs` or `consolidation` at all
 *     (conditional-sync strips them), so a stale copy cannot be rendered; the live list wins.
 *   - the two "I showed this" marks the renderer's consolidation section implies —
 *     `report-shown` for the one-line report, `questions/asked` for the questions — are sent
 *     here, after the context has been written to stdout, in parallel, each capped at
 *     MARK_TIMEOUT_MS, and only when the hook fired for a fresh start (see
 *     consolidationMarksOn). Fire-and-forget: a failed mark means the line is shown again next
 *     time, which is the cheap mistake. Failing the hook would be the expensive one — and
 *     until the v1.33.0 review the marks ran *before* the write, two 3s requests in a row,
 *     under the shell hook's `timeout 5`: a slow server cost the session its whole context.
 *
 * Both entry points (hooks/ownmind-session-start.js on Windows, hooks/lib/session-start-output.js
 * on macOS and Linux) call the same functions, so the platforms cannot drift.
 */

const TIMEOUT_MS = 3000;
const MARK_TIMEOUT_MS = 1500;

/**
 * `fetchFn` with a hard cap: the abort signal for a real fetch, and a race against a timer so a
 * fetch that ignores the signal (a test double, a socket stuck in connect) is given up on too.
 */
function withTimeout(fetchFn, url, init, timeoutMs = TIMEOUT_MS) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  const request = Promise.resolve().then(() => fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }));
  return Promise.race([request, expired]).finally(() => clearTimeout(timer));
}

/**
 * Should this SessionStart send the "shown" marks? Claude Code says why the hook fired:
 * `startup`, `clear`, `resume`, `compact`. A resume or a compact re-renders a context the
 * person has already seen, so counting a question as asked again there would burn its
 * once-a-day budget on the server for nothing. A payload with no source at all is an older
 * client, whose every SessionStart is a fresh start; any other value is unknown and does not
 * mark.
 *
 * @param {unknown} source `source` from the hook payload (Windows), or
 *   `OWNMIND_HOOK_START_SOURCE` as the shell hook hands it on (macOS and Linux)
 */
export function consolidationMarksOn(source) {
  if (source === undefined || source === null || source === '') return true;
  return source === 'startup' || source === 'clear';
}

/**
 * @returns {Promise<object[]|null>} the pending handoffs, or null when the server could not say
 */
export async function fetchPendingHandoffs({ apiUrl, apiKey, fetchFn = globalThis.fetch } = {}) {
  if (!apiUrl || !apiKey || typeof fetchFn !== 'function') return null;
  try {
    const res = await withTimeout(fetchFn, `${apiUrl.replace(/\/$/, '')}/api/handoff/pending`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res || !res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/**
 * The live pending list replaces whatever pending rows the init payload carried; accepted
 * rows (the 30-minute grace the server sends on a refreshed init) are kept, since nothing
 * lighter than init reports them. A null answer leaves the payload exactly as it was.
 */
export function mergeHandoffs(initData, pending) {
  if (!initData || typeof initData !== 'object' || !Array.isArray(pending)) return initData;
  const accepted = (Array.isArray(initData.handoffs) ? initData.handoffs : [])
    .filter((h) => h && h.status === 'accepted');
  const live = pending.map((h) => ({ ...h, status: 'pending' }));
  return { ...initData, handoffs: [...live, ...accepted] };
}

/**
 * Tell the server which consolidation lines this start rendered, so neither is shown twice.
 * The two requests go out together and each is capped at `timeoutMs`; neither can throw.
 *
 * @returns {Promise<{ reportShown: boolean, questionsAsked: number }>} what was acknowledged
 */
export async function markConsolidationShown({
  apiUrl, apiKey, consolidation, fetchFn = globalThis.fetch, timeoutMs = MARK_TIMEOUT_MS,
} = {}) {
  const outcome = { reportShown: false, questionsAsked: 0 };
  if (!apiUrl || !apiKey || !consolidation || typeof consolidation !== 'object' || typeof fetchFn !== 'function') {
    return outcome;
  }
  const base = apiUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const marks = [];

  const taskId = consolidation.report && consolidation.report.task_id;
  if (taskId != null) {
    marks.push(withTimeout(fetchFn, `${base}/api/memory/consolidation/report-shown`, {
      method: 'PUT', headers, body: JSON.stringify({ task_id: taskId }),
    }, timeoutMs)
      .then((res) => { outcome.reportShown = Boolean(res && res.ok); })
      .catch(() => { /* shown again next time */ }));
  }

  const ids = (Array.isArray(consolidation.questions) ? consolidation.questions : [])
    .map((q) => q && q.id).filter((id) => id != null);
  if (ids.length > 0) {
    marks.push(withTimeout(fetchFn, `${base}/api/memory/consolidation/questions/asked`, {
      method: 'POST', headers, body: JSON.stringify({ ids }),
    }, timeoutMs)
      .then((res) => { if (res && res.ok) outcome.questionsAsked = ids.length; })
      .catch(() => { /* asked again next time */ }));
  }

  await Promise.all(marks);
  return outcome;
}
markConsolidationShown.DEFAULT_TIMEOUT_MS = MARK_TIMEOUT_MS;
