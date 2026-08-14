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
import { pathToFileURL } from 'url';
import { execSync } from 'child_process';
import { readJsonSafe, getClientVersion, readCredentials, detectCommandTrigger, detectToolTrigger } from '../shared/helpers.js';
import { renderHookContextLine } from '../shared/hook-context.js';
import { fetchHookContext } from './lib/hook-context-fetch.js';
import { readComplianceEvents } from '../shared/compliance.js';
import { editReminder } from './ownmind-edit-reminder.js';
import {
  readEditReminderState,
  writeEditReminderState,
  decideEditReminder,
} from '../shared/edit-reminder-state.js';
// v1.26.108 — `await import()` takes a module specifier, and an absolute filesystem path is
// only accidentally one. On Windows it starts with a drive letter, which the ESM loader reads
// as a URL scheme and rejects: ERR_UNSUPPORTED_ESM_URL_SCHEME. On macOS and Linux the same
// string begins with `/` and resolves, which is why this only ever failed on Windows — and
// failed into a catch that exits 0, so the hook went quiet instead of going wrong.
const importFile = (p) => import(pathToFileURL(p).href);

const NOT_GATED_LINE =
  '[OwnMind] the action gate could not run - this command was NOT gated';
const DEGRADED_LINE =
  '[OwnMind] the action gate could not run in full - receipts unavailable, checks still enforced';

/**
 * Looks up a gate notice through t(), but the two lines above are what tell the user the
 * gate itself just broke — that lookup must never depend on the same i18n module it would be
 * reporting as broken. A dynamic import here (not a static one at module scope) means a
 * broken hooks/lib/i18n.js only ever degrades this ONE notice's text to the plain English
 * literal; it cannot take down this whole hook before main() even runs. LITERAL DUPLICATE of
 * the same helper in hooks/lib/action-gate-cli.js — these are independent client wirings of
 * one protocol, not a shared module, same as the notice strings themselves.
 */
async function gateNotice(key, fallback) {
  try {
    const { t } = await import('./lib/i18n.js');
    return t(key);
  } catch {
    return fallback;
  }
}

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

  // --- P1 action gate (v1.26.172) ---
  //
  // Before the credential guard on purpose: the gate reads the local enforcement cache,
  // not the API, so a machine that has never stored a key is still enforced. A block
  // replaces the reminder flow entirely — a blocked command needs no reminder — and the
  // degraded/fail-open notices take the same early exit, matching the .sh twin, which
  // echoes whatever the gate CLI prints and stops. Two wirings of one protocol must not
  // differ in what a platform is told.
  //
  // Fail-open-LOUD: anything thrown in here lets the command run but says so. The imports
  // are dynamic and inside the try so a broken gate module degrades to that message
  // instead of taking the whole hook down silently via main().catch.
  if (command) {
    try {
      const { evaluateGate } = await import('./lib/action-gate.js');
      const { readEnforcementBundle } = await import('./lib/enforcement-cache.js');
      const { ensureKey, ensureNonce } = await import('./lib/gate-receipt.js');

      const bundle = readEnforcementBundle();
      const stateDir = path.join(HOME, '.ownmind', 'state');
      const sid = /^[A-Za-z0-9._-]+$/.test(sessionId) ? sessionId : 'unknown';

      // Idempotent provisioning; a failure is survivable — evaluateGate degrades to
      // stateless checks and reports it through the degraded flag below.
      try {
        ensureKey(stateDir);
        ensureNonce(stateDir, sid);
      } catch { /* evaluateGate reports the degradation itself */ }

      const gate = evaluateGate({ command, guards: bundle.guards, stateDir, sessionId: sid });
      if (gate.action === 'block') {
        console.log(JSON.stringify({
          decision: 'block',
          reason: gate.reason,
          systemMessage: gate.userLine,
          hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '' },
        }));
        process.exit(0);
      }
      if (gate.degraded) {
        console.log(JSON.stringify({
          systemMessage: await gateNotice('gate.degraded', DEGRADED_LINE),
        }));
        process.exit(0);
      }
      // plain allow: fall through to the reminder flow in silence
    } catch {
      console.log(JSON.stringify({
        systemMessage: await gateNotice('gate.failopen', NOT_GATED_LINE),
      }));
      process.exit(0);
    }
  }

  const { apiKey, apiUrl } = readCredentials();
  if (!apiKey || !apiUrl) process.exit(0);

  // v1.26.92: editing is the most frequent thing in a session, so the edit trigger takes
  // its own path — throttled, and deliberately never reaching the verification engine
  // below, which is the only code here that can emit `decision: block`. Its conditions are
  // written for commit and deploy; none of them can be satisfied by an edit.
  if (trigger === 'edit') {
    // The path and the incoming text come out of the payload this function already read.
    // stdin is spent by now, so they are parsed from `input` rather than read again — and
    // without them the guard inside editReminder has nothing to judge, which on Windows
    // (the only platform that reaches this branch) would mean no guard at all.
    let filePath = '';
    let content = '';
    try {
      const toolInput = JSON.parse(input)?.tool_input || {};
      filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
      content = [toolInput.content, toolInput.new_string]
        .filter((s) => typeof s === 'string')
        .join('\n');
    } catch { /* a payload without tool_input simply has nothing to guard */ }

    const out = await editReminder({
      version: VERSION, apiKey, apiUrl, now: Date.now(), sessionId, filePath, content,
    });
    if (out) console.log(out);
    process.exit(0);
  }

  // v1.26.90: the fetched rules feed the reminder only, and the reminder block below skips
  // the 'command' fallback trigger entirely — so for an ordinary Bash command this request
  // was pure cost. It never showed before because the hook exited above on every call; now
  // that it runs, it would put a network round trip (3s timeout) in front of every single
  // Bash tool call. The verification engine reads the local cache, not this response.
  //
  // issue #94 — one request for all five memory categories, already filtered for this
  // trigger. Matching used to happen here, over iron rules only; see fetchHookContext for
  // why the fallback to `/type/iron_rule` exists and what `legacy` means.
  let relevant = [];
  let counts = null;
  let totals;
  let allNames;
  if (trigger !== 'command') {
    try {
      const ctx = await fetchHookContext({ apiUrl, apiKey, trigger });
      relevant = ctx.rules;
      // A legacy response knows the iron-rule count and nothing else. Printing the other four
      // as zeroes would claim they were consulted and found nothing, when they were not asked
      // — the precise confusion this issue is about. So the old line is printed instead.
      counts = ctx.legacy ? null : ctx.counts;
      totals = ctx.legacy ? undefined : ctx.totals;
      allNames = ctx.legacy ? undefined : ctx.names;
    } catch {
      process.exit(0);
    }
  }

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
  // issue #94 — the counts line goes first, above whatever else this hook has to say. It is
  // the part that answers "did OwnMind actually look", and it is the same string the .sh
  // sibling prints, so the two copies no longer differ in what the user is told.
  // v1.26.154 — the same window as the .sh twin, keyed the same way. A guard present in only
  // one of two implementations of one protocol is a protocol whose behaviour depends on which
  // copy a platform happens to install.
  let names;
  let decision = null;
  if (counts) {
    decision = decideEditReminder(readEditReminderState(sessionId, trigger), Date.now());
    if (decision.mode === 'full') {
      // Everything that matched gets named, iron rules included, on every trigger — the same
      // rule the .sh twin applies, for the same reason. v1.26.154 excluded them wherever the
      // banner was going to print them; v1.26.160 reverses that on the owner's instruction,
      // because a category showing a bare count next to categories showing names reads as a
      // category that found nothing.
      names = allNames;
    }
  }

  const contextLine = counts
    ? renderHookContextLine({
      version: VERSION, trigger, counts, totals, names, withHowTo: trigger !== 'commit',
    })
    : '';
  if (contextLine) lines.push(contextLine);

  // Opened only when something was shown, for the reason spelled out in the .sh twin: a window
  // spent on a listing nobody saw would throttle the next operation against nothing.
  if (decision && decision.mode === 'full' && contextLine) {
    writeEditReminderState(sessionId, trigger, {
      window_start_ms: decision.window_start_ms,
      occurrence: decision.occurrence,
      rule_count: relevant.length,
      counts,
      totals,
    });
  }

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
    const { evaluateConditions } = await importFile(verificationPath);

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
