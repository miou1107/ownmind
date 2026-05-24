import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useT } from '../../i18n/LocaleContext';
import { apiPost, clearMustChangePassword, getMustChangePassword } from '../../api';

// 帳密修改頁 — 3 欄表單（舊密 / 新密 / 確認）
// 前端先驗（長度 8、新舊不同、確認一致、trim 後不能空）、後端 POST /api/me/change-password
// 成功後 clearMustChangePassword 讓 RequireFreshPassword 守門員放行、user 可進其他頁

export default function SecurityPage() {
  const t = useT();
  const navigate = useNavigate();
  const mustChange = getMustChangePassword();

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [nextConfirm, setNextConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  // setTimeout cleanup：unmount 時 clear、避免 user 提早離開後 timer 仍 fire 強制 navigate
  const navTimerRef = useRef(null);
  useEffect(() => () => {
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
  }, []);

  function frontendValidate() {
    // length 用 trim 比、避免 8 個 space 通過
    if (next.trim().length < 8) return t('security.error_too_short');
    if (next === current) return t('security.error_same_as_old');
    if (next !== nextConfirm) return t('security.error_mismatch');
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setToast('');
    const localErr = frontendValidate();
    if (localErr) {
      setError(localErr);
      return;
    }
    setBusy(true);
    const r = await apiPost('/api/me/change-password', {
      current_password: current,
      new_password: next,
    });
    setBusy(false);
    if (!r.ok) {
      // 失敗：保留 current 讓 user 不用重打、但清掉新密欄位（避免明文卡 state）
      setNext('');
      setNextConfirm('');
      setError(r.error || t('security.error_generic'));
      return;
    }
    // 成功：清 must_change_password flag、清表單、顯示 toast
    clearMustChangePassword();
    setCurrent('');
    setNext('');
    setNextConfirm('');
    setToast(t('security.success_toast'));
    // 如果剛剛是被 RequireFreshPassword 從別頁強制導過來、改完密就導去用量頁
    // 用 setTimeout 讓 user 看到 toast 1.5 秒再跳；ref 存 id 讓 unmount 可 cleanup
    if (mustChange) {
      navTimerRef.current = setTimeout(
        () => navigate('/portal/usage', { replace: true }),
        1500,
      );
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('security.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('security.subtitle')}</p>

      {mustChange ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {t('security.must_change_notice')}
        </div>
      ) : null}

      <form
        name="change-password"
        onSubmit={handleSubmit}
        className="mt-6 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4"
      >
        <label className="block">
          <span className="block text-sm font-medium text-slate-700">
            {t('security.current_label')}
          </span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder={t('security.placeholder_password')}
            autoComplete="current-password"
            required
            disabled={busy}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
          />
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-slate-700">
            {t('security.new_label')}
          </span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder={t('security.placeholder_password')}
            autoComplete="new-password"
            minLength={8}
            required
            disabled={busy}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
          />
          <span className="block mt-1 text-xs text-slate-500">
            {t('security.hint_min_length')}
          </span>
        </label>

        <label className="block">
          <span className="block text-sm font-medium text-slate-700">
            {t('security.new_confirm_label')}
          </span>
          <input
            type="password"
            value={nextConfirm}
            onChange={(e) => setNextConfirm(e.target.value)}
            placeholder={t('security.placeholder_password')}
            autoComplete="new-password"
            required
            disabled={busy}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
          />
        </label>

        {error ? (
          <div
            role="alert"
            className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
          >
            {error}
          </div>
        ) : null}

        {toast ? (
          <div
            role="status"
            className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
          >
            {toast}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={busy || !current || !next || !nextConfirm}
          className="w-full rounded-lg bg-sage-600 px-4 py-2 text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? t('security.submitting') : t('security.submit')}
        </button>
      </form>
    </div>
  );
}
