import { useEffect, useState } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import useMeReport from './useMeReport.js';
import UsageRangeBar, { ReportState } from './UsageRangeBar.jsx';
import PitfallsPage from '../Portal/PitfallsPage.jsx';
import { rulesTiles, ruleBars } from './rules-vm.js';

// v1.32.4 — 用量與規矩 › 規矩遵守.
//
// Three tiles (the rate, with its formula in words; how many times OwnMind blocked the
// AI; how many sessions the AI never reported on), one bar per rule with 遵守／略過／違反
// in three colours, and below them the record of what went unreported — the old 踩坑紀錄
// page, embedded unchanged. The rows come from /api/me/report; the unreported count and
// the record from /api/me/pitfalls.

const WINDOW_OF = { '7d': '7d', '14d': '30d', '30d': '30d', all: 'all' };

export default function RulesPage() {
  const t = useT();
  const { data, loading, loadError, rangeBar } = useMeReport();
  const [pitfalls, setPitfalls] = useState(null);

  // The pitfalls endpoint has its own fixed windows; take the nearest one.
  const window_ = rangeBar.custom ? '30d' : (WINDOW_OF[rangeBar.range] ?? '30d');
  useEffect(() => {
    let current = true;
    (async () => {
      const r = await apiGet(`/api/me/pitfalls?window=${encodeURIComponent(window_)}`);
      if (!current) return;
      setPitfalls(r.ok ? (r.data || null) : null);
    })();
    return () => { current = false; };
  }, [window_]);

  const rows = data?.me?.compliance ?? [];
  const tiles = rulesTiles({ rows, pitfalls }, t);
  const bars = ruleBars(rows);

  return (
    <div className="max-w-6xl space-y-6">
      <p className="text-sm text-slate-500">{t('usage.rules.intro')}</p>
      <UsageRangeBar bar={rangeBar} />
      <ReportState loading={loading} loadError={loadError} data={data}>
        <section aria-label={t('home.tiles')} className="grid gap-3 sm:grid-cols-3">
          {tiles.map((tile) => (
            <div key={tile.id} className="bg-white border border-slate-200 rounded-2xl p-4 shadow-sm">
              <p className="text-xs font-semibold text-slate-500">{tile.label}</p>
              <p className={`font-bold text-slate-900 mt-1 ${tile.value === t('home.no_data') ? 'text-lg' : 'text-3xl tabular-nums'}`}>{tile.value}</p>
              <p className="text-xs text-slate-500 mt-1">{tile.note}</p>
            </div>
          ))}
        </section>

        <section className="bg-white border border-slate-200 rounded-2xl shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-slate-100">
            <h2 className="text-sm font-bold text-slate-900">{t('usage.rules.bars.title')}</h2>
            <div className="flex gap-3 text-xs text-slate-500">
              <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-500 mr-1 align-middle" />{t('usage.col.comply')}</span>
              <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-500 mr-1 align-middle" />{t('usage.col.skip')}</span>
              <span><i className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-500 mr-1 align-middle" />{t('usage.col.violate')}</span>
            </div>
          </div>
          {bars.length === 0 ? (
            <p className="px-4 py-6 text-sm text-slate-500">{t('usage.rules.bars.empty')}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {bars.map((b) => (
                <li key={b.code ?? b.title} className="px-4 py-2.5 grid gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_3.5rem] items-center">
                  <p className="text-xs text-slate-700 truncate" title={b.title}>
                    {b.code && <code className="text-slate-400 mr-1">{b.code}</code>}{b.title}
                  </p>
                  <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden flex gap-px" role="img"
                    aria-label={`${t('usage.col.comply')} ${b.comply}，${t('usage.col.skip')} ${b.skip}，${t('usage.col.violate')} ${b.violate}`}>
                    <i className="h-full bg-emerald-500" style={{ width: `${b.pct.comply}%` }} />
                    <i className="h-full bg-amber-500" style={{ width: `${b.pct.skip}%` }} />
                    <i className="h-full bg-rose-500" style={{ width: `${b.pct.violate}%` }} />
                  </div>
                  <p className="text-xs text-right tabular-nums text-slate-700">
                    {b.rate === null ? <span className="text-slate-400">{t('usage.rules.bars.untriggered')}</span> : `${Math.round(b.rate * 100)}%`}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">{t('usage.rules.bars.hint')}</p>
        </section>
      </ReportState>

      <section>
        <h2 className="text-sm font-bold text-slate-900 mb-1">{t('usage.rules.unreported.title')}</h2>
        <p className="text-xs text-slate-500 mb-3">{t('usage.rules.unreported.subtitle')}</p>
        <PitfallsPage embedded />
      </section>
    </div>
  );
}
