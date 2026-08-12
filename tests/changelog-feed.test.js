/**
 * v1.26.126 — the footer's "changelog" button opened an empty modal.
 *
 * The modal, its timeline markup and all three locale strings shipped in v1.20.0;
 * only the data was missing. client/src/App.jsx passed `changelog: []` with a
 * comment saying the real source "is a separate thing", and that separate thing
 * was never built. So the button had nothing to show and said so, in three
 * languages, for six months.
 *
 * These tests cover the source of truth (CHANGELOG.md), the parser that turns it
 * into entries, the route that serves them, and the one packaging step that a
 * runtime file read can silently lose: the Dockerfile COPY.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startServer } from './helpers/app-server.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseChangelog, loadChangelogEntries } from '../src/utils/changelog.js';
import { createChangelogRouter } from '../src/routes/changelog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;

describe('parseChangelog — heading shapes actually present in CHANGELOG.md', () => {
  it('reads the current shape: "## v1.26.125 — title"', () => {
    const [entry] = parseChangelog('# OwnMind\n\n## v1.26.125 — 名字寫錯了\n\nbody\n');
    assert.equal(entry.version, '1.26.125');
    assert.equal(entry.title, '名字寫錯了');
  });

  it('reads the older hyphen shape: "## v1.15.4 - title"', () => {
    // Everything up to v1.16.0 used an ASCII hyphen. A parser that only knows the
    // em dash would render 284 entries with no title at all.
    const [entry] = parseChangelog('## v1.15.4 - SessionStart 可靠觸發\n\nbody\n');
    assert.equal(entry.version, '1.15.4');
    assert.equal(entry.title, 'SessionStart 可靠觸發');
  });

  it('reads the earliest shape, where the date comes first: "## 2026-03-26 — v1.4.0 title"', () => {
    const [entry] = parseChangelog('## 2026-03-26 — v1.4.0 鐵律防護修正\n\nbody\n');
    assert.equal(entry.version, '1.4.0');
    assert.equal(entry.title, '鐵律防護修正');
    assert.equal(entry.date, '2026-03-26');
  });

  it('leaves date empty rather than inventing one when the heading carries no date', () => {
    const [entry] = parseChangelog('## v1.26.125 — 名字寫錯了\n\nbody\n');
    assert.equal(entry.date, '');
  });

  it('skips a heading with no version in it, instead of emitting a blank timeline dot', () => {
    const entries = parseChangelog('## 尚未發布\n\nbody\n\n## v1.2.3 — real\n\nbody\n');
    assert.deepEqual(entries.map((e) => e.version), ['1.2.3']);
  });
});

describe('parseChangelog — description', () => {
  it('takes the first paragraph, joined into one line', () => {
    const [entry] = parseChangelog(
      '## v1.0.0 — t\n\nfirst line\nsecond line\n\nsecond paragraph\n',
    );
    assert.equal(entry.description, 'first line second line');
  });

  it('does not start the description inside a code block', () => {
    // Several entries open with a fenced log excerpt. Rendering its contents as
    // the summary sentence would show the reader a stack trace fragment.
    const [entry] = parseChangelog(
      '## v1.0.0 — t\n\n```\nleak.txt: value 符合 openai_api_key\n```\n\nthe actual sentence\n',
    );
    assert.equal(entry.description, 'the actual sentence');
  });

  it('stops at a sub-heading rather than swallowing the whole entry', () => {
    const [entry] = parseChangelog('## v1.0.0 — t\n\nsummary\n\n### 修法\n\ndetail\n');
    assert.equal(entry.description, 'summary');
  });

  it('falls through a leading sub-heading instead of summarising as nothing', () => {
    // Eight of the thirty newest entries open straight into `### 修法`. Stopping at
    // the sub-heading left a quarter of the modal title-only; the paragraph beneath
    // it is still this entry's own text.
    const [entry] = parseChangelog('## v1.0.0 — t\n\n### 修法\n\nthe fix\n');
    assert.equal(entry.description, 'the fix');
  });

  it('skips a leading table or list rather than reading its pipes as a sentence', () => {
    const [entry] = parseChangelog(
      '## v1.0.0 — t\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- a bullet\n\nthe sentence\n',
    );
    assert.equal(entry.description, 'the sentence');
  });

  it('drops the （同版）marker that shares a version with the entry above', () => {
    const [entry] = parseChangelog('## v1.26.98（同版）— 回滾失敗時不要再回報\n\nbody\n');
    assert.equal(entry.version, '1.26.98');
    assert.equal(entry.title, '回滾失敗時不要再回報');
  });

  it('strips inline markdown so the modal renders prose, not syntax', () => {
    const [entry] = parseChangelog(
      '## v1.0.0 — `status_reason` 送錯值\n\n**擋是對的**，見 [說明](http://x) 跟 `code`\n',
    );
    assert.equal(entry.title, 'status_reason 送錯值');
    assert.equal(entry.description, '擋是對的，見 說明 跟 code');
  });

  it('does not read a heading quoted inside a fenced block as a release', () => {
    // Entries quote each other's headings. v1.26.126's own notes list the three
    // heading shapes inside a fence, and reading those as releases put an
    // invented v1.15.4 entry second in the timeline, above the real history.
    const entries = parseChangelog(
      '## v1.26.126 — t\n\n```\n## v1.15.4 - 標題\n## 2026-03-26 — v1.4.0 標題\n```\n\nreal body\n\n## v1.26.125 — u\n\nbody\n',
    );
    assert.deepEqual(entries.map((e) => e.version), ['1.26.126', '1.26.125']);
  });

  it('accepts an entry whose body is empty', () => {
    const [entry] = parseChangelog('## v1.0.0 — t\n\n## v0.9.0 — u\n\nbody\n');
    assert.equal(entry.description, '');
  });
});

describe('parseChangelog — ordering and size', () => {
  const many = Array.from({ length: 40 }, (_, i) => `## v1.0.${39 - i} — t${39 - i}\n\nbody\n`).join('\n');

  it('keeps file order, which is newest first', () => {
    const entries = parseChangelog(many, { limit: 3 });
    assert.deepEqual(entries.map((e) => e.version), ['1.0.39', '1.0.38', '1.0.37']);
  });

  it('caps the payload — a footer modal is not the place to ship 299 entries', () => {
    assert.equal(parseChangelog(many, { limit: 10 }).length, 10);
  });
});

describe('the real CHANGELOG.md', () => {
  const entries = parseChangelog(readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), {
    limit: Infinity,
  });

  it('parses into entries at all', () => {
    assert.ok(entries.length > 250, `only parsed ${entries.length} entries`);
  });

  it('leads with the version this build actually is', () => {
    // If the release step ever writes package.json without writing CHANGELOG.md,
    // the footer would show a version the user is not running.
    assert.equal(entries[0].version, pkgVersion);
  });

  it('gives every entry a title, so no row renders as a bare version number', () => {
    const untitled = entries.filter((e) => !e.title).map((e) => e.version);
    assert.deepEqual(untitled, []);
  });

  it('runs newest to oldest, so nothing it quoted has been spliced into the history', () => {
    // The regression this guards: a `## v1.15.4 …` heading quoted inside a fenced block was
    // parsed as a release and landed second, ahead of the real history.
    //
    // v1.26.127: this used to pin the literal '1.26.125' as the second entry, which made it
    // fail on the release after the one that wrote it — red every version, and silent about
    // the bug it exists for. A quoted heading is out of place wherever it lands, so assert
    // the property instead: versions never climb as the list descends. Equal is allowed —
    // v1.26.98 legitimately ships six entries in a row.
    const rank = (v) => v.split('.').map(Number);
    const climbs = (a, b) => {
      const [x, y] = [rank(a), rank(b)];
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
      return false;
    };
    const breaks = entries
      .slice(1)
      .map((e, i) => (climbs(entries[i].version, e.version) ? `${entries[i].version} → ${e.version}` : null))
      .filter(Boolean);
    assert.deepEqual(
      breaks, [],
      'a version climbs partway down the list — a heading quoted inside a fenced block has '
      + 'been parsed as a release',
    );
  });

  it('repeats a version more than once, so a version is not a unique key', () => {
    // v1.26.98 ships six entries, v1.26.87 and v1.17.1 two each. This is pinned
    // because the timeline used entry.version as its React key: were the file to
    // stop doing this, the reason that key is a composite would be lost.
    const seen = new Set();
    const repeated = entries.filter((e) => (seen.has(e.version) ? true : (seen.add(e.version), false)));
    assert.ok(repeated.length > 0, 'no version repeats — the composite React key can be simplified');
  });

  it('leaves no markdown syntax in the rendered fields', () => {
    // A lone `*` is not markdown here: a dozen entries talk about `*.pem` and
    // `iron-rule-*.js`, and those asterisks belong to the sentence. Only the
    // paired and bracketed forms are syntax the reader should never see.
    const dirty = entries.filter((e) => /`|\*\*|\]\(/.test(`${e.title} ${e.description}`));
    assert.deepEqual(dirty.map((e) => e.version), []);
  });
});

describe('loadChangelogEntries', () => {
  it('returns [] instead of throwing when the file is missing', () => {
    // The image could ship without CHANGELOG.md. A footer button that shows its
    // empty state is a cosmetic loss; a crashing route is an outage.
    const entries = loadChangelogEntries({
      readFile: () => { throw new Error('ENOENT'); },
    });
    assert.deepEqual(entries, []);
  });
});

async function getChangelog({ authorized = true } = {}) {
  const app = express();
  const auth = (req, res, next) => (authorized ? next() : res.status(401).json({ error: 'no key' }));
  app.use('/api/changelog', createChangelogRouter({ auth }));

  // v1.26.158 — through the shared helper: `listen(0)` can hand back a port `fetch` refuses
  // to dial, which is the v1.26.143 finding. See tests/helpers/app-server.js.
  const server = await startServer(app);
  try {
    const r = await fetch(`${server.url}/api/changelog`);
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, body: ct.includes('json') ? await r.json() : null };
  } finally {
    await server.close();
  }
}

describe('GET /api/changelog', () => {
  it('serves the entries, newest first', async () => {
    const r = await getChangelog();
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.entries));
    assert.equal(r.body.entries[0].version, pkgVersion);
  });

  it('sits behind the same auth as every other dashboard route', async () => {
    const r = await getChangelog({ authorized: false });
    assert.equal(r.status, 401);
  });

  it('returns only the fields the timeline renders', async () => {
    const r = await getChangelog();
    assert.deepEqual(Object.keys(r.body.entries[0]).sort(), [
      'date', 'description', 'title', 'version',
    ]);
  });
});

describe('packaging', () => {
  it('the Dockerfile copies CHANGELOG.md, which the server now reads at runtime', () => {
    // IR-268. src/ and db/ are copied explicitly; a file added outside those trees
    // is absent in the image, and the only symptom is a footer that stays empty in
    // production while it works on every developer machine.
    const dockerfile = readFileSync(join(repoRoot, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^COPY CHANGELOG\.md /m);
  });
});
