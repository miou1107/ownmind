/**
 * shared/update-banner.js — tell the user what the background update did.
 *
 * v1.26.129. The daily update already ran on its own: the SessionStart hook takes a lock and
 * a detached subshell does the fetch, the pull, the npm install and update.sh. Every outcome
 * was written to the local event log and nothing else. **So the update was silent whether it
 * worked or not** — and a failed update is indistinguishable from an up-to-date machine, from
 * the user's side, for as long as it keeps failing.
 *
 * The work happens in a detached child that outlives the session, so the result is not known
 * while that conversation is running. There is no turn left to announce it on, which is what
 * `logs/update-pending.jsonl` is for: the outcome waits there until the Stop hook of some
 * later turn emits it on the user-facing systemMessage channel and drops the line it showed.
 *
 * v1.26.173 — it used to queue into `banner-pending.jsonl` and rely on the next SessionStart
 * to flush it. v1.26.171 removed that flush, correctly: SessionStart stdout is read by the
 * MODEL, not by the user, and the flush erased the audit record on its way out. But every
 * other notice in the system is delivered on the turn it happens, so removing the flush left
 * this the one notice with no delivery path at all — a failed update, the case the user most
 * needs to hear about, was written to a file nobody reads. The two files are separate jobs
 * now: this one is a queue and gets drained; banner-pending.jsonl is an append-only audit
 * record and does not.
 *
 * Nothing is queued when there was no new version. Silence has to keep meaning "nothing
 * happened", or the message becomes noise and stops being read.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const QUEUE_RELATIVE = ['.ownmind', 'logs', 'update-pending.jsonl'];

/**
 * @param {string} homeDir
 * @returns {string} the queue file for undelivered update outcomes
 */
export function updateQueuePath(homeDir = os.homedir()) {
  return path.join(homeDir, ...QUEUE_RELATIVE);
}

/**
 * The steps the two updaters report, in the words a user can act on. An unrecognised step
 * falls back to its raw name rather than being dropped — a failure nobody can name is still
 * a failure the user should hear about.
 */
const STEP_LABELS = {
  cd: '找不到 OwnMind 資料夾',
  lock: '無法建立更新鎖（磁碟滿了或唯讀）',
  fetch: '連不上 GitHub',
  log: '讀不到遠端版本紀錄',
  pull: '拉新版失敗（本機檔案可能被改過）',
  npm: '安裝套件失敗',
  update_sh: '更新腳本執行失敗',
  update_script_missing: '找不到更新腳本',
  outer: '更新過程發生未預期的錯誤',
};

/**
 * @param {object} opts
 * @param {'applied'|'failed'} opts.outcome
 * @param {string} [opts.version] — the version now on disk; required for 'applied'
 * @param {string} [opts.step] — which step failed; used for 'failed'
 * @returns {string|null} the block to print, or null when there is nothing worth saying
 */
export function buildUpdateBanner({ outcome, version, step }) {
  if (outcome === 'applied') {
    if (!version || version === '?') return null;
    return `【OwnMind v${version}】ownmind已經自動更新到 ${version} 版，升級成功，你不需做任何處理`;
  }
  if (outcome === 'failed') {
    const label = STEP_LABELS[step] || step || '原因不明';
    // The offer to report is the point of surfacing this at all: the user cannot fix a pull
    // that fails inside a detached subshell, but they can hand it to someone who can.
    return `【OwnMind】ownmind 自動更新失敗：${label}。\n`
      + '要不要我幫你回報給管理者？回一句「回報 ownmind bug」就好。';
  }
  return null;
}

/**
 * Queue a banner for delivery on a later turn. Never throws: this runs at the tail of an
 * update that has already either succeeded or failed, and taking the process down here would
 * turn a reportable outcome into no outcome at all.
 *
 * @param {object} opts — as `buildUpdateBanner`, plus:
 * @param {string} [opts.homeDir] — override for tests
 * @returns {boolean} whether a record was written
 */
export function queueUpdateBanner({ outcome, version, step, homeDir = os.homedir() }) {
  try {
    const block = buildUpdateBanner({ outcome, version, step });
    if (!block) return false;
    const file = updateQueuePath(homeDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // JSON Lines, one record per line. A raw newline inside `block` would split one message
    // into two unparseable lines; JSON.stringify escapes it, which is why the record is built
    // here rather than concatenated by callers.
    fs.appendFileSync(file, JSON.stringify({ block, source: 'auto_update' }) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the outcomes still waiting to be shown.
 *
 * Unreadable lines are skipped rather than throwing — this file is appended to by detached
 * update children, so a half-written record at the tail is a normal thing to find. They are
 * still counted, because the caller drains by position and a skipped line has to occupy one
 * or the next drain would delete a record it never showed.
 *
 * @param {object} [opts]
 * @param {string} [opts.homeDir]
 * @returns {{ blocks: string[], lineCount: number }}
 */
export function readUpdateNotices({ homeDir = os.homedir() } = {}) {
  const empty = { blocks: [], lineCount: 0 };
  try {
    const raw = fs.readFileSync(updateQueuePath(homeDir), 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');
    const blocks = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.block === 'string' && rec.block !== '') blocks.push(rec.block);
      } catch { /* counted by lineCount, never shown */ }
    }
    return { blocks, lineCount: lines.length };
  } catch {
    return empty;
  }
}

/**
 * Drop the first `deliveredCount` lines, keep the rest.
 *
 * Drains by position rather than truncating the file, because a detached update child can
 * append between the read and this call. Truncating would delete an outcome that was never
 * shown to anyone, which is the exact failure this queue exists to end.
 *
 * Call it only after the notices have actually reached the user: cleanup goes after the
 * evidence, never before it.
 *
 * @param {object} opts
 * @param {number} opts.deliveredCount
 * @param {string} [opts.homeDir]
 * @returns {boolean} whether the queue was rewritten
 */
export function clearDeliveredUpdateNotices({ deliveredCount, homeDir = os.homedir() }) {
  if (!Number.isInteger(deliveredCount) || deliveredCount <= 0) return false;
  try {
    const file = updateQueuePath(homeDir);
    const raw = fs.readFileSync(file, 'utf8');
    const remaining = raw.split('\n').filter((l) => l.trim() !== '').slice(deliveredCount);
    if (remaining.length === 0) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, remaining.join('\n') + '\n');
    return true;
  } catch {
    return false;
  }
}
