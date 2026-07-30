// The `/admin` either/or.
//
// While any feature is still marked `signpost` in shared/legacy-console-manifest.js the
// legacy console has to keep working, because the new console links into it. Once nothing
// does, `/admin` must stop answering and start redirecting.
//
// Both branches are installed together from the start, with the redirect dormant. The
// alternative -- adding the redirect only at the final retirement step -- would leave
// `/admin/` returning 404 in the window between the last page landing and someone
// remembering to write the redirect, which is the same "remember to do it" failure the
// manifest exists to remove.
//
// Extracted from src/app.js so both directions can be exercised by a test. app.js decides
// the mount at import time from a module-level constant, which a test cannot vary; a
// function taking `retired` can be called twice.

import express from 'express';
import { relativeRedirectTarget } from '../utils/relative-redirect.js';

/**
 * @param {import('express').Express} app
 * @param {object}  opts
 * @param {boolean} opts.retired      Result of `isLegacyConsoleRetired()`.
 * @param {string}  opts.publicDir    Directory the legacy console is served from.
 * @param {string} [opts.consolePath] Redirect destination, relative to the app root.
 * @returns {'redirect'|'static'} Which branch was installed, so callers and tests can
 *   assert the decision itself rather than inferring it from a response.
 */
export function installLegacyAdminMount(app, { retired, publicDir, consolePath = 'dashboard/' }) {
  if (retired) {
    // A plain middleware rather than a route: this has to catch `/admin`, `/admin/` and
    // every path below it, and Express 5 no longer accepts the unnamed `/admin/*` pattern.
    app.use('/admin', (req, res) => {
      res.redirect(301, relativeRedirectTarget(req.originalUrl, consolePath));
    });
    return 'redirect';
  }

  app.use('/admin', express.static(publicDir));
  return 'static';
}
