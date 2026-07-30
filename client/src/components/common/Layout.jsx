import { useLocation } from 'react-router-dom';
import { useT } from '../../i18n/LocaleContext';
import useServerVersion from '../../hooks/useServerVersion';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import Footer from './Footer';

// 頁面標題對照表 — 由 path 反查 i18n key
// 新頁面要在 Sidebar NAV_SECTIONS 加路由、也要在這裡加標題對應
const PATH_TITLE_KEYS = {
  '/portal/usage': 'nav.usage',
  '/portal/project-history': 'nav.project_history',
  '/portal/handoffs': 'nav.handoffs',
  '/portal/reports': 'nav.reports',
  '/preference/profile': 'nav.profile',
  '/preference/security': 'nav.security',
  '/preference/vault': 'nav.vault',
  '/admin/team': 'nav.team',
  '/admin/bugs': 'nav.bugs',
  '/super/config': 'nav.config',
  '/super/broadcast': 'nav.broadcast',
  '/super/audit': 'nav.audit',
};

// 頁面包裝 — sidebar + topbar + 內容 + footer
// 由 App.jsx 包進路由內、所有頁面共用
// locale 由 LocaleProvider 提供、不需 props 傳
export default function Layout({
  children,
  role,
  onRoleChange,
  profile,
  changelog,
  onLogout,
  onOpenProfile,
}) {
  const t = useT();
  const { pathname } = useLocation();
  // v1.26.43: fetched here rather than passed down from App. Layout only renders
  // beneath RequireAuth, so the request carries a key; App mounts before login
  // and never unmounts, so a fetch there would 401 once and never retry.
  const version = useServerVersion();
  const titleKey = PATH_TITLE_KEYS[pathname];
  const pageTitle = titleKey ? t(titleKey) : t('header.title');

  return (
    <div className="flex h-screen bg-linen-100">
      <Sidebar role={role} version={version} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          pageTitle={pageTitle}
          currentRole={role}
          onRoleChange={role === 'super_admin' ? onRoleChange : null}
          profile={profile}
          onLogout={onLogout}
          onOpenProfile={onOpenProfile}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
        <Footer version={version} changelog={changelog} />
      </div>
    </div>
  );
}
