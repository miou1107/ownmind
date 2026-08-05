import { useState } from 'react';
import { useSession } from '../session/SessionContext';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import { useT } from '../i18n/LocaleContext';
import { apiPost, setApiKey, setMustChangePassword, getApiKey } from '../api';
import { decideLoginOutcome } from './login-outcome';

// 登入頁 — 不包 Layout、不需 sidebar / topbar
// 流程：email + password → POST /api/me/login → 拿到 api_key 存 localStorage
//      → must_change_password=true 導 /preference/security、否則導原本想去的頁面（或 /portal/usage）
//
// v1.26.59 多一條路：伺服器回 requiresSetup 代表這個帳號沒有密碼，而且現在正在救援
// 視窗內（伺服器有設 SETUP_TOKEN）。這是 scripts/reset-admin-password.js 跑完之後
// 留下的狀態，本來只有舊後台的表單能收尾，而舊後台這一版退場了。

export default function LoginPage() {
  const t = useT();
  const navigate = useNavigate();
  const location = useLocation();
  const { prime } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState('login');
  const [setupToken, setSetupToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newPassword2, setNewPassword2] = useState('');

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
    // Cleared here too: the "password set, sign in now" notice must not sit above a
    // failed second attempt still telling the user everything went well.
    setNotice('');
    const r = await apiPost('/api/me/login', { email, password });
    setBusy(false);

    // Three outcomes, not two — see login-outcome.js for why the order matters.
    const outcome = decideLoginOutcome(r);
    if (outcome.kind === 'error') {
      setError(outcome.error || t('login.error_generic'));
      return;
    }
    if (outcome.kind === 'setup') {
      setMode('setup');
      return;
    }
    // v1.26.63: the password was right, but it is the temporary one the admin relayed and
    // the server issued no key. The email and that password stay in state so the next
    // form does not ask for them again.
    if (outcome.kind === 'first_password') {
      setMode('first-password');
      setNewPassword('');
      setNewPassword2('');
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

  async function handleSetup(e) {
    e.preventDefault();
    if (busy) return;
    if (newPassword !== newPassword2) {
      setError(t('security.error_mismatch'));
      return;
    }
    if (newPassword.length < 8) {
      setError(t('security.error_too_short'));
      return;
    }
    setBusy(true);
    setError('');
    // The same endpoint the legacy console's setup form called. It re-checks the token
    // and the role server-side, so this form is a convenience, not the gate.
    const r = await apiPost('/api/admin/setup', {
      email, setup_token: setupToken, password: newPassword,
    });
    setBusy(false);
    if (!r.ok) {
      setError(r.error || t('login.error_generic'));
      return;
    }
    // Deliberately not signed in from here. The password is now set, so the ordinary
    // login path applies and the operator proves they know what they just typed.
    setMode('login');
    setPassword('');
    setSetupToken('');
    setNewPassword('');
    setNewPassword2('');
    setError('');
    setNotice(t('login.setup_done'));
  }

  // v1.26.63 — the first-login step. Sends the temporary password back with the new one;
  // the server verifies it again and only then issues the api_key, so nothing in this
  // browser holds a credential until the password has actually been replaced.
  async function handleFirstPassword(e) {
    e.preventDefault();
    if (busy) return;
    if (newPassword !== newPassword2) {
      setError(t('security.error_mismatch'));
      return;
    }
    if (newPassword.length < 8) {
      setError(t('security.error_too_short'));
      return;
    }
    setBusy(true);
    setError('');
    const r = await apiPost('/api/me/first-password', {
      email, current_password: password, new_password: newPassword,
    });
    setBusy(false);
    if (!r.ok || !r.data?.api_key) {
      setError(r.error || t('login.error_generic'));
      return;
    }
    setApiKey(r.data.api_key);
    prime(r.data);
    // No flag to write and no detour to /preference/security: the password was just set.
    setMustChangePassword(false);
    navigate(location.state?.from?.pathname || '/portal/usage', { replace: true });
  }

  if (mode === 'first-password') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-linen-100 px-4">
        <form
          name="first-password"
          onSubmit={handleFirstPassword}
          className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm w-full max-w-md"
        >
          <h1 className="text-2xl font-bold text-sage-700">{t('login.first_password_title')}</h1>
          <p className="text-slate-500 mt-2 text-sm">{t('login.first_password_subtitle', { email })}</p>

          <label className="block mt-6">
            <span className="block text-sm font-medium text-slate-700">
              {t('security.new_label')}
            </span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              disabled={busy}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
            />
            <span className="mt-1 block text-xs text-slate-500">{t('login.first_password_hint')}</span>
          </label>

          <label className="block mt-4">
            <span className="block text-sm font-medium text-slate-700">
              {t('security.new_confirm_label')}
            </span>
            <input
              type="password"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
              autoComplete="new-password"
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
            disabled={busy || !newPassword || !newPassword2}
            className="mt-6 w-full rounded-lg bg-sage-600 px-4 py-2 text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? t('security.submitting') : t('login.first_password_submit')}
          </button>

          <button
            type="button"
            onClick={() => {
              setMode('login');
              setPassword('');
              setNewPassword('');
              setNewPassword2('');
              setError('');
            }}
            className="mt-3 w-full rounded-lg px-4 py-2 text-sm text-slate-500 hover:bg-slate-50"
          >
            {t('login.first_password_back')}
          </button>
        </form>
      </div>
    );
  }

  if (mode === 'setup') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-linen-100 px-4">
        <form
          name="setup"
          onSubmit={handleSetup}
          className="bg-white border border-slate-200 rounded-2xl p-8 shadow-sm w-full max-w-md"
        >
          <h1 className="text-2xl font-bold text-sage-700">{t('login.setup_title')}</h1>
          <p className="text-slate-500 mt-2 text-sm">{t('login.setup_subtitle', { email })}</p>

          <label className="block mt-6">
            <span className="block text-sm font-medium text-slate-700">
              {t('login.setup_token_label')}
            </span>
            <input
              type="text"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
              autoComplete="off"
              required
              disabled={busy}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
            />
            <span className="mt-1 block text-xs text-slate-500">{t('login.setup_token_hint')}</span>
          </label>

          <label className="block mt-4">
            <span className="block text-sm font-medium text-slate-700">
              {t('security.new_label')}
            </span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
              disabled={busy}
              className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
            />
            <span className="mt-1 block text-xs text-slate-500">{t('security.hint_min_length')}</span>
          </label>

          <label className="block mt-4">
            <span className="block text-sm font-medium text-slate-700">
              {t('security.new_confirm_label')}
            </span>
            <input
              type="password"
              value={newPassword2}
              onChange={(e) => setNewPassword2(e.target.value)}
              autoComplete="new-password"
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
            disabled={busy || !setupToken || !newPassword || !newPassword2}
            className="mt-6 w-full rounded-lg bg-sage-600 px-4 py-2 text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
          >
            {busy ? t('security.submitting') : t('login.setup_submit')}
          </button>

          <button
            type="button"
            onClick={() => { setMode('login'); setError(''); }}
            className="mt-3 w-full rounded-lg px-4 py-2 text-sm text-slate-500 hover:bg-slate-50"
          >
            {t('vault.cancel')}
          </button>
        </form>
      </div>
    );
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

        {notice ? (
          <div
            role="status"
            className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          >
            {notice}
          </div>
        ) : null}

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
