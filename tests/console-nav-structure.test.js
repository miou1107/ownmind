// v1.26.46 — the console's navigation, and the promises it makes.
//
// Requirement 5: "no nav item promises a feature that exists nowhere". 稽核記錄 was a nav
// item for a feature with no page and no API anywhere, and nothing failed. So the checks
// here are about every item resolving to something real, and about the sidebar's idea of
// who may see what agreeing with the route guards'.
//
// v1.32.0 — 20 pages became 7 entries with tabs (openspec v1.32.0-console-rebuild,
// Phase 1). The promises are the same, plus two new ones: every old address redirects to
// a tab that exists, and an entry's bare address lands on a tab its reader may see.
//
// Most of this executes the navigation module rather than reading its source. The parts
// that must read source are the ones that live in JSX, which node --test cannot parse.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NAV_ENTRIES, NAV_SECTIONS, OLD_PATHS, allNavItems, visibleSections, visibleItems,
  navMinRole, navLabelKey, navEntryFor, firstVisiblePath, entryMinRole,
} from '../client/src/components/common/nav-sections.js';
import { ROLE_DENIED_REDIRECT, roleAtLeast } from '../client/src/session/roles.js';
import {
  LEGACY_CONSOLE_FEATURES, isSignpost, signpostFeatures,
} from '../shared/legacy-console-manifest.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(repoRoot, p), 'utf8');

const APP = 'client/src/App.jsx';
const SIDEBAR = 'client/src/components/common/Sidebar.jsx';
const LAYOUT = 'client/src/components/common/Layout.jsx';
const ROLES = ['user', 'admin', 'super_admin'];

describe('nav structure — every item resolves to something real', () => {
  it('every item is a built page — there is no other kind left', () => {
    // The App module lists the pages it has built. Read as source because App.jsx is JSX.
    //
    // v1.26.60: an item used to be allowed to be *either* a built page or a signpost into
    // the legacy console. That second option is gone with the console, so the assertion
    // tightens: anything in the navigation must have a page, or App.jsx renders it as a
    // visible "Route not wired" error. This is the 稽核記錄 defect — a menu item for a
    // feature that exists nowhere — and it now has exactly one way to be avoided.
    const app = read(APP);
    const realPaths = [...app.matchAll(/'(\/[\w/-]+)':\s*<\w+Page\s*\/>/g)].map((m) => m[1]);

    for (const item of allNavItems()) {
      assert.ok(
        realPaths.includes(item.path),
        `${item.path} is in the navigation but has no entry in App.jsx's REAL_PAGES`,
      );
      assert.equal(isSignpost(item.path), false,
        `${item.path} is signposted, which is no longer a thing that can work`);
    }
    // And nothing is wired that the navigation does not reach.
    const navPaths = new Set(allNavItems().map((i) => i.path));
    for (const p of realPaths) {
      assert.ok(navPaths.has(p), `${p} is wired in App.jsx but no nav item points there`);
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

  it('every entry has an icon, so the rail cannot render undefined as a component', () => {
    const sidebar = read(SIDEBAR);
    for (const entry of NAV_ENTRIES) {
      assert.match(
        sidebar,
        new RegExp(`'${entry.path.replace(/\//g, '\\/')}':`),
        `Sidebar ICONS has no entry for ${entry.path}`,
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
      ...NAV_ENTRIES.map((e) => e.labelKey),
    ]);
    for (const loc of ['zh', 'en', 'ja']) {
      const dict = JSON.parse(read(`client/src/i18n/${loc}.json`));
      for (const key of keys) {
        assert.ok(dict[key], `${loc}.json has no value for ${key}`);
      }
    }
  });
});

describe('v1.32.0 — seven entries, each a prefix of its own tabs', () => {
  it('there are seven, in the order the prototype fixed', () => {
    assert.deepEqual(NAV_ENTRIES.map((e) => e.id),
      ['home', 'inbox', 'usage', 'team', 'memory', 'settings', 'admin']);
    assert.equal(NAV_SECTIONS, NAV_ENTRIES, 'the old name must still resolve');
  });

  it('every tab lives under its entry\'s path, and ids are unique within an entry', () => {
    for (const entry of NAV_ENTRIES) {
      const ids = new Set();
      for (const tab of entry.tabs) {
        assert.ok(tab.path.startsWith(`${entry.path}/`), `${tab.path} is not under ${entry.path}`);
        assert.ok(!ids.has(tab.id), `${entry.id} has two tabs called ${tab.id}`);
        ids.add(tab.id);
        assert.equal(navEntryFor(tab.path), entry);
      }
      assert.equal(navEntryFor(entry.path), entry);
    }
    assert.equal(navEntryFor('/nope'), null);
  });

  it('no entry path is a prefix of another, so the active entry is unambiguous', () => {
    for (const a of NAV_ENTRIES) {
      for (const b of NAV_ENTRIES) {
        if (a === b) continue;
        assert.ok(!b.path.startsWith(`${a.path}/`), `${b.path} sits under ${a.path}`);
      }
    }
  });

  it('an entry\'s bare path lands on the first tab the role may see', () => {
    const inbox = NAV_ENTRIES.find((e) => e.id === 'inbox');
    assert.equal(firstVisiblePath(inbox, 'user'), '/inbox/handoffs');
    const admin = NAV_ENTRIES.find((e) => e.id === 'admin');
    assert.equal(firstVisiblePath(admin, 'admin'), '/admin/users');
    assert.equal(firstVisiblePath(admin, 'user'), null, 'a member may see no admin tab at all');
    const team = NAV_ENTRIES.find((e) => e.id === 'team');
    // v1.32.5 — 成員 is open to everyone, so every role lands there; the per-role skip is
    // exercised by 管理, whose first tab a member may not see.
    assert.equal(firstVisiblePath(team, 'user'), '/team/members');
    assert.equal(firstVisiblePath(team, 'admin'), '/team/members');
    const memory = NAV_ENTRIES.find((e) => e.id === 'memory');
    assert.equal(firstVisiblePath(memory, 'user'), '/memory/projects');
  });

  it('an entry\'s minimum role is the lowest among its tabs', () => {
    assert.equal(entryMinRole(NAV_ENTRIES.find((e) => e.id === 'home')), 'user');
    assert.equal(entryMinRole(NAV_ENTRIES.find((e) => e.id === 'team')), 'user');
    assert.equal(entryMinRole(NAV_ENTRIES.find((e) => e.id === 'admin')), 'admin');
  });

  it('App.jsx redirects an entry\'s bare path through the session, not a fixed target', () => {
    const app = read(APP);
    assert.match(app, /firstVisiblePath\(entry, role\)/,
      'the entry index must pick the tab by role; a fixed first tab would send a member to an admin page');
    assert.match(app, /if \(!ready\) return null;/,
      'and must wait for the identity, or a null role sends every admin to 總覽');
  });

  it('Layout titles the page by entry and subtitles it by tab', () => {
    const layout = read(LAYOUT);
    assert.match(layout, /navEntryFor\(pathname\)/);
    assert.match(layout, /navLabelKey\(pathname\)/);
    assert.match(layout, /visibleItems\(entry, role\)/, 'the tab strip shows only tabs the role may see');
  });
});

describe('v1.32.0 — every old address still works', () => {
  const OLD_TWENTY = [
    '/portal/usage', '/portal/project-history', '/portal/handoffs', '/portal/lessons',
    '/portal/tasks', '/portal/reports', '/portal/narrative', '/portal/pitfalls',
    '/portal/periodic-reports', '/team/usage', '/team/stats', '/team/tasks',
    '/preference/profile', '/preference/security', '/preference/vault',
    '/admin/team', '/admin/bugs', '/system/config', '/system/broadcast', '/system/work-log',
  ];

  it('each of the twenty is either a redirect or still a route', () => {
    const navPaths = new Set(allNavItems().map((i) => i.path));
    for (const old of OLD_TWENTY) {
      assert.ok(old in OLD_PATHS || navPaths.has(old),
        `${old} neither redirects nor exists; a link in somebody's memory just broke`);
    }
  });

  it('every redirect target is a nav item, so a redirect cannot land on 404', () => {
    const navPaths = new Set(allNavItems().map((i) => i.path));
    for (const [from, to] of Object.entries(OLD_PATHS)) {
      assert.ok(navPaths.has(to), `${from} redirects to ${to}, which is not a page`);
      assert.ok(!navPaths.has(from), `${from} is both a redirect and a page`);
    }
  });

  it('App.jsx renders the redirects from OLD_PATHS rather than listing them again', () => {
    const app = read(APP);
    assert.match(app, /Object\.entries\(OLD_PATHS\)/);
  });

  it('nothing in the client still links to an old address', () => {
    // The guards, the login page and the top bar all used to name /portal/usage or
    // /preference/*. A link left behind would work — the redirect catches it — but it is a
    // second place to update, which is how the first one went stale.
    const files = [
      APP, SIDEBAR, LAYOUT,
      'client/src/components/common/TopBar.jsx',
      'client/src/components/common/RequireFreshPassword.jsx',
      'client/src/components/common/RequireRole.jsx',
      'client/src/pages/LoginPage.jsx',
      'client/src/pages/Preference/SecurityPage.jsx',
      'client/src/session/roles.js',
    ];
    for (const f of files) {
      const src = read(f).replace(/\/\/.*$/gm, '');
      for (const old of Object.keys(OLD_PATHS)) {
        assert.doesNotMatch(src, new RegExp(`['"\`]${old.replace(/\//g, '\\/')}['"\`]`),
          `${f} still links to ${old}`);
      }
    }
  });
});

describe('nav structure — role filtering', () => {
  it('a plain member sees only the items marked for user', () => {
    const sections = visibleSections('user');
    const paths = sections.flatMap((s) => s.items.map((i) => i.path));
    // #126: a member who can see nothing at all passed both loops below. That is a broken
    // console, not a correct one, and it read as the strictest possible green.
    assert.ok(paths.length > 0, 'a plain member sees no navigation at all, which cannot be right');
    for (const p of paths) {
      assert.equal(navMinRole(p), 'user', `${p} is visible to a user but not marked minRole user`);
    }
    // And nothing admin-only slipped through.
    for (const item of allNavItems()) {
      if (item.minRole !== 'user') {
        assert.ok(!paths.includes(item.path), `${item.path} must not be visible to a user`);
      }
    }
    // The entries a member sees: everything but 管理.
    assert.deepEqual(sections.map((s) => s.id), ['home', 'inbox', 'usage', 'team', 'memory', 'settings']);
  });

  it('an entry appears when at least one of its tabs does, and not otherwise', () => {
    for (const role of ROLES) {
      const shown = new Set(visibleSections(role).map((s) => s.id));
      for (const entry of NAV_ENTRIES) {
        const any = visibleItems(entry, role).length > 0;
        assert.equal(
          shown.has(entry.id), any,
          `entry ${entry.id} visibility for ${role} disagrees with its tabs`,
        );
      }
    }
  });

  it('an unknown or absent role sees nothing', () => {
    // Identity failed to resolve. Failing closed here is what keeps the console from
    // offering admin tools during a database blip.
    for (const role of [null, undefined, '', 'root', 'valueOf']) {
      assert.deepEqual(visibleSections(role), [], `role ${String(role)} should see no entries`);
    }
  });

  it('a super_admin sees every item', () => {
    const paths = visibleSections('super_admin').flatMap((s) => s.items.map((i) => i.path));
    assert.equal(paths.length, allNavItems().length);
  });

  it('nobody gained or lost a page in the move', () => {
    // Phase 1 is a move, not a change of policy. Each tab carries the role its old page
    // had; this pins the ones that would be easiest to get wrong.
    assert.equal(navMinRole('/team/observe'), 'user', '整體分析 was open to members');
    assert.equal(navMinRole('/team/reports'), 'user', '週報月報 was open to members (v1.26.59)');
    // v1.32.5 — the one deliberate change of policy: the member list is for everyone, and the
    // admin tools (add/edit/delete, passwords) moved behind 管理 › 使用者.
    assert.equal(navMinRole('/team/members'), 'user');
    assert.equal(navMinRole('/admin/users'), 'admin');
    assert.equal(navMinRole('/memory/rules'), 'user');
    assert.equal(navMinRole('/inbox/bugs'), 'admin');
    assert.equal(navMinRole('/usage/team'), 'admin');
    assert.equal(navMinRole('/admin/machines'), 'admin');
    assert.equal(navMinRole('/admin/broadcast'), 'super_admin');
    assert.equal(navMinRole('/admin/work-log'), 'super_admin');
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
      /<Route\s+path="\/(portal|team|admin|system|inbox|usage|memory|settings)\//,
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
    assert.equal(ROLE_DENIED_REDIRECT, '/home', '總覽 is the first screen and the fallback');
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
    for (const file of [APP, SIDEBAR, 'client/src/components/common/nav-sections.js', LAYOUT]) {
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
    const layout = read(LAYOUT);
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

// ─────────────────────────────────────────────────────────────────────────────
// v1.26.60 — the signpost vocabulary is gone from every locale
// ─────────────────────────────────────────────────────────────────────────────

describe('v1.26.60 — no locale still describes the legacy console', () => {
  // The e2e suite used to assert "this nav item carries no amber marker" by looking for
  // the marker's aria-label. Deleting the label made those assertions unfailable, so the
  // claim moves here, where it is about the thing that actually has to stay deleted: the
  // strings. A future edit that reintroduces a signpost has to reintroduce these first.
  const LOCALES = ['zh', 'en', 'ja'];
  const GONE = [/^signpost\./, /^legacy\.tab\./, /^nav\.still_in_legacy$/];

  for (const loc of LOCALES) {
    it(`${loc} has no signpost keys`, () => {
      const dict = JSON.parse(
        readFileSync(join(repoRoot, `client/src/i18n/${loc}.json`), 'utf8'),
      );
      const left = Object.keys(dict).filter((k) => GONE.some((re) => re.test(k)));
      assert.deepEqual(left, [], `${loc}.json still carries signpost vocabulary`);
    });
  }
});
