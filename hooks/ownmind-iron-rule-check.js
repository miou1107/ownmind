#!/usr/bin/env node
// OwnMind Iron Rule Check — Claude Code PreToolUse Hook (Node.js version for Windows)
// Equivalent to ownmind-iron-rule-check.sh but without bash/curl dependency

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const LOG_DIR = path.join(HOME, '.ownmind', 'logs');

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
  // Read stdin (hook input)
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {}

  let command = '';
  try {
    command = JSON.parse(input).command || '';
  } catch {}

  if (!command) process.exit(0);

  // Detect trigger keywords
  let trigger = '';
  if (/git (commit|reset|rebase|merge)/i.test(command)) {
    trigger = 'commit';
  } else if (/git push/i.test(command)) {
    trigger = 'deploy';
  } else if (/(rm -rf|rmdir|del |drop table|DELETE FROM)/i.test(command)) {
    trigger = 'delete';
  } else if (/(docker.*deploy|docker.*up|kubectl apply|npm run deploy)/i.test(command)) {
    trigger = 'deploy';
  }

  if (!trigger) process.exit(0);

  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  // Fetch iron rules
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

  // IR-008 smart check: code changed but docs not synced
  let ir008Warning = '';
  if (trigger === 'commit') {
    try {
      const { execSync } = require('child_process');
      const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
      const stagedFiles = staged.split('\n').filter(Boolean);
      const hasCode = stagedFiles.some(f =>
        /^(src\/|mcp\/|hooks\/|install\.|skills\/|configs\/)/.test(f)
      );
      if (hasCode) {
        const missing = [];
        if (!stagedFiles.includes('README.md'))    missing.push('  ❌ README.md 未修改');
        if (!stagedFiles.includes('FILELIST.md'))   missing.push('  ❌ FILELIST.md 未修改');
        if (!stagedFiles.includes('CHANGELOG.md'))  missing.push('  ❌ CHANGELOG.md 未修改');
        if (missing.length > 0) {
          ir008Warning = '\n【OwnMind IR-008 檢查】偵測到程式碼變更但以下文件未同步：\n' +
            missing.join('\n') + '\n請先更新這些文件再 commit。';
        }
      }
    } catch {}
  }

  if (relevant.length === 0 && !ir008Warning) process.exit(0);

  logEvent('iron_rule_trigger', { trigger });

  const lines = [];
  if (relevant.length > 0) {
    lines.push(`【OwnMind 鐵律提醒】即將執行 ${trigger} 操作，請確認以下鐵律：`);
    relevant.forEach(r => lines.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));
  }
  if (ir008Warning) lines.push(ir008Warning);

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
