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
 * while that conversation is running. It is known at the next one, which is what
 * `banner-pending.jsonl` is for: whatever is queued here is printed by the next SessionStart.
 *
 * Nothing is queued when there was no new version. Silence has to keep meaning "nothing
 * happened", or the message becomes noise and stops being read.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const PENDING_RELATIVE = ['.ownmind', 'logs', 'banner-pending.jsonl'];

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
 * Queue a banner for the next SessionStart. Never throws: this runs at the tail of an update
 * that has already either succeeded or failed, and taking the process down here would turn a
 * reportable outcome into no outcome at all.
 *
 * @param {object} opts — as `buildUpdateBanner`, plus:
 * @param {string} [opts.homeDir] — override for tests
 * @returns {boolean} whether a record was written
 */
export function queueUpdateBanner({ outcome, version, step, homeDir = os.homedir() }) {
  try {
    const block = buildUpdateBanner({ outcome, version, step });
    if (!block) return false;
    const file = path.join(homeDir, ...PENDING_RELATIVE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // JSON Lines, one record per line, matching what flush-pending-banners.js reads. A raw
    // newline inside `block` would split one message into two unparseable lines; JSON.stringify
    // escapes it, which is why the record is built here rather than concatenated by callers.
    fs.appendFileSync(file, JSON.stringify({ block, source: 'auto_update' }) + '\n');
    return true;
  } catch {
    return false;
  }
}
