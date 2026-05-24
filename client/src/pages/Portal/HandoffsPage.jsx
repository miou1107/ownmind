import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPut } from '../../api';
import { fmtDate } from '../../utils/fmtDate';

// 工作交接頁 — list 待處理交接、接手後從清單移除
// 接手時 PUT /:id/accept、accepted_by 用當前 user 的 name（從 /api/me/profile 拿）
// 若 profile 載入失敗、myName 拿不到 → 整頁顯示 banner、不允許接手（避免空字串污染 DB）

export default function HandoffsPage() {
  const t = useT();
  const { locale } = useLocale();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [myName, setMyName] = useState('');
  const [profileFailed, setProfileFailed] = useState(false);
  // acceptingId 鎖住「正在接手」的 row、避免重複 click
  const [acceptingId, setAcceptingId] = useState(null);
  const [rowError, setRowError] = useState({});
  const [toast, setToast] = useState('');

  useEffect(() => {
    let aborted = false;
    (async () => {
      // 並行載 user name + handoffs，省一次 round trip
      const [profileR, handoffsR] = await Promise.all([
        apiGet('/api/me/profile'),
        apiGet('/api/handoff/pending'),
      ]);
      if (aborted) return;
      setLoading(false);
      // profile 失敗或 name 為空 → 標記 profileFailed，整頁停用接手避免送 'unknown' 進 DB
      if (profileR.ok && profileR.data?.name) {
        setMyName(profileR.data.name);
      } else {
        setProfileFailed(true);
      }
      if (!handoffsR.ok) {
        setLoadError(handoffsR.error || 'load_failed');
        return;
      }
      setItems(Array.isArray(handoffsR.data) ? handoffsR.data : []);
    })();
    return () => { aborted = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleAccept(id) {
    if (acceptingId) return;
    // 防護：profile 失敗時直接擋 — 不能送空字串或 'unknown' 污染 DB（IR-122 邏輯卡控）
    if (!myName) {
      setRowError((prev) => ({ ...prev, [id]: t('handoffs.profile_failed') }));
      return;
    }
    setAcceptingId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    const r = await apiPut(`/api/handoff/${id}/accept`, { accepted_by: myName });
    setAcceptingId(null);
    if (!r.ok) {
      setRowError((prev) => ({ ...prev, [id]: r.error || t('handoffs.accept_error') }));
      return;
    }
    // 從 list 移除
    setItems((prev) => prev.filter((h) => h.id !== id));
    setToast(t('handoffs.accept_success'));
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('handoffs.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('handoffs.subtitle')}</p>

      {toast ? (
        <div
          role="status"
          className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
        >
          {toast}
        </div>
      ) : null}

      {profileFailed ? (
        <div
          role="alert"
          className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {t('handoffs.profile_failed')}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : items.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('handoffs.empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((h) => (
            <li
              key={h.id}
              className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-medium text-slate-900 break-all">
                    {h.project || `#${h.id}`}
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    {t('handoffs.from_label')}：
                    {[h.from_tool, h.from_model, h.from_machine].filter(Boolean).join(' / ')} ·{' '}
                    {fmtDate(h.created_at, locale)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleAccept(h.id)}
                  disabled={acceptingId === h.id || profileFailed}
                  className="shrink-0 rounded-lg bg-sage-600 px-4 py-1.5 text-sm text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                >
                  {acceptingId === h.id ? t('handoffs.accepting') : t('handoffs.accept')}
                </button>
              </div>
              {h.content ? (
                <pre className="mt-3 text-sm text-slate-700 whitespace-pre-wrap break-words bg-slate-50 rounded p-3">
                  {h.content}
                </pre>
              ) : null}
              {rowError[h.id] ? (
                <div
                  role="alert"
                  className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
                >
                  {rowError[h.id]}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
