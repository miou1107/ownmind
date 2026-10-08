import { useT } from '../../i18n/LocaleContext';
import { RANGES } from './report-query.js';

// v1.32.4 — the range control the four 用量與規矩 tabs share, lifted out of the old usage
// page unchanged: four fixed windows plus a custom pair of dates.
export default function UsageRangeBar({ bar }) {
  const t = useT();
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm" role="group" aria-label={t('usage.range.label')}>
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => bar.pick(r)}
              aria-pressed={!bar.custom && bar.range === r}
              className={
                'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-sage-500 '
                + (!bar.custom && bar.range === r ? 'bg-sage-600 text-white' : 'text-slate-600 hover:bg-slate-100')
              }
            >
              {t(`usage.range.${r}`)}
            </button>
          ))}
          <button
            type="button"
            onClick={bar.pickCustom}
            aria-pressed={bar.custom}
            className={
              'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-sage-500 '
              + (bar.custom ? 'bg-sage-600 text-white' : 'text-slate-600 hover:bg-slate-100')
            }
          >
            {t('usage.range.custom')}
          </button>
        </div>

        {bar.custom && (
          <div className="inline-flex items-center gap-2 text-xs text-slate-600">
            <input
              type="date"
              value={bar.start}
              onChange={(e) => bar.setStart(e.target.value)}
              aria-label={t('usage.range.start')}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 shadow-sm"
            />
            <span className="text-slate-400">～</span>
            <input
              type="date"
              value={bar.end}
              onChange={(e) => bar.setEnd(e.target.value)}
              aria-label={t('usage.range.end')}
              className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 shadow-sm"
            />
          </div>
        )}
      </div>
      {bar.custom && !bar.customComplete && (
        <p className="mt-2 text-xs text-slate-500">{t('usage.range.pick_both')}</p>
      )}
      {bar.customReversed && (
        <p role="alert" className="mt-2 text-xs text-rose-600">{t('usage.range.reversed')}</p>
      )}
    </div>
  );
}

/** The loading / error / empty states every tab shows the same way. */
export function ReportState({ loading, loadError, data, children }) {
  const t = useT();
  if (loading) return <p className="text-slate-500">{t('common.loading')}</p>;
  if (loadError) {
    return (
      <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
        {loadError === 'load_failed' ? t('common.error_load') : loadError}
      </div>
    );
  }
  if (!data) return <p className="text-slate-500">{t('common.empty')}</p>;
  return children;
}
