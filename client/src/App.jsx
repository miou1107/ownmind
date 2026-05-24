import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useT } from './i18n/LocaleContext';
import { Layout, RequireAuth, RequireFreshPassword } from './components/common';
import LoginPage from './pages/LoginPage';
import SecurityPage from './pages/Preference/SecurityPage';
import ProfilePage from './pages/Preference/ProfilePage';
import VaultPage from './pages/Preference/VaultPage';
import UsagePage from './pages/Portal/UsagePage';
import ProjectHistoryPage from './pages/Portal/ProjectHistoryPage';
import HandoffsPage from './pages/Portal/HandoffsPage';
import ReportsPage from './pages/Portal/ReportsPage';

// 階段 1 空殼 — 各頁面在階段 3（v1.20.1 步驟 3）拆出實作
function PlaceholderPage({ titleKey }) {
  const t = useT();
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-12 text-center shadow-sm">
      <h1 className="text-2xl font-bold text-sage-700">{t(titleKey)}</h1>
      <p className="text-slate-500 mt-2">{t('placeholder.coming_soon')}</p>
    </div>
  );
}

// 暫時 mock 的版本紀錄資料 — 後續會改從 API 載入
const MOCK_CHANGELOG = [
  {
    version: 'v1.20.1',
    date: '2026-05-24',
    title: 'Dashboard 個人版上線',
    description: 'Portal + Preference 共 7 頁與後端 API 對接',
  },
  {
    version: 'v1.20.0',
    date: '2026-05-24',
    title: '後台前端基礎建設',
    description: 'React 19 + Vite 8 + Tailwind v4、藍綠並存路由',
  },
];

export default function App() {
  // 角色狀態仍由 App 持有（locale 已抽到 LocaleProvider）
  // 未來會抽到 SessionProvider 統一管理使用者身分
  const [currentRole, setCurrentRole] = useState('super_admin');
  const navigate = useNavigate();

  // 監聽 client.js 在 401 時 dispatch 的 auth-expired event、自動導 /login
  // 保留 SPA 體驗（不 hard reload）、router state reset 由 navigate 處理
  useEffect(() => {
    function onAuthExpired() {
      navigate('/login', { replace: true });
    }
    window.addEventListener('ownmind:auth-expired', onAuthExpired);
    return () => window.removeEventListener('ownmind:auth-expired', onAuthExpired);
  }, [navigate]);

  const layoutProps = {
    role: currentRole,
    onRoleChange: setCurrentRole,
    profile: { name: 'Vin' },
    version: 'v1.20.1',
    changelog: MOCK_CHANGELOG,
    onLogout: () => console.log('logout'),
    onOpenProfile: () => console.log('open profile'),
  };

  // 所有實際頁面包兩層守門員：
  //   RequireAuth — 沒登入直接導 /login
  //   RequireFreshPassword — 登入了但 must_change_password=true 強制導 /preference/security
  //     （/preference/security 本身會被 RequireFreshPassword 放行、避免無限循環）
  const renderPlaceholder = (titleKey) => (
    <RequireAuth>
      <RequireFreshPassword>
        <Layout {...layoutProps}>
          <PlaceholderPage titleKey={titleKey} />
        </Layout>
      </RequireFreshPassword>
    </RequireAuth>
  );

  // 實際頁面 wrapper：跟 renderPlaceholder 同樣守門結構、但顯示真實 page
  const renderPage = (page) => (
    <RequireAuth>
      <RequireFreshPassword>
        <Layout {...layoutProps}>{page}</Layout>
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

      <Route path="/admin/team" element={renderPlaceholder('nav.team')} />
      <Route path="/admin/bugs" element={renderPlaceholder('nav.bugs')} />

      <Route path="/super/config" element={renderPlaceholder('nav.config')} />
      <Route path="/super/broadcast" element={renderPlaceholder('nav.broadcast')} />
      <Route path="/super/audit" element={renderPlaceholder('nav.audit')} />

      <Route path="*" element={renderPlaceholder('error.not_found')} />
    </Routes>
  );
}
