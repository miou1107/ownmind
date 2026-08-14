// hooks/lib/i18n.js — total-function message lookup for hook user notices.
// Model-facing strings stay English by policy; only audience=user strings go through t().
import fs from 'node:fs';
import { getLocale } from './locale.js';

const dictCache = new Map();

/**
 * The locale resolved for this process, or null before the first resolution.
 *
 * getLocale() reads and JSON.parses <home>/.ownmind/cache/memories.json on every call —
 * measured at 0.296 ms against a real 57 KB cache. One gate run emits several notices, on the
 * PreToolUse path whose whole budget is ~1.5 ms, so a per-call read is most of the budget spent
 * re-deriving an answer that cannot change usefully mid-run. Resolving once also closes the
 * window where a concurrent locale rewrite renders two lines of the same run in two languages.
 */
let localeMemo = null;

/**
 * OWNMIND_LOCALE_FORCE is deliberately exempt from the memo: it is the documented test seam,
 * and several suites flip it between calls inside a single process. An env lookup is free, so
 * only the file-reading resolution below it is worth caching.
 */
const FORCED_LOCALES = new Set(['zh', 'en', 'ja']);

function resolveLocale() {
  if (FORCED_LOCALES.has(process.env.OWNMIND_LOCALE_FORCE)) return getLocale();
  if (localeMemo === null) localeMemo = getLocale();
  return localeMemo;
}

function loadDict(locale) {
  if (!dictCache.has(locale)) {
    let dict = null;
    try {
      dict = JSON.parse(fs.readFileSync(new URL(`../locales/${locale}.json`, import.meta.url), 'utf8'));
    } catch { /* fail open: missing/corrupt dictionary must never break a hook */ }
    dictCache.set(locale, dict);
  }
  return dictCache.get(locale);
}

export function t(key, params) {
  // `= {}` would only cover undefined; an explicit null reaches Object.hasOwn below and throws,
  // which contradicts the total-function contract this module's callers rely on.
  const values = params || {};
  let template;
  for (const locale of [resolveLocale(), 'en']) {
    const dict = loadDict(locale);
    if (dict && typeof dict[key] === 'string') { template = dict[key]; break; }
  }
  if (template === undefined) template = key;
  // Object.hasOwn, not `name in params`: `in` walks the prototype chain, so a template
  // containing {constructor} or {toString} would render a function body into a user notice.
  return template.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(values, name) ? String(values[name]) : m));
}

export function resetI18nCacheForTests() { dictCache.clear(); localeMemo = null; }
