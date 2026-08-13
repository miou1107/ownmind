#!/usr/bin/env node
'use strict';
// gate.js — PreToolUse-style enforcement gate, ACTION track (prototype).
//
//   <command on stdin> | node gate.js --state <dir> [--rules <file>] [--secrets <dir>]
//
// stdin accepts either the raw candidate Bash command, or a Claude Code
// PreToolUse hook payload: {"tool_name":"Bash","tool_input":{"command":"..."}}.
// Exit codes match PreToolUse semantics: 0 = allow, 2 = block (reason on
// stderr, which the harness feeds back to the assistant).
//
// Decision pipeline, in order:
//   0. rules.json integrity vs the hash pinned at setup — mismatch: fail CLOSED.
//   1. trigger match: rule.trigger.command_patterns vs each normalized shell
//      segment of the command (see gatelib.lexSegments). No match: allow.
//   2. GATE 1 read-before-act: a valid HMAC read receipt for this rule in this
//      session must exist (written only by fetch-rules.js). Missing/invalid:
//      block with the FULL rule text and the fetch instruction.
//   3. GATE 2 compliance: the rule's data-declared checks run against the
//      triggering segment. Any failure: block with the specific reasons.
//   4. LIMIT: 3rd consecutive block of the same rule at the same gate does NOT
//      auto-execute — it blocks with the distinct STOPPED-ASK-HUMAN marker.
//      (Vin's decision: the action track never auto-releases.)
//   5. Every allow/block/limit event is appended to <state>/gate-log.jsonl.

const fs = require('fs');
const path = require('path');
const lib = require('./gatelib');

const t0 = process.hrtime.bigint();
const LIMIT = 3;
const LIMIT_MARKER = 'STOPPED-ASK-HUMAN';

const args = lib.parseArgs(process.argv.slice(2));
if (!args.state) {
  console.error('usage: <command on stdin> | node gate.js --state <dir> [--rules <file>] [--secrets <dir>]');
  process.exit(2); // fail closed on bad invocation
}

// ---- read the candidate command -------------------------------------------
let rawInput = '';
try { rawInput = fs.readFileSync(0, 'utf8'); } catch (e) { /* no stdin */ }
let command = rawInput.trim();
let toolName = 'Bash';
try {
  const payload = JSON.parse(rawInput);
  if (payload && typeof payload === 'object' && payload.tool_input) {
    command = String(payload.tool_input.command || '').trim();
    if (payload.tool_name) toolName = String(payload.tool_name);
  }
} catch (e) { /* raw command string */ }

function decisionMs() { return Number(process.hrtime.bigint() - t0) / 1e6; }

function log(event) {
  lib.appendLog(args.state, Object.assign({
    ts: new Date().toISOString(),
    session: lib.sessionId(args.state),
    command: command,
    decision_ms: Math.round(decisionMs() * 1000) / 1000,
  }, event));
}

function allow(ruleIds) {
  log({ decision: 'allow', ruleIds: ruleIds || [] });
  process.exit(0);
}

// ---- consecutive-block counters (reset when the same rule later passes) ----
const countersPath = path.join(args.state, 'counters.json');
function loadCounters() {
  try { return JSON.parse(fs.readFileSync(countersPath, 'utf8')); } catch (e) { return {}; }
}
function saveCounters(c) { fs.writeFileSync(countersPath, JSON.stringify(c)); }

function block(rule, gate, reasons, extraStderr) {
  const counters = loadCounters();
  const key = rule.id + ':' + gate;
  counters[key] = (counters[key] || 0) + 1;
  saveCounters(counters);
  const n = counters[key];

  if (n >= LIMIT) {
    // Distinct marker: stopped, ask the human. Still exit 2 — never an allow.
    console.error('BLOCK [LIMIT] ' + LIMIT_MARKER);
    console.error('Rule "' + rule.id + '" (' + rule.title + ') has now blocked ' + n +
      ' consecutive times at ' + gate + '.');
    console.error('The action track never auto-releases. Stop retrying this command and ask');
    console.error('the human to fix the command, approve the action, or amend the rule.');
    console.error('Underlying reason(s): ' + reasons.join(' | '));
    log({ decision: 'limit', ruleId: rule.id, gate: gate, count: n, reasons: reasons });
    process.exit(2);
  }

  console.error('BLOCK [' + gate + '] rule "' + rule.id + '" — ' + rule.title);
  for (const r of reasons) console.error('  - ' + r);
  if (extraStderr) console.error(extraStderr);
  log({ decision: 'block', ruleId: rule.id, gate: gate, count: n, reasons: reasons });
  process.exit(2);
}

// ---- only Bash commands are gated -----------------------------------------
if (toolName !== 'Bash' || command === '') allow([]);

// ---- trust material + rules integrity (fail closed) -----------------------
let trust;
try {
  trust = lib.loadTrust(args.secrets, args.state);
} catch (e) {
  console.error('BLOCK [init] gate not initialized for this session (run setup.js): ' + e.message);
  log({ decision: 'block', ruleId: null, gate: 'init', reasons: ['missing trust material'] });
  process.exit(2);
}
const loaded = lib.loadRules(args.rules, trust.pinnedRulesHash);
if (loaded.error) {
  console.error('BLOCK [integrity] ' + loaded.error);
  log({ decision: 'block', ruleId: null, gate: 'integrity', reasons: [loaded.error] });
  process.exit(2);
}
const rules = loaded.rules;

// ---- trigger matching ------------------------------------------------------
const segments = lib.lexSegments(command);
const triggered = []; // [{rule, segment}] in rules.json order, first matching segment
for (const rule of rules) {
  const patterns = (rule.trigger && rule.trigger.command_patterns) || [];
  let hit = null;
  for (const seg of segments) {
    if (patterns.some((p) => new RegExp(p, 'i').test(seg))) { hit = seg; break; }
  }
  if (hit !== null) triggered.push({ rule: rule, segment: hit });
}
if (triggered.length === 0) allow([]);

// ---- GATE 1: read-before-act ----------------------------------------------
for (const t of triggered) {
  if (t.rule.read_required === false) continue;
  const v = lib.verifyReceipt(args.state, t.rule, trust);
  if (!v.ok) {
    block(t.rule, 'gate-1-read-before-act',
      ['rules not read this session: ' + v.why],
      '\nThis command matches rule "' + t.rule.id + '". Read it before acting:\n' +
      '--- RULE ' + t.rule.id + ' — ' + t.rule.title + ' ---\n' +
      JSON.stringify(t.rule, null, 2) + '\n' +
      '--- END RULE ---\n' +
      'To unblock: run\n' +
      '  node ' + path.join(lib.BASE, 'fetch-rules.js') + ' --state ' + args.state + ' --rule ' + t.rule.id + '\n' +
      '(this prints the rule and writes your read receipt), then retry the SAME command.');
  }
}

// ---- GATE 2: compliance checks (data-declared) ----------------------------
for (const t of triggered) {
  const failures = [];
  for (const c of t.rule.checks || []) {
    if (c.type === 'must_match') {
      if (!new RegExp(c.pattern, 'i').test(t.segment)) failures.push(c.reason);
    } else if (c.type === 'must_not_match') {
      if (new RegExp(c.pattern, 'i').test(t.segment)) failures.push(c.reason);
    } else if (c.type === 'marker_exists') {
      let ok = false;
      try { ok = fs.lstatSync(path.join(args.state, c.marker)).isFile(); } catch (e) { /* absent */ }
      if (!ok) failures.push(c.reason);
    } else {
      failures.push('unknown check type "' + c.type + '" in rule ' + t.rule.id + ' — failing closed');
    }
  }
  if (failures.length > 0) {
    block(t.rule, 'gate-2-compliance', failures, 'Command segment: ' + t.segment);
  }
}

// ---- allow: reset consecutive-block counters for the rules that now pass ---
{
  const counters = loadCounters();
  for (const t of triggered) {
    delete counters[t.rule.id + ':gate-1-read-before-act'];
    delete counters[t.rule.id + ':gate-2-compliance'];
  }
  saveCounters(counters);
}
allow(triggered.map((t) => t.rule.id));
