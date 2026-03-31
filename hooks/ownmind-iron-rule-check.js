#!/usr/bin/env node
/**
 * OwnMind Iron Rule Check — Claude Code PreToolUse Hook (L2)
 *
 * 偵測高風險操作（commit/deploy/delete），顯示鐵律提醒。
 * 對所有 trigger 類型都跑 verification engine，block_on_fail 規則會擋下操作。
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { readJsonSafe, getClientVersion, readCredentials, detectCommandTrigger } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const VERSION = getClientVersion();

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

async function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {}

  let command = '';
  try {
    command = JSON.parse(input).command || '';
  } catch {}

  if (!command) process.exit(0);

  const trigger = detectCommandTrigger(command);
  if (!trigger) process.exit(0);

  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  let rules;
  try {
    const raw = await httpGet(`${apiUrl}/api/memory/type/iron_rule`, {
      'Authorization': `Bearer ${apiKey}`
    });
    rules = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const relevant = rules.filter(r => {
    if (!r.tags || r.tags.length === 0) return true;
    return r.tags.some(t =>
      t === 'trigger:' + trigger ||
      (trigger === 'commit' && t === 'trigger:git')
    );
  });

  if (relevant.length === 0) process.exit(0);

  const lines = [];
  lines.push(`【OwnMind v${VERSION}】鐵律提醒：即將執行 ${trigger} 操作，請確認以下鐵律`);
  relevant.forEach(r => lines.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));

  // Run verification engine for ALL triggers (commit/deploy/delete)
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const { evaluateConditions } = await import(verificationPath);

    const cachedRules = readJsonSafe(CACHE_FILE) || [];

    const triggerRules = cachedRules.filter(r => {
      const triggers = r.metadata?.verification?.trigger;
      return Array.isArray(triggers) && triggers.includes(trigger);
    });

    if (triggerRules.length > 0) {
      const complianceEvents = readComplianceEvents();
      const context = { complianceEvents };
      const blockFailures = [];

      for (const rule of triggerRules) {
        const verification = rule.metadata?.verification;
        if (!verification?.conditions) continue;

        const result = evaluateConditions(verification.conditions, context);
        if (!result.pass && verification.block_on_fail) {
          const code = rule.code || rule.metadata?.code || 'IR-???';
          const title = rule.title || '未命名規則';
          blockFailures.push(`${code}: ${title}`);
          for (const f of result.failures) {
            blockFailures.push(`    → ${f}`);
          }
        }
      }

      if (blockFailures.length > 0) {
        lines.push('');
        lines.push(`【OwnMind v${VERSION}】鐵律攔截：${trigger} 操作被擋下`);
        blockFailures.forEach(f => lines.push(`  ❌ ${f}`));
        lines.push(`請先完成上述步驟再執行 ${trigger}。`);

        console.log(JSON.stringify({
          decision: 'block',
          reason: `Iron rule verification failed for ${trigger} operation`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: lines.join('\n')
          }
        }));
        return;
      }
    }
  } catch {
    // Verification engine not available, continue with reminder only
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
