// Redirect a static mount's bare path to its own directory, without leaving the
// reverse-proxy prefix.
//
// Why this exists
// ---------------
// `express.static` has `redirect: true` by default. When a request resolves to the
// served directory itself, serve-static answers 301 with
// `Location = req.originalUrl.pathname + '/'` — an absolute path built from what
// Express sees. nginx exposes this app at /ownmind and strips the prefix before
// proxying (`rewrite ^/ownmind/(.*) /$1`), so Express sees `/dashboard` and writes
// `/dashboard/`. Correct from inside the app; wrong for the browser, which still holds
// the prefix.
//
// Measured on production 2026-08-04: `https://kkvin.com/ownmind/dashboard` sent the
// browser to `https://kkvin.com/dashboard/`, an unrelated page. `/ownmind/admin` did the
// same. v1.26.48 made every redirect *this codebase writes* relative via
// relativeRedirectTarget(); it could not reach these two, because serve-static emits
// them from inside a dependency.
//
// The fix runs before the static mount, so serve-static never gets the chance.
//
// Matching has to be at least as wide as what it shadows
// ------------------------------------------------------
// Found in review, by probing the running app rather than reading it. A first version
// compared `req.originalUrl` to the mount path as raw strings, and three request shapes
// slipped past it straight back into serve-static's absolute redirect:
//
//   /Dashboard   →  Location: /Dashboard/            Express mounts are case-insensitive
//                                                     by default, so the request enters
//                                                     the mount but a case-sensitive
//                                                     comparison lets it through.
//   GET http://evil.example/dashboard  (absolute-form request line)
//                →  Location: http://evil.example/dashboard/
//                                                     serve-static reflects the
//                                                     client-supplied host.
//   POST /dashboard
//                →  301 where serve-static answers 404, because it only redirects
//                    GET and HEAD.
//
// So the comparison runs on a normalised pathname, case-folded, and non-GET/HEAD is
// passed straight through. Normalising also collapses `..` segments, which means
// `/dashboard/../dashboard` matches here exactly as it does inside serve-static.
//
// Why not `{ redirect: false }`
// -----------------------------
// It stops the bad Location, but then `/dashboard` falls through to the SPA shell
// handler, which serves index.html with a `<base href>` computed for the wrong depth —
// the blank-page failure v1.26.44 fixed. Correct matching here is the fix; disabling
// serve-static's redirect on top of it would only swap a wrong redirect for a blank
// page in the case where the matching is wrong, which is not an improvement.

import { relativeRedirectTarget } from '../utils/relative-redirect.js';

/**
 * A single absolute path segment: `/dashboard`, `/admin`.
 *
 * Deliberately narrow. `/` would install a handler that redirects the root to itself;
 * `/..` would build a target of `../`; a nested or query-bearing path would point
 * somewhere nobody intended. All of those are developer typos in a hardcoded constant,
 * which is exactly the class of mistake worth turning into a boot failure.
 */
const MOUNT_PATH = /^\/[A-Za-z0-9][A-Za-z0-9._~-]*$/;

/** Only these ever produced a directory redirect from serve-static. */
const REDIRECTING_METHODS = new Set(['GET', 'HEAD']);

/** Base for parsing — the host is discarded, only the normalised pathname is used. */
const PARSE_BASE = 'http://mount.invalid';

/**
 * Install a bare-path redirect for a static mount. Call immediately *before* the
 * `express.static` for the same path.
 *
 * Top-level `app` only. The handler compares against `req.originalUrl`, so mounting it
 * on a sub-app or Router that is itself mounted under another prefix would never match
 * and would silently do nothing.
 *
 * @param {import('express').Express} app
 * @param {string} mountPath  e.g. `'/dashboard'`. The redirect target is derived from
 *   it rather than passed separately, so the two cannot drift apart.
 */
export function redirectBareMountPath(app, mountPath) {
  // Fail closed at install time — a boot failure is noisy and immediate, where a
  // quietly wrong handler is a routing surprise in production. Same reasoning as the
  // load-time throw in shared/legacy-console-manifest.js.
  if (typeof mountPath !== 'string' || !MOUNT_PATH.test(mountPath)) {
    throw new Error(
      `bare-mount-redirect: mount path must be a single absolute segment, got ${JSON.stringify(mountPath)}`,
    );
  }

  const canonical = mountPath.toLowerCase();
  const target = `${mountPath.slice(1)}/`; // '/dashboard' → 'dashboard/'

  // Middleware rather than `app.get(mountPath, …)`. Express's default routing is
  // non-strict, so `app.get('/dashboard')` ALSO matches `/dashboard/` — and redirecting
  // that to the relative `dashboard/` resolves to `/dashboard/dashboard/`, forever. The
  // loop would be worse than the bug. Compare the real path and pass everything else on.
  app.use(mountPath, (req, res, next) => {
    if (!REDIRECTING_METHODS.has(req.method)) return next();

    const pathname = normalisedPathname(req.originalUrl);
    if (pathname === null || pathname.toLowerCase() !== canonical) return next();

    // serve-static preserved the query (`/dashboard?a=1` → `/dashboard/?a=1`), so
    // dropping it would be a regression introduced by this fix.
    //
    // Depth is computed from the normalised pathname, never the raw originalUrl: an
    // absolute-form request line would otherwise be counted as two directories deep and
    // emit `../../dashboard/`.
    const query = queryOf(req.originalUrl);
    res.redirect(301, relativeRedirectTarget(pathname, target) + (query ? `?${query}` : ''));
  });
}

/** Normalised path, or null when the URL cannot be parsed at all. */
function normalisedPathname(originalUrl) {
  try {
    return new URL(String(originalUrl), PARSE_BASE).pathname;
  } catch {
    return null;
  }
}

/** `'/dashboard?a=1#f'` → `'a=1'`. Fragments do not normally reach a server, but a
 *  malformed client can send one, so it is stripped rather than assumed absent. */
function queryOf(originalUrl) {
  const noHash = String(originalUrl).split('#')[0];
  const i = noHash.indexOf('?');
  return i === -1 ? '' : noHash.slice(i + 1);
}
