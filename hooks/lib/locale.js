// hooks/lib/locale.js — resolves which locale hook user notices should render in.
//
// This is a stub: it only honors the OWNMIND_LOCALE_FORCE test seam and otherwise always
// returns 'en'. A later task replaces the body with real resolution (env vars, machine
// config, etc.) but keeps this exact export signature — the OWNMIND_LOCALE_FORCE check must
// stay first, since it is the documented way tests pin a locale without touching real config.

const VALID_LOCALES = new Set(['zh', 'en', 'ja']);

/**
 * @param {{homeDir?: string}} [opts] reserved for the real resolver; unused by this stub.
 * @returns {'zh'|'en'|'ja'}
 */
export function getLocale({ homeDir } = {}) {
  const forced = process.env.OWNMIND_LOCALE_FORCE;
  if (VALID_LOCALES.has(forced)) return forced;
  return 'en';
}
