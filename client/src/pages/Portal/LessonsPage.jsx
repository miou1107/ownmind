import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPut } from '../../api';
import { notifyInboxChanged } from '../../hooks/useInboxCount';
import { fmtDate } from '../../utils/fmtDate';

// 學到的 — the lessons each closed session left behind (v1.31.0).
// A lesson waits here until the person promotes it into a memory or dismisses it; the AI
// never promotes on its own. Same page shape as HandoffsPage: one list, one action per row,
// row-level errors, a toast on success.

export default function LessonsPage() {
  const t = useT();
  const { locale } = useLocale();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // busyId locks the row whose request is in flight, so a double click cannot promote twice.
  const [busyId, setBusyId] = useState(null);
  const [rowError, setRowError] = useState({});
  const [toast, setToast] = useState('');

  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet('/api/session/lessons?status=new');
      if (aborted) return;
      setLoading(false);
      if (!r.ok) {
        setLoadError(r.error || 'load_failed');
        return;
      }
      setItems(Array.isArray(r.data) ? r.data : []);
    })();
    return () => { aborted = true; };
  }, []);

  async function act(id, action) {
    if (busyId) return;
    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    const r = await apiPut(`/api/session/lessons/${id}/${action}`, {});
    setBusyId(null);
    if (!r.ok) {
      // The server's reason is a status, not a sentence for the person: map it here so
      // the page never shows a raw English error string.
      const key = r.status === 409 ? 'lessons.already_resolved'
        : r.status === 404 ? 'lessons.gone'
        : r.status === 400 && r.data?.rule ? 'lessons.secret_refused'
        : 'lessons.action_error';
      setRowError((prev) => ({ ...prev, [id]: t(key) }));
      return;
    }
    setItems((prev) => prev.filter((l) => l.id !== id));
    notifyInboxChanged();
    setToast(action === 'promote' ? t('lessons.promoted') : t('lessons.dismissed'));
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('lessons.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('lessons.subtitle')}</p>

      {toast ? (
        <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {toast}
        </div>
      ) : null}

      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : items.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('lessons.empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((l) => (
            <li key={l.id} className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-medium text-slate-900 break-words">{l.stuck}</h2>
                  <p className="mt-1 text-xs text-slate-500">
                    {l.project ? `${l.project} · ` : ''}
                    {fmtDate(l.created_at, locale)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => act(l.id, 'dismiss')}
                    disabled={busyId === l.id}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 transition-colors"
                  >
                    {t('lessons.dismiss')}
                  </button>
                  <button
                    type="button"
                    onClick={() => act(l.id, 'promote')}
                    disabled={busyId === l.id}
                    className="rounded-lg bg-sage-600 px-4 py-1.5 text-sm text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
                  >
                    {busyId === l.id ? t('lessons.working') : t('lessons.promote')}
                  </button>
                </div>
              </div>
              <dl className="mt-3 grid gap-2 text-sm text-slate-700 bg-slate-50 rounded p-3">
                {l.fix ? (
                  <div>
                    <dt className="text-xs text-slate-500">{t('lessons.fix_label')}</dt>
                    <dd className="whitespace-pre-wrap break-words">{l.fix}</dd>
                  </div>
                ) : null}
                {l.next_time ? (
                  <div>
                    <dt className="text-xs text-slate-500">{t('lessons.next_time_label')}</dt>
                    <dd className="whitespace-pre-wrap break-words">{l.next_time}</dd>
                  </div>
                ) : null}
                {!l.fix && !l.next_time ? (
                  <p className="text-xs text-slate-400">{t('lessons.only_stuck')}</p>
                ) : null}
              </dl>
              {rowError[l.id] ? (
                <div role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                  {rowError[l.id]}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
