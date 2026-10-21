import { useEffect, useState } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPost } from '../../api';
import { Modal } from '../../components/common';
import { fmtDate } from '../../utils/fmtDate';
import { archivedRows } from './memory-archived-vm.js';
import { postMemoryWrite } from '../../lib/memory-write.js';

// v1.33.0 — the archived memories tab: the project memories the AI archived while
// keeping the store.
//
// One list (GET /api/memory/archived, newest archive first), each row with the reason the
// AI gave and one undo, the restore button (POST /api/memory/:id/restore), which puts the
// memory back in use and drops the row from the list. Clicking a row opens it in full,
// the same way the rules page does.
export default function MemoryArchivedPage() {
  const t = useT();
  const { locale } = useLocale();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [rowError, setRowError] = useState({});
  const [toast, setToast] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let current = true;
    (async () => {
      const r = await apiGet('/api/memory/archived');
      if (!current) return;
      setLoading(false);
      if (!r.ok) { setLoadError(r.error || 'load_failed'); return; }
      setRows(archivedRows(r.data));
    })();
    return () => { current = false; };
  }, []);

  async function restore(id) {
    if (busyId) return;
    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    // The write needs a sync_token: postMemoryWrite fetches one and retries once on 409.
    const r = await postMemoryWrite(apiPost, apiGet, `/api/memory/${id}/restore`, {});
    setBusyId(null);
    if (!r.ok) {
      setRowError((prev) => ({ ...prev, [id]: r.status === 404 ? t('memory.archived.gone') : t('memory.archived.restore_error') }));
      return;
    }
    setRows((prev) => prev.filter((m) => m.id !== id));
    setToast(t('memory.archived.restored'));
  }

  return (
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-slate-500">{t('memory.archived.intro')}</p>
      {toast ? (
        <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {toast}
        </div>
      ) : null}
      {loading ? (
        <p className="text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-slate-500">{t('memory.archived.empty')}</p>
      ) : (
        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm">
          <ul className="divide-y divide-slate-100">
            {rows.map((m) => (
              <li key={m.id} className="px-4 py-3 flex flex-wrap items-start gap-2">
                <button
                  type="button"
                  onClick={() => setSelected(m)}
                  className="flex-1 min-w-[200px] text-left hover:bg-slate-50 rounded focus-visible:outline-2 focus-visible:outline-sage-500"
                >
                  <span className="block text-sm text-slate-900 break-words">{m.title}</span>
                  <span className="block mt-0.5 text-xs text-slate-500">
                    {m.project ? `${m.project} · ` : ''}
                    {fmtDate(m.archivedAt, locale)}
                    {m.reason ? ` · ${t('memory.archived.reason', { reason: m.reason })}` : ''}
                  </span>
                </button>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={() => restore(m.id)}
                    disabled={busyId === m.id}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 transition-colors"
                  >
                    {busyId === m.id ? t('memory.archived.restoring') : t('memory.archived.restore')}
                  </button>
                  {rowError[m.id] ? (
                    <span role="alert" className="text-xs text-rose-700">{rowError[m.id]}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="text-xs text-slate-400">{t('memory.archived.hint')}</p>

      <Modal
        isOpen={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title || ''}
        size="lg"
      >
        {selected && (
          <div className="space-y-3">
            {selected.reason && (
              <p className="text-xs text-slate-500">{t('memory.archived.reason', { reason: selected.reason })}</p>
            )}
            <pre className="whitespace-pre-wrap break-words text-sm text-slate-800 font-sans">{selected.content}</pre>
          </div>
        )}
      </Modal>
    </div>
  );
}
