import { Navigate, useLocation } from 'react-router-dom';
import { getApiKey } from '../../api';

// 路由守門員 — 沒 api_key 就導 /login、登入後再回原本路徑
// 用法：<Route path="/portal/usage" element={<RequireAuth><UsagePage /></RequireAuth>} />
//
// 設計：用 state.from 帶原 location 過去、LoginPage 成功後讀 state.from 導回
// 這樣 user 點 bookmark 進來 /portal/usage、被導去 /login、登入後直接回 /portal/usage
// 不會再被丟到首頁

export default function RequireAuth({ children }) {
  const location = useLocation();
  if (!getApiKey()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}
