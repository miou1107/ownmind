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
    // Name them. "1 unhandled" tells the person something is waiting; "#32 <title>" tells them
    // whether it is worth opening now.
    const waiting = Array.isArray(notif.admin.recent_unhandled) ? notif.admin.recent_unhandled : [];
    for (const r of waiting.slice(0, 3)) {
      if (r && r.id != null) segments.push(`  - #${r.id} ${String(r.title || '').replace(/[\r\n]+/g, ' ').slice(0, 120)}`);
    }
  }
  if (notif.reporter && notif.reporter.unread_resolved_count > 0) {
    segments.push(`${notif.reporter.unread_resolved_count} of your reports have been resolved`);
  }
  if (segments.length === 0) return [];

  // The dashboard route is /admin/bugs. Until 2026-10-02 this line said /admin/bug-reports,
  // a page that does not exist. The full address comes from the server this machine talks to.
  // A member who is not an admin cannot open /admin/bugs; their own reports are /portal/reports.
  const page = notif.admin && notif.admin.unhandled_count > 0 ? 'admin/bugs' : 'portal/reports';
  const where = typeof notif.dashboard_base === 'string' && notif.dashboard_base
    ? `open ${notif.dashboard_base}/${page}`
    : 'open the dashboard';

  return [
    '## Bug report notifications',
    ...segments.map((s) => (s.startsWith('  ') ? s : `- ${s}`)),
    `(Say "list my reports" or ${where} for details)`,
    // Without this the section sat in the AI's context and was never said: on 2026-10-02 a
    // session opened with "9 of your reports have been resolved" and the owner heard nothing.
    // The broadcasts above carry the same instruction; this one had none.
    '> **[SYSTEM] Action required:** In your first response sentence, tell the user what this '
      + 'section says, translated into the language you are speaking with them, including the '
      + 'report numbers and titles and the address to open. Do not wait for them to ask.',
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
    if (!parsed || typeof parsed !== 'object') return null;
    return { ...parsed, dashboard_base: `${String(apiUrl).replace(/\/+$/, '')}/dashboard` };
  } catch {
    return null;
  }
}
