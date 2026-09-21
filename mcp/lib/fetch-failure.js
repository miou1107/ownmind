/**
 * What a connection-level failure is allowed to tell you.
 *
 * #127 — `ownmind_log_session` failed three times in a row with exactly
 * `[OwnMind v1.30.20] Error report：fetch failed`, while curl against the same URL, with the
 * same credentials, in the same second, returned 201. That string is Node's fetch rejecting
 * with the cause discarded: no method, no URL, no elapsed time, and — the part that actually
 * names the fault — no `err.cause`, which is where undici puts `ECONNRESET`,
 * `UND_ERR_CONNECT_TIMEOUT`, a TLS failure or a DNS failure.
 *
 * With none of that surfaced, a person holding a failing tool and a working curl has nothing
 * to compare. The row being lost is the smaller half of the cost.
 *
 * The literal words `fetch failed` are kept at the front on purpose: `isNetworkError` in
 * mcp/offline.js matches on them, and offline mode — the cache fallback that keeps a
 * disconnected machine usable — hangs off that match.
 */

/** Every error in a `cause` chain, outermost first, without looping on a cycle. */
function causeChain(err) {
  const seen = new Set();
  const out = [];
  let current = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = current.cause;
  }
  return out;
}

/** `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`, `CERT_HAS_EXPIRED` … whichever the chain carries. */
export function fetchFailureCode(err) {
  for (const link of causeChain(err)) {
    if (typeof link.code === 'string' && link.code) return link.code;
  }
  return '';
}

/**
 * A one-line description of a failed fetch, for the message of the Error thrown in its place.
 *
 * @param {Error} err the error `fetch` rejected with
 * @param {{ method?: string, url?: string, elapsedMs?: number }} call what was being attempted
 * @returns {string}
 */
export function describeFetchFailure(err, call = {}) {
  const head = String(err?.message || 'fetch failed');

  const where = [call.method, call.url].filter(Boolean).join(' ');
  const parts = [];
  if (where) parts.push(where);
  if (Number.isFinite(call.elapsedMs)) parts.push(`after ${call.elapsedMs}ms`);

  // The innermost link names the fault; the outer one is almost always the bare "fetch failed".
  const chain = causeChain(err);
  const inner = chain.length > 1 ? chain[chain.length - 1] : null;
  if (inner) {
    const name = inner.name && inner.name !== 'Error' ? inner.name : '';
    const detail = [name, String(inner.message || '').slice(0, 160)].filter(Boolean).join(': ');
    const code = fetchFailureCode(err);
    const both = [detail, code && code !== name ? `code ${code}` : ''].filter(Boolean).join(', ');
    if (both) parts.push(`(${both})`);
  } else {
    const code = fetchFailureCode(err);
    if (code) parts.push(`(code ${code})`);
  }

  return parts.length > 0 ? `${head} — ${parts.join(' ')}` : head;
}
