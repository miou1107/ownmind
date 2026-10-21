import { useState, useEffect } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet, apiPut } from '../../api';
import { notifyInboxChanged } from '../../hooks/useInboxCount';
import { fmtDate } from '../../utils/fmtDate';
import {
  TASKS_MINE_PATH, TASKS_CLOSED_PATH, canReopen, moveReopened, reopenedCard, reopenErrorKey,
} from './tasks-vm.js';

// Task cards (v1.31.3): the cards this person owns or holds.
//
// v1.33.0: a card the AI finished with evidence is closed; nobody reviews it. The moving
// cards and this month's closed ones are two calls; closed cards sit under 本月結案 with
// the evidence the AI ran and one undo, 退回, which sends the card back to open and moves
// it up into the active list. Same page shape as HandoffsPage.

const STATUS_KEY = {
  open: 'tasks.status.open',
  claimed: 'tasks.status.claimed',
  done: 'tasks.status.done',
  reviewed: 'tasks.status.reviewed',
  dropped: 'tasks.status.dropped',
};

export function TaskCard({ card, t, locale, busy, onReopen, canReopen: allowed }) {
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
        {allowed && canReopen(card) ? (
          <button
            type="button"
            onClick={() => onReopen(card.id)}
            disabled={busy === card.id}
            className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 transition-colors"
          >
            {busy === card.id ? t('tasks.working') : t('tasks.reopen')}
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
      {card.evidence ? (
        <div className="mt-3">
          <p className="text-xs text-slate-500">{t('tasks.evidence_label')}</p>
          <pre className="text-sm text-slate-700 whitespace-pre-wrap break-words bg-slate-50 rounded p-3">{card.evidence}</pre>
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

/**
 * Shared by both task pages: PUT reopen, then `onReopened(id)` moves the card in the
 * page's own state, so the two pages cannot drift apart on the request or the messages.
 */
export function useReopen({ t, onReopened }) {
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  async function reopen(id) {
    if (busy) return;
    setBusy(id);
    setError('');
    const r = await apiPut(`/api/tasks/${id}/reopen`, {});
    setBusy(null);
    if (!r.ok) {
      setError(t(reopenErrorKey(r)));
      return;
    }
    onReopened(id);
    setToast(t('tasks.reopened_ok'));
  }

  return { busy, toast, error, reopen };
}

/** The team page's in-place update: the same card, open again. */
export function reopenInPlace(setItems, id) {
  setItems((prev) => prev.map((c) => (c.id === id ? reopenedCard(c) : c)));
}

export default function TasksPage() {
  const t = useT();
  const { locale } = useLocale();
  const mine = useTaskList(TASKS_MINE_PATH);
  const closedList = useTaskList(TASKS_CLOSED_PATH);
  const { busy, toast, error, reopen } = useReopen({
    t,
    onReopened: (id) => {
      // Two lists, one move: compute from the closed list, then write both.
      const next = moveReopened({ active: mine.items, closed: closedList.items }, id);
      mine.setItems(next.active);
      closedList.setItems(next.closed);
      notifyInboxChanged();
    },
  });
  const loading = mine.loading || closedList.loading;
  const loadError = mine.loadError || closedList.loadError;
  const active = mine.items;
  const closed = closedList.items;

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
      ) : active.length === 0 && closed.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('tasks.empty')}</p>
      ) : (
        <>
          {active.length > 0 ? (
            <ul className="mt-6 space-y-3">
              {active.map((c) => (
                <TaskCard key={c.id} card={c} t={t} locale={locale} busy={busy} onReopen={reopen} canReopen />
              ))}
            </ul>
          ) : null}
          {closed.length > 0 ? (
            <section className="mt-6">
              <h2 className="text-sm font-medium text-slate-600 mb-2">{t('tasks.closed_section')} · {closed.length}</h2>
              <ul className="space-y-3">
                {closed.map((c) => (
                  <TaskCard key={c.id} card={c} t={t} locale={locale} busy={busy} onReopen={reopen} canReopen />
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
