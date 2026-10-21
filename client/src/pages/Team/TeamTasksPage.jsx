import { useT, useLocale } from '../../i18n/LocaleContext';
import { TaskCard, useTaskList, useReopen, reopenInPlace } from '../Portal/TasksPage.jsx';
import { teamTaskGroups } from '../Portal/tasks-vm.js';

// Team task cards (v1.31.3, admin+): every non-private card of every member, by status.
//
// v1.33.0: nobody reviews a card; a closed one (本月結案) can be sent back with 退回, which
// an admin may do on any card.

export default function TeamTasksPage() {
  const t = useT();
  const { locale } = useLocale();
  const { items, setItems, loading, loadError } = useTaskList('/api/tasks?all=true&full=true');
  const { busy, toast, error, reopen } = useReopen({ t, onReopened: (id) => reopenInPlace(setItems, id) });

  const groups = teamTaskGroups(items);

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
          <section key={g.id} className="mt-6">
            <h2 className="text-sm font-medium text-slate-600 mb-2">{t(g.labelKey)} · {g.cards.length}</h2>
            <ul className="space-y-3">
              {g.cards.map((c) => (
                <TaskCard key={c.id} card={c} t={t} locale={locale} busy={busy} onReopen={reopen} canReopen />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
