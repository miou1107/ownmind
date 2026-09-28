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

/**
 * The host of a URL, lowercased, or '' when it will not parse.
 *
 * The scheme-less form is tried too, because that is how the placeholder is written in the
 * install instructions people copy from: `YOUR_OWNMIND_URL/ownmind` has no scheme, `new URL`
 * refuses it, and the host that most needs naming would go unnamed.
 */
function hostOf(apiUrl) {
  const raw = String(apiUrl).trim();
  for (const candidate of [raw, `http://${raw}`]) {
    try {
      const host = new URL(candidate).hostname.toLowerCase();
      if (host) return host;
    } catch { /* try the next form */ }
  }
  return '';
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
 * `permanent` is the part callers act on rather than print. A queued write behind a
 * placeholder can never be sent, because no connection will ever appear at a host that does
 * not exist — saying so is the whole point. A queued write behind an address that merely did
 * not resolve this minute, or behind the built-in default on a machine whose own server is
 * down, goes out by itself the moment the VPN reconnects or the container starts. Telling
 * that person their memory "cannot be sent until the address is fixed" is the same confident
 * wrong diagnosis in the opposite direction, and on the write path it is the expensive one.
 *
 * @param {Error} err the error `fetch` rejected with
 * @param {string} apiUrl the address the call was made against
 * @param {{ configured?: boolean }} [opts] `configured: false` when nothing set
 *   OWNMIND_API_URL and this is the built-in default
 * @returns {{ kind: ''|'placeholder'|'unset'|'unresolved', line: string, permanent: boolean }}
 *   `kind` is '' and `line` empty when the address is not in question and offline mode should
 *   say what it always said. `permanent` is true only when nothing but an edited setting can
 *   ever clear the fault.
 */
export function addressFault(err, apiUrl, opts = {}) {
  const none = { kind: '', line: '', permanent: false };
  if (!apiUrl) return none;
  const { configured = true } = opts;

  // A host the installer ships as a placeholder has never pointed at a server, whatever the
  // connection did, and never will until somebody edits the setting.
  if (PLACEHOLDER_HOSTS.has(hostOf(apiUrl))) {
    return {
      kind: 'placeholder',
      permanent: true,
      line: `[OwnMind setup problem] OWNMIND_API_URL is still the placeholder the installer ships (${apiUrl}), `
        + `so this tool has never been talking to a server. Nothing is wrong with the server. ${REMEDY}`,
    };
  }

  // Nobody set the address, so this is the built-in default. That is not by itself a mistake:
  // the project's own compose file publishes the API on this port, so a self-hoster who never
  // set the variable is correctly pointed at their own server and is looking at an outage.
  // Claiming "there is no server there" would be wrong for exactly the people running OwnMind
  // the way the README tells them to.
  if (!configured) {
    return {
      kind: 'unset',
      permanent: false,
      line: `[OwnMind] Nothing set OWNMIND_API_URL, so this tool is dialling the built-in default `
        + `(${apiUrl}) and nothing answered there. If you run the OwnMind server on this machine, it `
        + `is simply not up right now. If your server is somewhere else, this tool was never pointed `
        + `at it. ${REMEDY}`,
    };
  }

  // Beyond this point the address may be perfectly good and the machine simply off the
  // network, so the line states both readings and lets the person tell them apart.
  if (UNRESOLVED_CODES.has(fetchFailureCode(err))) {
    return {
      kind: 'unresolved',
      permanent: false,
      line: `[OwnMind] The address this tool dials did not resolve (${apiUrl}), so nothing was contacted. `
        + `Either that address is wrong, or this machine cannot look up names right now — a dropped VPN, `
        + `a sleeping laptop or a captive portal all land here. Check the address first, and if it is `
        + `right, the connection is what to fix. ${REMEDY}`,
    };
  }

  return none;
}
