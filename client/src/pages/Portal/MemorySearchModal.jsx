// Ports the legacy console's memory-search modal (src/public/index.html:1491-1526).
//
// Every friction and suggestion row is clickable there, and clicking searches
// memories for that row's text. Stage 5 found the handler lives inside `loadReport`
// and nowhere else, so it belongs to this page. Without it the two lists become dead
// text where they are clickable today.

import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { fmtDate } from '../../utils/fmtDate';

/** The legacy console searched on the first 30 characters, not the whole line. */
export const SEARCH_PREFIX_LENGTH = 30;

/** Same cap the legacy modal rendered. */
const MAX_RESULTS = 10;

export default function MemorySearchModal({ text, kind, onClose }) {
  const t = useT();
  const { locale } = useLocale();

  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      const q = String(text || '').slice(0, SEARCH_PREFIX_LENGTH);
      const r = await apiGet(`/api/memory/search?q=${encodeURIComponent(q)}`);
      if (!current) return;
      setLoading(false);
      if (!r.ok) { setLoadError(r.error || 'load_failed'); setRows(null); return; }
      setRows(Array.isArray(r.data) ? r.data : []);
    })();
    return () => { current = false; };
  }, [text]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t(`periodic.search.title_${kind}`)}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-bold text-slate-900">
              {t(`periodic.search.title_${kind}`)}
            </h2>
            <p className="mt-0.5 break-all text-xs text-slate-500">
              {t('periodic.search.query', { q: String(text || '').slice(0, SEARCH_PREFIX_LENGTH) })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-slate-500">{t('common.loading')}</p>
        ) : loadError ? (
          <p role="alert" className="text-sm text-rose-700">
            {loadError === 'load_failed' ? t('common.error_load') : loadError}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">{t('periodic.search.empty')}</p>
        ) : (
          <ul className="space-y-2">
            {rows.slice(0, MAX_RESULTS).map((m) => (
              <li key={m.id} className="rounded-lg border border-slate-200 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">
                    {m.type}
                  </span>
                  <span className="text-sm font-semibold text-slate-800 break-all">{m.title}</span>
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  {m.created_at ? fmtDate(m.created_at, locale) : '-'}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
