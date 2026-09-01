/**
 * "N of your reports have been resolved", for both platforms.
 *
 * Closing a report sets `notified_to_reporter = false`, and `GET /api/bug-reports/notifications`
 * hands the reporter what they have not seen yet. Until now the only caller was
 * `hooks/ownmind-session-start.js`, which session-hook-command.cjs registers on Windows alone.
 * macOS and Linux run `ownmind-session-start.sh`, which fetches broadcasts and never fetched
 * this, so a person on a Mac was never told their report had been fixed.
 *
 * This module exists so the repair does not become a second copy. v1.26.83 fixed the mirror
 * image of the same fault — the .js hook missing broadcasts the .sh had always fetched — and
 * the lesson written down there is that a channel implemented inside one platform's entry point
 * is a channel the other platform silently lacks. Both entry points call these three functions;
 * neither spells the sentences out itself.
 */

/**
 * Which half of the endpoint this account may ask for.
 *
 * `role=both` answers 403 to a non-admin, and a 403 loses the reporter half as well — so an
 * ordinary member has to ask for `reporter` specifically rather than for everything.
 *
 * @param {{role?: string}|undefined} profile the `profile` object from the init payload
 * @returns {'both'|'reporter'}
 */
export function roleForProfile(profile) {
  const role = profile && typeof profile.role === 'string' ? profile.role : '';
  return role === 'admin' || role === 'super_admin' ? 'both' : 'reporter';
}

/**
 * The section, as lines. Pure: no network, no clock.
 *
 * @param {object|null} notif the endpoint's answer
 * @returns {string[]} the lines to append, or [] when there is nothing to say
 */
export function bugReportNotificationLines(notif) {
  if (!notif || typeof notif !== 'object') return [];

  const segments = [];
  if (notif.admin && notif.admin.unhandled_count > 0) {
    segments.push(`As admin: ${notif.admin.unhandled_count} unhandled bug reports`);
  }
  if (notif.reporter && notif.reporter.unread_resolved_count > 0) {
    segments.push(`${notif.reporter.unread_resolved_count} of your reports have been resolved`);
  }
  if (segments.length === 0) return [];

  return [
    '## Bug report notifications',
    ...segments.map((s) => `- ${s}`),
    '(Say "list my reports" or open /admin/bug-reports for details)',
    '',
  ];
}

/**
 * Ask the server. Answers null on anything at all going wrong.
 *
 * Null rather than a throw, and null rather than an empty object: a session start must not be
 * lost to this, and a caller must not be able to mistake an outage for "nothing to report".
 *
 * @param {object} opts
 * @param {string} opts.apiUrl
 * @param {string} opts.apiKey
 * @param {'both'|'reporter'} opts.role
 * @param {(url: string, headers: object) => Promise<string>} opts.httpGet
 * @returns {Promise<object|null>}
 */
export async function fetchBugReportNotifications({ apiUrl, apiKey, role, httpGet }) {
  if (!apiUrl || !apiKey || typeof httpGet !== 'function') return null;
  try {
    const raw = await httpGet(
      `${String(apiUrl).replace(/\/+$/, '')}/api/bug-reports/notifications?role=${role}`,
      { Authorization: `Bearer ${apiKey}` },
    );
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
