/**
 * OwnMind Compliance Log — unified read/write format.
 *
 * Pure-function module, zero external deps.
 * Shared by MCP report_compliance, git hooks, session audit.
 *
 * Schema:
 *   ts: ISO 8601
 *   event: rule_code (e.g. 'IR-XXX')
 *   action: 'comply' | 'skip' | 'violate' | 'block' | 'bypass' | 'hook_internal_error'
 *   rule_code: string
 *   rule_title: string
 *   source: 'mcp' | 'pre_commit' | 'post_commit' | 'session_audit' | 'hook'
 *   session_id?: string
 *   commit_hash?: string
 *   failures?: string[]
 *   tier?: 'critical' | 'default' | 'advisory' — since v1.19, caller resolves it
 *           from the iron-rule cache and passes it in
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { isValidTier } from './iron-rule-tier.js';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'compliance.jsonl');

function getLogPath() {
  return process.env.__OWNMIND_COMPLIANCE_LOG_PATH || DEFAULT_LOG_PATH;
}

/**
 * Append one compliance entry to compliance.jsonl.
 * Fills in ts automatically if not provided.
 */
export function appendCompliance(entry) {
  try {
    const logPath = getLogPath();
    const logDir = path.dirname(logPath);
    fs.mkdirSync(logDir, { recursive: true });

    const record = {
      ts: entry.ts || new Date().toISOString(),
      event: entry.event || entry.rule_code || '',
      action: entry.action,
      rule_code: entry.rule_code || '',
      rule_title: entry.rule_title || '',
      source: entry.source || 'unknown',
    };

    // Optional fields
    if (entry.session_id) record.session_id = entry.session_id;
    if (entry.commit_hash) record.commit_hash = entry.commit_hash;
    if (entry.failures) record.failures = entry.failures;
    // v1.19 tier field (caller has already normalized). Drop invalid values
    // to avoid polluting queries.
    if (entry.tier && isValidTier(entry.tier)) record.tier = entry.tier;

    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch {
    // Silent fail — never disrupt main flow
  }
}

/**
 * Read events from compliance.jsonl within the last cutoffMs milliseconds.
 * @param {number} [cutoffMs=86400000] — default 24 hours
 */
export function readComplianceEvents(cutoffMs = 24 * 60 * 60 * 1000) {
  try {
    const logPath = getLogPath();
    const raw = fs.readFileSync(logPath, 'utf8').trim();
    if (!raw) return [];

    const cutoff = Date.now() - cutoffMs;
    const events = [];

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const entryTime = new Date(entry.ts).getTime();
        if (entryTime >= cutoff) {
          events.push(entry);
        }
      } catch {
        // skip malformed lines
      }
    }
    return events;
  } catch {
    return [];
  }
}
