#!/usr/bin/env node
/**
 * scripts/backfill-iron-rule-origin-context.js — v1.18.2 backfill for 35 existing iron rules.
 *
 * Tags every iron_rule lacking metadata.origin_context with confidence='user_direct' +
 * event='v1.18.2 backfill: origin unknown; treated as a direct user instruction'.
 *
 * Behavior:
 *   - Pull every active iron_rule, check metadata.origin_context.
 *   - Missing → add user_direct + backfill event.
 *   - Present → skip (idempotent).
 *   - **Does NOT modify content body** (keep original content; only touch metadata).
 *     In the future Vin can manually fill in `event` and inject a body section via the
 *     upgrade assistant.
 *
 * Usage:
 *   node scripts/backfill-iron-rule-origin-context.js [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DRY_RUN = process.argv.includes('--dry-run');

function readCreds() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const env = s.mcpServers?.ownmind?.env || {};
  return { apiKey: env.OWNMIND_API_KEY, apiUrl: env.OWNMIND_API_URL };
}

async function fetchRules(apiUrl, apiKey) {
  const url = `${apiUrl.replace(/\/$/, '')}/api/memory/sync?types=iron_rule`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (Array.isArray(body?.iron_rule)) return body.iron_rule;
  if (Array.isArray(body?.types?.iron_rule)) return body.types.iron_rule;
  if (Array.isArray(body?.memories)) return body.memories.filter(m => m?.type === 'iron_rule');
  return [];
}

async function fetchSyncToken(apiUrl, apiKey) {
  const url = `${apiUrl.replace(/\/$/, '')}/api/memory/sync-token`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return body.sync_token;
}

async function updateRule(apiUrl, apiKey, ruleId, metadata, syncToken) {
  const url = `${apiUrl.replace(/\/$/, '')}/api/memory/${ruleId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      metadata,
      update_reason: 'v1.18.2 backfill: fill in origin_context (origin unknown; user_direct)',
      sync_token: syncToken,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  // Pick up the new sync_token (it changes after every update).
  try { return JSON.parse(text).sync_token; } catch { return syncToken; }
}

async function main() {
  const { apiKey, apiUrl } = readCreds();
  if (!apiKey || !apiUrl) {
    console.error('Missing OWNMIND_API_KEY / OWNMIND_API_URL');
    process.exit(1);
  }

  console.log(`=== Backfill iron_rule origin_context (${DRY_RUN ? 'DRY RUN' : 'LIVE'}) ===`);
  const rules = await fetchRules(apiUrl, apiKey);
  console.log(`Total active iron_rule: ${rules.length}`);

  const skipped = [];
  const toUpdate = [];

  for (const rule of rules) {
    if (rule.metadata?.origin_context) {
      skipped.push({ id: rule.id, code: rule.code, title: rule.title });
    } else {
      toUpdate.push(rule);
    }
  }

  console.log(`Already has origin_context: ${skipped.length}`);
  console.log(`To backfill: ${toUpdate.length}`);
  console.log('');

  if (skipped.length > 0) {
    console.log('--- Skipped (already has origin_context) ---');
    for (const s of skipped) console.log(`  [${s.code}] ${s.title}`);
    console.log('');
  }

  if (toUpdate.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  if (DRY_RUN) {
    console.log('--- Would backfill ---');
    for (const r of toUpdate) console.log(`  [${r.code || `id-${r.id}`}] ${r.title}`);
    console.log('\n(DRY RUN — no writes. Re-run without --dry-run to apply.)');
    return;
  }

  let syncToken = await fetchSyncToken(apiUrl, apiKey);
  console.log(`Initial sync_token: ${syncToken}`);
  console.log('');

  let success = 0;
  let failed = 0;
  for (const rule of toUpdate) {
    const newMetadata = {
      ...(rule.metadata || {}),
      origin_context: {
        captured_at: new Date().toISOString(),
        confidence: 'user_direct',
        event: 'v1.18.2 backfill: origin unknown; treated as a direct user instruction',
        // Do not set cwd / git_branch / project — unknowable at backfill time.
      },
    };
    try {
      syncToken = await updateRule(apiUrl, apiKey, rule.id, newMetadata, syncToken);
      console.log(`  ✓ [${rule.code || `id-${rule.id}`}] ${rule.title}`);
      success++;
    } catch (e) {
      console.log(`  ✗ [${rule.code || `id-${rule.id}`}] ${rule.title} — ${e.message}`);
      failed++;
    }
  }

  console.log('');
  console.log(`=== Done: ${success} backfilled, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
