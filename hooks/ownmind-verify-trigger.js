#!/usr/bin/env node
/**
 * OwnMind Verify Trigger — Node.js helper for bash PreToolUse hook
 *
 * Called by ownmind-iron-rule-check.sh for deploy/delete operations.
 * Reads local cache + compliance JSONL, runs evaluateConditions(),
 * outputs JSON result to stdout.
 *
 * Usage: node ownmind-verify-trigger.js <trigger_type>
 * Output: {"pass": true} or {"pass": false, "failures": [...]}
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');
const COMPLIANCE_LOG = path.join(HOME, '.ownmind', 'logs', 'compliance.jsonl');

async function main() {
  const triggerType = process.argv[2];
  if (!triggerType) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 1. Read cached iron rules
  let rules = [];
  try {
    rules = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    // No cache = no rules to check = pass
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  if (!Array.isArray(rules) || rules.length === 0) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 2. Filter rules matching this trigger type
  const triggerRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes(triggerType);
  });

  if (triggerRules.length === 0) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 3. Read compliance events (last 24 hours)
  let complianceEvents = [];
  try {
    const raw = fs.readFileSync(COMPLIANCE_LOG, 'utf8').trim();
    if (raw) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const entryTime = new Date(entry.ts).getTime();
          if (entryTime >= cutoff) {
            complianceEvents.push(entry);
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  } catch {
    // No compliance log = empty events
  }

  // 4. Dynamic import of ESM verification module
  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    // verification.js not available = can't check = pass gracefully
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  // 5. Evaluate each rule
  const context = { complianceEvents };
  const failures = [];

  for (const rule of triggerRules) {
    const verification = rule.metadata?.verification;
    if (!verification?.conditions) continue;

    const result = evaluateConditions(verification.conditions, context);

    if (!result.pass && verification.block_on_fail) {
      const code = rule.code || rule.metadata?.code || 'IR-???';
      const title = rule.title || '未命名規則';
      failures.push(`${code}: ${title}`);
      for (const f of result.failures) {
        failures.push(`  → ${f}`);
      }
    }
  }

  // 6. Output result
  if (failures.length > 0) {
    console.log(JSON.stringify({ pass: false, failures }));
  } else {
    console.log(JSON.stringify({ pass: true }));
  }
}

main().catch(() => {
  // Any unhandled error = don't block
  console.log(JSON.stringify({ pass: true }));
});
