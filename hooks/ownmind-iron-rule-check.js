#!/usr/bin/env node
// OwnMind Iron Rule Check — Claude Code PreToolUse Hook (Node.js version for Windows)
// Equivalent to ownmind-iron-rule-check.sh but without bash/curl dependency

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const LOG_DIR = path.join(HOME, '.ownmind', 'logs');
const VERSION = (() => {
  try {
    // 統一從根目錄 package.json 讀取版號（單一來源）
    const pkg = JSON.parse(fs.readFileSync(path.join(HOME, '.ownmind', 'package.json'), 'utf8'));
    return pkg.version || '?';
  } catch { return '?'; }
})();

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

  if (relevant.length === 0) process.exit(0);

  logEvent('iron_rule_trigger', { trigger });

  const lines = [];
  lines.push(`【OwnMind v${VERSION}】鐵律提醒：即將執行 ${trigger} 操作，請確認以下鐵律`);
  relevant.forEach(r => lines.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));

  // For git push: check that git tag matches package.json version
  if (/git push/i.test(command)) {
    try {
      const pkgVersion = VERSION !== '?' ? VERSION : null;
      if (pkgVersion) {
        const expectedTag = `v${pkgVersion}`;
        const tagOutput = execSync(`git tag -l ${expectedTag}`, { encoding: 'utf8' }).trim();
        if (!tagOutput) {
          // Tag doesn't exist — block push
          const blockLines = [
            `【OwnMind v${VERSION}】版號卡控：package.json 版號為 ${pkgVersion}，但沒有對應的 git tag ${expectedTag}`,
            `  ❌ 請先執行：git tag ${expectedTag}`,
            `  然後再 git push --tags`,
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

  // For deploy/delete: run verification engine
  if (trigger === 'deploy' || trigger === 'delete') {
    try {
      const os = require('os');
      const verificationPath = path.join(os.homedir(), '.ownmind', 'shared', 'verification.js');
      const { evaluateConditions } = await import(verificationPath);

      const cacheFile = path.join(os.homedir(), '.ownmind', 'cache', 'iron_rules.json');
      const complianceLog = path.join(os.homedir(), '.ownmind', 'logs', 'compliance.jsonl');

      let cachedRules = [];
      try { cachedRules = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch {}

      const triggerRules = cachedRules.filter(r => {
        const triggers = r.metadata?.verification?.trigger;
        return Array.isArray(triggers) && triggers.includes(trigger);
      });

      if (triggerRules.length > 0) {
        // Read compliance events (last 24h)
        let complianceEvents = [];
        try {
          const raw = fs.readFileSync(complianceLog, 'utf8').trim();
          if (raw) {
            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            for (const line of raw.split('\n')) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);
                if (new Date(entry.ts).getTime() >= cutoff) complianceEvents.push(entry);
              } catch {}
            }
          }
        } catch {}

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
  }

  // For commit: always allow (L1 handles blocking), just show reminders
  // For deploy/delete: all verifications passed, allow
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
