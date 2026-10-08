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
// v1.32.0 (openspec v1.32.0-console-rebuild, Phase 1) — 20 pages become 7 entries.
//
// On 2026-10-04 the owner said the console was cluttered: the data was scattered over five
// groups and twenty items, and finding one thing meant knowing which group somebody had
// filed it under. The rail now has seven entries, each answering one question the reader
// already has, and each entry holds tabs. A tab is a route (`/inbox/handoffs`) so it can
// be linked from a notice or a memory; an entry's own path (`/inbox`) sends the reader to
// the first tab their role may see.
//
// Every one of the twenty old paths keeps working as a redirect to the tab that took it
// over (OLD_PATHS below), so links in memories, notices and broadcasts do not break.
//
// Permission stays on the item (the tab), as it has since v1.26.46: an entry is shown
// when at least one of its tabs is, and a tab the role may not see is not rendered, with
// its URL redirecting to the entry's first visible tab. `minRole` on a tab must equal the
// `min` passed to RequireRole for the same path in App.jsx; asserted by
// tests/console-nav-structure.test.js.

import { roleAtLeast } from '../../session/roles.js';

/**
 * The seven entries. Phase 1 moves the existing pages under them unchanged — each tab
 * renders the component the old path rendered — and keeps every role exactly where it
 * was, so nobody gains or loses a page in this release. Phases 2–5 replace the tab
 * contents one entry at a time.
 */
export const NAV_ENTRIES = [
  {
    id: 'home',
    path: '/home',
    labelKey: 'nav.home',
    minRole: 'user',
    tabs: [],
  },
  {
    id: 'inbox',
    path: '/inbox',
    labelKey: 'nav.inbox',
    tabs: [
      { id: 'handoffs', path: '/inbox/handoffs', labelKey: 'nav.inbox.handoffs', minRole: 'user' },
      // v1.31.0: personal — GET /api/session/lessons filters WHERE user_id = $1.
      { id: 'lessons', path: '/inbox/lessons', labelKey: 'nav.inbox.lessons', minRole: 'user' },
      // v1.31.3: personal — GET /api/tasks?mine=true filters on the caller.
      { id: 'tasks', path: '/inbox/tasks', labelKey: 'nav.inbox.tasks', minRole: 'user' },
      // The member's own bug reports and what happened to them.
      { id: 'reports', path: '/inbox/reports', labelKey: 'nav.inbox.reports', minRole: 'user' },
      // Every report, for the people who fix them.
      { id: 'bugs', path: '/inbox/bugs', labelKey: 'nav.inbox.bugs', minRole: 'admin' },
    ],
  },
  {
    id: 'usage',
    path: '/usage',
    labelKey: 'nav.usage',
    tabs: [
      { id: 'mine', path: '/usage/mine', labelKey: 'nav.usage.mine', minRole: 'user' },
      { id: 'rules', path: '/usage/rules', labelKey: 'nav.usage.rules', minRole: 'user' },
      // Backs onto adminAuth routes: /api/usage/team-stats and /api/usage/admin/team-overview.
      { id: 'team', path: '/usage/team', labelKey: 'nav.usage.team', minRole: 'admin' },
    ],
  },
  {
    id: 'team',
    path: '/team',
    labelKey: 'nav.team',
    tabs: [
      // User CRUD lives here until Phase 5 splits the member list from the admin tools.
      { id: 'members', path: '/team/members', labelKey: 'nav.team.members', minRole: 'admin' },
      { id: 'observe', path: '/team/observe', labelKey: 'nav.team.observe', minRole: 'user' },
      // Personal by nature: GET /api/session/report filters WHERE user_id = $1.
      { id: 'reports', path: '/team/reports', labelKey: 'nav.team.reports', minRole: 'user' },
      { id: 'stats', path: '/team/stats', labelKey: 'nav.team.stats', minRole: 'admin' },
      // v1.31.3: GET /api/tasks?all=true answers 403 below admin.
      { id: 'tasks', path: '/team/tasks', labelKey: 'nav.team.tasks', minRole: 'admin' },
    ],
  },
  {
    id: 'memory',
    path: '/memory',
    labelKey: 'nav.memory',
    tabs: [
      { id: 'projects', path: '/memory/projects', labelKey: 'nav.memory.projects', minRole: 'user' },
    ],
  },
  {
    id: 'settings',
    path: '/settings',
    labelKey: 'nav.settings',
    tabs: [
      { id: 'profile', path: '/settings/profile', labelKey: 'nav.settings.profile', minRole: 'user' },
      { id: 'security', path: '/settings/security', labelKey: 'nav.settings.security', minRole: 'user' },
      { id: 'vault', path: '/settings/vault', labelKey: 'nav.settings.vault', minRole: 'user' },
    ],
  },
  {
    id: 'admin',
    path: '/admin',
    labelKey: 'nav.admin',
    tabs: [
      // Its data comes from adminAuth routes, so admin+.
      { id: 'machines', path: '/admin/machines', labelKey: 'nav.admin.machines', minRole: 'admin' },
      // Both super_admin: /api/broadcast/admin and /api/admin/work-log are superAdminAuth.
      { id: 'broadcast', path: '/admin/broadcast', labelKey: 'nav.admin.broadcast', minRole: 'super_admin' },
      { id: 'work-log', path: '/admin/work-log', labelKey: 'nav.admin.work_log', minRole: 'super_admin' },
    ],
  },
];

/**
 * The twenty paths the console had before v1.32.0, each pointing at the tab that took it
 * over. Two of them (`/team/stats`, `/team/tasks`) kept their address and are not here.
 * App.jsx renders a redirect for every key.
 */
export const OLD_PATHS = {
  '/portal/usage': '/usage/mine',
  '/portal/project-history': '/memory/projects',
  '/portal/handoffs': '/inbox/handoffs',
  '/portal/lessons': '/inbox/lessons',
  '/portal/tasks': '/inbox/tasks',
  '/portal/reports': '/inbox/reports',
  '/portal/narrative': '/team/observe',
  '/portal/pitfalls': '/usage/rules',
  '/portal/periodic-reports': '/team/reports',
  '/team/usage': '/usage/team',
  '/preference/profile': '/settings/profile',
  '/preference/security': '/settings/security',
  '/preference/vault': '/settings/vault',
  '/admin/team': '/team/members',
  '/admin/bugs': '/inbox/bugs',
  '/system/config': '/admin/machines',
  '/system/broadcast': '/admin/broadcast',
  '/system/work-log': '/admin/work-log',
};

/** The lowest role that may see an entry: the lowest among its tabs, or its own. */
export function entryMinRole(entry) {
  if (entry.minRole) return entry.minRole;
  const ranks = { user: 1, admin: 2, super_admin: 3 };
  return entry.tabs.reduce(
    (low, t) => ((ranks[t.minRole] ?? Infinity) < (ranks[low] ?? Infinity) ? t.minRole : low),
    null,
  );
}

/**
 * The items of an entry, as routes: a single-page entry is one item at its own path, a
 * tabbed entry is one item per tab. Each carries `sectionId` (the entry id) so a page can
 * find its entry.
 */
function itemsOf(entry) {
  if (entry.tabs.length === 0) {
    return [{ id: entry.id, path: entry.path, labelKey: entry.labelKey, minRole: entry.minRole, sectionId: entry.id }];
  }
  return entry.tabs.map((t) => ({ ...t, sectionId: entry.id }));
}

/** Items (tabs) of one entry that `role` may see. */
export function visibleItems(entry, role) {
  return itemsOf(entry).filter((item) => roleAtLeast(role, item.minRole));
}

/** Entries with at least one item visible to `role`, each carrying its filtered items. */
export function visibleSections(role) {
  return NAV_ENTRIES
    .map((entry) => ({ ...entry, items: visibleItems(entry, role) }))
    .filter((entry) => entry.items.length > 0);
}

/** Every routed item, flattened, with its entry id attached. */
export function allNavItems() {
  return NAV_ENTRIES.flatMap(itemsOf);
}

/** The declared minimum role for a path, or null when the path is not in the navigation. */
export function navMinRole(path) {
  return allNavItems().find((i) => i.path === path)?.minRole ?? null;
}

/**
 * The i18n key naming a path, or null when the path is not in the navigation.
 *
 * Pages read their heading from here rather than taking a `titleKey` prop, so a page
 * and its nav item cannot end up calling the same feature two different things.
 */
export function navLabelKey(path) {
  return allNavItems().find((i) => i.path === path)?.labelKey ?? null;
}

/** The entry a path belongs to (its own path or one of its tabs), or null. */
export function navEntryFor(path) {
  return NAV_ENTRIES.find((e) => e.path === path || e.tabs.some((t) => t.path === path)) ?? null;
}

/**
 * Where an entry's bare path sends `role`: its first tab they may see, or null when they
 * may see none (RequireRole then sends them to ROLE_DENIED_REDIRECT).
 */
export function firstVisiblePath(entry, role) {
  return visibleItems(entry, role)[0]?.path ?? null;
}

/**
 * Kept for the two tests and the sidebar that still say "sections": an entry is what a
 * section became.
 */
export const NAV_SECTIONS = NAV_ENTRIES;
