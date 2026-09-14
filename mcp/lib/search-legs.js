/**
 * What `ownmind_search` does when one of its two API calls fails.
 *
 * #129 — the search asked two endpoints (memories, session logs) and wrapped both in
 * `.catch(() => [])`. A network error therefore never reached the handler's catch block,
 * the offline branch never ran, and the tool answered `0 hits` with no notice attached.
 * That is indistinguishable from "you never saved this", which is how an MCP process whose
 * connection had been dead for six hours told its caller that a memory it holds does not
 * exist. Swallowing an error is only safe when the caller can still tell the difference.
 *
 * Pure on purpose: the handler owns the calls, this owns the judgement.
 */

/** @typedef {{ ok: true, value: any } | { ok: false, error: Error }} Leg */

/**
 * @param {{ memory: Leg, session: Leg }} legs
 * @param {(err: Error) => boolean} isNetworkError
 * @returns {{ mode: 'online'|'partial'|'offline'|'error', failed: string[], notice: string|null, error: Error|null }}
 *   - `online`  both answered; merge and return as before.
 *   - `partial` one answered; return it with `notice` so the caller knows the count is short.
 *   - `offline` the memory half is unreachable; search the local cache instead.
 *   - `error`   both failed for reasons a cache cannot stand in for; rethrow `error`.
 */
export function classifySearchLegs(legs, isNetworkError) {
  const memory = legs?.memory ?? { ok: false, error: new Error('memory leg missing') };
  const session = legs?.session ?? { ok: false, error: new Error('session leg missing') };
  const failed = [];
  if (!memory.ok) failed.push('memory');
  if (!session.ok) failed.push('session');

  if (failed.length === 0) return { mode: 'online', failed, notice: null, error: null };

  // The memory half is the one a cache can answer for, so it decides whether this is an
  // offline situation at all.
  if (!memory.ok && isNetworkError(memory.error)) {
    return { mode: 'offline', failed, notice: null, error: null };
  }

  if (!memory.ok && !session.ok) {
    return { mode: 'error', failed, notice: null, error: memory.error };
  }

  const half = memory.ok ? 'session logs' : 'saved memories';
  const err = memory.ok ? session.error : memory.error;
  return {
    mode: 'partial',
    failed,
    notice: `[OwnMind] Partial results — ${half} could not be searched (${err?.message || 'unknown error'}). `
      + 'The counts below cover the other half only; do not read them as "nothing is stored".',
    error: null,
  };
}
