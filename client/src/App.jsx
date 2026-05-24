import { Routes, Route, Navigate } from 'react-router-dom';
import { useState } from 'react';
import { useT } from './i18n/LocaleContext';
import { Layout } from './components/common';

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

  const layoutProps = {
    role: currentRole,
    onRoleChange: setCurrentRole,
    profile: { name: 'Vin' },
    version: 'v1.20.1-dev',
    changelog: MOCK_CHANGELOG,
    onLogout: () => console.log('logout'),
    onOpenProfile: () => console.log('open profile'),
  };

  const renderPlaceholder = (titleKey) => (
    <Layout {...layoutProps}>
      <PlaceholderPage titleKey={titleKey} />
    </Layout>
  );

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/portal/usage" replace />} />

      <Route path="/portal/usage" element={renderPlaceholder('nav.usage')} />
      <Route path="/portal/project-history" element={renderPlaceholder('nav.project_history')} />
      <Route path="/portal/handoffs" element={renderPlaceholder('nav.handoffs')} />
      <Route path="/portal/reports" element={renderPlaceholder('nav.reports')} />

      <Route path="/preference/profile" element={renderPlaceholder('nav.profile')} />
      <Route path="/preference/security" element={renderPlaceholder('nav.security')} />
      <Route path="/preference/vault" element={renderPlaceholder('nav.vault')} />

      <Route path="/admin/team" element={renderPlaceholder('nav.team')} />
      <Route path="/admin/bugs" element={renderPlaceholder('nav.bugs')} />

      <Route path="/super/config" element={renderPlaceholder('nav.config')} />
      <Route path="/super/broadcast" element={renderPlaceholder('nav.broadcast')} />
      <Route path="/super/audit" element={renderPlaceholder('nav.audit')} />

      <Route path="*" element={renderPlaceholder('error.not_found')} />
    </Routes>
  );
}
