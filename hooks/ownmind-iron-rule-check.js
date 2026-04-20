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
import { execSync } from 'child_process';
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

  // For git push: check that git tag matches package.json version
  if (/git push/i.test(command)) {
    try {
      const pkgVersion = VERSION !== '?' ? VERSION : null;
      if (pkgVersion) {
        const expectedTag = `v${pkgVersion}`;
        const tagOutput = execSync(`git tag -l ${expectedTag}`, { encoding: 'utf8' }).trim();
        if (!tagOutput) {
          // Tag doesn't exist — block push
          const versionTag = `【OwnMind v${VERSION}】版號卡控`;
          const blockLines = [
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            versionTag,
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `  package.json 版號為 ${pkgVersion}，但沒有對應的 git tag ${expectedTag}`,
            `  ❌ 請先執行：git tag ${expectedTag}`,
            `  然後再 git push --tags`,
            '',
            `回應格式要求：AI 的第一行必須是「${versionTag}」。`,
          ];
          console.log(JSON.stringify({
            decision: 'block',
            reason: `Missing git tag for version ${pkgVersion}`,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: blockLines.join('\n')
            }
          }));
          process.exit(0);
        }
      }
    } catch { /* ignore version check errors */ }
  }

  // commit trigger: 精簡模式（頻率高，只顯示結果）
  // deploy/delete trigger: 完整模式（頻率低風險高，列出所有規則 + 醒目標記）
  if (trigger !== 'commit') {
    const triggerTag = `【OwnMind v${VERSION}】鐵律觸發（${trigger}）`;
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(triggerTag);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    relevant.forEach(r => lines.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));
    lines.push('');
    lines.push(`回應格式要求：AI 的第一行必須是「${triggerTag}」，讓使用者看到鐵律觸發。`);
  }

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
        const blockTag = `【OwnMind v${VERSION}】鐵律攔截（${trigger}）`;
        lines.push('');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push(blockTag);
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        blockFailures.forEach(f => lines.push(`  ❌ ${f}`));
        lines.push('');
        lines.push(`回應格式要求：AI 的第一行必須是「${blockTag}」，並說明為何被擋下。請先完成上述步驟再執行 ${trigger}。`);

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

  // commit trigger 且無 block：顯示精簡通過訊息
  if (trigger === 'commit' && lines.length === 0) {
    lines.push(`【OwnMind v${VERSION}】鐵律檢查：commit 操作，${relevant.length} 條規則已確認 ✓`);
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
