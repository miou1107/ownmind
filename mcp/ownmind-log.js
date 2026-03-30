import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

const LOGS_DIR = join(process.env.HOME || '', '.ownmind', 'logs');
const TOOL_NAME = process.env.OWNMIND_TOOL || 'unknown';

// Ensure logs directory exists (once per process)
let dirReady = false;
function ensureDir() {
  if (dirReady) return;
  if (!existsSync(LOGS_DIR)) mkdirSync(LOGS_DIR, { recursive: true });
  dirReady = true;
}

/**
 * Write a structured log event to ~/.ownmind/logs/YYYY-MM-DD.jsonl
 * Never throws — silent fail to avoid disrupting main flow.
 *
 * @param {string} event - Event name (init, memory_save, iron_rule_trigger, etc.)
 * @param {object} details - Additional fields merged into the log entry
 */
export function logEvent(event, details = {}) {
  try {
    ensureDir();
    const now = new Date();
    const tzOffset = -now.getTimezoneOffset();
    const sign = tzOffset >= 0 ? '+' : '-';
    const hh = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, '0');
    const mm = String(Math.abs(tzOffset) % 60).padStart(2, '0');
    const ts = now.getFullYear() + '-' +
      String(now.getMonth() + 1).padStart(2, '0') + '-' +
      String(now.getDate()).padStart(2, '0') + 'T' +
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0') + ':' +
      String(now.getSeconds()).padStart(2, '0') +
      sign + hh + ':' + mm;

    const dateStr = ts.slice(0, 10);
    const filePath = join(LOGS_DIR, `${dateStr}.jsonl`);

    const entry = { ts, event, tool: details.tool || TOOL_NAME, ...details };
    delete entry.tool; // remove from details to avoid duplicate
    const line = JSON.stringify({ ts, event, tool: details.tool || TOOL_NAME, source: details.source || 'mcp', ...details });

    appendFileSync(filePath, line + '\n');
  } catch {
    // Silent fail — never disrupt main flow
  }
}
