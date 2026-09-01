#!/usr/bin/env node
/**
 * hooks/lib/session-start-output.js — JSON output wrapper for the SessionStart hook.
 *
 * Usage: node session-start-output.js '<init JSON>' '<broadcasts JSON>' ['<notifications JSON>']
 * Output: JSON to stdout matching the Claude Code hookSpecificOutput schema.
 *
 * Why extract this: the render logic (renderSessionContext) can be imported directly by
 * tests/session-start-render.test.js.
 *
 * The bug-report notifications are fetched here rather than by the shell hook that calls this.
 * Which half of that endpoint an account may ask for depends on `profile.role` in the init
 * payload, and this script is the first place on the macOS and Linux path where that payload is
 * already parsed. Deciding it in bash would mean either a second copy of the rule or a `node -e`
 * whose dynamic `import()` of an absolute path is the failure this repository has recorded twice
 * on Windows. `renderSessionContext` stays pure; the answer is handed to it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderSessionContext } from './render-session-context.js';
import { roleForProfile, fetchBugReportNotifications } from './bug-report-notifications.js';
import { readCredentials } from '../../shared/helpers.js';
import { localDateOnly, localIsoTimestamp } from '../../shared/local-date.js';

const LOG_DIR = path.join(os.homedir(), '.ownmind', 'logs');

/**
 * The same JSONL sink the two session-start hooks write to.
 *
 * Without it this path has no record of anything: the Windows hook logs
 * `bug_report_notifications_fetch_failed`, and shipping the newly-covered platform with no
 * equivalent would mean the next time this channel breaks on a Mac, the way anyone finds out is
 * a person noticing they were never told — which is how the present bug was found.
 */
function logEvent(event, details = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    fs.appendFileSync(
      path.join(LOG_DIR, `${localDateOnly(now)}.jsonl`),
      `${JSON.stringify({
        ts: localIsoTimestamp(now), event, tool: 'claude-code', source: 'hook', details,
      })}\n`,
    );
  } catch { /* a missing log line must not cost the load */ }
}

let initData = {};
let broadcasts = [];
try { initData = JSON.parse(process.argv[2] || '{}'); } catch {}
try { broadcasts = JSON.parse(process.argv[3] || '[]'); } catch {}

/**
 * Three seconds, matching the `--max-time 3` the shell hook uses for broadcasts.
 */
async function httpGet(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

let notifications = null;
try {
  // A third argument, when given and non-empty, wins: it is how a test drives the render
  // without a server. Empty is treated as absent so a future edit to the shell hook that passes
  // an unset variable falls through to the fetch rather than silently disabling it.
  if (process.argv[4]) {
    notifications = JSON.parse(process.argv[4]);
  } else {
    const { apiKey, apiUrl } = readCredentials();
    notifications = await fetchBugReportNotifications({
      apiUrl, apiKey, role: roleForProfile(initData.profile), httpGet,
    });
    if (apiKey && apiUrl && !notifications) logEvent('bug_report_notifications_fetch_failed', {});
  }
} catch {
  // Never at the cost of the load: no credentials, a bad argument, a broken log — all mean the
  // section is skipped and everything else still prints.
  notifications = null;
}

const additionalContext = renderSessionContext(initData, broadcasts, { notifications });

// exit(0) once stdout has drained, rather than waiting for the event loop to empty.
//
// `AbortSignal.timeout` rejects the fetch on time but does not tear down a TCP connect that is
// still waiting for a SYN-ACK, so on a network that drops packets rather than refusing them —
// hotel wifi, a captive portal, a VPN that is down — the socket held this process open for a
// measured 10.66s after the 3s abort. The hook is registered with a 10s timeout, so bash was
// killed mid-way: the whole context injection lost, and the memory-file sync that runs after
// this line in the shell hook never reached. Trading "a Mac user is not told their bug was
// fixed" for "a Mac user on bad wifi loses their memory load" is not a trade worth making.
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext
  }
}), () => process.exit(0));
