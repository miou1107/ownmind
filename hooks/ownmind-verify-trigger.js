#!/usr/bin/env node
/**
 * OwnMind Verify Trigger — Node.js helper for deploy/delete verification
 *
 * Reads local cache + compliance JSONL, runs evaluateConditions(),
 * outputs JSON result to stdout.
 *
 * Usage: node ownmind-verify-trigger.js <trigger_type>
 * Output: {"pass": true} or {"pass": false, "failures": [...]}
 */

import path from 'path';
import os from 'os';
import { readJsonSafe } from '../shared/helpers.js';
import { readComplianceEvents } from '../shared/compliance.js';

const HOME = os.homedir();
const CACHE_FILE = path.join(HOME, '.ownmind', 'cache', 'iron_rules.json');

async function main() {
  const triggerType = process.argv[2];
  if (!triggerType) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  const rules = readJsonSafe(CACHE_FILE);
  if (!rules || !Array.isArray(rules) || rules.length === 0) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  const triggerRules = rules.filter(r => {
    const triggers = r.metadata?.verification?.trigger;
    return Array.isArray(triggers) && triggers.includes(triggerType);
  });

  if (triggerRules.length === 0) {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

  const complianceEvents = readComplianceEvents();

  let evaluateConditions;
  try {
    const verificationPath = path.join(HOME, '.ownmind', 'shared', 'verification.js');
    const mod = await import(verificationPath);
    evaluateConditions = mod.evaluateConditions;
  } catch {
    console.log(JSON.stringify({ pass: true }));
    return;
  }

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

  if (failures.length > 0) {
    console.log(JSON.stringify({ pass: false, failures }));
  } else {
    console.log(JSON.stringify({ pass: true }));
  }
}

main().catch(() => {
  console.log(JSON.stringify({ pass: true }));
});
