/**
 * log-mcp-call.js — v1.18.9 latency instrumentation helper.
 *
 * Why this exists (closing v1.18.6's missed item + Gemini r3 C4 observability gap):
 *   Earlier, the main flow in mcp/index.js didn't measure "the latency the user actually
 *   feels before seeing the result". The admin dashboard had no p95, so we couldn't tell
 *   which path slowed down which call, and couldn't tune.
 *
 * Why extract a helper:
 *   The logic is simple, but the invariant "a logEvent throw must never fail the tool call"
 *   deserves its own unit test so future changes have a safety net.
 *
 * Same pattern as enrich-error.js — a pure module, easy to test.
 */

/**
 * Safely write an mcp_call event. Any logEvent failure is swallowed; never throws.
 *
 * @param {Object} args
 * @param {Function} args.logEvent - the logEvent function (event, details)
 * @param {string} args.tool - tool name (do not pass null/undefined; use 'unknown' instead)
 * @param {number} args.latencyMs - tool call duration in ms (caller computes via Date.now)
 * @param {string} args.status - 'ok' | 'error'
 */
export function logMcpCallSafe({ logEvent, tool, latencyMs, status }) {
  try {
    logEvent('mcp_call', {
      tool: tool || 'unknown',
      latency_ms: latencyMs,
      status,
    });
  } catch (e) {
    // Must not block the main response flow.
    try {
      console.error('[log-mcp-call] logEvent failed:', e?.message || String(e));
    } catch { /* even console.error is broken — give up */ }
  }
}
