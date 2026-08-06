// v1.26.78 — `activity_logs.source` was VARCHAR(10) and the values are longer than that.
//
// Found in the production log on 2026-08-06 while verifying the v1.26.77 deploy:
//
//   [ERROR] memory_save iron_rule observed_trigger write failed
//           {"error":"value too long for type character varying(10)"}
//   [ERROR] activity log batch upload failed
//           {"error":"value too long for type character varying(10)"}
//
// `mcp/ownmind-log.js:107` lifts `details.source` into the row's `source` column, so an
// auto-detected compliance event arrives with `source: 'system_auto'` — eleven characters
// into a ten-character column. The server writes `'system_server_auto'`, eighteen.
//
// The cost is not one lost row. `POST /api/activity/batch` inserts inside one try around
// the whole loop, so the throw escapes, the request 500s, and **every event in that batch
// is rejected**. The table proves it happened: across 31,000 rows the only sources ever
// stored are `mcp`, `hook`, `api` and `e2e-test`. Not one `system_auto` in the product's
// entire history.
//
// The column is widened rather than the strings shortened, because the strings are also
// sent by installed clients that will never be upgraded — Adam is on v1.26.29. Shortening
// server-side literals would leave every one of those clients still failing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The width `activity_logs.source` ends up with after every migration is applied. */
function declaredSourceWidth() {
  const dir = path.join(repoRoot, 'db');
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  let width = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    // the CREATE TABLE column, and any later ALTER ... TYPE
    const created = sql.match(/source\s+VARCHAR\((\d+)\)/i);
    if (created) width = Number(created[1]);
    const altered = sql.match(
      /ALTER\s+TABLE\s+activity_logs[\s\S]{0,120}?ALTER\s+COLUMN\s+source\s+TYPE\s+VARCHAR\((\d+)\)/i);
    if (altered) width = Number(altered[1]);
  }
  return width;
}

/** Every `source: '...'` literal in code that can reach the column. */
function sourceLiterals() {
  const dirs = ['mcp', 'hooks', 'shared', 'src'];
  const found = new Map();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'public') continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const m of text.matchAll(/\bsource:\s*'([a-zA-Z0-9_-]+)'/g)) {
        if (!found.has(m[1])) found.set(m[1], path.relative(repoRoot, full));
      }
    }
  };
  for (const d of dirs) {
    const full = path.join(repoRoot, d);
    if (fs.existsSync(full)) walk(full);
  }
  return found;
}

describe('activity_logs.source is wide enough for what is written to it', () => {
  it('has a declared width at all', () => {
    assert.ok(declaredSourceWidth(), 'could not find the column definition in db/');
  });

  it('fits every source value in the codebase', () => {
    // `mcp/ownmind-log.js` puts `details.source` into the column, so any of these can
    // become the stored value. One that does not fit does not lose a row — it rejects the
    // whole batch the row travelled in.
    const width = declaredSourceWidth();
    const tooLong = [...sourceLiterals().entries()]
      .filter(([value]) => value.length > width)
      .map(([value, file]) => `${value} (${value.length} chars, ${file})`);
    assert.deepEqual(tooLong, [],
      `these do not fit VARCHAR(${width}); each one rejects an entire batch`);
  });

  it('leaves headroom rather than fitting exactly', () => {
    // Sized to the longest value and nothing more is the same defect waiting for the next
    // string somebody adds.
    const width = declaredSourceWidth();
    const longest = Math.max(...[...sourceLiterals().keys()].map((v) => v.length));
    assert.ok(width >= longest + 8,
      `width ${width} against a longest value of ${longest}: no room for the next one`);
  });
});

describe('one bad event must not reject the whole batch', () => {
  it('inserts each event inside its own try', () => {
    // Structural, and worth saying why: `POST /api/activity/batch` uses the module-level
    // `query` import rather than an injected one, so the loop cannot be driven from a test
    // the way createEventsRouter or createTeamOverviewRouter can. Making it injectable is
    // its own change (openspec/BACKLOG.md). Until then this asserts the shape, which is
    // weaker than asserting the behaviour and is the honest thing to say about it.
    const src = fs.readFileSync(path.join(repoRoot, 'src/routes/activity.js'), 'utf8');
    const loop = src.slice(src.indexOf('for (const e of batch)'),
      src.indexOf('res.json({ inserted'));
    assert.match(loop, /try\s*{/, 'the per-event body must be able to fail on its own');
    assert.match(loop, /failed\s*\+\+|failed\s*\+=/,
      'a rejected event must be counted, not silently dropped');
  });

  it('reports the failures in the response', () => {
    // Bounded to the res.json call itself. A 200-character window past it also catches the
    // catch block's "activity log batch upload failed" string and passes while the response
    // says nothing — which is exactly what it did on the first run.
    const src = fs.readFileSync(path.join(repoRoot, 'src/routes/activity.js'), 'utf8');
    const response = src.match(/res\.json\(\{\s*inserted[^}]*\}\)/)?.[0] ?? '';
    assert.ok(response, 'could not find the batch response');
    assert.match(response, /failed/,
      'the client is told how many of its events did not land, or it cannot know');
  });
});
