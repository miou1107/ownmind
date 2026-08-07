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
import { readJsonSafe, getClientVersion, readCredentials, detectCommandTrigger, detectToolTrigger, ruleMatchesTrigger } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';
import { editReminder } from './ownmind-edit-reminder.js';

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

/** True when the current working directory is the OwnMind checkout itself. */
function inOwnMindCheckout() {
  try {
    const top = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!top) return false;
    return fs.realpathSync(top) === fs.realpathSync(path.join(HOME, '.ownmind'));
  } catch {
    return false;
  }
}

async function main() {
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf8');
  } catch {}

  let command = '';
  let toolName = '';
  let sessionId = '';
  try {
    // v1.26.90: Claude Code sends { tool_name, tool_input: { command } } — reading a
    // top-level .command yielded undefined on every platform, so this hook exited at the
    // !command guard on every call, macOS included. This copy's stdin read was already
    // correct; the Windows-only '/dev/stdin' half of the bug was in the .sh sibling.
    // A bare { command } is still accepted for direct/manual invocation.
    const p = JSON.parse(input);
    const raw = (p.tool_input && p.tool_input.command) || p.command;
    command = typeof raw === 'string' ? raw : '';
    toolName = typeof p.tool_name === 'string' ? p.tool_name : '';
    sessionId = typeof p.session_id === 'string' ? p.session_id : '';
  } catch {}

  // v1.26.92: a file-editing tool carries no command, so this used to exit here — which is
  // why no rule tagged trigger:edit had ever fired. The command path keeps priority, so a
  // payload carrying both is still resolved by detectCommandTrigger, unchanged.
  let trigger;
  if (command) {
    // v1.19.20: when no trigger is detected, fall back to 'command' so command-based iron rules
    // (command-based iron rules) always run verification and aren't filtered out by the trigger check.
    trigger = detectCommandTrigger(command) || 'command';
  } else {
    trigger = detectToolTrigger(toolName);
    if (!trigger) process.exit(0);
  }

  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  // v1.26.92: editing is the most frequent thing in a session, so the edit trigger takes
  // its own path — throttled, and deliberately never reaching the verification engine
  // below, which is the only code here that can emit `decision: block`. Its conditions are
  // written for commit and deploy; none of them can be satisfied by an edit.
  if (trigger === 'edit') {
    const out = await editReminder({ version: VERSION, apiKey, apiUrl, now: Date.now(), sessionId });
    if (out) console.log(out);
    process.exit(0);
  }

  // v1.26.90: the fetched rules feed the reminder only, and the reminder block below skips
  // the 'command' fallback trigger entirely — so for an ordinary Bash command this request
  // was pure cost. It never showed before because the hook exited above on every call; now
  // that it runs, it would put a network round trip (3s timeout) in front of every single
  // Bash tool call. The verification engine reads the local cache, not this response.
  let rules = [];
  if (trigger !== 'command') {
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
  }

  // v1.26.91: was an inline match on 'trigger:<trigger>' plus a commit/git special case,
  // which meant a rule tagged in any other vocabulary could never match. See
  // TRIGGER_TAG_ALIASES for why that silently stranded whole rule sets.
  const relevant = rules.filter(r => ruleMatchesTrigger(r, trigger));

  // v1.19.20: even without any reminder-relevant rule, the verification engine block may still
  // fire — do not early-return here.

  const lines = [];

  // For git push: check that git tag matches package.json version.
  //
  // v1.26.90: scoped to the OwnMind checkout. This compares OwnMind's own version against
  // `git tag -l` in the user's current directory — a maintainer release gate that only ever
  // made sense in this repo. It had never executed (the hook exited at the empty-command
  // guard on every call), so without this scoping the fix would start blocking `git push`
  // in every other repository, telling the user to create OwnMind's version tag there.
  if (/git push/i.test(command) && inOwnMindCheckout()) {
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

  // Run verification engine for ALL triggers (commit/deploy/delete).
  //
  // v1.26.90: this reports, it does not block — see the matching note in the .sh sibling.
  // The conditions come from the local rule cache, which mirrors the server, and the
  // server-side data still carries verification templates that a pre-v1.26.89 bug attached
  // on its own (every one of them `block_on_fail`). Nobody has ever seen this path run, so
  // switching the hook back on would switch on enforcement of conditions no user wrote.
  // This copy is stricter than the .sh one — it evaluates on `commit` too, not just
  // deploy/delete — so it would have been the harsher of the two.
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
        const warnTag = `[OwnMind v${VERSION}] Iron rule reminder (${trigger})`;
        lines.push('');
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        lines.push(warnTag);
        lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        blockFailures.forEach(f => lines.push(`  ⚠️  ${f}`));
        lines.push('');
        lines.push(`Response format: the AI's first line must be "${warnTag}" and address the points above. This is a reminder; it does not stop the ${trigger}.`);

        console.log(JSON.stringify({
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

  // v1.26.90: nothing to say — stay silent rather than injecting an empty context blob into
  // every Bash tool call.
  if (lines.length === 0) return;

  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join('\n')
    }
  }));
}

main().catch(() => process.exit(0));
