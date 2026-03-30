#!/usr/bin/env node
// OwnMind SessionStart Hook (Node.js version for Windows)
// Equivalent to ownmind-session-start.sh but without bash/curl dependency

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const HOME = process.env.HOME || process.env.USERPROFILE;
const OWNMIND_DIR = path.join(HOME, '.ownmind');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const LOG_DIR = path.join(OWNMIND_DIR, 'logs');

function readCredentials() {
  try {
    const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
    const env = s.mcpServers?.ownmind?.env || {};
    return { apiKey: env.OWNMIND_API_KEY || '', apiUrl: env.OWNMIND_API_URL || '' };
  } catch {
    return { apiKey: '', apiUrl: '' };
  }
}

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
  lines.push(`【OwnMind v${initData.server_version || '?'}】記憶已自動載入`);
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

  lines.push('ownmind_* MCP tools 可操作記憶。鐵律完整內容：ownmind_get("iron_rule")。');

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
