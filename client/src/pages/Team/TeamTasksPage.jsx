import { useState } from 'react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiPut } from '../../api';
import { TaskCard, useTaskList } from '../Portal/TasksPage.jsx';

// Team task cards (v1.31.3, admin+): every non-private card of every member, by status. An
// admin may review any done card.

export default function TeamTasksPage() {
  const t = useT();
  const { locale } = useLocale();
  const { items, setItems, loading, loadError } = useTaskList('/api/tasks?all=true&full=true');
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
      setError(r.status === 409 ? t('tasks.review_not_done') : t('tasks.action_error'));
      return;
    }
    setItems((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'reviewed' } : c)));
    setToast(t('tasks.reviewed_ok'));
  }

  const groups = ['claimed', 'open', 'done', 'reviewed', 'dropped']
    .map((status) => ({ status, cards: items.filter((c) => c.status === status) }))
    .filter((g) => g.cards.length > 0);

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-sage-700">{t('tasks.team_title')}</h1>
      <p className="text-slate-500 mt-1 text-sm">{t('tasks.team_subtitle')}</p>
      {toast ? <div role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{toast}</div> : null}
      {error ? <div role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div> : null}
      {loading ? (
        <p className="mt-6 text-slate-500">{t('common.loading')}</p>
      ) : loadError ? (
        <div role="alert" className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      ) : groups.length === 0 ? (
        <p className="mt-6 text-slate-500">{t('tasks.team_empty')}</p>
      ) : (
        groups.map((g) => (
          <section key={g.status} className="mt-6">
            <h2 className="text-sm font-medium text-slate-600 mb-2">{t(`tasks.status.${g.status}`)} · {g.cards.length}</h2>
            <ul className="space-y-3">
              {g.cards.map((c) => (
                <TaskCard key={c.id} card={c} t={t} locale={locale} busy={busy} onReview={review} canReview />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
