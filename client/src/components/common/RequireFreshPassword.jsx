import { Navigate, useLocation } from 'react-router-dom';
import { getMustChangePassword } from '../../api';

// 強制改密碼守門員 — 配合「提醒無效、邏輯才有效、用程式卡控」原則
//
// 場景：user 用預設密碼第一次登入（後端 must_change_password=true）
// 必須先改密碼才能用其他功能、避免 user 直接打 URL 繞過登入頁的強制 redirect
//
// 例外：/preference/security 本身（避免無限循環）
// 用法：把 RequireFreshPassword 套在 RequireAuth 之內、Layout 之外

export default function RequireFreshPassword({ children }) {
  const location = useLocation();
  if (getMustChangePassword() && location.pathname !== '/preference/security') {
    return <Navigate to="/preference/security" replace />;
  }
  return children;
}
