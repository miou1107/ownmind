/**
 * First-run redirect middleware — v1.19.8
 *
 * Implements openspec/changes/v1.19.8-setup-wizard/spec.md scenarios 1, 2, 3.
 *
 * Behavior:
 *   - users table empty (first_run=true) → /admin/* auto-redirects to /setup
 *   - users table has an admin (first_run=false) → /setup auto-redirects to /admin/login
 *   - the opposite path in each state stays normal (no extra interception)
 *
 * Design:
 *   - pure redirect, does not block the API (/api/setup/* is handled by its own router)
 *   - fail-open on error: if the DB query fails, treat as not first_run, so users
 *     aren't misled into the wizard
 *   - no result caching: queries the DB on every request; if this becomes a perf issue,
 *     an in-memory 1-second cache could be added later (within v1.19.8 scope the
 *     first_run window is expected to be very short and not hit frequently)
 *   - Factory pattern (v1.19.8 code-review I-2): dependencies are injectable for easy integration testing
 */
import { detectFirstRun as defaultDetectFirstRun } from '../routes/setup.js';

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
    const isAdminPath = path === '/admin' || path === '/admin/' || path.startsWith('/admin/');
    const isSetupPath = path === '/setup' || path === '/setup/';

    if (!isAdminPath && !isSetupPath) {
      return next();
    }

    // Note: /api/* paths never reach here (already excluded above), so no extra guard needed
    // (v1.19.8 code-review M-1 removed the dead code)

    let firstRun;
    try {
      ({ firstRun } = await detectFirstRun());
    } catch {
      // fail-open: on DB failure, don't redirect; let the user see the original page
      return next();
    }

    if (firstRun && isAdminPath) {
      // users table empty, user opened admin → guide them to the wizard
      return res.redirect(302, '/setup');
    }

    if (!firstRun && isSetupPath) {
      // setup already done, wizard permanently closed, guide back to the login page
      return res.redirect(302, '/admin/login');
    }

    // other cases (first_run + setup path, or non-first_run + admin path) pass normally
    return next();
  };
}

// Default export: for production app.js to mount directly (uses the real detectFirstRun)
export const firstRunRedirect = createFirstRunRedirect();
