#!/usr/bin/env node
/**
 * v1.31.2 — the collision warning, run from the edit branch of ownmind-iron-rule-check.js.
 *
 * Before a file edit, tell the server "this person is in this directory of this project"
 * and learn who else was there in the last two hours. One line into the AI's context when
 * there is somebody; nothing otherwise. The edit is never blocked: two people in one folder
 * is often correct, and what this guards against is finding out at merge time.
 *
 * Fail-open, and loud about it in the log: a server that does not answer, a table that
 * does not exist, a key that is missing — the edit proceeds, and `~/.ownmind/logs/<day>.jsonl`
 * gets a `touch_report_failed` event with the reason, so a warning that stopped working
 * does not look like a team that never overlaps (the v1.26.87 rule).
 *
 * Opt-out: `~/.ownmind/.no-touch-report`. The person then sends nothing and is warned about
 * nothing; the two halves go together on purpose.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import http from 'http';
import { touchOf, renderOverlapLine } from '../shared/touch-report.js';
import { localDateOnly, localIsoTimestamp } from '../shared/local-date.js';
import {
  touchStateFile, readTouchState, writeTouchState, touchKey,
  decideTouchReport, recordTouchReport, unprintedOthers,
} from './lib/touch-state.js';

export const OPT_OUT_FILE = '.no-touch-report';
const TIMEOUT_MS = 3000;

function logEvent(home, event, details) {
  try {
    const dir = path.join(home, '.ownmind', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const entry = { ts: localIsoTimestamp(now), event, tool: 'claude-code', source: 'hook', details };
    fs.appendFileSync(path.join(dir, `${localDateOnly(now)}.jsonl`), `${JSON.stringify(entry)}\n`);
  } catch { /* a logging failure must never cost the user their edit */ }
}

/** POST JSON; resolves { status, body } or rejects on network failure / timeout. */
export function postJson(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const payload = JSON.stringify(body);
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

/**
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.apiUrl
 * @param {string} opts.sessionId
 * @param {string} opts.filePath       the file about to be edited
 * @param {string} opts.projectDir     CLAUDE_PROJECT_DIR or the cwd
 * @param {number} opts.now
 * @param {string} opts.version
 * @param {string} [opts.home]         injection point for tests
 * @param {Function} [opts.post]       injection point for tests; defaults to postJson
 * @returns {Promise<string>} the context line, or '' when there is nothing to say
 */
export async function touchReport({
  apiKey, apiUrl, sessionId, filePath, projectDir, now, version,
  home = os.homedir(), post = postJson,
}) {
  if (!apiKey || !apiUrl || !sessionId) return '';
  if (fs.existsSync(path.join(home, '.ownmind', OPT_OUT_FILE))) return '';

  const touch = touchOf(filePath, projectDir);
  if (!touch) return '';

  const file = touchStateFile(home);
  const state = readTouchState(file);
  const key = touchKey(touch);
  const decision = decideTouchReport(state, sessionId, key, now);

  let others = decision.others;
  if (decision.report) {
    try {
      const res = await post(`${apiUrl}/api/activity/touch`, apiKey, { ...touch, session_id: sessionId });
      if (res.status !== 200) {
        logEvent(home, 'touch_report_failed', { reason: `http_${res.status}`, project: touch.project });
        // A failure opens the same window a success does: the next edits in this directory
        // do not each pay the timeout again. The precedent is FETCH_BACKOFF_MS in
        // shared/edit-reminder-state.js.
        recordTouchReport(state, sessionId, key, [], now);
        writeTouchState(file, state, now);
        return '';
      }
      const parsed = JSON.parse(res.body);
      others = Array.isArray(parsed?.others) ? parsed.others : [];
      recordTouchReport(state, sessionId, key, others, now);
    } catch (err) {
      logEvent(home, 'touch_report_failed', { reason: err?.message || 'error', project: touch.project });
      recordTouchReport(state, sessionId, key, [], now);
      writeTouchState(file, state, now);
      return '';
    }
  }

  const fresh = unprintedOthers(state, sessionId, key, others);
  // Inside the window with nobody new to mention, nothing changed: leave the file alone.
  if (decision.report || fresh.length > 0) writeTouchState(file, state, now);
  return renderOverlapLine(fresh, touch, version);
}
