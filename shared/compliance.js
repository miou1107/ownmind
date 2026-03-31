/**
 * OwnMind Compliance Log — 統一格式讀寫
 *
 * 純函式模組，零外部依賴。
 * 被 MCP report_compliance、git hooks、session audit 共用。
 *
 * Schema:
 *   ts: ISO 8601
 *   event: rule_code（如 'IR-008'）
 *   action: 'comply' | 'skip' | 'violate'
 *   rule_code: string
 *   rule_title: string
 *   source: 'mcp' | 'pre_commit' | 'post_commit' | 'session_audit' | 'hook'
 *   session_id?: string
 *   commit_hash?: string
 *   failures?: string[]
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_LOG_PATH = path.join(os.homedir(), '.ownmind', 'logs', 'compliance.jsonl');

function getLogPath() {
  return process.env.__OWNMIND_COMPLIANCE_LOG_PATH || DEFAULT_LOG_PATH;
}

/**
 * 寫入一筆 compliance entry 到 compliance.jsonl
 * 自動補 ts（若未提供）
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

    fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
  } catch {
    // Silent fail — never disrupt main flow
  }
}

/**
 * 讀取 compliance.jsonl 中近 cutoffMs 毫秒內的事件
 * @param {number} [cutoffMs=86400000] — 預設 24 小時
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
