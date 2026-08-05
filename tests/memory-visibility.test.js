import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SHARED_MEMORY_TYPES,
  isSharedMemoryType,
  buildReadableWhere,
} from '../src/utils/memory-visibility.js';

/**
 * v1.26.38 — share team-standard details with every member
 *
 * `team_standard` summaries are global on purpose (src/routes/memory.js:418-424)
 * but the `standard_detail` fragments carrying the actual rule text were still
 * filtered by the caller's own user_id on every read path. Members loaded a
 * shelf of standard titles nobody but the uploader could open: production held
 * 127 active fragments, all owned by one account, unreachable since the first
 * upload on 2026-04-07.
 *
 * These tests pin the shared read predicate. It is a pure SQL builder, so the
 * suite needs no live Postgres — matching the convention in
 * tests/memory-search-query.test.js. Behaviour against real rows is verified
 * separately against a live database before release.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

/** Collapse whitespace so assertions do not depend on SQL formatting. */
const flat = (sql) => sql.replace(/\s+/g, ' ').trim();

/**
 * Slice one route handler out of the source.
 *
 * Ends at the next top-level `router.` declaration rather than the first
 * `});`, because handlers contain nested calls such as
 * `res.status(400).json({ ... });` that would truncate the body early.
 */
const handlerBody = (src, marker) => {
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `handler not found: ${marker}`);
  const rest = src.slice(start + marker.length);
  const end = rest.indexOf('\nrouter.');
  return rest.slice(0, end === -1 ? rest.length : end);
};

describe('SHARED_MEMORY_TYPES', () => {
  it('shares exactly the two team-standard layers', () => {
    assert.deepEqual([...SHARED_MEMORY_TYPES].sort(), ['standard_detail', 'team_standard']);
  });

  it('does not share private types', () => {
    for (const type of ['profile', 'iron_rule', 'project', 'env', 'coding_standard']) {
      assert.equal(isSharedMemoryType(type), false, `${type} must stay owner-only`);
    }
  });

  it('reports both shared types as shared', () => {
    assert.equal(isSharedMemoryType('team_standard'), true);
    assert.equal(isSharedMemoryType('standard_detail'), true);
  });

  it('handles unknown / non-string input without throwing', () => {
    assert.equal(isSharedMemoryType('nope'), false);
    assert.equal(isSharedMemoryType(undefined), false);
    assert.equal(isSharedMemoryType(null), false);
    assert.equal(isSharedMemoryType(42), false);
  });
});

describe('buildReadableWhere()', () => {
  it('lets a caller read their own rows of any type', () => {
    const sql = flat(buildReadableWhere({ alias: 'm', userParam: '$1' }));
    assert.match(sql, /m\.user_id = \$1/);
  });

  it('lets any caller read team_standard rows regardless of owner', () => {
    const sql = flat(buildReadableWhere({ alias: 'm', userParam: '$1' }));
    assert.match(sql, /m\.type = 'team_standard'/);
  });

  it('lets any caller read standard_detail rows under an active parent', () => {
    const sql = flat(buildReadableWhere({ alias: 'm', userParam: '$1' }));
    assert.match(sql, /m\.type = 'standard_detail'/);
    assert.match(sql, /EXISTS/);
    // Qualified with the parent alias on purpose: an unqualified
    // /type = 'team_standard'/ would also be satisfied by the outer branch, so
    // deleting the condition inside EXISTS would leave this test green.
    assert.match(sql, /parent\.type = 'team_standard'/);
    assert.match(sql, /parent\.status = 'active'/);
  });

  it('correlates the parent lookup to the row being filtered', () => {
    const sql = flat(buildReadableWhere({ alias: 'm', userParam: '$1' }));
    // Both sides pinned: reading parent_id off `parent` instead of `m` would
    // make the EXISTS uncorrelated and therefore true for every fragment.
    assert.match(sql, /parent\.id::text = m\.metadata->>'parent_id'/);
    // A non-numeric or absent parent_id must simply not match. Casting it to
    // int would abort the whole query instead.
    assert.doesNotMatch(sql, /parent_id'\)::int/);
  });

  it('hides fragments whose parent the caller opted out of', () => {
    const sql = flat(buildReadableWhere({ alias: 'm', userParam: '$1' }));
    assert.match(sql, /NOT EXISTS/);
    assert.match(sql, /optout\.tags @> ARRAY\['team_standard_optout'\]/);
    // Without this the opt-out is unscoped and every member would inherit
    // every other member's opt-outs.
    assert.match(sql, /optout\.user_id = \$1/);
    assert.match(sql, /optout\.metadata->>'team_standard_id' = parent\.id::text/);
  });

  it('parameterizes the user id instead of inlining it', () => {
    const sql = buildReadableWhere({ alias: 'm', userParam: '$7' });
    assert.match(sql, /\$7/);
    assert.doesNotMatch(sql, /\$1\b/);
    // Owner check plus the opt-out lookup both need the caller.
    assert.ok(sql.split('$7').length - 1 >= 2, 'user param should appear at least twice');
  });

  it('honours a custom table alias', () => {
    const sql = flat(buildReadableWhere({ alias: 'memories', userParam: '$2' }));
    assert.match(sql, /memories\.user_id = \$2/);
    assert.doesNotMatch(sql, /\bm\.user_id/);
  });

  it('returns a single parenthesised expression safe to AND together', () => {
    const sql = flat(buildReadableWhere({ alias: 'm', userParam: '$1' }));
    assert.ok(sql.startsWith('('), 'must open with a paren');
    assert.ok(sql.endsWith(')'), 'must close with a paren');
    const opens = (sql.match(/\(/g) || []).length;
    const closes = (sql.match(/\)/g) || []).length;
    assert.equal(opens, closes, 'parens must balance');
  });
});

describe('read routes adopt the shared predicate', () => {
  const routeSrc = read('src/routes/memory.js');

  it('imports the shared visibility helper', () => {
    assert.match(routeSrc, /memory-visibility\.js/);
    assert.match(routeSrc, /buildReadableWhere/);
  });

  it('GET /type/:type serves standard_detail from the shared branch', () => {
    // The type handler previously special-cased only team_standard.
    const body = handlerBody(routeSrc, "router.get('/type/:type'");
    assert.match(body, /standard_detail/);
  });

  it('GET /search no longer hard-scopes to the caller', () => {
    const body = handlerBody(routeSrc, "router.get('/search'");
    assert.doesNotMatch(body, /WHERE user_id = \$1/);
    assert.match(body, /buildReadableWhere/);
  });

  it('GET /:id no longer hard-scopes to the caller', () => {
    const body = handlerBody(routeSrc, "router.get('/:id'");
    assert.doesNotMatch(body, /WHERE id = \$1 AND user_id = \$2/);
    assert.match(body, /buildReadableWhere/);
  });
});

describe('read routes bind the caller in the right slot', () => {
  const routeSrc = read('src/routes/memory.js');

  // Placeholder drift is the one bug class these source-level tests can catch:
  // the predicate takes its own placeholder, so it must agree with where
  // req.user.id actually sits in the params array.
  it('GET /type/:type binds the user id as $2', () => {
    const body = handlerBody(routeSrc, "router.get('/type/:type'");
    assert.match(body, /userParam: '\$2'/);
    assert.match(body, /\[req\.params\.type, req\.user\.id\]/);
  });

  it('GET /search binds the user id as $1, ahead of the search tokens', () => {
    const body = handlerBody(routeSrc, "router.get('/search'");
    assert.match(body, /userParam: '\$1'/);
    assert.match(body, /buildSearchWhere\(tokens, 2\)/);
    assert.match(body, /\[req\.user\.id, \.\.\.built\.params\]/);
  });

  it('GET /:id binds the user id as $2', () => {
    const body = handlerBody(routeSrc, "router.get('/:id'");
    assert.match(body, /userParam: '\$2'/);
    assert.match(body, /\[req\.params\.id, req\.user\.id\]/);
  });

  it('GET /:id does not hand a disabled row to a non-owner', () => {
    // The predicate constrains the parent's status, never the row's own. /type
    // and /search AND in status = 'active'; /:id must not be the gap that lets
    // a retired standard back out.
    const body = handlerBody(routeSrc, "router.get('/:id'");
    assert.match(body, /m\.status = 'active' OR m\.user_id = \$2/);
  });
});

describe('GET /type/standard_detail can be narrowed to one parent', () => {
  const routeSrc = read('src/routes/memory.js');
  const mcpSrc = read('mcp/index.js');

  it('accepts a parent_id filter so callers need not pull every fragment', () => {
    // Unfiltered it returns every fragment of every standard (119 in
    // production), which the SOP points the assistant straight at.
    const body = handlerBody(routeSrc, "router.get('/type/:type'");
    assert.match(body, /req\.query\.parent_id/);
  });

  it('the MCP tool can pass the filter through', () => {
    const idx = mcpSrc.indexOf('name: "ownmind_get"');
    const block = mcpSrc.slice(idx, idx + 900);
    assert.match(block, /parent_id/);
  });

  it('parent_id is optional — it must not join the required list', () => {
    const idx = mcpSrc.indexOf('name: "ownmind_get"');
    const block = mcpSrc.slice(idx, idx + 1400);
    const required = block.match(/required: \[([^\]]*)\]/);
    assert.ok(required, 'ownmind_get has no required list at all');
    assert.doesNotMatch(required[1], /parent_id/);
  });

  it('type stopped being required, so the handler has to check for itself', () => {
    // v1.26.64 made `type` optional, because a call carrying `id` does not need one.
    // The schema no longer refuses a call with neither, so the handler must. Without
    // this the tool would silently fetch something arbitrary.
    const idx = mcpSrc.indexOf('name: "ownmind_get"');
    const required = mcpSrc.slice(idx, idx + 1400).match(/required: \[([^\]]*)\]/);
    assert.doesNotMatch(required[1], /type/);

    // Window sized to reach past the id branch and its offline fallback. A tighter one
    // fails on the length of the code above the guard rather than on the guard.
    const handlerIdx = mcpSrc.indexOf('case "ownmind_get"');
    const handler = mcpSrc.slice(handlerIdx, handlerIdx + 2600);
    assert.match(handler, /if \(!args\.type\)/, 'nothing refuses a call with neither id nor type');
  });
});

describe('creating or editing a shared type stays admin-only', () => {
  const routeSrc = read('src/routes/memory.js');

  // Before the read widening, a self-minted standard_detail was visible only
  // to its author, so the missing gate was inert. Now an ungated row would be
  // broadcast to every member's AI as authoritative team-standard text.
  it('POST / gates every shared type, not just team_standard', () => {
    const body = handlerBody(routeSrc, "router.post('/'");
    assert.match(body, /isSharedMemoryType\(type\)/);
  });

  it('PUT /:id gates every shared type', () => {
    const body = handlerBody(routeSrc, "router.put('/:id'");
    assert.match(body, /isSharedMemoryType\(oldMemory\.type\)/);
  });

  it('disable gates every shared type', () => {
    assert.match(routeSrc, /isSharedMemoryType\(check\.rows\[0\]\.type\)/);
  });

  it('no write handler still tests type equality against team_standard alone', () => {
    assert.doesNotMatch(routeSrc, /type === 'team_standard' && !isAtLeast/);
    assert.doesNotMatch(routeSrc, /type === 'team_standard' &&\s*!isAtLeast/);
  });
});

describe('write routes stay owner-scoped', () => {
  const routeSrc = read('src/routes/memory.js');

  it('update still matches on the caller user_id', () => {
    const body = handlerBody(routeSrc, "router.put('/:id'");
    assert.match(body, /WHERE id = \$1 AND user_id = \$2/);
  });

  it('disable still matches on the caller user_id', () => {
    assert.match(routeSrc, /SET status = 'disabled',[\s\S]{0,400}?WHERE id = \$2 AND user_id = \$3/);
  });

  it('the shared predicate is never used by a write statement', () => {
    for (const stmt of ['UPDATE memories', 'DELETE FROM memories']) {
      const idx = routeSrc.indexOf(stmt);
      if (idx === -1) continue;
      const window = routeSrc.slice(idx, idx + 600);
      assert.doesNotMatch(window, /buildReadableWhere/, `${stmt} must not widen via the read predicate`);
    }
  });
});

describe('session start stays summary-only', () => {
  const routeSrc = read('src/routes/memory.js');

  it('init still excludes rule_detail fragments', () => {
    assert.match(routeSrc, /NOT \(m\.tags @> ARRAY\['rule_detail'\]\)/);
  });
});

describe('MCP client exposes the type (server and client must move together)', () => {
  const mcpSrc = read('mcp/index.js');

  it('ownmind_get accepts standard_detail', () => {
    const idx = mcpSrc.indexOf('name: "ownmind_get"');
    // 1400, not 600: v1.26.64 lengthened the description to explain the id argument, and
    // a window that tight fails on prose rather than on behaviour.
    const block = mcpSrc.slice(idx, idx + 1400);
    assert.match(block, /"standard_detail"/);
  });

  it('ownmind_save still refuses standard_detail', () => {
    const idx = mcpSrc.indexOf('name: "ownmind_save"');
    const block = mcpSrc.slice(idx, idx + 1600);
    assert.doesNotMatch(block, /"standard_detail"/);
  });

  it('the banner has a label for standard_detail', () => {
    const idx = mcpSrc.indexOf('ownmind_get: {');
    const block = mcpSrc.slice(idx, idx + 400);
    assert.match(block, /standard_detail:/);
  });
});
