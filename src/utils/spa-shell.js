// v1.26.44 — serving the dashboard SPA shell so that deep links survive a hard load.
//
// The problem this solves: the shell references its assets relatively
// (`./assets/index-*.js`, from `base: './'` in client/vite.config.js) and carries
// `<base href="./">`. A relative base is resolved against the document's own
// address, so on a two-segment route such as /ownmind/dashboard/portal/handoffs
// the base lands on /ownmind/dashboard/portal/ and every asset request 404s. The
// page renders blank with no console error, because the bundle never loads.
//
// Why not an absolute base: nginx strips the /ownmind prefix before proxying, so
// Express never sees the public prefix and cannot compute an absolute path that is
// correct in production. The relative base is what makes the same build mount under
// both /dashboard and /ownmind/dashboard.
//
// The fix keeps the base relative but makes it point at the mount root, by walking
// up as many levels as the requested route is deep. Express has exactly the
// information needed: inside the middleware mounted at /dashboard, `req.path` is the
// route relative to the mount, with the proxy prefix and the mount segment already
// stripped. Because the emitted value never contains a prefix, no prefix can be
// wrong, and prefix-agnostic mounting is preserved by construction.
//
// See openspec/changes/v1.26.44-spa-deep-link-base/ for the options considered, and
// the iron rule on pairing SPA install-path detection with a <base href> tag.

import { readFile } from 'node:fs/promises';

// `<base ...>` and `<head ...>`; \b keeps these from matching <baseball> / <header>.
const BASE_TAG = /<base\b[^>]*>/i;
const HEAD_OPEN_TAG = /<head\b[^>]*>/i;

/**
 * The relative base href that climbs from a route back to the mount root.
 *
 * The document's directory is the mount root plus the directory part of the route,
 * so the number of `../` steps required is the number of `/`-separated levels the
 * route introduces below the root.
 *
 *   '/login'             -> './'        (the route's directory already is the root)
 *   '/portal/handoffs'   -> '../'
 *   '/portal/handoffs/'  -> '../../'    (a trailing slash makes the route a directory)
 *   '/portal//handoffs'  -> '../../'    (an empty segment is still a level)
 *
 * Empty segments are counted, not collapsed. An earlier version used
 * `split('/').filter(Boolean)`, reasoning that repeated slashes are not extra
 * levels — that premise is wrong: the URL resolver treats `//` as two levels, so
 * `/a//b` needs `../../`. Under-counting emits a base that lands below the mount
 * root and every asset 404s, which is the blank page this module exists to prevent.
 * Production is shielded because nginx merges slashes, but the direct
 * `http://localhost:3100/dashboard/` deployment is not.
 *
 * Counting from `split('/').length` rather than from segments makes the trailing
 * slash and the empty segment fall out of the same arithmetic: a leading `/`
 * contributes one empty element that is the root itself, hence `- 2`.
 *
 * @param {string} routePath route relative to the mount, i.e. Express `req.path`
 * @returns {string} a purely relative href, never an absolute path or URL
 */
export function relativeBaseHref(routePath) {
  const p = typeof routePath === 'string' ? routePath : '';
  // Express always yields a rooted path here; anything else gets the safe './'.
  const depth = p.startsWith('/') ? p.split('/').length - 2 : 0;
  return depth > 0 ? '../'.repeat(depth) : './';
}

/**
 * Return `html` with its base href set to `href`.
 *
 * Replaces an existing `<base>` tag, or inserts one at the top of `<head>` if the
 * shell has none. The insert branch matters because the shell is a build artefact:
 * a rewrite that only replaced a literal would silently no-op if that literal ever
 * changed, and the failure mode would be the blank page this module exists to
 * prevent. The base must precede the asset references it governs, hence the top of
 * `<head>` rather than just before `</head>`.
 *
 * `href` comes from relativeBaseHref, i.e. a repetition count, never from request
 * text, so no request content reaches the emitted markup.
 */
export function withBaseHref(html, href) {
  const tag = `<base href="${href}" />`;
  if (BASE_TAG.test(html)) return html.replace(BASE_TAG, tag);
  if (HEAD_OPEN_TAG.test(html)) {
    return html.replace(HEAD_OPEN_TAG, (headTag) => `${headTag}\n    ${tag}`);
  }
  return `${tag}\n${html}`;
}

/**
 * Express handler that answers SPA route requests with the shell, rewriting the
 * base href for the requested depth.
 *
 * Mount it after `express.static` for the same path: static answers real files
 * (including index.html at the mount root, where the on-disk './' is already
 * correct), and only its misses reach here.
 *
 * @param {string} indexPath absolute path to the built index.html
 */
export function createSpaShellHandler(indexPath) {
  return async function serveSpaShell(req, res, next) {
    // only GET gets the SPA fallback; other methods go to normal error handling
    if (req.method !== 'GET') return next();
    // A dot anywhere in the path is treated as an asset miss, so it 404s normally
    // instead of answering a script or an image with HTML. Carried over unchanged
    // from the previous inline fallback. Note it is a dot test, not an extension
    // test: a route with a dot in a segment (`/portal/v1.2/detail`) would also be
    // refused. No such route exists today; adding one means tightening this to a
    // trailing-extension check.
    if (req.path.includes('.')) return next();

    let html;
    try {
      html = await readFile(indexPath, 'utf8');
    } catch {
      // no shell on disk (e.g. the client was never built) — same as the previous
      // res.sendFile error path: fall through instead of returning a 500
      return next();
    }

    // Cache-Control is set explicitly because res.send does not, whereas the
    // res.sendFile this replaced did. Without it (and without Last-Modified, which
    // send also omits) heuristic freshness is up to the cache, and a cache that
    // decides to hold this shell would keep serving hashed asset references that no
    // longer exist after a deploy — the same blank page, by another route.
    res.type('html').set('Cache-Control', 'public, max-age=0').send(
      withBaseHref(html, relativeBaseHref(req.path)));
  };
}
