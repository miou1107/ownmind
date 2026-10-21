import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPut } from '../../api';
import { notifyInboxChanged } from '../../hooks/useInboxCount';
import { fmtDate } from '../../utils/fmtDate';
import { HANDOFFS_PATH, handoffGroups, reopenedHandoff } from './handoffs-vm.js';

// 工作交接頁 — what other AI tools left for this person.
//
// v1.33.0: nobody presses 接手. The AI accepts a handoff when a conversation opens in the
// same project, so a pending row only says so. A row accepted in the last week shows who
// took it and one undo, 重開, which puts it back to pending (PUT /:id/reopen).

function HandoffRow({ h, t, locale, children }) {
  return (
    <li className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium text-slate-900 break-all">
            {h.project || `#${h.id}`}
          </h2>
          {/* v1.30.4: the label is dropped rather than left dangling. from_tool stopped
              being server-required, so a row with all three source fields empty is now
              reachable and rendered as "來源：· 2026/08/15" — a label with nothing after
              it. Omitting the whole prefix reads correctly in all three languages and
              needs no new string. */}
          <p className="mt-1 text-xs text-slate-500">
            {(() => {
              const from = [h.from_tool, h.from_model, h.from_machine].filter(Boolean).join(' / ');
              return from ? `${t('handoffs.from_label')}：${from} · ` : '';
            })()}
            {fmtDate(h.created_at, locale)}
          </p>
        </div>
        {children}
      </div>
      {h.content ? (
        <pre className="mt-3 text-sm text-slate-700 whitespace-pre-wrap break-words bg-slate-50 rounded p-3">
          {h.content}
        </pre>
      ) : null}
    </li>
  );
}

export default function HandoffsPage() {
  const t = useT();
  const { locale } = useLocale();

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // busyId locks the row whose request is in flight, so a double click cannot reopen twice.
  const [busyId, setBusyId] = useState(null);
  const [rowError, setRowError] = useState({});
  const [toast, setToast] = useState('');

  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet(HANDOFFS_PATH);
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

  async function handleReopen(id) {
    if (busyId) return;
    setBusyId(id);
    setRowError((prev) => ({ ...prev, [id]: '' }));
    const r = await apiPut(`/api/handoff/${id}/reopen`, {});
    setBusyId(null);
    if (!r.ok) {
      setRowError((prev) => ({ ...prev, [id]: t('handoffs.reopen_error') }));
      return;
    }
    setItems((prev) => prev.map((h) => (h.id === id ? reopenedHandoff(h) : h)));
    notifyInboxChanged();
    setToast(t('handoffs.reopened'));
  }

  const { pending, accepted } = handoffGroups(items);

  const rowErrorBox = (id) => (rowError[id] ? (
    <div role="alert" className="mt-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
      {rowError[id]}
    </div>
  ) : null);

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

      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div
          role="alert"
          className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : pending.length === 0 && accepted.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('handoffs.empty')}</p>
      ) : (
        <>
          {pending.length > 0 ? (
            <ul className="mt-6 space-y-3">
              {pending.map((h) => (
                <HandoffRow key={h.id} h={h} t={t} locale={locale}>
                  <p className="shrink-0 max-w-[12rem] text-right text-xs text-slate-500">{t('handoffs.auto_accept')}</p>
                </HandoffRow>
              ))}
            </ul>
          ) : null}
          {accepted.length > 0 ? (
            <section className="mt-6">
              <h2 className="text-sm font-medium text-slate-600 mb-2">{t('handoffs.accepted_section')} · {accepted.length}</h2>
              <ul className="space-y-3">
                {accepted.map((h) => (
                  <HandoffRow key={h.id} h={h} t={t} locale={locale}>
                    <div className="flex shrink-0 flex-col items-end gap-2">
                      <p className="text-xs text-slate-500">
                        {t('handoffs.taken_by', { name: h.accepted_by || t('handoffs.taken_by_ai') })} · {fmtDate(h.accepted_at, locale)}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleReopen(h.id)}
                        disabled={busyId === h.id}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 transition-colors"
                      >
                        {busyId === h.id ? t('handoffs.reopening') : t('handoffs.reopen')}
                      </button>
                      {rowErrorBox(h.id)}
                    </div>
                  </HandoffRow>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
