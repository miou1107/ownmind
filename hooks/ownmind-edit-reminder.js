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
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { getClientVersion, readCredentials, ruleMatchesTrigger } from '../shared/helpers.js';
import {
  readEditReminderState,
  writeEditReminderState,
  decideEditReminder,
  renderEditReminderLine,
} from '../shared/edit-reminder-state.js';

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function envelope(text) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text },
  });
}

/**
 * @param {{version: string, apiKey: string, apiUrl: string, now: number}} opts
 * @returns {Promise<string|null>} the JSON envelope to print, or null to stay silent
 */
export async function editReminder({ version, apiKey, apiUrl, now }) {
  const decision = decideEditReminder(readEditReminderState(), now);

  if (decision.mode === 'line') {
    // No request on this path. The count is carried in the state file precisely so the
    // throttled case — the common one — puts no network round trip in front of an edit.
    writeEditReminderState({
      window_start_ms: decision.window_start_ms,
      occurrence: decision.occurrence,
      rule_count: decision.rule_count,
    });
    return envelope(renderEditReminderLine(version, decision.rule_count, decision.occurrence));
  }

  if (!apiKey || !apiUrl) return null;

  let rules = [];
  try {
    const raw = await httpGet(`${apiUrl}/api/memory/type/iron_rule`, {
      'Authorization': `Bearer ${apiKey}`,
    });
    const parsed = JSON.parse(raw);
    // The API wraps responses as { data: [...] }; older shapes were a bare array.
    rules = Array.isArray(parsed) ? parsed : (parsed.data || []);
  } catch {
    // Leave the window closed: a failed fetch must not cost the user their listing for the
    // next hour. The next edit tries again.
    return null;
  }

  const relevant = rules.filter(r => ruleMatchesTrigger(r, 'edit'));

  writeEditReminderState({
    window_start_ms: decision.window_start_ms,
    occurrence: decision.occurrence,
    rule_count: relevant.length,
  });

  if (relevant.length === 0) return null;

  const tag = `【OwnMind v${version}】AI 改檔案要遵守的鐵律 ${relevant.length} 條`;
  const lines = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    tag,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ...relevant.map(r => `  ⚠️  ${r.code || 'IR-?'}: ${r.title}`),
    '',
    '完整清單每小時列一次，同一小時內之後的編輯只會顯示一行。這是提醒，不會擋下編輯。',
  ];
  return envelope(lines.join('\n'));
}

/** CLI entry — how the .sh hook calls this. */
async function main() {
  const { apiKey, apiUrl } = readCredentials();
  const out = await editReminder({
    version: getClientVersion(),
    apiKey,
    apiUrl,
    now: Date.now(),
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
