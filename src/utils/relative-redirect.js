// Build relative `Location` headers that survive the reverse-proxy prefix.
//
// nginx exposes the app at /ownmind and strips that prefix before proxying, so Express
// never sees it. An absolute `Location: /dashboard/` therefore sends the browser to a
// path that does not exist in production. A relative one is resolved by the browser
// against the address it actually requested, prefix intact.
//
// The catch is that a browser resolves a relative URL against the request's *directory*,
// so the number of `../` segments depends on how deep the request was. Getting that wrong
// is silent: it produces a working redirect at one depth and a 404 at another.

/**
 * @param {string} originalUrl  Express `req.originalUrl` (query and fragment are ignored).
 * @param {string} target       Where to go, relative to the app root, e.g. `'dashboard/'`.
 * @returns {string}            A relative `Location` value.
 *
 * Given target 'dashboard/', with the app mounted at /ownmind:
 *   /admin        -> 'dashboard/'        browser resolves /ownmind/       -> /ownmind/dashboard/
 *   /admin/       -> '../dashboard/'     browser resolves /ownmind/admin/ -> /ownmind/dashboard/
 *   /admin/x      -> '../dashboard/'     same directory as above
 *   /admin/x/y    -> '../../dashboard/'  browser resolves /ownmind/admin/x/
 *
 * And with no prefix at all, the same values resolve to /dashboard/ throughout.
 */
export function relativeRedirectTarget(originalUrl, target) {
  // A leading slash on the target would make the result absolute again ('..//dashboard/'),
  // quietly undoing the whole point of this function.
  const rel = String(target).replace(/^\/+/, '');
  const path = String(originalUrl).split('?')[0].split('#')[0];
  // The directory the browser will resolve against: everything up to the last slash.
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  // Segment count of that directory. `split('/')` on '/a/b/' yields ['', 'a', 'b', ''];
  // dropping the leading and trailing empties leaves the depth. Not `filter(Boolean)`,
  // which would also drop the empty segment of a doubled slash and under-count.
  const depth = Math.max(0, dir.split('/').length - 2);
  return '../'.repeat(depth) + rel;
}
