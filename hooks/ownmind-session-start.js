#!/usr/bin/env node
/**
 * OwnMind SessionStart Hook (L4)
 *
 * 載入初始記憶並顯示鐵律摘要。
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';
import { readCredentials, getClientVersion } from '../shared/helpers.js';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.ownmind', 'logs');

function logEvent(event, extra = {}) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const now = new Date();
    const ts = now.toISOString().replace('Z', '+00:00');
    const dateStr = now.toISOString().slice(0, 10);
    const entry = JSON.stringify({ ts, event, tool: 'claude-code', source: 'hook', ...extra });
    fs.appendFileSync(path.join(LOG_DIR, `${dateStr}.jsonl`), entry + '\n');
  } catch {}
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  logEvent('init', { status: 'starting' });

  let initData;
  try {
    const raw = await httpGet(`${apiUrl}/api/memory/init?compact=true`, {
      'Authorization': `Bearer ${apiKey}`
    });
    initData = JSON.parse(raw);
  } catch {
    logEvent('init_fail', { status: 'api_timeout' });
    process.exit(0);
  }

  logEvent('init', { status: 'ok' });

  const lines = [];
  lines.push(`【OwnMind v${initData.server_version || '?'}】記憶載入：已載入你的個人記憶`);
  lines.push('');

  if (initData.profile) {
    lines.push('## Profile');
    lines.push(`- ${initData.profile.title || ''}: ${(initData.profile.content || '').substring(0, 200)}`);
    lines.push('');
  }

  if (initData.iron_rules_digest) {
    lines.push('## 鐵律（必須嚴格遵守）');
    lines.push(initData.iron_rules_digest);
    lines.push('');
  }

  if (initData.principles && initData.principles.length > 0) {
    lines.push('## 工作原則');
    initData.principles.forEach(p => lines.push(`- ${p.title}`));
    lines.push('');
  }

  if (initData.active_handoff) {
    lines.push('## 待接手交接');
    lines.push(`專案: ${initData.active_handoff.project || '?'}`);
    lines.push('');
  }

  // v1.19.14：錯誤回報通知（雙軌：管理員看新回報、回報者看處理完成）
  // fetch 失敗 / 連不到 → 靜默略過（不擋啟動流程、見 spec 場景 50）
  try {
    const isAdmin =
      initData.profile?.role === 'admin' || initData.profile?.role === 'super_admin';
    const role = isAdmin ? 'both' : 'reporter';
    const rawNotif = await httpGet(
      `${apiUrl}/api/bug-reports/notifications?role=${role}`,
      { Authorization: `Bearer ${apiKey}` }
    );
    const notif = JSON.parse(rawNotif);
    const segments = [];
    if (notif.admin && notif.admin.unhandled_count > 0) {
      segments.push(
        `身為管理員：有 ${notif.admin.unhandled_count} 筆未處理錯誤回報`
      );
    }
    if (notif.reporter && notif.reporter.unread_resolved_count > 0) {
      segments.push(
        `你的 ${notif.reporter.unread_resolved_count} 筆回報已處理`
      );
    }
    if (segments.length > 0) {
      lines.push('## 錯誤回報通知');
      segments.forEach((s) => lines.push(`- ${s}`));
      lines.push('（用「列我的回報」或後台 /admin/bug-reports 查詳情）');
      lines.push('');
    }
  } catch {
    // fetch 失敗 → 靜默略過、寫 log 但不擋啟動
    logEvent('bug_report_notifications_fetch_failed', {});
  }

  lines.push('ownmind_* MCP tools 可操作記憶。鐵律完整內容：ownmind_get("iron_rule")。');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
