// hooks/lib/i18n.js — total-function message lookup for hook user notices.
// Model-facing strings stay English by policy; only audience=user strings go through t().
import fs from 'node:fs';
import { getLocale } from './locale.js';

const dictCache = new Map();

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

export function t(key, params = {}) {
  let template;
  for (const locale of [getLocale(), 'en']) {
    const dict = loadDict(locale);
    if (dict && typeof dict[key] === 'string') { template = dict[key]; break; }
  }
  if (template === undefined) template = key;
  return template.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

export function resetI18nCacheForTests() { dictCache.clear(); }
