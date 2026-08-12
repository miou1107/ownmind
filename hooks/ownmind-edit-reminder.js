#!/usr/bin/env node
/**
 * v1.26.92 — the edit-trigger iron rule reminder.
 *
 * One implementation, two callers: `ownmind-iron-rule-check.js` imports `editReminder()`,
 * and `ownmind-iron-rule-check.sh` runs this file by path, the way it already runs
 * `ownmind-verify-trigger.js`. The alias table in v1.26.91 had to be duplicated because it
 * lives inside a `node -e` string; this does not, so it is not.
 *
 * The edit trigger never blocks. It returns a `hookSpecificOutput` envelope or nothing, and
 * deliberately does not touch the verification engine — that engine is the only path that
 * can emit `decision: block`, and its conditions are written for commit and deploy.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { getClientVersion, readCredentials } from '../shared/helpers.js';
import { renderHookContextLine } from '../shared/hook-context.js';
import { fetchHookContext } from './lib/hook-context-fetch.js';
import {
  readEditReminderState,
  writeEditReminderState,
  decideEditReminder,
  renderEditReminderLine,
  FETCH_BACKOFF_MS,
} from '../shared/edit-reminder-state.js';

function envelope(text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  });
}

/**
 * Said out loud when the state file cannot be written.
 *
 * Without this the degradation is invisible and permanent: every edit re-lists and pays a
 * network round trip, because nothing can remember that the listing already happened. The
 * whole point of this release line is that a broken guard must not look like a working one.
 */
const STATE_WRITE_FAILED =
  '（OwnMind 無法寫入 ~/.ownmind/state/，所以每次編輯都會重列一次。請檢查該目錄權限。）';

/**
 * @param {{version: string, apiKey: string, apiUrl: string, now: number, sessionId?: string}} opts
 * @returns {Promise<string|null>} the JSON envelope to print, or null to stay silent
 */
export async function editReminder({ version, apiKey, apiUrl, now, sessionId }) {
  const decision = decideEditReminder(readEditReminderState(sessionId), now);

  if (decision.mode === 'line') {
    // No request on this path. The count is carried in the state file precisely so the
    // throttled case — the common one — puts no network round trip in front of an edit.
    const wrote = writeEditReminderState(sessionId, {
      window_start_ms: decision.window_start_ms,
      occurrence: decision.occurrence,
      rule_count: decision.rule_count,
    });
    // rule_count 0 means there is nothing to say: either this account has no rule matching
    // an edit, or the last lookup failed and this is the back-off window. Saying "0 條"
    // before every file write is noise with no content, and a brand new account — the
    // population least willing to put up with it — is exactly where it would happen.
    if (decision.rule_count <= 0) return wrote ? null : envelope(STATE_WRITE_FAILED);
    // issue #94 — the throttled line names every category too, from the counts stored in the
    // window. A state file written by an older client has none, so the pre-v1.26.151 line is
    // still what comes out until the next full listing refreshes the window.
    const contextLine = decision.counts
      ? renderHookContextLine({ version, trigger: 'edit', counts: decision.counts })
      : '';
    const line = contextLine
      ? `${contextLine} · 本小時第 ${decision.occurrence} 次`
      : renderEditReminderLine(version, decision.rule_count, decision.occurrence);
    return envelope(wrote ? line : `${line}\n${STATE_WRITE_FAILED}`);
  }

  if (!apiKey || !apiUrl) return null;

  let ctx = null;
  try {
    // issue #94 — all five categories in one request. See fetchHookContext for the fallback
    // to `/type/iron_rule` when the server predates that endpoint.
    ctx = await fetchHookContext({ apiUrl, apiKey, trigger: 'edit' });
  } catch {
    // Back off rather than retry on the next keystroke. An unreachable server would
    // otherwise cost every edit a 3s timeout for the length of the outage, silently. A
    // short window still leaves the hourly listing intact once the server is back.
    writeEditReminderState(sessionId, {
      window_start_ms: now,
      occurrence: 1,
      rule_count: 0,
      window_ms: FETCH_BACKOFF_MS,
    });
    return null;
  }

  const relevant = ctx.rules;
  // A legacy response knows the iron-rule count and nothing else. Storing zeroes for the other
  // four would have the throttled line claim they were consulted and empty, when they were
  // never asked — so nothing is stored and the old line is what gets printed.
  const counts = ctx.legacy ? undefined : ctx.counts;

  const wrote = writeEditReminderState(sessionId, {
    window_start_ms: decision.window_start_ms,
    occurrence: decision.occurrence,
    rule_count: relevant.length,
    counts,
  });

  if (relevant.length === 0) return wrote ? null : envelope(STATE_WRITE_FAILED);

  const tag = `【OwnMind v${version}】AI 改檔案要遵守的鐵律 ${relevant.length} 條`;
  const contextLine = counts
    ? renderHookContextLine({ version, trigger: 'edit', counts, withHowTo: true })
    : '';
  const lines = [
    ...(contextLine ? [contextLine, ''] : []),
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    tag,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...relevant.map(r => `  ⚠️  ${r.code || 'IR-?'}: ${r.title}`),
    '',
    '完整清單每小時列一次，同一小時內之後的編輯只會顯示一行。這是提醒，不會擋下編輯。',
  ];
  if (!wrote) lines.push(STATE_WRITE_FAILED);
  return envelope(lines.join('\n'));
}

/** Read the session id off the payload, when a caller pipes one in. */
function readSessionId() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return '';
    const p = JSON.parse(raw);
    return typeof p.session_id === 'string' ? p.session_id : '';
  } catch {
    return '';
  }
}

/** CLI entry — how the .sh hook calls this. */
async function main() {
  const { apiKey, apiUrl } = readCredentials();
  const out = await editReminder({
    version: getClientVersion(),
    apiKey,
    apiUrl,
    now: Date.now(),
    sessionId: readSessionId(),
  });
  if (out) console.log(out);
}

// Compare real paths, not the strings. `import.meta.url` is already symlink-resolved while
// `argv[1]` is whatever path the caller typed, so a hooks directory assembled with symlinks
// — which is how the tests build one — makes the two differ and this file silently does
// nothing when run as a CLI. Exactly the failure mode this release exists to stop.
function invokedDirectly() {
  try {
    return process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch(() => process.exit(0));
}
