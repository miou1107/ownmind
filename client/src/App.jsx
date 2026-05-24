import { Routes, Route, Navigate } from 'react-router-dom';
import { useState } from 'react';
import { t } from './i18n';

// 階段 1 空殼：路由 + 角色守衛骨架、各頁面元件在階段 3 拆解後填入
function PlaceholderPage({ titleKey }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold text-sage-700">{t(titleKey)}</h1>
      <p className="text-slate-500 mt-2">{t('placeholder.coming_soon')}</p>
    </div>
  );
}

export default function App() {
  // 角色模擬器 — super_admin 可預覽其他角色視角
  const [currentRole] = useState('super_admin');

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/portal/usage" replace />} />

      {/* 個人版塊（全角色可見） */}
      <Route path="/portal/usage" element={<PlaceholderPage titleKey="nav.usage" />} />
      <Route path="/portal/project-history" element={<PlaceholderPage titleKey="nav.project_history" />} />
      <Route path="/portal/handoffs" element={<PlaceholderPage titleKey="nav.handoffs" />} />
      <Route path="/portal/reports" element={<PlaceholderPage titleKey="nav.reports" />} />

      <Route path="/preference/profile" element={<PlaceholderPage titleKey="nav.profile" />} />
      <Route path="/preference/security" element={<PlaceholderPage titleKey="nav.security" />} />
      <Route path="/preference/vault" element={<PlaceholderPage titleKey="nav.vault" />} />

      {/* 管理員專區 — 階段 3 加角色守衛 */}
      <Route path="/admin/team" element={<PlaceholderPage titleKey="nav.team" />} />
      <Route path="/admin/bugs" element={<PlaceholderPage titleKey="nav.bugs" />} />

      {/* 超級管理員專區 — 階段 3 加角色守衛 */}
      <Route path="/super/config" element={<PlaceholderPage titleKey="nav.config" />} />
      <Route path="/super/broadcast" element={<PlaceholderPage titleKey="nav.broadcast" />} />
      <Route path="/super/audit" element={<PlaceholderPage titleKey="nav.audit" />} />

      <Route path="*" element={<PlaceholderPage titleKey="error.not_found" />} />
    </Routes>
  );
}
