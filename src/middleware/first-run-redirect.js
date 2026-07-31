/**
 * First-run redirect middleware — v1.19.8, extended in v1.26.48.
 *
 * Implements openspec/changes/v1.19.8-setup-wizard/spec.md scenarios 1, 2, 3
 * and openspec/changes/v1.26.48-flip-root-retire-me/spec.md Requirement 3.
 *
 * Behavior:
 *   - users table empty (first_run=true) → GET /, /admin/* → /setup
 *   - users table has an admin (first_run=false) → GET /setup → /admin/login
 *   - the opposite path in each state stays normal (no extra interception)
 *
 * v1.26.48 changes:
 *   - GET / is also intercepted, so a fresh install landing on the new root
 *     (which no longer points at /admin/) still reaches the wizard.
 *   - Locations are relative (via relativeRedirectTarget), so the middleware
 *     survives an /ownmind reverse-proxy prefix without a hardcoded string.
 *
 * Design:
 *   - pure redirect, does not block the API (/api/setup/* is handled by its own router)
 *   - fail-open on error: if the DB query fails, treat as not first_run, so users
 *     aren't misled into the wizard
 *   - no result caching: queries the DB on every request; if this becomes a perf issue,
 *     an in-memory 1-second cache could be added later
 *   - Factory pattern (v1.19.8 code-review I-2): dependencies are injectable for testing
 */
import { detectFirstRun as defaultDetectFirstRun } from '../routes/setup.js';
import { relativeRedirectTarget } from '../utils/relative-redirect.js';

/**
 * Create the first-run redirect middleware
 *
 * @param {object} [deps]
 * @param {() => Promise<{firstRun: boolean}>} [deps.detectFirstRun] - detection function (injected in tests)
 * @returns {(req, res, next) => Promise<void>}
 */
export function createFirstRunRedirect(deps = {}) {
  const detectFirstRun = deps.detectFirstRun || defaultDetectFirstRun;

  return async function firstRunRedirectImpl(req, res, next) {
    const path = req.path;

    // only intercept specific paths; everything else passes straight to next
    const isRootPath = path === '/';
    const isAdminPath = path === '/admin' || path === '/admin/' || path.startsWith('/admin/');
    const isSetupPath = path === '/setup' || path === '/setup/';

    if (!isRootPath && !isAdminPath && !isSetupPath) {
      return next();
    }

    let firstRun;
    try {
      ({ firstRun } = await detectFirstRun());
    } catch {
      // fail-open: on DB failure, don't redirect; let the user see the original page
      return next();
    }

    if (firstRun && (isRootPath || isAdminPath)) {
      // users table empty, user opened the root or admin → guide them to the wizard
      return res.redirect(302, relativeRedirectTarget(req.originalUrl, 'setup'));
    }

    if (!firstRun && isSetupPath) {
      // setup already done, wizard permanently closed, guide back to the login page
      return res.redirect(302, relativeRedirectTarget(req.originalUrl, 'admin/login'));
    }

    // other cases (first_run + setup path, or non-first_run + admin/root path) pass normally
    return next();
  };
}

// Default export: for production app.js to mount directly (uses the real detectFirstRun)
export const firstRunRedirect = createFirstRunRedirect();
