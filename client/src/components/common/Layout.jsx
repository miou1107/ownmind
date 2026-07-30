import { useLocation } from 'react-router-dom';
import { useT } from '../../i18n/LocaleContext';
import useServerVersion from '../../hooks/useServerVersion';
import { useSession } from '../../session/SessionContext';
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
//
// 身分（角色、姓名）跟版號都由這裡自己去拿，不從 App 往下傳。理由同 v1.26.43：
// Layout 只在登入後才渲染，所以請求一定帶著 key；App 在登入前就掛好而且不會
// unmount，在那裡發請求會 401 一次然後永遠不重試。
// locale 由 LocaleProvider 提供、同樣不需 props。
export default function Layout({ children, changelog }) {
  const t = useT();
  const { pathname } = useLocation();
  const version = useServerVersion();
  const { role, name, error, ready, logout } = useSession();
  const titleKey = PATH_TITLE_KEYS[pathname];
  const pageTitle = titleKey ? t(titleKey) : t('header.title');

  // 身分還沒回來時不要先畫殼。role 這時是 null，側邊欄的四個區塊會全部過濾掉，
  // 頭像顯示「?」跟「訪客」、角色徽章還會先顯示一般使用者才跳成正確的。等一個
  // 往返再畫，比先畫錯的再改好。
  if (!ready) {
    return <div className="h-screen bg-linen-100" aria-busy="true" />;
  }

  return (
    <div className="flex h-screen bg-linen-100">
      <Sidebar role={role} version={version} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          pageTitle={pageTitle}
          currentRole={role}
          userName={name}
          onLogout={logout}
        />
        <main className="flex-1 overflow-y-auto p-6">
          {error && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {t('session.identity_unavailable')}
            </div>
          )}
          {children}
        </main>
        <Footer version={version} changelog={changelog} />
      </div>
    </div>
  );
}
