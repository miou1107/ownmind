import { useLocation } from 'react-router-dom';
import { useT } from '../../i18n/LocaleContext';
import useServerVersion from '../../hooks/useServerVersion';
import { useSession } from '../../session/SessionContext';
import { navLabelKey } from './nav-sections';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import Footer from './Footer';

// v1.26.46：頁面標題改成直接問導覽列（navLabelKey）。
// 這裡原本自己維護一份 path → i18n key 的對照表，註解還寫著「新頁面要在 NAV_SECTIONS
// 加路由、也要在這裡加標題對應」— 那就是第二個要記得改的地方，而且忘了改不會壞、
// 只會靜靜地把標題顯示成「OwnMind 控制中心」。同一個功能的名字只留一個來源。

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
  const titleKey = navLabelKey(pathname);
  const pageTitle = titleKey ? t(titleKey) : t('header.title');

  // 身分還沒回來時不要先畫殼。role 這時是 null，側邊欄的五個區塊會全部過濾掉，
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
