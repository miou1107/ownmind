// v1.26.59 — 週報月報 (consolidation Stage 7). Ports src/public/index.html:371-414.
//
// The last feature to leave the legacy console: flipping its manifest entry to
// `live` empties the signpost list, which is what stops /admin being served.
//
// Two things differ from the legacy tab, both because it could not tell absence from
// zero. 自動建立 Suggestion Action always read `—`, because nothing ever emitted
// suggestion_actions_created — an absent query, not a wrong one. And an empty list
// printed 本期無 friction 資料 whether nothing was logged, nothing carried the
// reflection fields, nothing was found, or the period is old enough that its detail
// has been compressed away. Which one it is now comes from the data; see
// periodic-report-vm.js.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CalendarRange, RefreshCw } from 'lucide-react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { fmtDate } from '../../utils/fmtDate';
import { makeRequestGate } from '../../utils/request-gate.js';
import {
  PERIODS, OFFSETS, listStateVm, retentionVm, cardsVm, periodLabelOf,
} from './periodic-report-vm.js';
import MemorySearchModal from './MemorySearchModal.jsx';

const LISTS = [
  { key: 'top_frictions', kind: 'friction' },
  { key: 'top_suggestions', kind: 'suggestion' },
];

export default function PeriodicReportsPage() {
  const t = useT();
  const { locale } = useLocale();

  const [period, setPeriod] = useState('week');
  const [offset, setOffset] = useState(0);
  // The payload remembers which selection produced it. Two different problems need
  // that, and only one of them is the request gate's:
  //
  //   - a late reply from an abandoned selection must not write state at all. That is
  //     the gate, the same one the stats and team-usage pages use.
  //   - while a refetch is in flight, the selects have already moved but the numbers
  //     below have not. Rendering them anyway shows one period's figures under
  //     another period's controls, which is the v1.26.56 Critical in a milder form.
  //     So the numbers render only when the payload matches what is selected now.
  const [payload, setPayload] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState(null);

  const gate = useRef(makeRequestGate()).current;

  const load = useCallback(async () => {
    const mine = gate.begin();
    setLoadError('');
    const r = await apiGet(`/api/session/report?period=${period}&offset=${offset}`);
    if (!gate.isCurrent(mine)) return;
    if (!r.ok) { setLoadError(r.error || 'load_failed'); setPayload(null); return; }
    setPayload({ period, offset, data: r.data || null });
  }, [period, offset]);

  useEffect(() => { load(); }, [load]);

  const report = payload && payload.period === period && payload.offset === offset
    ? payload.data
    : null;
  // Distinguished from `report === null` deliberately: a report that has not arrived is
  // not a report full of absent values, and Requirement 7 is exactly about not letting
  // those two render the same.
  const loading = report === null && !loadError;

  const cards = useMemo(() => cardsVm(report), [report]);
  const retention = useMemo(() => retentionVm(report), [report]);
  const label = periodLabelOf(report);

  return (
    <div className="max-w-5xl">
      <h1 className="flex items-center gap-2 text-2xl font-bold text-sage-700">
        <CalendarRange size={22} />
        {t('periodic.title')}
      </h1>
      <p className="mt-1 text-sm text-slate-500">{t('periodic.subtitle')}</p>

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div>
          <label className="mb-1 block text-xs text-slate-500" htmlFor="periodic-period">
            {t('periodic.filter.period')}
          </label>
          <select
            id="periodic-period"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {PERIODS.map((p) => (
              <option key={p} value={p}>{t(`periodic.period.${p}`)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500" htmlFor="periodic-offset">
            {t('periodic.filter.offset')}
          </label>
          <select
            id="periodic-offset"
            value={offset}
            onChange={(e) => setOffset(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {OFFSETS.map((o) => (
              <option key={o} value={o}>{t(`periodic.offset.${o}`)}</option>
            ))}
          </select>
        </div>
        <div data-period-label className="pb-1.5 text-sm text-slate-600">
          {label ? label : <span className="text-slate-400">—</span>}
        </div>
        {loading && (
          <div className="flex items-center gap-1.5 pb-2 text-xs text-slate-500">
            <RefreshCw size={14} className="animate-spin" />
            {t('common.loading')}
          </div>
        )}
      </div>

      {loadError && (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700"
        >
          {loadError === 'load_failed' ? t('common.error_load') : loadError}
        </div>
      )}

      {/* Stated above the numbers, not under them: for an expired window the lists
          below are incomplete in a way no amount of reading them reveals.
          The wording says "not guaranteed complete" rather than "has been
          compressed", because compressOldSessions runs opportunistically off a
          memory write rather than on a schedule — an old window may still hold its
          detail. Claiming the stronger thing would be a confident statement about
          something the server did not check. */}
      {retention.known && retention.affected && (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {t(retention.whole ? 'periodic.retention.whole' : 'periodic.retention.partial')}
        </div>
      )}

      {/* Nothing below renders until the payload matches the current selection. The
          alternative — leaving the previous period's cards up while the new request is
          in flight — puts one period's figures under another period's controls. */}
      {report && (
        <>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {cards.map((c) => (
              <div
                key={c.key}
                data-card={c.key}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <p className="text-xs text-slate-500">{t(`periodic.card.${c.key}`)}</p>
                {c.absent ? (
                  <p className="mt-1 text-sm italic text-slate-400">{t('periodic.card.absent')}</p>
                ) : (
                  <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{c.value}</p>
                )}
              </div>
            ))}
          </div>

          {/* The weekly job runs on Monday for the previous week, so an issue distilled
              from last week's frictions is created this Monday and counted here. Saying
              so is cheaper and more honest than inventing an attribution the memories
              carry no stamp for. */}
          <p className="mt-2 text-xs text-slate-500">{t('periodic.card.created_note')}</p>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            {LISTS.map(({ key, kind }) => (
              <ReportList
                key={key}
                vm={listStateVm(report, key)}
                kind={kind}
                onPick={(text) => setSearch({ text, kind })}
              />
            ))}
          </div>

          {report.generated_at && (
            <p className="mt-6 text-xs text-slate-400">
              {t('narrative.generated_at', { at: fmtDate(report.generated_at, locale) })}
            </p>
          )}
        </>
      )}

      {search && (
        <MemorySearchModal
          key={`${search.kind}:${search.text}`}
          text={search.text}
          kind={search.kind}
          onClose={() => setSearch(null)}
        />
      )}
    </div>
  );
}

function ReportList({ vm, kind, onPick }) {
  const t = useT();
  const tone = kind === 'friction' ? 'text-orange-600' : 'text-violet-600';

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="mb-2 text-sm font-bold text-slate-900">{t(`periodic.list.${kind}`)}</h2>

      {vm.state === 'ok' ? (
        <ul className="divide-y divide-slate-100">
          {vm.rows.map((r, i) => (
            <li key={`${r.text}-${i}`}>
              <button
                type="button"
                onClick={() => onPick(r.text)}
                title={t('periodic.list.search_hint')}
                className="flex w-full gap-2 py-2 text-left hover:bg-slate-50"
              >
                <span className={`shrink-0 text-sm font-bold tabular-nums ${tone}`}>
                  {r.count}x
                </span>
                <span className="break-all text-sm text-slate-700">{r.text}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        // Four different absences, four different sentences. Each names how many
        // sessions the statement is drawn from, so the reader can tell a reporting
        // gap from an idle period.
        <p className="text-sm text-slate-500">
          {t(`periodic.list.empty_${vm.state}`, {
            total: vm.sessionsTotal ?? 0,
            analyzed: vm.sessionsAnalyzed ?? 0,
          })}
        </p>
      )}
    </section>
  );
}
