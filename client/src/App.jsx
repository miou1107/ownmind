import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useT } from './i18n/LocaleContext';
import { AUTH_EXPIRED } from './api/events';
import { Layout, RequireAuth, RequireFreshPassword, RequireRole } from './components/common';
import LoginPage from './pages/LoginPage';
import SecurityPage from './pages/Preference/SecurityPage';
import ProfilePage from './pages/Preference/ProfilePage';
import VaultPage from './pages/Preference/VaultPage';
import UsagePage from './pages/Portal/UsagePage';
import ProjectHistoryPage from './pages/Portal/ProjectHistoryPage';
import HandoffsPage from './pages/Portal/HandoffsPage';
import ReportsPage from './pages/Portal/ReportsPage';

// 尚未實作的頁面 — 依整併計畫在階段 2 到 7 逐一換成真頁面
function PlaceholderPage({ titleKey }) {
  const t = useT();
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center shadow-sm">
      <h1 className="text-2xl font-bold text-sage-700">{t(titleKey)}</h1>
      <p className="text-slate-500 mt-2">{t('placeholder.coming_soon')}</p>
    </div>
  );
}

export default function App() {
  const navigate = useNavigate();

  // 監聽 client.js 在 401 時 dispatch 的 auth-expired event、自動導 /login
  // 保留 SPA 體驗（不 hard reload）、router state reset 由 navigate 處理
  //
  // SessionContext 的 logout() 也 dispatch 同一個 event，所以「登出」跟
  // 「token 失效」走同一條路徑，只有一個地方決定怎麼回到 /login
  useEffect(() => {
    function onAuthExpired() {
      navigate('/login', { replace: true });
    }
    window.addEventListener(AUTH_EXPIRED, onAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED, onAuthExpired);
  }, [navigate]);

  // Layout 自己從 SessionContext 讀身分、從 server 讀版號，所以這裡不再往下傳
  // role / profile / onLogout / onOpenProfile。那四個原本是寫死的佔位值：角色寫死
  // super_admin、姓名寫死 'User'、登出只 console.log、onOpenProfile 沒有實作。
  // 寫死的角色會讓每一個登入者都看到「管理」跟「超級管理」區塊。
  //
  // changelog 刻意留空：Footer 三語系都有 changelog.empty 空狀態，真正的更新
  // 紀錄來源是獨立的一件事。
  const layoutProps = { changelog: [] };

  // 一般頁面兩層守門員：
  //   RequireAuth — 沒登入直接導 /login
  //   RequireFreshPassword — 登入了但 must_change_password=true 強制導
  //     /preference/security（該頁本身會被放行、避免無限循環）
  const renderPage = (page) => (
    <RequireAuth>
      <RequireFreshPassword>
        <Layout {...layoutProps}>{page}</Layout>
      </RequireFreshPassword>
    </RequireAuth>
  );

  // 管理與超級管理頁面多包一層 RequireRole。側邊欄本來就按角色過濾，但那只擋住
  // 「看得到入口」，擋不住直接打網址進來。伺服器端每支 API 仍各自把關，這裡是
  // 讓後台不要提供伺服器本來就會拒絕的東西。
  const renderAdmin = (page) => (
    <RequireAuth>
      <RequireFreshPassword>
        <RequireRole min="admin">
          <Layout {...layoutProps}>{page}</Layout>
        </RequireRole>
      </RequireFreshPassword>
    </RequireAuth>
  );

  const renderSuper = (page) => (
    <RequireAuth>
      <RequireFreshPassword>
        <RequireRole min="super_admin">
          <Layout {...layoutProps}>{page}</Layout>
        </RequireRole>
      </RequireFreshPassword>
    </RequireAuth>
  );

  return (
    <Routes>
      {/* /login 不包 Layout、不包 RequireAuth — 唯一公開路由 */}
      <Route path="/login" element={<LoginPage />} />

      <Route path="/" element={<Navigate to="/portal/usage" replace />} />

      <Route path="/portal/usage" element={renderPage(<UsagePage />)} />
      <Route path="/portal/project-history" element={renderPage(<ProjectHistoryPage />)} />
      <Route path="/portal/handoffs" element={renderPage(<HandoffsPage />)} />
      <Route path="/portal/reports" element={renderPage(<ReportsPage />)} />

      <Route path="/preference/profile" element={renderPage(<ProfilePage />)} />
      <Route path="/preference/security" element={renderPage(<SecurityPage />)} />
      <Route path="/preference/vault" element={renderPage(<VaultPage />)} />

      <Route path="/admin/team" element={renderAdmin(<PlaceholderPage titleKey="nav.team" />)} />
      <Route path="/admin/bugs" element={renderAdmin(<PlaceholderPage titleKey="nav.bugs" />)} />

      <Route path="/super/config" element={renderSuper(<PlaceholderPage titleKey="nav.config" />)} />
      <Route path="/super/broadcast" element={renderSuper(<PlaceholderPage titleKey="nav.broadcast" />)} />
      <Route path="/super/audit" element={renderSuper(<PlaceholderPage titleKey="nav.audit" />)} />

      <Route path="*" element={renderPage(<PlaceholderPage titleKey="error.not_found" />)} />
    </Routes>
  );
}
