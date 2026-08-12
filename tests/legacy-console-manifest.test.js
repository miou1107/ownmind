// v1.26.46 — the legacy-console manifest and the /admin either/or.
import { startServer } from './helpers/app-server.js';
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
import { tempDir } from './helpers/temp-dir.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const ROLE_RANK = { user: 1, admin: 2, super_admin: 3 };

async function fetchOnce(app, urlPath) {
  // v1.26.158 — through the shared helper: `listen(0)` can hand back a port `fetch` refuses
  // to dial, which is the v1.26.143 finding. See tests/helpers/app-server.js.
  const srv = await startServer(app);
  try {
    const r = await fetch(`${srv.url}${urlPath}`, { redirect: 'manual' });
    const body = r.status === 200 ? await r.text() : '';
    return { status: r.status, location: r.headers.get('location'), body };
  } finally {
    await srv.close();
  }
}

function makeLegacyDir() {
  const dir = tempDir('legacy-console-');
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
    const ok = { id: 'a', consolePath: '/a', legacyTab: 'a', state: 'live' };
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

  it('v1.26.60 — "signpost" is no longer a state the manifest accepts', () => {
    // The old console is gone, so a signpost would link to /admin/#tab, which redirects
    // to the console, which renders the signpost again. Putting a feature back is not
    // something that can half-work any more, so it fails at import rather than at
    // runtime as a loop. Executed, not described: this calls the validator.
    assert.equal(FEATURE_STATES.includes('signpost'), false);
    assert.throws(
      () => validateFeatures([{ id: 'a', consolePath: '/a', legacyTab: 'a', state: 'signpost' }]),
      /unknown state/,
      'reintroducing a signpost must be a boot failure',
    );
  });

  it('retirement can no longer be undone by editing the manifest', () => {
    // There is no legal state that produces a signpost, so the predicate the server
    // reads is permanently true whatever anyone writes in the entry list.
    assert.equal(isLegacyConsoleRetired(), true);
    assert.deepEqual(signpostFeatures(), []);
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

  it('v1.26.50 — system-config and broadcast are live, not signposts', () => {
    // Stage 3 flip. The pages are built in this release; the two amber dots on
    // 系統設定 and 廣播管理 must be gone. If a future edit reverts either
    // entry to signpost, this test fires so no one has to notice via UI.
    const cfg = legacyFeatureFor('/system/config');
    const brd = legacyFeatureFor('/system/broadcast');
    assert.ok(cfg, 'system-config entry missing from manifest');
    assert.ok(brd, 'broadcast entry missing from manifest');
    assert.equal(cfg.state, 'live', 'system-config should be live after Stage 3');
    assert.equal(brd.state, 'live', 'broadcast should be live after Stage 3');
    assert.equal(isSignpost('/system/config'), false);
    assert.equal(isSignpost('/system/broadcast'), false);
  });

  it('v1.26.51 — bug-reports and work-log are live, not signposts', () => {
    // Stage 4 flip. The two amber dots on 錯誤回報 and 工作紀錄 must be gone.
    // If a future edit reverts either entry, this test fires immediately.
    const bugs = legacyFeatureFor('/admin/bugs');
    const wlog = legacyFeatureFor('/system/work-log');
    assert.ok(bugs, 'bug-reports entry missing from manifest');
    assert.ok(wlog, 'work-log entry missing from manifest');
    assert.equal(bugs.state, 'live', 'bug-reports should be live after Stage 4');
    assert.equal(wlog.state, 'live', 'work-log should be live after Stage 4');
    assert.equal(isSignpost('/admin/bugs'), false);
    assert.equal(isSignpost('/system/work-log'), false);
  });

  it('v1.26.56 — stats-dashboard is live, not a signpost', () => {
    // Stage 5 flip. The amber dot on 統計儀表板 must be gone.
    const stats = legacyFeatureFor('/team/stats');
    assert.ok(stats, 'stats-dashboard entry missing from manifest');
    assert.equal(stats.state, 'live', 'stats-dashboard should be live after Stage 5');
    assert.equal(isSignpost('/team/stats'), false);
  });

  it('v1.26.58 — team-usage is live, not a signpost', () => {
    // Stage 6 flip. The amber dot on 團隊用量 must be gone.
    const usage = legacyFeatureFor('/team/usage');
    assert.ok(usage, 'team-usage entry missing from manifest');
    assert.equal(usage.state, 'live', 'team-usage should be live after Stage 6');
    assert.equal(isSignpost('/team/usage'), false);
  });

  it('v1.26.59 — 週報月報 is live', () => {
    // Stage 7 flip, and the last one. The amber dot on 週報月報 must be gone.
    const periodic = legacyFeatureFor('/portal/periodic-reports');
    assert.ok(periodic, 'periodic-reports entry missing from manifest');
    assert.equal(periodic.state, 'live', 'periodic-reports should be live after Stage 7');
    assert.equal(isSignpost('/portal/periodic-reports'), false);
  });

  it('v1.26.59 — the manifest is empty, so the legacy console is retired', () => {
    // This is the switch the whole file was built around: nothing points back at
    // /admin any more, so it stops being served with no other edit anywhere. If a
    // later change re-signposts something, this turns red and says so.
    assert.deepEqual(signpostFeatures(), [], 'no feature may still live in /admin');
    assert.equal(isLegacyConsoleRetired(), true);
  });

  it('every feature that ever lived in /admin is accounted for, not deleted', () => {
    // Entries are flipped, never removed — the manifest is the record of where each
    // feature went. An empty list must mean "all live", not "all forgotten".
    assert.equal(LEGACY_CONSOLE_FEATURES.length, 8);
    assert.ok(LEGACY_CONSOLE_FEATURES.every((f) => f.state === 'live'));
  });
});

describe('legacy-console manifest — the record it leaves behind', () => {
  it('every entry still names the tab it came from', () => {
    // The manifest is the record of where each feature went, so the provenance has to
    // survive the source file being retired. Checked against the preserved snapshot
    // rather than the served tree, because nothing serves it any more.
    const html = readFileSync(join(repoRoot, 'legacy/admin-v1.26/index.html'), 'utf8');
    for (const f of LEGACY_CONSOLE_FEATURES) {
      assert.ok(
        html.includes(`data-tab="${f.legacyTab}"`),
        `${f.id} records legacy tab "${f.legacyTab}", which the preserved console has no button for`,
      );
    }
  });

  it('every migrated feature has a nav item in the console it moved to', () => {
    // The other half of the same claim: the feature did not merely stop being in /admin,
    // it arrived somewhere. A path with no nav item would be a feature that vanished.
    for (const f of LEGACY_CONSOLE_FEATURES) {
      assert.ok(
        navMinRole(f.consolePath),
        `${f.id} claims to be live at ${f.consolePath}, but the console has no nav item there`,
      );
    }
  });
});

describe('/admin after retirement — it can only redirect', () => {
  it('/admin/ is not served and does redirect', async () => {
    const dir = makeLegacyDir();
    try {
      const app = express();
      const branch = installLegacyAdminMount(app);
      assert.equal(branch, 'redirect');

      const root = await fetchOnce(app, '/admin/');
      assert.equal(root.status, 301);
      assert.equal(root.location, '../dashboard/');
      assert.doesNotMatch(root.body, /legacy console/, 'the legacy file must not be served');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the redirect covers every depth below /admin', async () => {
    const app = express();
    installLegacyAdminMount(app);

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
  });

  it('nothing can serve the legacy console any more', () => {
    // v1.26.60. The either/or is gone: the helper has one branch, and it holds no
    // reference to a directory to serve. Previously this suite proved both directions
    // worked; what has to be proved now is that only one of them exists, because the
    // deleted branch was express.static over the whole of src/public.
    const src = readFileSync(join(repoRoot, 'src/middleware/legacy-admin-mount.js'), 'utf8');
    // A call, not a mention: the header comment explains what was removed and why, and
    // the first version of this assertion matched its own documentation.
    assert.doesNotMatch(src, /express\.static\s*\(/, 'the static branch must stay deleted');
    assert.doesNotMatch(src, /^\s*import .*from ['"]express['"]/m, 'express is no longer needed here');
    assert.doesNotMatch(src, /publicDir/, 'nothing should name a directory to serve');
  });

  it('src/app.js does not mount /admin outside the helper', () => {
    // The structural half of the guard. Without this, a future edit could restore a
    // hardcoded `app.use('/admin', express.static(...))` with every behavioural test
    // above still green.
    const appSrc = readFileSync(join(repoRoot, 'src/app.js'), 'utf8');
    assert.doesNotMatch(
      appSrc,
      /app\.use\(\s*['"`]\/admin['"`]\s*,\s*express\.static/,
      'src/app.js must not mount /admin directly; go through installLegacyAdminMount',
    );
    assert.match(appSrc, /installLegacyAdminMount\(/);
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
