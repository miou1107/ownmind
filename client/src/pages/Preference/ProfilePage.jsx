import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPut } from '../../api';

// 個人資料頁 — 顯示 email / role / created_at（read-only）+ name（可改）
// 載入：GET /api/me/profile
// 存檔：PUT /api/me/profile { name }（後端 v1.20.1 才補上、只允許改 name）

// role 白名單：防 server 回意外值（如 'guest'）讓 t() 把 key 本身 raw 顯示給 user
const KNOWN_ROLES = ['user', 'admin', 'super_admin'];

export default function ProfilePage() {
  const t = useT();
  const { locale } = useLocale();

  // 載入狀態
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // 表單狀態
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  // useEffect deps 故意空：profile 載入跟語系無關、不能依賴 t（useT 回的 callback
  // 在 locale 變時 identity 變、會引發無謂的 re-fetch）。失敗訊息走 hard-coded
  // fallback、由 error UI 渲染時的 t() 自然拿到當前語系。
  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet('/api/me/profile');
      if (aborted) return;
      setLoading(false);
      if (!r.ok) {
        // 存 raw error、render 時用 t() 對應翻譯 + 補後端訊息
        setLoadError(r.error || 'load_failed');
        return;
      }
      setProfile(r.data);
      setName(r.data.name || '');
    })();
    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function frontendValidate() {
    const trimmed = name.trim();
    if (trimmed.length === 0) return t('profile.error_name_required');
    if (trimmed.length > 100) return t('profile.error_name_too_long');
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
    const r = await apiPut('/api/me/profile', { name: name.trim() });
    setBusy(false);
    if (!r.ok) {
      setError(r.error || t('profile.error_save'));
      return;
    }
    setProfile(r.data);
    setName(r.data.name);
    setToast(t('profile.success_toast'));
  }

  if (loading) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-sage-700">{t('profile.title')}</h1>
        <p className="text-slate-500 mt-4">{t('profile.loading')}</p>
      </div>
    );
  }

  if (loadError) {
    // load_failed 是內部 token、其他值是後端真實 error 訊息
    const msg = loadError === 'load_failed' ? t('profile.error_load') : loadError;
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-sage-700">{t('profile.title')}</h1>
        <div
          role="alert"
          className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {msg}
        </div>
      </div>
    );
  }

  // 角色翻譯走共用 header.role.* namespace（v1.20.0 sidebar 也用同一組、避免重複）
  // 白名單外的值（'guest' 之類）直接顯示原值、防 t() 把 key 本身當文字回傳
  const roleLabel = profile?.role && KNOWN_ROLES.includes(profile.role)
    ? t(`header.role.${profile.role}`)
    : (profile?.role || '-');

  // 把 ISO timestamp 轉成 user 看得懂的格式、用 LocaleContext 的 locale 不被瀏覽器 default 干擾
  // 也順便防 invalid timestamp 炸 'Invalid Date' 字串給 user
  const createdAtLabel = (() => {
    if (!profile?.created_at) return '-';
    const d = new Date(profile.created_at);
    if (isNaN(d.getTime())) return '-';
    const bcp47 = locale === 'zh' ? 'zh-TW' : (locale === 'ja' ? 'ja-JP' : 'en-US');
    return d.toLocaleString(bcp47);
  })();

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('profile.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('profile.subtitle')}</p>

      <form
        name="profile"
        onSubmit={handleSubmit}
        className="mt-6 bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4"
      >
        <label className="block">
          <span className="block text-sm font-medium text-slate-700">
            {t('profile.name_label')}
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('profile.name_placeholder')}
            maxLength={100}
            required
            disabled={busy}
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sage-500 disabled:bg-slate-50"
          />
        </label>

        {/* read-only 欄位用 <dl><dt><dd>、screen reader 會把 dt 跟 dd 視為一組關聯 */}
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
          <div>
            <dt className="text-xs font-medium text-slate-500">
              {t('profile.email_label')}
            </dt>
            <dd className="mt-1 text-sm text-slate-700 break-all">
              {profile?.email || '-'}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500">
              {t('profile.role_label')}
            </dt>
            <dd className="mt-1 text-sm text-slate-700">
              {roleLabel}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-medium text-slate-500">
              {t('profile.created_at_label')}
            </dt>
            <dd className="mt-1 text-sm text-slate-700">
              {createdAtLabel}
            </dd>
          </div>
        </dl>

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
          disabled={busy || !name.trim() || name.trim() === (profile?.name || '')}
          className="w-full rounded-lg bg-sage-600 px-4 py-2 text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? t('profile.submitting') : t('profile.submit')}
        </button>
      </form>
    </div>
  );
}
