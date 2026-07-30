// The navigation structure, as data, with no React and no icon imports.
//
// This used to live inside Sidebar.jsx, where it was untestable: node --test cannot parse
// JSX, so the only assertion possible was that the file contained the string `roles: [`
// and the three role names. Review pointed out what that misses — a section handing the
// admin pages to `user` would pass, because the test checked vocabulary rather than
// agreement. The requirement it is meant to cover ("a regular member sees only their own
// sections") was therefore verified by nothing that runs.
//
// Split out so the sidebar's idea of who may see what can be compared against the route
// guards' idea, by a test that executes. Icons stay in Sidebar.jsx, keyed by path, so the
// only import here is the role ladder itself.
//
// v1.26.46: permission moved from the section to the item. The 系統 group holds 系統設定
// (admin+, matching the legacy 裝機狀況 card) next to 廣播管理 and 工作紀錄 (super_admin
// only, matching their `super-admin-only` markup and `superAdminAuth` routes). A single
// per-section role would have had to pick one, either hiding 系統設定 from admins who can
// use it today or promising the other two to admins the server will refuse. A section is
// now shown when at least one of its items is.

import { roleAtLeast } from '../../session/roles.js';

/**
 * `minRole` is the lowest role that may see the item, and must equal the `min` passed to
 * RequireRole for the same path in App.jsx. Asserted by tests/console-nav-structure.test.js.
 *
 * Items whose feature still lives in the legacy console render a signpost rather than a
 * real page; which ones is decided by shared/legacy-console-manifest.js, not here. Their
 * `minRole` is additionally floored at the legacy console's own login requirement, because
 * a signpost shown to someone who cannot log in there is a dead end.
 */
export const NAV_SECTIONS = [
  {
    id: 'mine',
    labelKey: 'nav.section.mine',
    items: [
      { path: '/portal/usage', labelKey: 'nav.usage', minRole: 'user' },
      { path: '/portal/project-history', labelKey: 'nav.project_history', minRole: 'user' },
      { path: '/portal/handoffs', labelKey: 'nav.handoffs', minRole: 'user' },
      { path: '/portal/reports', labelKey: 'nav.reports', minRole: 'user' },
      { path: '/portal/narrative', labelKey: 'nav.narrative', minRole: 'user' },
      { path: '/portal/pitfalls', labelKey: 'nav.pitfalls', minRole: 'user' },
      // Personal by nature: GET /api/session/report filters WHERE user_id = $1. Sits at
      // admin only while it is a signpost, because the legacy console it points at
      // refuses a `user` at login. Drops to 'user' when the real page is built.
      { path: '/portal/periodic-reports', labelKey: 'nav.periodic_reports', minRole: 'admin' },
    ],
  },
  {
    id: 'team',
    labelKey: 'nav.section.team',
    items: [
      // Both back onto adminAuth routes: /api/usage/team-stats and /api/activity/stats*.
      { path: '/team/usage', labelKey: 'nav.team_usage', minRole: 'admin' },
      { path: '/team/stats', labelKey: 'nav.team_stats', minRole: 'admin' },
    ],
  },
  {
    id: 'preference',
    labelKey: 'nav.section.preference',
    items: [
      { path: '/preference/profile', labelKey: 'nav.profile', minRole: 'user' },
      { path: '/preference/security', labelKey: 'nav.security', minRole: 'user' },
      { path: '/preference/vault', labelKey: 'nav.vault', minRole: 'user' },
    ],
  },
  {
    id: 'admin',
    labelKey: 'nav.section.admin',
    items: [
      { path: '/admin/team', labelKey: 'nav.members', minRole: 'admin' },
      { path: '/admin/bugs', labelKey: 'nav.bugs', minRole: 'admin' },
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.section.system',
    items: [
      // 裝機狀況 is revealed to admin+ in the legacy console and its data comes from
      // adminAuth routes, so it stays admin+ here.
      { path: '/system/config', labelKey: 'nav.config', minRole: 'admin' },
      // Both super_admin: the legacy broadcast card carries `super-admin-only`, and
      // /api/admin/work-log is superAdminAuth throughout.
      { path: '/system/broadcast', labelKey: 'nav.broadcast', minRole: 'super_admin' },
      { path: '/system/work-log', labelKey: 'nav.work_log', minRole: 'super_admin' },
    ],
  },
];

/** Items of one section that `role` may see. */
export function visibleItems(section, role) {
  return section.items.filter((item) => roleAtLeast(role, item.minRole));
}

/** Sections with at least one item visible to `role`, each carrying its filtered items. */
export function visibleSections(role) {
  return NAV_SECTIONS
    .map((section) => ({ ...section, items: visibleItems(section, role) }))
    .filter((section) => section.items.length > 0);
}

/** Every nav item, flattened, with its section id attached. */
export function allNavItems() {
  return NAV_SECTIONS.flatMap((s) => s.items.map((item) => ({ ...item, sectionId: s.id })));
}

/** The declared minimum role for a path, or null when the path is not in the navigation. */
export function navMinRole(path) {
  return allNavItems().find((i) => i.path === path)?.minRole ?? null;
}

/**
 * The i18n key naming a path, or null when the path is not in the navigation.
 *
 * Signposts read their heading from here rather than taking a `titleKey` prop, so a page
 * and its nav item cannot end up calling the same feature two different things.
 */
export function navLabelKey(path) {
  return allNavItems().find((i) => i.path === path)?.labelKey ?? null;
}
