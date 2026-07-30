// v1.26.46 — the console's navigation, and the promises it makes.
//
// Requirement 5: "no nav item promises a feature that exists nowhere". 稽核記錄 was a nav
// item for a feature with no page and no API anywhere, and nothing failed. So the checks
// here are about every item resolving to something real, and about the sidebar's idea of
// who may see what agreeing with the route guards'.
//
// Most of this executes the navigation module rather than reading its source. The parts
// that must read source are the ones that live in JSX, which node --test cannot parse.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAV_SECTIONS, allNavItems, visibleSections, visibleItems, navMinRole, navLabelKey,
} from '../client/src/components/common/nav-sections.js';
import { ROLE_DENIED_REDIRECT, roleAtLeast } from '../client/src/session/roles.js';
import {
  LEGACY_CONSOLE_FEATURES, isSignpost, signpostFeatures,
} from '../shared/legacy-console-manifest.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

const APP = 'client/src/App.jsx';
const SIDEBAR = 'client/src/components/common/Sidebar.jsx';
const ROLES = ['user', 'admin', 'super_admin'];

describe('nav structure — every item resolves to something real', () => {
  it('each item is either a built page or a signposted legacy feature, never neither', () => {
    // The App module lists the pages it has built. Read as source because App.jsx is JSX.
    const app = read(APP);
    const realPaths = [...app.matchAll(/'(\/[\w/-]+)':\s*<\w+Page\s*\/>/g)].map((m) => m[1]);

    for (const item of allNavItems()) {
      const built = realPaths.includes(item.path);
      const signposted = isSignpost(item.path);
      assert.ok(
        built || signposted,
        `${item.path} is in the navigation but has neither an entry in REAL_PAGES nor a `
        + 'signpost in shared/legacy-console-manifest.js. This is the 稽核記錄 defect: a '
        + 'menu item for a feature that exists nowhere',
      );
      assert.ok(
        !(built && signposted),
        `${item.path} is both built and signposted; flip its manifest entry to 'live'`,
      );
    }
  });

  it('every manifest entry has a seat in the navigation', () => {
    const paths = allNavItems().map((i) => i.path);
    for (const f of LEGACY_CONSOLE_FEATURES) {
      assert.ok(
        paths.includes(f.consolePath),
        `${f.id} is in the manifest at ${f.consolePath} but nothing in the navigation `
        + 'points there, so the feature is invisible until someone remembers it',
      );
    }
  });

  it('every item has an icon, so the sidebar cannot render undefined as a component', () => {
    const sidebar = read(SIDEBAR);
    for (const item of allNavItems()) {
      assert.match(
        sidebar,
        new RegExp(`'${item.path.replace(/\//g, '\\/')}':`),
        `Sidebar ICONS has no entry for ${item.path}`,
      );
    }
  });

  it('no two items share a label key', () => {
    // The collision that caused the first inventory to mark 週/月報 as already built:
    // /portal/reports (回報紀錄) and the weekly report both read as "reports".
    const seen = new Map();
    for (const item of allNavItems()) {
      const prev = seen.get(item.labelKey);
      assert.equal(
        prev, undefined,
        `${item.path} and ${prev} share the label key ${item.labelKey}; two features with `
        + 'one name is how the weekly report got mistaken for the bug-report log',
      );
      seen.set(item.labelKey, item.path);
    }
  });

  it('every label key exists in all three locales', () => {
    const keys = new Set([
      ...allNavItems().map((i) => i.labelKey),
      ...NAV_SECTIONS.map((s) => s.labelKey),
    ]);
    for (const loc of ['zh', 'en', 'ja']) {
      const dict = JSON.parse(read(`client/src/i18n/${loc}.json`));
      for (const key of keys) {
        assert.ok(dict[key], `${loc}.json has no value for ${key}`);
      }
    }
  });
});

describe('nav structure — role filtering', () => {
  it('a plain member sees only the items marked for user', () => {
    const sections = visibleSections('user');
    const paths = sections.flatMap((s) => s.items.map((i) => i.path));
    for (const p of paths) {
      assert.equal(navMinRole(p), 'user', `${p} is visible to a user but not marked minRole user`);
    }
    // And nothing admin-only slipped through.
    for (const item of allNavItems()) {
      if (item.minRole !== 'user') {
        assert.ok(!paths.includes(item.path), `${item.path} must not be visible to a user`);
      }
    }
  });

  it('a section appears when at least one of its items does, and not otherwise', () => {
    for (const role of ROLES) {
      const shown = new Set(visibleSections(role).map((s) => s.id));
      for (const section of NAV_SECTIONS) {
        const any = visibleItems(section, role).length > 0;
        assert.equal(
          shown.has(section.id), any,
          `section ${section.id} visibility for ${role} disagrees with its items`,
        );
      }
    }
  });

  it('an unknown or absent role sees nothing', () => {
    // Identity failed to resolve. Failing closed here is what keeps the console from
    // offering admin tools during a database blip.
    for (const role of [null, undefined, '', 'root', 'valueOf']) {
      assert.deepEqual(visibleSections(role), [], `role ${String(role)} should see no sections`);
    }
  });

  it('a super_admin sees every item', () => {
    const paths = visibleSections('super_admin').flatMap((s) => s.items.map((i) => i.path));
    assert.equal(paths.length, allNavItems().length);
  });
});

describe('nav structure — the guards agree with the navigation', () => {
  it('routes are generated from the navigation rather than hand-listed', () => {
    // If App.jsx goes back to a literal <Route> per page, a nav item can exist with no
    // route (a dead menu entry) or a route with no nav item (an unreachable page), and
    // every executable test above still passes.
    const app = read(APP);
    assert.match(app, /allNavItems\(\)/, 'App.jsx must build its feature routes from the nav data');
    assert.doesNotMatch(
      app,
      /<Route\s+path="\/(portal|team|admin|system)\//,
      'App.jsx must not hardcode feature routes; they come from allNavItems()',
    );
  });

  it('the guard tier is chosen from the item minRole, not restated', () => {
    const app = read(APP);
    assert.match(app, /item\.minRole/, 'the route guard must read minRole from the nav item');
  });

  it('the denied-role fallback is reachable by every role', () => {
    // RequireRole sends a denied role to ROLE_DENIED_REDIRECT. If that path were itself
    // role-gated, a session whose identity failed to resolve would bounce from the
    // fallback to the fallback forever.
    assert.equal(
      navMinRole(ROLE_DENIED_REDIRECT), 'user',
      `${ROLE_DENIED_REDIRECT} is where a denied role is sent, so it must be open to user`,
    );
    for (const role of ROLES) {
      assert.ok(roleAtLeast(role, navMinRole(ROLE_DENIED_REDIRECT)));
    }
  });

  it('the fallback is not a signpost, so a denied member is not sent to a dead end', () => {
    assert.equal(isSignpost(ROLE_DENIED_REDIRECT), false);
  });
});

describe('nav structure — 稽核記錄 is gone, not hidden', () => {
  it('no source file still routes or labels the audit page', () => {
    for (const file of [APP, SIDEBAR, 'client/src/components/common/nav-sections.js',
      'client/src/components/common/Layout.jsx']) {
      assert.doesNotMatch(read(file), /super\/audit/, `${file} still references /super/audit`);
    }
  });

  it('the audit label is gone from all three locales', () => {
    for (const loc of ['zh', 'en', 'ja']) {
      const dict = JSON.parse(read(`client/src/i18n/${loc}.json`));
      assert.ok(!('nav.audit' in dict), `${loc}.json still carries nav.audit`);
    }
  });

  it('the placeholder copy is gone, because it was not true', () => {
    // "此頁面正在重構中、即將於後續階段完工" described a feature that was working the
    // whole time, in the old console. Signposts replaced it.
    for (const loc of ['zh', 'en', 'ja']) {
      const dict = JSON.parse(read(`client/src/i18n/${loc}.json`));
      assert.ok(!('placeholder.coming_soon' in dict), `${loc}.json still carries the placeholder copy`);
    }
    assert.doesNotMatch(read(APP), /placeholder\.coming_soon/);
  });

  it('every signpost has a legacy tab label in all three locales', () => {
    for (const loc of ['zh', 'en', 'ja']) {
      const dict = JSON.parse(read(`client/src/i18n/${loc}.json`));
      for (const f of signpostFeatures()) {
        assert.ok(
          dict[`legacy.tab.${f.legacyTab}`],
          `${loc}.json has no legacy.tab.${f.legacyTab}, so the signpost for ${f.id} would `
          + 'show a raw key instead of naming where to go',
        );
      }
    }
  });
});

describe('nav structure — page titles have one source', () => {
  it('Layout reads the title from the navigation instead of its own table', () => {
    const layout = read('client/src/components/common/Layout.jsx');
    assert.match(layout, /navLabelKey\(/, 'Layout must resolve titles through navLabelKey');
    assert.doesNotMatch(
      layout,
      /PATH_TITLE_KEYS\s*=/,
      'the duplicate path-to-title map was a second place to remember; it is gone',
    );
  });

  it('navLabelKey answers for every nav path and no other', () => {
    for (const item of allNavItems()) {
      assert.equal(navLabelKey(item.path), item.labelKey);
    }
    assert.equal(navLabelKey('/nope'), null);
  });
});
