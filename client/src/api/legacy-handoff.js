// Cross to the legacy console without asking for a second login.
//
// The three consoles keep the credential under three different names — `om_api_key` for
// /admin, `ownmind_api_key` for /me, `ownmind.api_key` for this one — so they never clobber
// each other. The *value* is the same `users.api_key` row whichever endpoint issued it, so
// writing the legacy names is enough: src/public/index.html restores its session from
// `om_api_key` + `om_role` on load and skips its login view.
//
// Nothing leaves the browser. These are localStorage writes on this document's own origin,
// and the destination is a path on the same host.
//
// The role is re-checked here even though the signpost routes are already role-guarded.
// This is the function that hands over a working credential, and `POST /api/admin/login`
// refuses anything below admin, so handing it to a member would put them in front of a
// console that cannot serve them.

import { getApiKey } from './auth.js';
import { appBase } from './client.js';
import { LEGACY_STORAGE_KEYS } from './legacy-keys.js';
import { roleAtLeast } from '../session/roles.js';
import { LEGACY_CONSOLE_MIN_ROLE } from '@shared/legacy-console-manifest.js';

/** Legal `data-tab` values in the legacy console: lowercase words joined by hyphens. */
const TAB_PATTERN = /^[a-z0-9-]+$/;

/**
 * Where the legacy console lives, optionally deep-linked to one of its tabs.
 *
 * The tab is passed as a fragment because the legacy console is a single HTML document
 * that switches tabs in JavaScript; it reads `location.hash` on load (added in v1.26.46).
 * Not URL-encoded on purpose: the legacy side compares the raw fragment against its
 * `data-tab` attributes, so an encoded value would simply never match. The pattern check
 * is what keeps the value safe to interpolate.
 */
export function legacyConsoleUrl(tab) {
  const base = `${appBase()}/admin/`;
  if (!tab) return base;
  if (!TAB_PATTERN.test(tab)) return base;
  return `${base}#${tab}`;
}

/**
 * Write the legacy console's credential keys so following a signpost lands inside.
 *
 * @returns {boolean} false when the handoff was not made, so the caller can warn that a
 *   second login will be needed rather than silently promising it will not.
 */
export function primeLegacyConsole({ role, id, name }) {
  if (!roleAtLeast(role, LEGACY_CONSOLE_MIN_ROLE)) return false;
  const key = getApiKey();
  if (!key) return false;
  try {
    localStorage.setItem(LEGACY_STORAGE_KEYS.apiKey, key);
    localStorage.setItem(LEGACY_STORAGE_KEYS.role, role);
    localStorage.setItem(LEGACY_STORAGE_KEYS.userId, id == null ? '' : String(id));
    localStorage.setItem(LEGACY_STORAGE_KEYS.userName, name || '');
    return true;
  } catch {
    // Private mode or a full quota. The old console will just ask for a password.
    return false;
  }
}
