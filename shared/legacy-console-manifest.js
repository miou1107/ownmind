// The single record of what still lives in the legacy `/admin` console.
//
// Why this file exists instead of a checklist item: `v1.20.4-legacy-retire` was written,
// archived, and never executed, so the old console outlived its replacement by months. A
// checklist cannot be the guard, and neither can a test that merely turns red: this repo
// has no CI, so a red suite blocks no release.
//
// So the guard is structural. Every reader derives feature state from here:
//   - the console's routes decide whether to render the real page or a signpost
//   - the console's navigation decides which items point at a signpost
//   - the server decides whether to mount `/admin` at all
//
// The invariant that follows: the console cannot be simultaneously finished and
// unretired. Flipping the last `signpost` to `live` stops `/admin` being served and
// starts it redirecting, with no other edit anywhere.
//
// Shared between server and client deliberately. Two copies would be two things to keep
// in step, which is the failure mode this replaces. The client reaches it through the
// `@shared` alias in `client/vite.config.js`; the container gets it from the `COPY shared/`
// directives in both Dockerfile stages.

/**
 * `signpost` — the feature still lives in `/admin`; the console shows a page saying so
 *              and links across, carrying the credential so no second login is needed.
 * `live`     — the feature is rebuilt in the console and `/admin` is no longer needed
 *              for it.
 */
export const FEATURE_STATES = ['signpost', 'live'];

/**
 * The lowest role that can log in to the legacy console at all.
 *
 * `POST /api/admin/login` filters `role IN ('admin', 'super_admin')` (src/routes/admin.js),
 * so a `user` cannot enter it whatever the feature's own permission is. A signpost shown
 * to someone who cannot use the destination is worse than no signpost, so every signpost
 * is gated at this role or higher. Asserted by tests/legacy-console-manifest.test.js.
 */
export const LEGACY_CONSOLE_MIN_ROLE = 'admin';

/**
 * One entry per feature that the consolidation moves out of `/admin`.
 *
 * `consolePath` is the identity: it joins to the nav item and route of the same path in
 * `client/src/components/common/nav-sections.js`.
 * `legacyTab` is the `data-tab` value of the tab in `src/public/index.html`, used both to
 * deep-link and to name the destination for the user.
 *
 * Entries are flipped to `live`, never deleted: the manifest is the record of where each
 * feature went, and an empty list is what triggers retirement.
 */
export const LEGACY_CONSOLE_FEATURES = [
  // v1.26.49: team-management rebuilt in the console. /admin/team now renders
  // <TeamPage>; the amber dot next to 成員 in the sidebar disappears. /admin/
  // stays served — the six other signposts still need it.
  { id: 'team-management', consolePath: '/admin/team', legacyTab: 'users', state: 'live' },
  // v1.26.51: bug-reports rebuilt in the console. Report list + spam-suspect
  // sub-tab + detail-and-status modal, all against the same /api/bug-reports
  // routes the legacy tab called.
  { id: 'bug-reports', consolePath: '/admin/bugs', legacyTab: 'bug-reports', state: 'live' },
  // v1.26.50: system-config and broadcast rebuilt in the console. Two more
  // amber dots gone; the pricing card in the same legacy tab is not ported
  // (Stage 8 deletion). The other five signposts still keep /admin/ served.
  { id: 'system-config', consolePath: '/system/config', legacyTab: 'settings', state: 'live' },
  { id: 'broadcast', consolePath: '/system/broadcast', legacyTab: 'settings', state: 'live' },
  // v1.26.51: work-log rebuilt in the console. Three-source merged timeline
  // (activity / compliance / session) against /api/admin/work-log.
  { id: 'work-log', consolePath: '/system/work-log', legacyTab: 'work-log', state: 'live' },
  // v1.26.56: stats-dashboard rebuilt in the console. Two views (cross-user
  // overview and per-user detail) against /api/activity/stats/all, /stats and
  // /stats/rules — endpoints the console had never called before, so this one
  // was a new integration rather than a move.
  { id: 'stats-dashboard', consolePath: '/team/stats', legacyTab: 'stats', state: 'live' },
  // v1.26.58: team-usage rebuilt in the console. Ranking plus per-member
  // drill-down against /api/usage/team-stats, /api/usage/admin/team-overview and
  // /api/usage/stats. The Notional cost column is not ported (Requirement 8) and
  // the coverage panel counts members with usage data instead of collector
  // heartbeats. One signpost left, so /admin/ is still served.
  { id: 'team-usage', consolePath: '/team/usage', legacyTab: 'team-usage', state: 'live' },
  // The one feature whose real permission is wider than its signpost's. The report is
  // per-user (`GET /api/session/report` filters `WHERE user_id = $1`), so it belongs to
  // every member, but no member below admin can reach the legacy tab that serves it
  // today. The signpost stays at admin; the rebuilt page opens it to `user`.
  { id: 'periodic-reports', consolePath: '/portal/periodic-reports', legacyTab: 'reports', state: 'signpost' },
];

/**
 * Throw on anything that would make the manifest lie. Exported so the five failure modes
 * can be exercised by a test that runs them.
 *
 * The dangerous typo is a misspelled state: anything that is not exactly 'signpost' would
 * otherwise read as "not a signpost", which retires the old console early and takes a
 * working feature offline. Throwing on import turns that into a boot failure, which is
 * noisy and immediate, instead of silent data loss.
 *
 * @param {Array<object>} features
 */
export function validateFeatures(features) {
  const seenPath = new Set();
  const seenId = new Set();
  for (const f of features) {
    if (!FEATURE_STATES.includes(f.state)) {
      throw new Error(`legacy-console-manifest: unknown state "${f.state}" for ${f.id}`);
    }
    if (!f.id || !f.consolePath || !f.legacyTab) {
      throw new Error(`legacy-console-manifest: incomplete entry ${JSON.stringify(f)}`);
    }
    if (!f.consolePath.startsWith('/')) {
      throw new Error(`legacy-console-manifest: consolePath must be absolute: ${f.consolePath}`);
    }
    if (seenPath.has(f.consolePath)) {
      throw new Error(`legacy-console-manifest: duplicate consolePath ${f.consolePath}`);
    }
    if (seenId.has(f.id)) {
      throw new Error(`legacy-console-manifest: duplicate id ${f.id}`);
    }
    seenPath.add(f.consolePath);
    seenId.add(f.id);
  }
  return features;
}

// Validate at load rather than on use.
validateFeatures(LEGACY_CONSOLE_FEATURES);

/** Features still living in the legacy console. */
export function signpostFeatures() {
  return LEGACY_CONSOLE_FEATURES.filter((f) => f.state === 'signpost');
}

/** The manifest entry for a console path, or null when that path owns no legacy feature. */
export function legacyFeatureFor(consolePath) {
  return LEGACY_CONSOLE_FEATURES.find((f) => f.consolePath === consolePath) || null;
}

/** True when a console path should render a signpost instead of a real page. */
export function isSignpost(consolePath) {
  const f = legacyFeatureFor(consolePath);
  return f ? f.state === 'signpost' : false;
}

/**
 * True once nothing points back at the legacy console.
 *
 * This is the whole retirement switch. `src/app.js` reads it to choose between serving
 * `/admin` and redirecting it.
 */
export function isLegacyConsoleRetired() {
  return signpostFeatures().length === 0;
}
