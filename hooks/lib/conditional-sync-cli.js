#!/usr/bin/env node
/**
 * hooks/lib/conditional-sync-cli.js — wrapper for the sh hook (v1.18.0)
 *
 * Why this exists:
 *   The sh hook can't conveniently call an ESM lib directly, so a Node CLI wrapper writes the init
 *   data to stdout and bash captures it via `$(node ...)`.
 *
 * Behavior:
 *   1. Run runConditionalSync → produce init data (cache_fresh / init_refreshed / fallback).
 *   2. If refreshed=true → additionally call /api/memory/sync?types=iron_rule for the full
 *      iron rule list (the init endpoint's compact mode doesn't include the array), then rewrite
 *      local ~/.claude/skills/ownmind-iron-rules/ + cross-tool files.
 *   3. Print the init data JSON to stdout (consumed by the sh wrapper and forwarded to
 *      session-start-output.js).
 *   4. Failure → print empty string and exit 0 (sh falls back).
 *
 * Usage:
 *   INIT_DATA=$(node hooks/lib/conditional-sync-cli.js "$API_URL" "$API_KEY")
 *
 * v1.18.0-rc2 review fixes:
 *   - B1: extractIronRules can't pull iron rules from the init data (compact mode doesn't send them)
 *         → call /api/memory/sync?types=iron_rule for the full list instead.
 *   - I3: wait for stdout drain before exiting (avoid truncation).
 *   - I4: log syncToAllTools results to ~/.ownmind/logs/sync.log (for debugging).
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runConditionalSync } from './conditional-sync.js';
// v1.18.5: syncToAllTools switched to dynamic import (line 116 below).
// Reason: iron-rule-sync.js → iron-rule-frontmatter.js → js-yaml.
// User install only runs npm install in ~/.ownmind/mcp/ — root deps aren't installed, so js-yaml is missing.
// Result: the entire CLI crashed at import time with ERR_MODULE_NOT_FOUND, the SessionStart hook
// silently failed → cache wasn't written, the big skill never updated (broken since v1.18.0 shipped).
// Fix: dynamic import + outer try/catch — even if big-skill sync fails, the cache + stdout init
// data still work.

const SYNC_LOG_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'sync.log');

function logSyncResult(message) {
  try {
    const dir = path.dirname(SYNC_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(SYNC_LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch { /* silent */ }
}

/**
 * Additionally call /api/memory/sync?types=iron_rule to get the full iron_rule list
 * (the init endpoint compact mode only sends iron_rules_digest as a string, not an array).
 */
async function fetchIronRuleList(apiUrl, apiKey) {
  if (!apiUrl || !apiKey) return [];
  try {
    const url = `${apiUrl.replace(/\/$/, '')}/api/memory/sync?types=iron_rule`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const body = await res.json();
    // /api/memory/sync returns { iron_rule: [...], project: [...], ... }
    // or { types: { iron_rule: [...] } } depending on server version.
    if (Array.isArray(body?.iron_rule)) return body.iron_rule;
    if (Array.isArray(body?.types?.iron_rule)) return body.types.iron_rule;
    if (Array.isArray(body?.memories)) {
      return body.memories.filter(m => m?.type === 'iron_rule');
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Promise wrapper for stdout.write (ensures drain completes before exit to avoid truncation).
 */
function writeStdoutAsync(data) {
  return new Promise((resolve) => {
    const ok = process.stdout.write(data, () => resolve());
    if (!ok) {
      // Not drained yet — wait for the drain event.
      process.stdout.once('drain', resolve);
    }
  });
}

async function main() {
  const apiUrl = process.argv[2];
  const apiKey = process.argv[3];

  if (!apiUrl || !apiKey) {
    await writeStdoutAsync('');
    process.exit(0);
  }

  let result;
  try {
    result = await runConditionalSync({ apiUrl, apiKey });
  } catch (err) {
    logSyncResult(`runConditionalSync error: ${err.message}`);
    await writeStdoutAsync('');
    process.exit(0);
  }

  if (result.source === 'error' || !result.data) {
    logSyncResult(`source=${result.source}, no data`);
    await writeStdoutAsync('');
    process.exit(0);
  }

  // Iron-rule sync — only rewrite local skill files when refreshed=true.
  // cache_fresh is skipped to avoid pointless filesystem churn.
  if (result.refreshed) {
    try {
      // v1.18.5: dynamic import guards against "js-yaml not installed → whole CLI crashes".
      // A load failure is caught by the outer catch, logged, and silently skipped — does not block
      // the stdout init data response.
      const { syncToAllTools } = await import('../../src/utils/iron-rule-sync.js');

      // v1.18.0-rc2 B1 fix: init endpoint compact doesn't send the iron_rules array, so we
      // additionally call /api/memory/sync for the full list.
      const ironRules = await fetchIronRuleList(apiUrl, apiKey);
      if (ironRules.length > 0) {
        const results = syncToAllTools(ironRules);
        const written = results.filter(r => r.written).map(r => r.target);
        const skipped = results.filter(r => !r.written).map(r => r.target);
        logSyncResult(
          `sync ${ironRules.length} rules — written: [${written.join(',')}] / skipped: [${skipped.join(',')}]`
        );
      } else {
        logSyncResult('no iron_rule list returned, skip filesystem sync');
      }
    } catch (err) {
      logSyncResult(`syncToAllTools error: ${err.message}`);
      // Filesystem sync failure is silent — does not block the init data response.
      // Common cause: iron-rule-sync.js depends on js-yaml further down the chain; user env
      // doesn't have it → MODULE_NOT_FOUND. Fix: run update.sh which auto-installs js-yaml (v1.18.5).
    }
  }

  // Write init data to stdout for the sh hook to consume.
  await writeStdoutAsync(JSON.stringify(result.data));
  process.exit(0);
}

main().catch(async (err) => {
  logSyncResult(`uncaught: ${err.message}`);
  try { await writeStdoutAsync(''); } catch { /* ignore */ }
  process.exit(0);
});
