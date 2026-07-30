import { useState } from 'react';
import { useSession } from '../session/SessionContext';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useT } from '../i18n/LocaleContext';
import { apiPost, setApiKey, setMustChangePassword, getApiKey } from '../api';

// 登入頁 — 不包 Layout、不需 sidebar / topbar
// 流程：email + password → POST /api/me/login → 拿到 api_key 存 localStorage
//      → must_change_password=true 導 /preference/security、否則導原本想去的頁面（或 /portal/usage）

export default function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { prime } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // 已登入訪問 /login → 直接導去原本想去的地方、避免重複登入
  // 防 self-loop：若 from path 本身就是 /login（理論上不會、防禦性編程），導 /portal/usage
  if (getApiKey()) {
    const from = location.state?.from?.pathname;
    const to = from && from !== '/login' ? from : '/portal/usage';
    return <Navigate to={to} replace />;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await apiPost('/api/me/login', { email, password });
    setBusy(false);
    if (!r.ok) {
      setError(r.error || t('login.error_generic'));
      return;
    }
    setApiKey(r.data.api_key);
    // 直接把登入回應裡的身分餵進 session。下面的 navigate 跟這裡是同一個同步區塊，
    // 所以 /api/me/profile 不可能已經回來；不餵的話目的頁會拿到一個「已解析但沒有
    // 角色」的 session，管理員從深連結登入會每次都被導去 /portal/usage。
    prime(r.data);
    // 同步存 must_change_password 旗標到 localStorage、讓 RequireFreshPassword 守門員可讀
    // 卡控邏輯：user 用 URL 直接打跳走時、守門員仍會強制把他導回 /preference/security
    setMustChangePassword(!!r.data.must_change_password);
    // 必須改預設密碼 → 強制導去帳密頁，user 改完密碼才能用其他功能
    const to = r.data.must_change_password
      ? '/preference/security'
      : (location.state?.from?.pathname || '/portal/usage');
    navigate(to, { replace: true });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-linen-100 px-4">
      <form
        name="login"
        onSubmit={handleSubmit}
        className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm w-full max-w-md"
      >
        <h1 className="text-2xl font-bold text-sage-700">{t('login.title')}</h1>
        <p className="text-slate-500 mt-2 text-sm">{t('login.subtitle')}</p>

        <label className="block mt-6">
          <span className="block text-sm font-medium text-slate-700">
            {t('login.email_label')}
          </span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('login.email_placeholder')}
            autoComplete="email"
            required
            disabled={busy}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
          />
        </label>

        <label className="block mt-4">
          <span className="block text-sm font-medium text-slate-700">
            {t('login.password_label')}
          </span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('login.password_placeholder')}
            autoComplete="current-password"
            required
            disabled={busy}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
          />
        </label>

        {error ? (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={busy || !email || !password}
          className="mt-6 w-full rounded-lg bg-sage-600 px-4 py-2 text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? t('login.submitting') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}
