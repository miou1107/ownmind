// The record of which features once lived in the legacy `/admin` console, and the switch
// that retired it.
//
// Why this file exists instead of a checklist item: `v1.20.4-legacy-retire` was written,
// archived, and never executed, so the old console outlived its replacement by months. A
// checklist cannot be the guard, and neither can a test that merely turns red: this repo
// has no CI, so a red suite blocks no release.
//
// So the guard was structural. Every reader derived feature state from here — the
// console's routes, its navigation, and the server's decision whether to mount `/admin`
// at all — which made one invariant hold by construction: the console could not be
// simultaneously finished and unretired. Flipping the last `signpost` to `live` stopped
// `/admin` being served and started it redirecting, with no other edit anywhere.
//
// **That happened in v1.26.59, and it worked.** This file is now the record rather than
// the mechanism: every entry is `live`, `signpost` is no longer a legal state, and
// `isLegacyConsoleRetired()` is permanently true. Entries are kept, never deleted — an
// empty list would read as "nothing was ever migrated" instead of "all of it was".
//
// Shared between server and client deliberately. Two copies would be two things to keep
// in step, which is the failure mode this replaces. The client reaches it through the
// `@shared` alias in `client/vite.config.js`; the container gets it from the `COPY shared/`
// directives in both Dockerfile stages.

/**
 * `live` — the feature is rebuilt in the console.
 *
 * v1.26.60: `signpost` used to be the other value, meaning "still lives in `/admin`; the
 * console shows a page saying so and links across". It is no longer accepted, and the
 * validator below already throws on a state it does not recognise — the mechanism Stage
 * 1a built for exactly this class of mistake.
 *
 * Why it is an error rather than merely unused: `/admin` is gone, so a signpost would
 * link to `/admin/#tab`, which redirects to the console, which renders the signpost
 * again. Putting a feature back in the old console is not a thing that can half-work
 * any more, so it fails at import with a message instead of at runtime as a loop.
 */
export const FEATURE_STATES = ['live'];

/**
 * One entry per feature the consolidation moved out of `/admin`.
 *
 * `consolePath` is the identity: it joins to the nav item and route of the same path in
 * `client/src/components/common/nav-sections.js`.
 * `legacyTab` was the `data-tab` value of the tab in the old console, kept as the record
 * of where each feature came from. The source it names now lives in
 * `legacy/admin-v1.26/index.html` and is served by nothing.
 *
 * Entries are flipped to `live`, never deleted.
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
  // v1.26.59: 週報月報 rebuilt in the console, and with it the list is empty.
  //
  // This entry is the one that ends the migration: `isLegacyConsoleRetired()` now
  // returns true, so `src/app.js` stops serving `/admin` and starts redirecting it,
  // with no other edit anywhere. That is the whole design of this file — see the
  // header. The feature's permission also widens here: the report is per-user
  // (`GET /api/session/report` filters `WHERE user_id = $1`) and only sat at admin
  // because no member below admin can log in to the legacy console it pointed at.
  { id: 'periodic-reports', consolePath: '/portal/periodic-reports', legacyTab: 'reports', state: 'live' },
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
