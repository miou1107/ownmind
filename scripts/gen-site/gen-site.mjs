// Builds the project website in docs/ (served by GitHub Pages) from one
// template and one file of translations, so every language says the same
// thing and none of them can fall behind:
//
//   docs/site/template.html  the page, with {{T.key}} where words go
//   docs/site/strings.json   the words, one block per language
//
// English goes to docs/index.html and every other language to
// docs/<slug>/index.html, each listing all the others with hreflang so search
// engines show people the page in their own language. docs/sitemap.xml and
// docs/robots.txt are written alongside.
//
// Run from the repository root after changing either source file:
//
//   node scripts/gen-site/gen-site.mjs
//
// tests/gen-site.test.js fails when a language is missing a string or the
// committed pages no longer match what this would generate.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Where GitHub Pages serves docs/. */
export const SITE_URL = 'https://miou1107.github.io/ownmind/';
const REPO_URL = 'https://github.com/miou1107/ownmind';

/**
 * Every published language, English first. Adding one means adding it here
 * and giving it a block in strings.json; the test catches a missing block.
 * code: BCP 47, for lang= and hreflang=; slug: folder under docs/, '' for the
 * English root; name: what the language calls itself; og: Open Graph locale;
 * docs: the setup guide in that language.
 */
export const LANGS = [
  { code: 'en', slug: '', name: 'English', og: 'en_US', docs: `${REPO_URL}#quick-start` },
  { code: 'zh-TW', slug: 'zh-tw', name: '繁體中文', og: 'zh_TW', docs: `${REPO_URL}/blob/main/docs/README.zh-TW.md` },
  { code: 'ja', slug: 'ja', name: '日本語', og: 'ja_JP', docs: `${REPO_URL}/blob/main/docs/README.ja.md` },
];

const langUrl = (l) => (l.slug ? `${SITE_URL}${l.slug}/` : SITE_URL);

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Looks up a dotted path ("T.title", "Lang.code") in a scope chain. */
function lookup(path, scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    let v = scopes[i];
    for (const part of path.split('.')) {
      if (v == null || typeof v !== 'object' || !Object.hasOwn(v, part)) { v = undefined; break; }
      v = v[part];
    }
    if (v !== undefined) return v;
  }
  throw new Error(`template refers to "${path}", which is not defined`);
}

/**
 * A tiny mustache: {{a.b}} escapes, {{json:a.b}} emits a JSON string literal
 * that is safe inside a script element, {{#list}}...{{/list}} repeats over an
 * array or renders once for a true value, {{^flag}}...{{/flag}} renders when
 * the value is false or empty. Each section body is rendered once and parked
 * in a hole until the variable pass is over, so a value that happens to
 * contain braces is never expanded a second time.
 */
export function render(tpl, scopes) {
  const holes = [];
  const section = /\{\{([#^])([\w.]+)\}\}([\s\S]*?)\{\{\/\2\}\}/;
  let m;
  while ((m = section.exec(tpl))) {
    const [whole, kind, path, body] = m;
    const v = lookup(path, scopes);
    let out = '';
    if (kind === '#') {
      if (Array.isArray(v)) out = v.map((item) => render(body, [...scopes, item])).join('');
      else if (v) out = render(body, scopes);
    } else if (!v || (Array.isArray(v) && v.length === 0)) {
      out = render(body, scopes);
    }
    holes.push(out);
    tpl = tpl.slice(0, m.index) + `\u0000${holes.length - 1}\u0000` + tpl.slice(m.index + whole.length);
  }
  const stray = /\{\{[#^/][^}]*\}\}/.exec(tpl);
  if (stray) throw new Error(`unrendered section tag ${stray[0]}: every {{#x}} or {{^x}} needs a matching {{/x}}`);
  tpl = tpl.replace(/\{\{(json:)?([\w.]+)\}\}/g, (_, json, path) => {
    const v = lookup(path, scopes);
    return json ? jsonLiteral(String(v)) : escapeHtml(v);
  });
  return tpl.replace(/\u0000(\d+)\u0000/g, (_, i) => holes[Number(i)]);
}

/** JSON.stringify, with the three characters that can end or break a script element escaped. */
const jsonLiteral = (s) =>
  JSON.stringify(s).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * Renders every page and the two crawler files, keyed by their path relative
 * to docs/. Nothing is written, so the test can compare.
 */
export async function build(templatePath, stringsPath) {
  const tpl = await readFile(templatePath, 'utf8');
  const all = JSON.parse(await readFile(stringsPath, 'utf8'));
  const out = {};
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];
  for (const lang of LANGS) {
    const T = all[lang.code];
    if (!T) throw new Error(`strings.json has no block for ${lang.code}`);
    const base = lang.slug ? '../' : '';
    const file = lang.slug ? `${lang.slug}/index.html` : 'index.html';
    const alternates = LANGS.map((o) => ({
      code: o.code,
      name: o.name,
      url: langUrl(o),
      // The root page's link to itself is "" from the root and "../" from a
      // subfolder; an empty href reloads the page, so spell it "./".
      path: o.slug ? `${base}${o.slug}/` : base || './',
      current: o.code === lang.code,
    }));
    out[file] = render(tpl, [{ Lang: lang, T, URL: langUrl(lang), SiteURL: SITE_URL, RepoURL: REPO_URL, Base: base, Docs: lang.docs, Alternates: alternates }]);
    sitemap.push('  <url>', `    <loc>${langUrl(lang)}</loc>`);
    for (const o of LANGS) sitemap.push(`    <xhtml:link rel="alternate" hreflang="${o.code}" href="${langUrl(o)}"/>`);
    sitemap.push('  </url>');
  }
  sitemap.push('</urlset>', '');
  out['sitemap.xml'] = sitemap.join('\n');
  // docs/site/ holds the raw template, full of {{...}}; keep it out of search.
  out['robots.txt'] = `User-agent: *\nAllow: /\nDisallow: /site/\n\nSitemap: ${SITE_URL}sitemap.xml\n`;
  return out;
}

export const TEMPLATE = join(repoRoot, 'docs', 'site', 'template.html');
export const STRINGS = join(repoRoot, 'docs', 'site', 'strings.json');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = await build(TEMPLATE, STRINGS);
  for (const [name, data] of Object.entries(files)) {
    const path = join(repoRoot, 'docs', name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  console.log(`wrote ${Object.keys(files).length} files under docs/`);
}
