#!/usr/bin/env node
/**
 * OwnMind SessionStart Hook (L4)
 *
 * Load initial memory and display the iron rule digest.
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

/**
 * v1.26.83 — report an event to the server as well as the local JSONL.
 *
 * The bash hook has always POSTed each event to /api/activity/batch; this file's port
 * dropped that line, so a Windows machine whose hook worked was indistinguishable,
 * server-side, from one whose hook was dead. Found while verifying the v1.26.82 rollout:
 * Adam restarted, his MCP showed up, and the hook-sourced init this whole repair is judged
 * by could never have appeared. Worse, the memory_load self-check reads exactly that
 * event, so every healthy Windows machine would be reported broken forever.
 *
 * Fire-and-forget with a short timeout: session start must never wait on telemetry, and
 * the pending request keeps the process alive just long enough to finish on its own.
 */
function reportEvent(apiUrl, apiKey, event, extra = {}) {
  logEvent(event, extra);
  try {
    const url = `${String(apiUrl).replace(/\/$/, '')}/api/activity/batch`;
    const body = JSON.stringify({
      events: [{
        ts: new Date().toISOString(),
        event,
        tool: 'claude-code',
        source: 'hook',
        ...extra,
      }],
    });
    const mod = url.startsWith('https') ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 3000,
    }, (res) => { res.resume(); });
    req.on('error', () => {});
    req.on('timeout', () => req.destroy());
    req.end(body);
  } catch { /* telemetry must never break session start */ }
}

async function main() {
  // v1.20.3: when a new session starts, clear the legacy "session temporarily disabled" state file.
  // Implements the spec's "new session auto-resumes" — opening a new conversation re-enables the OwnMind hooks.
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
    reportEvent(apiUrl, apiKey, 'init_fail', { status: 'api_timeout' });
    process.exit(0);
  }

  reportEvent(apiUrl, apiKey, 'init', { status: 'ok' });

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

  // v1.19.14: bug report notifications (two channels — admin sees new reports, reporter sees resolutions).
  // Fetch failure / unreachable → silently skip (do not block startup, see spec scenario 50).
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
    // fetch failed → silently skip, log it but don't block startup.
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
