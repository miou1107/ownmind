// v1.26.46 — the legacy-console manifest and the /admin either/or.
//
// Requirement 5 of the single-console consolidation: retirement is a consequence of
// finishing the work, not a task to remember. The manifest is the guard, so these tests
// are about the guard actually holding, not about today's snapshot of feature states.
//
// The both-directions requirement is load-bearing. A test that only checks the
// empty-manifest case passes just as well against code that never serves /admin/ at all,
// which would prove nothing.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_CONSOLE_FEATURES,
  LEGACY_CONSOLE_MIN_ROLE,
  FEATURE_STATES,
  signpostFeatures,
  legacyFeatureFor,
  isSignpost,
  isLegacyConsoleRetired,
  validateFeatures,
} from '../shared/legacy-console-manifest.js';
import { installLegacyAdminMount } from '../src/middleware/legacy-admin-mount.js';
import { relativeRedirectTarget } from '../src/utils/relative-redirect.js';
import { navMinRole } from '../client/src/components/common/nav-sections.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const ROLE_RANK = { user: 1, admin: 2, super_admin: 3 };

async function fetchOnce(app, urlPath) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, async () => {
      try {
        const { port } = srv.address();
        const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, { redirect: 'manual' });
        const body = r.status === 200 ? await r.text() : '';
        resolve({ status: r.status, location: r.headers.get('location'), body });
      } catch (err) {
        reject(err);
      } finally {
        srv.close();
      }
    });
  });
}

function makeLegacyDir() {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-console-'));
  writeFileSync(join(dir, 'index.html'), '<h1>legacy console</h1>');
  return dir;
}

describe('legacy-console manifest — shape', () => {
  it('every entry carries a state from the declared vocabulary', () => {
    for (const f of LEGACY_CONSOLE_FEATURES) {
      assert.ok(
        FEATURE_STATES.includes(f.state),
        `${f.id} has state "${f.state}", which is not one of ${FEATURE_STATES.join(' / ')}`,
      );
    }
  });

  it('the validator throws on all five ways the manifest can lie', () => {
    // This test used to assert `FEATURE_STATES.includes('signpst') === false`, which never
    // touched the validator at all: deleting the whole validate() body left it green. The
    // fail-closed claim is what Requirement 5 rests on, and this repo has no CI, so it has
    // to be executed rather than described.
    const ok = { id: 'a', consolePath: '/a', legacyTab: 'a', state: 'signpost' };
    const cases = [
      ['unknown state', [{ ...ok, state: 'signpst' }], /unknown state/],
      ['missing legacyTab', [{ ...ok, legacyTab: '' }], /incomplete entry/],
      ['relative consolePath', [{ ...ok, consolePath: 'a' }], /must be absolute/],
      ['duplicate consolePath', [ok, { ...ok, id: 'b' }], /duplicate consolePath/],
      ['duplicate id', [ok, { ...ok, consolePath: '/b' }], /duplicate id/],
    ];
    for (const [label, features, expected] of cases) {
      assert.throws(() => validateFeatures(features), expected, `${label} should throw`);
    }
    // And it accepts the real thing, so the guard is not simply throwing on everything.
    assert.doesNotThrow(() => validateFeatures(LEGACY_CONSOLE_FEATURES));
  });

  it('a misspelled state would otherwise have read as live', () => {
    // Why the throw matters rather than a warning: the predicate every reader uses is
    // "state === 'signpost'", so a typo silently means "already rebuilt" and retires the
    // old console while the feature is still only there.
    assert.equal('signpst' === 'signpost', false);
    assert.equal(FEATURE_STATES.includes('signpst'), false);
  });

  it('console paths and ids are unique', () => {
    const paths = LEGACY_CONSOLE_FEATURES.map((f) => f.consolePath);
    const ids = LEGACY_CONSOLE_FEATURES.map((f) => f.id);
    assert.equal(new Set(paths).size, paths.length, 'duplicate consolePath');
    assert.equal(new Set(ids).size, ids.length, 'duplicate id');
  });

  it('retirement is derived from the signpost count, not stored separately', () => {
    assert.equal(isLegacyConsoleRetired(), signpostFeatures().length === 0);
  });

  it('legacyFeatureFor / isSignpost agree with the entry list', () => {
    for (const f of LEGACY_CONSOLE_FEATURES) {
      assert.equal(legacyFeatureFor(f.consolePath).id, f.id);
      assert.equal(isSignpost(f.consolePath), f.state === 'signpost');
    }
    assert.equal(legacyFeatureFor('/portal/usage'), null);
    assert.equal(isSignpost('/portal/usage'), false, 'a path with no entry is not a signpost');
  });
});

describe('legacy-console manifest — signposts point somewhere reachable', () => {
  it('every signposted legacy tab exists in src/public/index.html', () => {
    // A signpost naming a tab that is not there would send the user to a console that
    // cannot show them the feature. Checked against the file rather than a list, so
    // renaming a tab in the legacy console fails here.
    const html = readFileSync(join(repoRoot, 'src/public/index.html'), 'utf8');
    for (const f of signpostFeatures()) {
      assert.ok(
        html.includes(`data-tab="${f.legacyTab}"`),
        `${f.id} points at legacy tab "${f.legacyTab}", which src/public/index.html has no button for`,
      );
    }
  });

  it('no signpost is offered to a role that cannot log in to the legacy console', () => {
    // POST /api/admin/login filters role IN ('admin','super_admin'), so a `user` following
    // a signpost would be rejected at the door. The nav guard for every signposted path
    // must therefore be at least LEGACY_CONSOLE_MIN_ROLE. Read from the nav module rather
    // than restated here, so the two cannot drift.
    const floor = ROLE_RANK[LEGACY_CONSOLE_MIN_ROLE];
    for (const f of signpostFeatures()) {
      const min = navMinRole(f.consolePath);
      assert.ok(min, `${f.consolePath} has no nav item, so nothing declares its minimum role`);
      assert.ok(
        ROLE_RANK[min] >= floor,
        `${f.id} is signposted at minRole "${min}" but the legacy console needs `
          + `"${LEGACY_CONSOLE_MIN_ROLE}"; a lower role would be handed a dead end`,
      );
    }
  });
});

describe('/admin either/or — both directions', () => {
  it('with one signpost remaining, /admin/ is served and not redirected', async () => {
    const dir = makeLegacyDir();
    try {
      const app = express();
      const branch = installLegacyAdminMount(app, { retired: false, publicDir: dir });
      assert.equal(branch, 'static');

      const root = await fetchOnce(app, '/admin/');
      assert.equal(root.status, 200, '/admin/ must still serve the legacy console');
      assert.match(root.body, /legacy console/);
      assert.equal(root.location, null, 'must not redirect while a signpost remains');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('with no signposts left, /admin/ is not served and does redirect', async () => {
    const dir = makeLegacyDir();
    try {
      const app = express();
      const branch = installLegacyAdminMount(app, { retired: true, publicDir: dir });
      assert.equal(branch, 'redirect');

      const root = await fetchOnce(app, '/admin/');
      assert.equal(root.status, 301);
      assert.equal(root.location, '../dashboard/');
      assert.doesNotMatch(root.body, /legacy console/, 'the legacy file must not be served');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the retirement redirect covers every depth below /admin', async () => {
    const dir = makeLegacyDir();
    try {
      const app = express();
      installLegacyAdminMount(app, { retired: true, publicDir: dir });

      const cases = [
        ['/admin', 'dashboard/'],
        ['/admin/', '../dashboard/'],
        ['/admin/setup.html', '../dashboard/'],
        ['/admin/me/index.html', '../../dashboard/'],
      ];
      for (const [url, expected] of cases) {
        const r = await fetchOnce(app, url);
        assert.equal(r.status, 301, `${url} should redirect`);
        assert.equal(r.location, expected, `${url} resolved to the wrong relative target`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('src/app.js derives the mount from the manifest instead of mounting unconditionally', () => {
    // The structural half of the guard. Without this, a future edit could restore the
    // hardcoded `app.use('/admin', express.static(...))` and the manifest would stop
    // deciding anything, with every behavioural test above still green.
    const appSrc = readFileSync(join(repoRoot, 'src/app.js'), 'utf8');
    // Quote-agnostic and tolerant of a variable for the directory: the point is that
    // nothing mounts /admin outside the manifest-driven helper.
    assert.doesNotMatch(
      appSrc,
      /app\.use\(\s*['"`]\/admin['"`]\s*,\s*express\.static/,
      'src/app.js must not mount /admin directly; go through installLegacyAdminMount',
    );
    assert.match(appSrc, /installLegacyAdminMount\(/);
    assert.match(appSrc, /isLegacyConsoleRetired\(\)/);
  });
});

describe('relativeRedirectTarget', () => {
  it('counts depth from the request directory, not the segment count', () => {
    assert.equal(relativeRedirectTarget('/admin', 'dashboard/'), 'dashboard/');
    assert.equal(relativeRedirectTarget('/admin/', 'dashboard/'), '../dashboard/');
    assert.equal(relativeRedirectTarget('/admin/x', 'dashboard/'), '../dashboard/');
    assert.equal(relativeRedirectTarget('/admin/x/y', 'dashboard/'), '../../dashboard/');
    assert.equal(relativeRedirectTarget('/', 'dashboard/'), 'dashboard/');
  });

  it('ignores query and fragment', () => {
    assert.equal(relativeRedirectTarget('/admin/x?a=1', 'dashboard/'), '../dashboard/');
    assert.equal(relativeRedirectTarget('/admin/x#top', 'dashboard/'), '../dashboard/');
  });

  it('does not under-count a doubled slash', () => {
    // filter(Boolean) would drop the empty segment and produce '../dashboard/', which the
    // browser resolves one level too deep.
    assert.equal(relativeRedirectTarget('/admin//x', 'dashboard/'), '../../dashboard/');
  });

  it('never produces a negative repeat count', () => {
    assert.equal(relativeRedirectTarget('admin', 'dashboard/'), 'dashboard/');
    assert.equal(relativeRedirectTarget('', 'dashboard/'), 'dashboard/');
  });

  it('strips a leading slash from the target instead of going absolute again', () => {
    // Passing '/dashboard/' would otherwise yield '..//dashboard/', which the browser
    // resolves as an absolute path and so drops the /ownmind prefix — undoing the entire
    // reason this function exists, silently.
    assert.equal(relativeRedirectTarget('/admin/', '/dashboard/'), '../dashboard/');
    assert.equal(relativeRedirectTarget('/admin', '/dashboard/'), 'dashboard/');
    assert.equal(relativeRedirectTarget('/admin/x/y', '///dashboard/'), '../../dashboard/');
  });
});
