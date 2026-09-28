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

/**
 * Codes that mean the name was never resolved, so nothing was ever dialled. `ENOTFOUND` is a
 * name that does not exist; `EAI_AGAIN` is a resolver that could not answer. Both land here
 * within milliseconds, which is also how they are told apart from a real outage by eye: a
 * server that is down takes a connect timeout to say so.
 */
const UNRESOLVED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);

/**
 * Fragments an installer leaves behind when nobody substitutes the address. A host containing
 * one of these has never pointed at a server, so every failure against it is a setup problem
 * however it presents.
 */
const PLACEHOLDER_MARKERS = ['your_ownmind_url', 'your-ownmind-url', 'your-server.com', 'your_server'];

/**
 * What to say when the address itself is the fault, rather than the server or the network.
 *
 * 2026-09-28: an MCP process spent five days dialling `https://YOUR_OWNMIND_URL/ownmind` and
 * reporting, each time, that it could not reach the OwnMind server — while curl against the
 * configured URL returned 200 from the same machine. `ENOTFOUND` counts as a network error,
 * which is correct for the cache fallback and wrong for the sentence printed next to it:
 * offline mode told the caller to wait for a connection that no one was dialling, and eight
 * memory writes queued up behind that advice.
 *
 * @param {Error} err the error `fetch` rejected with
 * @param {string} apiUrl the address the call was made against
 * @returns {string} one line naming the address and the remedy, or '' when the network is
 *   genuinely at fault and offline mode should say what it always said
 */
export function addressFault(err, apiUrl) {
  if (!apiUrl) return '';

  const host = String(apiUrl).toLowerCase();
  const isPlaceholder = PLACEHOLDER_MARKERS.some((marker) => host.includes(marker));
  const unresolved = UNRESOLVED_CODES.has(fetchFailureCode(err));
  if (!isPlaceholder && !unresolved) return '';

  // A tool reads OWNMIND_API_URL once, when it starts, and keeps it for its whole life.
  // Correcting the setting while it runs changes nothing, which is why the remedy has to say
  // "restart" out loud — the 2026-09-28 process kept the placeholder across three days of
  // config edits that had already fixed it on disk.
  const remedy = 'Set OWNMIND_API_URL to the real address in the MCP config, then restart this tool — '
    + 'a running one keeps the address it started with, so editing the setting alone changes nothing.';

  if (isPlaceholder) {
    return `[OwnMind setup problem] OWNMIND_API_URL is still the placeholder the installer ships (${apiUrl}), `
      + `so this tool has never been talking to a server. Nothing is wrong with the server. ${remedy}`;
  }

  return `[OwnMind setup problem] The address this tool dials does not resolve (${apiUrl}), so nothing was ever `
    + `contacted. This is the setting, not the server and not your connection. ${remedy}`;
}
