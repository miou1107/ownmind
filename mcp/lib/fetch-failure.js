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
 * Codes that mean no connection was ever made because the name did not resolve. They do not
 * say *why*: a placeholder host and a laptop with the Wi-Fi off produce the same
 * `ENOTFOUND`, and `EAI_AGAIN` is literally a temporary resolver failure. So the wording
 * below offers both readings rather than picking one — the address is what the caller needs
 * printed, not a verdict the code cannot reach.
 */
const UNRESOLVED_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);

/**
 * Host names the project itself ships in install instructions and templates. Matched whole,
 * against the host alone: `your-server.com` as a substring also matches a real customer host
 * under that domain, and telling somebody mid-outage that their working server was never
 * configured is the same wrong-diagnosis failure this file exists to stop.
 */
const PLACEHOLDER_HOSTS = new Set(['your_ownmind_url', 'your-ownmind-url', 'your-server.com', 'your-server']);

/** The host of a URL, lowercased, or '' when it will not parse. */
function hostOf(apiUrl) {
  try {
    return new URL(String(apiUrl)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Where `OWNMIND_API_URL` actually lives, in the order a person should look. */
const REMEDY = 'Set OWNMIND_API_URL wherever it is configured for this tool — the MCP entry in '
  + '~/.claude.json (each opened project carries its own copy), settings.json or settings.local.json — '
  + 'then restart the tool: a running one keeps the address it read at startup, so editing the setting '
  + 'alone changes nothing.';

/**
 * What to say when the address, rather than the server, is worth looking at first.
 *
 * 2026-09-28: an MCP process spent five days dialling `https://YOUR_OWNMIND_URL/ownmind` and
 * reporting, each time, that it could not reach the OwnMind server — while curl against the
 * configured URL returned 200 from the same machine. `ENOTFOUND` counts as a network error,
 * which is correct for the cache fallback and wrong for the sentence printed next to it:
 * offline mode told the caller to wait for a connection nobody was dialling, and eight memory
 * writes queued up behind that advice, the oldest five weeks old.
 *
 * @param {Error} err the error `fetch` rejected with
 * @param {string} apiUrl the address the call was made against
 * @param {{ configured?: boolean }} [opts] `configured: false` when nothing set
 *   OWNMIND_API_URL and this is the built-in default
 * @returns {string} one line naming the address, or '' when the address is not in question
 *   and offline mode should say what it always said
 */
export function addressFault(err, apiUrl, opts = {}) {
  if (!apiUrl) return '';
  const { configured = true } = opts;

  // A placeholder or an unset address is a setup problem whatever the connection did, because
  // neither has ever pointed at a server.
  if (PLACEHOLDER_HOSTS.has(hostOf(apiUrl))) {
    return `[OwnMind setup problem] OWNMIND_API_URL is still the placeholder the installer ships (${apiUrl}), `
      + `so this tool has never been talking to a server. Nothing is wrong with the server. ${REMEDY}`;
  }

  if (!configured) {
    return `[OwnMind setup problem] Nothing set OWNMIND_API_URL, so this tool is dialling the built-in `
      + `default (${apiUrl}) and there is no server there. ${REMEDY}`;
  }

  // Beyond this point the address may be perfectly good and the machine simply off the
  // network, so the line states both readings and lets the person tell them apart.
  if (UNRESOLVED_CODES.has(fetchFailureCode(err))) {
    return `[OwnMind] The address this tool dials did not resolve (${apiUrl}), so nothing was contacted. `
      + `Either that address is wrong, or this machine cannot look up names right now — a dropped VPN, `
      + `a sleeping laptop or a captive portal all land here. Check the address first, and if it is `
      + `right, the connection is what to fix. ${REMEDY}`;
  }

  return '';
}
