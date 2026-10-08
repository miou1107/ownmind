import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPut } from '../../api';
import { notifyInboxChanged } from '../../hooks/useInboxCount';
import { fmtDate } from '../../utils/fmtDate';

// Task cards (v1.31.3): the cards this person owns or holds. A `done` card is reviewed here,
// the only place a card can be closed; no MCP tool can. Same page shape as HandoffsPage.

const STATUS_KEY = {
  open: 'tasks.status.open',
  claimed: 'tasks.status.claimed',
  done: 'tasks.status.done',
  reviewed: 'tasks.status.reviewed',
  dropped: 'tasks.status.dropped',
};

export function TaskCard({ card, t, locale, busy, onReview, canReview }) {
  const holder = card.holder_name || null;
  return (
    <li className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium text-slate-900 break-words">#{card.id} {card.title}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {card.project} · {t(STATUS_KEY[card.status] || 'tasks.status.open')}
            {holder ? ` · ${t('tasks.held_by', { name: holder })}` : ''}
            {card.owner_name ? ` · ${t('tasks.owned_by', { name: card.owner_name })}` : ''}
            {' · '}{fmtDate(card.created_at, locale)}
          </p>
        </div>
        {card.status === 'done' && canReview ? (
          <button
            type="button"
            onClick={() => onReview(card.id)}
            disabled={busy === card.id}
            className="shrink-0 rounded-lg bg-sage-600 px-4 py-1.5 text-sm text-white font-medium hover:bg-sage-700 disabled:bg-slate-300 disabled:cursor-not-allowed transition-colors"
          >
            {busy === card.id ? t('tasks.working') : t('tasks.review')}
          </button>
        ) : null}
      </div>
      {card.body ? (
        <pre className="mt-3 text-sm text-slate-700 whitespace-pre-wrap break-words bg-slate-50 rounded p-3">{card.body}</pre>
      ) : null}
      {card.result ? (
        <div className="mt-3">
          <p className="text-xs text-slate-500">{t('tasks.result_label')}</p>
          <pre className="text-sm text-slate-700 whitespace-pre-wrap break-words bg-emerald-50 rounded p-3">{card.result}</pre>
        </div>
      ) : null}
      {card.links && Object.keys(card.links).length > 0 ? (
        <p className="mt-2 text-xs">
          {Object.entries(card.links).map(([k, v]) => (
            <a key={k} href={v} target="_blank" rel="noreferrer" className="mr-3 text-sage-700 underline break-all">{k}</a>
          ))}
        </p>
      ) : null}
    </li>
  );
}

export function useTaskList(path) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    let aborted = false;
    (async () => {
      const r = await apiGet(path);
      if (aborted) return;
      setLoading(false);
      if (!r.ok) { setLoadError(r.error || 'load_failed'); return; }
      setItems(Array.isArray(r.data) ? r.data : []);
    })();
    return () => { aborted = true; };
  }, [path]);
  return { items, setItems, loading, loadError };
}

export default function TasksPage() {
  const t = useT();
  const { locale } = useLocale();
  const { items, setItems, loading, loadError } = useTaskList('/api/tasks?mine=true&full=true');
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  async function review(id) {
    if (busy) return;
    setBusy(id);
    setError('');
    const r = await apiPut(`/api/tasks/${id}/review`, {});
    setBusy(null);
    if (!r.ok) {
      setError(r.status === 409 ? t('tasks.review_not_done') : r.status === 403 ? t('tasks.review_not_yours') : t('tasks.action_error'));
      return;
    }
    setItems((prev) => prev.filter((c) => c.id !== id));
    notifyInboxChanged();
    setToast(t('tasks.reviewed_ok'));
  }

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('tasks.title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('tasks.subtitle')}</p>
      {toast ? <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{toast}</div> : null}
      {error ? <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : items.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('tasks.empty')}</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {items.map((c) => (
            <TaskCard key={c.id} card={c} t={t} locale={locale} busy={busy} onReview={review} canReview />
          ))}
        </ul>
      )}
    </div>
  );
}
