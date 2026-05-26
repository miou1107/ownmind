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
import { clearSessionOffState, readSessionOffState } from '../shared/session-off-state.js';

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
  // v1.20.3：新 session 開啟時、清掉舊的「session 暫時關閉」狀態檔
  // 達成 spec 寫的「新 session 自動恢復」（白話：開新對話、OwnMind 鉤子自動重新啟用）
  try {
    const prev = readSessionOffState();
    if (prev) {
      clearSessionOffState();
      logEvent('session_off_cleared_on_new_session', { prev_session_id: prev.session_id });
    }
  } catch { /* fail-open */ }

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
  lines.push(`[OwnMind v${initData.server_version || '?'}] Memory loaded: your personal memories are now active`);
  lines.push('');

  if (initData.profile) {
    lines.push('## Profile');
    lines.push(`- ${initData.profile.title || ''}: ${(initData.profile.content || '').substring(0, 200)}`);
    lines.push('');
  }

  if (initData.iron_rules_digest) {
    lines.push('## Iron rules (strictly enforced)');
    lines.push(initData.iron_rules_digest);
    lines.push('');
  }

  if (initData.principles && initData.principles.length > 0) {
    lines.push('## Working principles');
    initData.principles.forEach(p => lines.push(`- ${p.title}`));
    lines.push('');
  }

  if (initData.active_handoff) {
    lines.push('## Pending handoff');
    lines.push(`Project: ${initData.active_handoff.project || '?'}`);
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
        `As admin: ${notif.admin.unhandled_count} unhandled bug reports`
      );
    }
    if (notif.reporter && notif.reporter.unread_resolved_count > 0) {
      segments.push(
        `${notif.reporter.unread_resolved_count} of your reports have been resolved`
      );
    }
    if (segments.length > 0) {
      lines.push('## Bug report notifications');
      segments.forEach((s) => lines.push(`- ${s}`));
      lines.push('(Say "list my reports" or open /admin/bug-reports for details)');
      lines.push('');
    }
  } catch {
    // fetch 失敗 → 靜默略過、寫 log 但不擋啟動
    logEvent('bug_report_notifications_fetch_failed', {});
  }

  lines.push('The ownmind_* MCP tools manage memory. For full iron rule content: ownmind_get("iron_rule").');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
