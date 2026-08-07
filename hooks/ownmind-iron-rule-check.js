#!/usr/bin/env node
/**
 * OwnMind Iron Rule Check — Claude Code PreToolUse Hook (L2)
 *
 * Detect high-risk operations (commit/deploy/delete) and surface iron rule reminders.
 * Runs the verification engine for every trigger type; block_on_fail rules abort the operation.
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
    // v1.26.90: Claude Code sends { tool_name, tool_input: { command } } — reading a
    // top-level .command yielded undefined on every platform, so this hook exited at the
    // !command guard on every call, macOS included. The Windows-only half of the bug was
    // the '/dev/stdin' read above; this half was never platform-specific.
    // A bare { command } is still accepted for direct/manual invocation.
    const p = JSON.parse(input);
    command = (p.tool_input && p.tool_input.command) || p.command || '';
  } catch {}

  if (!command) process.exit(0);

  // v1.19.20: when no trigger is detected, fall back to 'command' so command-based iron rules
  // (command-based iron rules) always run verification and aren't filtered out by the trigger check.
  const detectedTrigger = detectCommandTrigger(command);
  const trigger = detectedTrigger || 'command';

  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  let rules;
  try {
    const raw = await httpGet(`${apiUrl}/api/memory/type/iron_rule`, {
      'Authorization': `Bearer ${apiKey}`
    });
    const parsed = JSON.parse(raw);
    // v1.19.20: starting in some v1.19.x release the API wraps responses in { data: [...] };
    // older hooks calling .filter directly would throw. Support both shapes.
    rules = Array.isArray(parsed) ? parsed : (parsed.data || []);
  } catch {
    process.exit(0);
  }

  const relevant = rules.filter(r => {
    if (!r.tags || r.tags.length === 0) return true;
    return r.tags.some(t =>
      t === 'trigger:' + trigger ||
      t === 'trigger:command' ||  // v1.19.20: command-based iron rules are always relevant
      (trigger === 'commit' && t === 'trigger:git')
    );
  });

  // v1.19.20: even without any reminder-relevant rule, the verification engine block may still
  // fire — do not early-return here.

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
          const versionTag = `[OwnMind v${VERSION}] Version block`;
          const blockLines = [
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            versionTag,
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            `  package.json version is ${pkgVersion}, but no matching git tag ${expectedTag} exists`,
            `  ❌ Run first: git tag ${expectedTag}`,
            `  Then: git push --tags`,
            '',
            `Response format: the AI's first line must be "${versionTag}".`,
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

  // commit trigger: compact mode (frequent — only show the result).
  // deploy/delete trigger: full mode (infrequent + high risk — list all rules with eye-catching markers).
  // v1.19.20: the 'command' fallback trigger does NOT show a reminder (it fires on command shape,
  // not operation type).
  if (trigger !== 'commit' && trigger !== 'command' && relevant.length > 0) {
    const triggerTag = `[OwnMind v${VERSION}] Iron rule triggered (${trigger})`;
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    lines.push(triggerTag);
    lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    relevant.forEach(r => lines.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));
    lines.push('');
    lines.push(`Response format: the AI's first line must be "${triggerTag}" so the user sees the rule trigger.`);
  }

  // Run verification engine for ALL triggers (commit/deploy/delete)
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const { evaluateConditions } = await import(verificationPath);

    const cachedRules = readJsonSafe(CACHE_FILE) || [];

    const triggerRules = cachedRules.filter(r => {
      const triggers = r.metadata?.verification?.trigger;
      if (!Array.isArray(triggers)) return false;
      // v1.19.20: trigger='command' iron rules are always evaluated regardless of current operation type.
      return triggers.includes(trigger) || triggers.includes('command');
    });

    if (triggerRules.length > 0) {
      const complianceEvents = readComplianceEvents();
      // v1.19.20: include command in context so command_matches / command_not_matches handlers
      // can pattern-match against the Bash command string.
      const context = { complianceEvents, command };
      const blockFailures = [];

      for (const rule of triggerRules) {
        const verification = rule.metadata?.verification;
        if (!verification?.conditions) continue;

        const result = evaluateConditions(verification.conditions, context);
        if (!result.pass && verification.block_on_fail) {
          const code = rule.code || rule.metadata?.code || 'IR-???';
          const title = rule.title || 'Unnamed rule';
          blockFailures.push(`${code}: ${title}`);
          for (const f of result.failures) {
            blockFailures.push(`    → ${f}`);
          }
        }
      }

      if (blockFailures.length > 0) {
        const blockTag = `[OwnMind v${VERSION}] Iron rule block (${trigger})`;
        lines.push('');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push(blockTag);
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        blockFailures.forEach(f => lines.push(`  ❌ ${f}`));
        lines.push('');
        lines.push(`Response format: the AI's first line must be "${blockTag}" and explain why this was blocked. Complete the steps above before executing ${trigger}.`);

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

  // commit trigger with no block: show a compact pass message.
  if (trigger === 'commit' && lines.length === 0) {
    lines.push(`[OwnMind v${VERSION}] Iron rule check: commit — ${relevant.length} rules verified ✓`);
  }

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
