/**
 * Any member could read the title and code of anyone's private iron rule.
 *
 * POST /api/activity/batch enriches a "memory_disable" event by looking up the memory it names,
 * and the lookup had no owner check, so reporting memory_disable for id 1, 2, 3 … stored the
 * type, code and title of every user's memories in the reporter's own activity log.
 * GET /api/me/pitfalls, open to every member, then showed them. Even without that trick, the
 * page showed every member the whole team's rows: other people's iron-rule titles, names, and
 * session projects and summaries.
 *
 * Now the lookups only see what the reporting user may read, the page's fallback lookups only
 * see the row owner's own memory, and a member sees their own rows (admins still see the team).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import express from 'express';
import { scopePitfallRows, hideOthersRuleTitles } from '../src/utils/pitfalls-scope.js';
import { createNarrativeRouter } from '../src/routes/me-narrative.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(repoRoot, rel), 'utf8');

describe('scopePitfallRows — a member sees their own rows, an admin the team', () => {
  const rows = [{ user_id: 5, what: 'mine' }, { user_id: 6, what: 'theirs' }, { user_id: '5', what: 'mine, as text' }];

  it('a member sees only their own rows', () => {
    assert.deepEqual(scopePitfallRows(rows, { id: 5, role: 'user' }).map((r) => r.what), ['mine', 'mine, as text']);
  });

  it('admins and super_admins see everyone', () => {
    assert.equal(scopePitfallRows(rows, { id: 1, role: 'admin' }).length, 3);
    assert.equal(scopePitfallRows(rows, { id: 1, role: 'super_admin' }).length, 3);
  });

  it('no user, an unknown role or no rows sees nothing it should not', () => {
    assert.deepEqual(scopePitfallRows(rows, null), []);
    assert.deepEqual(scopePitfallRows(rows, { id: 9, role: 'guest' }), []);
    assert.deepEqual(scopePitfallRows(undefined, { id: 5, role: 'user' }), []);
  });
});

describe('the lookups only see what the reporting user may read', () => {
  const src = read('src/routes/activity.js');

  it('memoryLookup is scoped by buildReadableWhere and called with the reporter\'s id', () => {
    assert.match(src, /async function memoryLookup\(id, userId\)[\s\S]{0,600}buildReadableWhere\(\{ alias: 'm', userParam: '\$2' \}\)[\s\S]{0,80}\[id, userId\]/);
    assert.match(src, /enrichActivityDetails\(e, \(id\) => memoryLookup\(id, req\.user\.id\)\)/);
  });

  it('no unscoped "FROM memories WHERE id = $1" lookup is left', () => {
    assert.doesNotMatch(src, /FROM memories WHERE id = \$1/);
  });
});

describe('the pitfalls page', () => {
  const src = read('src/routes/me.js');
  const route = src.slice(src.indexOf("router.get('/pitfalls'"));

  it('every fallback lookup is limited to the row owner\'s own memory', () => {
    const lookups = route.match(/\(SELECT (?:type|title|code) FROM memories WHERE id = [^\n]+/g) || [];
    assert.equal(lookups.length, 5);
    for (const l of lookups) assert.match(l, /AND user_id = [as]\.user_id\)/, l);
  });

  it('the id pattern reaches SQL as \\d, and only up to nine digits', () => {
    // A lone backslash in a template literal is eaten (SQL used to get '^d+$', which never
    // matched). Once it matches, an id beyond a 32-bit integer would make ::int throw and take
    // the whole page down for everyone — any member can plant one with a forged event.
    const lookups = route.match(/\(SELECT (?:type|title|code) FROM memories WHERE id = [^\n]+/g) || [];
    for (const l of lookups) assert.ok(l.includes("'^\\\\d{1,9}$'"), l);
  });

  it('every section is filtered by scopePitfallRows before it is returned', () => {
    for (const q of ['unobservedQ', 'unverifiedQ', 'orphanQ']) {
      assert.match(route, new RegExp(`scopePitfallRows\\(${q}\\.rows, req\\.user\\)`));
    }
    assert.doesNotMatch(route, /rows: (?:unobservedQ|unverifiedQ|orphanQ)\.rows\.map/);
  });
});

describe('the team narrative keeps its rows but not other people\'s rule titles', () => {
  const sections = { compliance: [
    { user_id: 5, rule_code: 'IR-001', title: 'my own rule', violate: 1 },
    { user_id: 6, rule_code: 'IR-001', title: 'someone else\'s private rule', violate: 2 },
  ], other: 'kept' };

  it('a member keeps every row and count, and only their own titles', () => {
    const out = hideOthersRuleTitles(sections, { id: 5, role: 'user' });
    assert.equal(out.compliance.length, 2);
    assert.equal(out.compliance[0].title, 'my own rule');
    assert.equal(out.compliance[1].title, null);
    assert.equal(out.compliance[1].violate, 2);
    assert.equal(out.other, 'kept');
  });

  it('an admin sees every title', () => {
    assert.equal(hideOthersRuleTitles(sections, { id: 1, role: 'admin' }).compliance[1].title, 'someone else\'s private rule');
  });

  it('the route applies it before answering a member', async () => {
    const query = async (sql) => (/WITH stats AS/.test(sql) ? { rows: sections.compliance } : { rows: [] });
    const app = express();
    app.use('/api/me/narrative', createNarrativeRouter({
      query, auth: (req, res, next) => { req.user = { id: 5, role: 'user' }; next(); },
    }));
    const body = await new Promise((resolve) => {
      const req = { method: 'GET', url: '/api/me/narrative', path: '/api/me/narrative', originalUrl: '/api/me/narrative', headers: {}, query: {} };
      const res = {
        statusCode: 200, setHeader() {}, getHeader() {},
        status(c) { this.statusCode = c; return this; },
        json(b) { resolve(b); return this; },
        end(b) { resolve(b); return this; },
      };
      app(req, res, () => resolve(null));
    });
    assert.ok(body && body.sections, JSON.stringify(body));
    assert.ok(!JSON.stringify(body).includes('someone else'), 'another member\'s rule title never reaches a member');
  });
});
