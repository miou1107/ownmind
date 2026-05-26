#!/usr/bin/env node
/**
 * scripts/audit-real-iron-rules-lint.js — v1.18.1 hotfix B
 *
 * Purpose: run lintIronRule against all 35 real iron rules in prod; report which pass /
 *          fail; for the failing ones, list the offending words; aggregate frequency counts
 *          to inform the v1.18.1 hotfix C whitelist expansion.
 *
 * Why this exists:
 *   When v1.18.0 lint shipped it only ran on POST/PUT, never retroactively against existing
 *   rows. The "all 35 rules pass" claim was an illusion — IR-004 actually got blocked the
 *   moment the upgrade assistant ran it. IR-007 lesson (fixture/prod mismatch): don't guess,
 *   validate against real data.
 *
 * Usage:
 *   node scripts/audit-real-iron-rules-lint.js
 *   Reads ~/.ownmind/cache/memories.json (synced by the SessionStart hook).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lintIronRule } from '../src/utils/iron-rule-quality.js';

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
  console.error('Unexpected response shape, keys:', Object.keys(body));
  return [];
}

async function main() {
  const { apiKey, apiUrl } = readCreds();
  if (!apiKey || !apiUrl) {
    console.error('Missing OWNMIND_API_KEY / OWNMIND_API_URL in ~/.claude/settings.json');
    process.exit(1);
  }
  const rules = await fetchRules(apiUrl, apiKey);

  console.log(`=== Auditing ${rules.length} real iron rules from prod ===`);
  console.log('');

  const passed = [];
  const failed = [];
  const allMixedWords = {};  // word → count across all failures

  for (const rule of rules) {
    const r = lintIronRule({
      title: rule.title,
      content: rule.content,
      tags: rule.tags,
    });

    if (r.ok) {
      passed.push({ code: rule.code, title: rule.title, format: r.format });
    } else {
      // Extract the English words caught by IR-037 (S8 / regex #7).
      const mixedErr = r.errors.find(e =>
        e.includes('中英混雜') || e.includes('S8') || e.includes('IR-037')
      );
      let mixedWords = [];
      if (mixedErr) {
        const m = mixedErr.match(/前 5 個[：:]\s*([^）)]+)/);
        if (m) {
          mixedWords = m[1].split(/[,，、]/).map(w => w.trim());
        }
      }
      failed.push({
        code: rule.code,
        title: rule.title,
        format: r.format,
        errors: r.errors,
        mixedWords,
      });
      for (const w of mixedWords) allMixedWords[w] = (allMixedWords[w] || 0) + 1;
    }
  }

  console.log(`PASSED: ${passed.length}/${rules.length}`);
  console.log(`FAILED: ${failed.length}/${rules.length}`);
  console.log('');

  if (failed.length > 0) {
    console.log('=== Failed rules ===');
    for (const f of failed) {
      console.log(`\n[${f.code}] ${f.title}`);
      console.log(`  format: ${f.format}`);
      for (const e of f.errors) {
        console.log(`  ✗ ${e.slice(0, 200)}${e.length > 200 ? '...' : ''}`);
      }
    }

    console.log('\n=== Top mixed words across all failures ===');
    const sorted = Object.entries(allMixedWords).sort((a, b) => b[1] - a[1]);
    for (const [w, c] of sorted) {
      console.log(`  ${c}x  ${w}`);
    }
  }

  console.log('');
  process.exit(failed.length > 0 ? 1 : 0);
}

main();
