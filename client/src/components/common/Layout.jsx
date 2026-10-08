import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useT } from '../../i18n/LocaleContext';
import useServerVersion from '../../hooks/useServerVersion';
import useChangelog from '../../hooks/useChangelog';
import { useSession } from '../../session/SessionContext';
import { navLabelKey, navEntryFor, visibleItems } from './nav-sections';
import useInboxCount from '../../hooks/useInboxCount';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import Footer from './Footer';

// v1.26.46：頁面標題改成直接問導覽列（navLabelKey）。
// 這裡原本自己維護一份 path → i18n key 的對照表，註解還寫著「新頁面要在 NAV_SECTIONS
// 加路由、也要在這裡加標題對應」— 那就是第二個要記得改的地方，而且忘了改不會壞、
// 只會靜靜地把標題顯示成「OwnMind 控制中心」。同一個功能的名字只留一個來源。
//
// v1.32.0：標題是入口的名字（待你處理），副標題是分頁的名字（交接）；分頁列畫在內容
// 上方，只列這個身分看得到的分頁。960px 以下左邊的入口列收成選單，從上方列的按鈕打開。

// 頁面包裝 — sidebar + topbar + 內容 + footer
// 由 App.jsx 包進路由內、所有頁面共用
//
// 身分（角色、姓名）跟版號都由這裡自己去拿，不從 App 往下傳。理由同 v1.26.43：
// Layout 只在登入後才渲染，所以請求一定帶著 key；App 在登入前就掛好而且不會
// unmount，在那裡發請求會 401 一次然後永遠不重試。
// locale 由 LocaleProvider 提供、同樣不需 props。
//
// v1.26.126: the changelog joins them, for the same reason. It arrived as a prop
// from App, where it was the literal `[]` -- so the footer's changelog button
// opened an empty modal from v1.20.0 until now.
export default function Layout({ children }) {
  const t = useT();
  const { pathname } = useLocation();
  const version = useServerVersion();
  const changelog = useChangelog();
  const { role, name, error, ready, logout } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  // v1.32.3 — 待你處理 的數字：左欄的入口旁一個總數，分頁列上每個分頁各一個。
  const inbox = useInboxCount();
  const badges = { inbox: inbox.total };

  // 換頁就把小螢幕的選單收起來，不然點了入口選單還蓋在新頁面上。
  useEffect(() => { setMenuOpen(false); }, [pathname]);

  const entry = navEntryFor(pathname);
  const tabs = entry ? visibleItems(entry, role) : [];
  const hasTabs = Boolean(entry && entry.tabs.length > 0);
  const pageTitle = entry ? t(entry.labelKey) : t('header.title');
  const tabKey = hasTabs ? navLabelKey(pathname) : null;
  const pageSubtitle = tabKey ? t(tabKey) : undefined;

  // 身分還沒回來時不要先畫殼。role 這時是 null，側邊欄的入口會全部過濾掉，
  // 頭像顯示「?」跟「訪客」、角色徽章還會先顯示一般使用者才跳成正確的。等一個
  // 往返再畫，比先畫錯的再改好。
  if (!ready) {
    return <div className="h-screen bg-linen-100" aria-busy="true" />;
  }

  return (
    <div className="flex h-screen bg-linen-100">
      <div className="hidden min-[960px]:block">
        <Sidebar role={role} version={version} badges={badges} />
      </div>
      {menuOpen && (
        <div className="fixed inset-0 z-40 flex min-[960px]:hidden">
          <Sidebar role={role} version={version} badges={badges} onNavigate={() => setMenuOpen(false)} onClose={() => setMenuOpen(false)} />
          <button
            type="button"
            aria-label={t('nav.menu_close')}
            onClick={() => setMenuOpen(false)}
            className="flex-1 bg-slate-900/40"
          />
        </div>
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          pageTitle={pageTitle}
          pageSubtitle={pageSubtitle}
          currentRole={role}
          userName={name}
          onLogout={logout}
          onOpenMenu={() => setMenuOpen(true)}
        />
        {hasTabs && tabs.length > 1 && (
          <nav aria-label={pageTitle} className="bg-white border-b border-slate-200 px-4 sm:px-6 overflow-x-auto">
            <ul className="flex gap-1 -mb-px">
              {tabs.map((tab) => (
                <li key={tab.path}>
                  <NavLink
                    to={tab.path}
                    end
                    className={({ isActive }) =>
                      'inline-block px-3 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap '
                      + 'focus-visible:outline-2 focus-visible:outline-sage-500 '
                      + (isActive
                        ? 'border-sage-500 text-sage-700'
                        : 'border-transparent text-slate-500 hover:text-slate-900 hover:border-slate-300')}
                  >
                    {t(tab.labelKey)}
                    {entry.id === 'inbox' && typeof inbox.byTab[tab.id] === 'number' && inbox.byTab[tab.id] > 0 && (
                      <span className="ml-1.5 inline-grid place-items-center min-w-[18px] h-[18px] px-1 rounded-full bg-slate-100 text-slate-600 text-[11px] font-bold tabular-nums">
                        {inbox.byTab[tab.id]}
                      </span>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
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
