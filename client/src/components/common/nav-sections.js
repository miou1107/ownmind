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
// guards' idea, by a test that executes. Icons stay in Sidebar.jsx, keyed by path, so this
// module has zero imports.
//
// `roles` is "at least one of these", matching how the sidebar filters. It must stay
// consistent with the `min` passed to RequireRole in App.jsx: a section listing
// ['admin', 'super_admin'] corresponds to min="admin", and ['super_admin'] to
// min="super_admin".

export const NAV_SECTIONS = [
  {
    id: 'portal',
    labelKey: 'nav.section.portal_analytics',
    roles: ['user', 'admin', 'super_admin'],
    items: [
      { path: '/portal/usage', labelKey: 'nav.usage' },
      { path: '/portal/project-history', labelKey: 'nav.project_history' },
      { path: '/portal/handoffs', labelKey: 'nav.handoffs' },
      { path: '/portal/reports', labelKey: 'nav.reports' },
    ],
  },
  {
    id: 'preference',
    labelKey: 'nav.section.preference',
    roles: ['user', 'admin', 'super_admin'],
    items: [
      { path: '/preference/profile', labelKey: 'nav.profile' },
      { path: '/preference/security', labelKey: 'nav.security' },
      { path: '/preference/vault', labelKey: 'nav.vault' },
    ],
  },
  {
    id: 'admin',
    labelKey: 'nav.section.admin',
    roles: ['admin', 'super_admin'],
    items: [
      { path: '/admin/team', labelKey: 'nav.team' },
      { path: '/admin/bugs', labelKey: 'nav.bugs' },
    ],
  },
  {
    id: 'super',
    labelKey: 'nav.section.super',
    roles: ['super_admin'],
    items: [
      { path: '/super/config', labelKey: 'nav.config' },
      { path: '/super/broadcast', labelKey: 'nav.broadcast' },
      { path: '/super/audit', labelKey: 'nav.audit' },
    ],
  },
];

/** The lowest role in a section's `roles` list, i.e. the `min` its routes should use. */
export function sectionMinRole(section) {
  const order = ['user', 'admin', 'super_admin'];
  return order.find((r) => section.roles.includes(r)) ?? null;
}
