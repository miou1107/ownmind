/**
 * Render a dead collector as a broadcast, once for each audience.
 *
 * Pure. Chinese on purpose, matching every other broadcast this server writes
 * (see src/lib/install-check-alert-message.js).
 *
 * **Two messages, not one.** The person whose machine it is needs to know their
 * own usage has stopped uploading and what to run; the admin needs to know who
 * is affected and cannot act on any of those machines. One neutral wording would
 * serve neither: the member would read a status report about somebody, and the
 * admin would read an instruction meant for someone else's computer.
 */

import {
  DELIVERY_MAX_CHARS,
  DELIVERY_MAX_LINES,
  FIELD_SEPARATOR,
  oneLine,
  renderBody,
} from './broadcast-envelope.js';

const TOOL_SEPARATOR = '、';

/**
 * The repair, in the one form that is true on every machine.
 *
 * Not the path to `ensure-scanner-schedule.sh`: that helper only exists on
 * clients from v1.26.79 onward, and a machine whose collector has been frozen
 * for weeks is exactly the one that never received it.
 */
const FIX = '修法：重跑安裝指令，重新註冊排程';

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '不明';
  // Asia/Taipei because every reader of this is here, and a UTC date silently
  // one day behind is the kind of detail that makes people distrust the rest.
  return new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
  }).format(date);
}

function tools(fingerprint) {
  return String(fingerprint || '').split(',').filter(Boolean).join(TOOL_SEPARATOR) || '採集程式';
}

/**
 * v1.26.142 — a collector that reports its own failure has not been quiet.
 *
 * Two different faults reach this renderer now. One stopped writing rows weeks ago; the
 * other writes one every two hours saying it crashed. Both mean no usage is arriving, and
 * both belong in the same alert — but telling somebody their collector "has not reported
 * since today (0 days)" reads as a bug in the alert, and the reader stops believing the
 * rest of it.
 *
 * @param {Object} s a silence finding
 * @returns {boolean} whether every tool in it is failing rather than silent
 */
function allFailing(s) {
  const failing = Array.isArray(s.failing_tools) ? s.failing_tools : [];
  if (failing.length === 0) return false;
  const named = String(s.stale_tools || '').split(',').filter(Boolean);
  return named.length > 0 && named.every((t) => failing.includes(t));
}

/**
 * What the person whose machine it is gets told.
 *
 * @param {Array<Object>} silences findings for this one user
 * @param {{limit?: number, maxLines?: number}} [opts]
 * @returns {{title: string, body: string, omitted: number}}
 */
export function renderMemberMessage(silences = [], {
  limit = DELIVERY_MAX_CHARS,
  maxLines = DELIVERY_MAX_LINES,
} = {}) {
  const title = '你的用量採集停了';
  // Longest silence first, as in the admin message: if the envelope drops
  // entries, it must drop the newest problems, not the ones that have been
  // broken for a month. Somebody with more machines than fit is exactly the
  // person whose oldest one matters most.
  const ordered = [...silences].sort((a, b) => (b.stale_days ?? 0) - (a.stale_days ?? 0));
  const entries = ordered.map((s) => [
    oneLine(s.machine),
    allFailing(s)
      ? `${tools(s.stale_tools)} 每次執行都失敗`
      : `${tools(s.stale_tools)} 從 ${formatDate(s.last_beat_at)} 起沒再回報（${s.stale_days} 天）`,
    '這段期間的用量沒有上傳',
    FIX,
  ].join(FIELD_SEPARATOR));

  const { body, omitted } = renderBody(entries, { limit, maxLines });
  return { title, body, omitted };
}

/**
 * What the admin gets told: who, which machine, how long.
 *
 * No fix instruction — the admin cannot run it on somebody else's computer, and
 * a line telling them to would only take room from the names.
 *
 * @param {Array<Object>} silences findings across every user
 * @param {{limit?: number, maxLines?: number}} [opts]
 * @returns {{title: string, body: string, omitted: number}}
 */
export function renderAdminMessage(silences = [], {
  limit = DELIVERY_MAX_CHARS,
  maxLines = DELIVERY_MAX_LINES,
} = {}) {
  const title = `${silences.length} 台機器的用量採集停了`;
  // Longest silence first: if the envelope drops entries, it drops the newest
  // problems, not the ones that have been broken for a month.
  const ordered = [...silences].sort((a, b) => (b.stale_days ?? 0) - (a.stale_days ?? 0));
  const entries = ordered.map((s) => [
    `${oneLine(s.user_name) || `user ${s.user_id}`}（${oneLine(s.machine)}）`,
    allFailing(s)
      ? `${tools(s.stale_tools)} 每次執行都失敗（最近一次 ${formatDate(s.last_beat_at)}）`
      : `${tools(s.stale_tools)} 停在 ${formatDate(s.last_beat_at)}，已 ${s.stale_days} 天`,
    // The reason the dashboard still looks fine, which is the part that makes
    // this worth a broadcast rather than a column somebody might notice.
    '但機器還在回報，所以看起來像沒工作',
  ].join(FIELD_SEPARATOR));

  const { body, omitted } = renderBody(entries, { limit, maxLines });
  return { title, body, omitted };
}
