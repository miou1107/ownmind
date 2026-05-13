#!/usr/bin/env node
/**
 * hooks/lib/conditional-sync-cli.js — sh hook 用的 wrapper (v1.18.0)
 *
 * 為什麼存在：
 *   sh hook 不方便直接呼叫 ESM lib、用 node CLI wrapper 把 init data 印到
 *   stdout、bash 用 `$(node ...)` 接住。
 *
 * 行為：
 *   1. 跑 runConditionalSync → 拿 init data (cache_fresh / init_refreshed / fallback)
 *   2. 若 refreshed=true → 額外打 /api/memory/sync?types=iron_rule 拿完整鐵律 list
 *      (init endpoint compact mode 不送 iron_rules array)、然後重寫本地
 *      ~/.claude/skills/ownmind-iron-rules/ + 跨工具
 *   3. 把 init data JSON 印到 stdout（給 sh 接住餵 session-start-output.js）
 *   4. 失敗 → 印空 string、exit 0（sh 會 fallback）
 *
 * 用法：
 *   INIT_DATA=$(node hooks/lib/conditional-sync-cli.js "$API_URL" "$API_KEY")
 *
 * v1.18.0-rc2 review 修正：
 *   - B1: extractIronRules 從 init data 抓不到鐵律（compact mode 不送）→
 *     改打 /api/memory/sync?types=iron_rule 拿完整列表
 *   - I3: 等 stdout drain 才 exit、避免被截斷
 *   - I4: syncToAllTools results 寫到 ~/.ownmind/logs/sync.log、debug 用
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { runConditionalSync } from './conditional-sync.js';
// v1.18.5: syncToAllTools 改成 dynamic import (line 116 內)
// 原因：iron-rule-sync.js → iron-rule-frontmatter.js → js-yaml
// user install 只在 ~/.ownmind/mcp/ 跑 npm install、不裝 root deps、js-yaml 缺
// 結果：整個 cli 在 import 階段就 ERR_MODULE_NOT_FOUND crash、SessionStart hook silent fail
// → 後遺症：cache 也沒寫、big skill 永遠不更新 (從 v1.18.0 上線就壞)
// 修法：dynamic import + 外層 try/catch、即使 big skill sync 失敗、cache + stdout init data 仍 work

const SYNC_LOG_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'sync.log');

function logSyncResult(message) {
  try {
    const dir = path.dirname(SYNC_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(SYNC_LOG_PATH, `${new Date().toISOString()} ${message}\n`);
  } catch { /* silent */ }
}

/**
 * 額外打 /api/memory/sync?types=iron_rule 拿完整 iron_rule 列表
 * (init endpoint compact mode 只送 iron_rules_digest string、不送 array)
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
    // /api/memory/sync 回 { iron_rule: [...], project: [...], ... }
    // 或 { types: { iron_rule: [...] } } 視 server 版本而定
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
 * Promise wrapper for stdout.write (確保 drain 完才 exit、避免截斷)
 */
function writeStdoutAsync(data) {
  return new Promise((resolve) => {
    const ok = process.stdout.write(data, () => resolve());
    if (!ok) {
      // 還沒 drain、等 drain event
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

  // 鐵律 sync — 只在 refreshed=true 重寫本地 skill files
  // cache_fresh 跳過避免無謂的 file system churn
  if (result.refreshed) {
    try {
      // v1.18.5: dynamic import 防 js-yaml 沒裝 → 整個 cli crash 的問題
      // 載入失敗會被外層 catch 抓住、log 後 silent skip、不擋 stdout init data 回傳
      const { syncToAllTools } = await import('../../src/utils/iron-rule-sync.js');

      // v1.18.0-rc2 B1 修正：init endpoint compact 不送 iron_rules array、
      // 額外打 /api/memory/sync 拿完整列表
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
      // sync filesystem 失敗 silent、不擋 init data 回傳
      // 常見原因：iron-rule-sync.js 鏈依賴 js-yaml、user 端沒裝 → MODULE_NOT_FOUND
      // 解法：跑 update.sh 自動補裝 js-yaml (v1.18.5)
    }
  }

  // 把 init data 印到 stdout、給 sh hook 接住
  await writeStdoutAsync(JSON.stringify(result.data));
  process.exit(0);
}

main().catch(async (err) => {
  logSyncResult(`uncaught: ${err.message}`);
  try { await writeStdoutAsync(''); } catch { /* ignore */ }
  process.exit(0);
});
