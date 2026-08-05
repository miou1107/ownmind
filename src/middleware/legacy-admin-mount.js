// `/admin` redirects to the console.
//
// This used to be an either/or. While any feature was still marked `signpost` in
// shared/legacy-console-manifest.js the legacy console had to keep working, because the
// new console linked into it; once nothing did, `/admin` had to stop answering. Both
// branches were installed together from the start with the redirect dormant, so there was
// never a window where `/admin/` returned 404 between the last page landing and someone
// remembering to write the redirect — which is the "remember to do it" failure the
// manifest exists to remove.
//
// v1.26.59 flipped the last signpost and the redirect branch took over by itself, which
// was the whole point of the design. v1.26.60 removed the other branch.
//
// Deleting it matters beyond tidiness. It was `express.static` over the *whole* of
// `src/public/`, so while it was installable `/admin/setup.html`, `/admin/me/index.html`
// and `/admin/dashboard/index.html` all resolved. And `signpost` is no longer a state the
// manifest accepts — it throws at import — so no edit brings the branch back by accident.

import { relativeRedirectTarget } from '../utils/relative-redirect.js';

/**
 * @param {import('express').Express} app
 * @param {object}  [opts]
 * @param {string} [opts.consolePath] Redirect destination, relative to the app root.
 * @returns {'redirect'} Which branch was installed. Kept as a return value so the call
 *   site and its tests assert the decision rather than inferring it from a response.
 *   There is only one branch now, and that is itself worth asserting.
 */
export function installLegacyAdminMount(app, { consolePath = 'dashboard/' } = {}) {
  // A plain middleware rather than a route: this has to catch `/admin`, `/admin/` and
  // every path below it, and Express 5 no longer accepts the unnamed `/admin/*` pattern.
  app.use('/admin', (req, res) => {
    res.redirect(301, relativeRedirectTarget(req.originalUrl, consolePath));
  });
  return 'redirect';
}
