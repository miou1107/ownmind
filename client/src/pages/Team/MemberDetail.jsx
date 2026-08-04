// v1.26.58 — 成員詳情 (Stage 6), opened by clicking a row of the ranking.
//
// Two requests, issued together: GET /api/usage/stats?user_id= for the totals
// and the distribution, and the team-overview sessions endpoint for 最近對話.
// The legacy page loaded the conversations lazily behind a 展開 button, which
// bought one query at the cost of a cache that had to be invalidated on every
// range change — and was, in three places. They are fetched together here and
// the toggle only shows and hides what is already loaded.

import { useState, useEffect, useCallback, useRef } from 'react';
import { X, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { useT, useLocale } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { fmtDate, bcp47Of } from '../../utils/fmtDate';
import { makeRequestGate } from './request-gate.js';
import { dayBoundsIso } from './team-usage-vm.js';
import { detailTotalsVm, usageBarRows, sessionRowVm } from './member-detail-vm.js';
import { Card, NoData, bandTextClass } from './charts.jsx';

const GROUP_BY = ['day', 'tool', 'model', 'session'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_LIMIT = 100;

/** Seconds as hours, and the two token cards through the number formatter. */
function cardValue(card, locale, t) {
  if (card.value === null) {
    return <span className="text-base italic text-slate-400">{t('team_usage.no_data')}</span>;
  }
  if (card.key === 'wall' || card.key === 'active') return `${(card.value / 3600).toFixed(1)}h`;
  return card.value.toLocaleString(bcp47Of(locale));
}

export default function MemberDetail({ member, from, to, onClose }) {
  const t = useT();
  const { locale } = useLocale();

  const [detailFrom, setDetailFrom] = useState(from);
  const [detailTo, setDetailTo] = useState(to);
  const [groupBy, setGroupBy] = useState('day');
  const [stats, setStats] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // Follows the ranking when its window moves, so the two never quietly disagree
  // about which period is on screen. Switching member is not handled here: the
  // parent keys this component by member id, so that case is a fresh mount.
  useEffect(() => {
    setDetailFrom(from);
    setDetailTo(to);
  }, [from, to]);

  const gate = useRef(makeRequestGate()).current;
  const rangeUsable = ISO_DATE.test(detailFrom) && ISO_DATE.test(detailTo) && detailFrom <= detailTo;

  const load = useCallback(async () => {
    // Not just `return`: `loading` starts true, and this component can mount with
    // an unusable range — the ranking keeps rendering its last good payload while
    // the dates are reversed, so a row is still there to click. Returning without
    // clearing the flag left the drill-down spinning for ever with no message.
    if (!rangeUsable) { setLoading(false); return; }
    const mine = gate.begin();
    setLoading(true);
    setLoadError('');

    const { fromIso, toIso } = dayBoundsIso(detailFrom, detailTo);
    const [statsRes, sessionsRes] = await Promise.all([
      apiGet(`/api/usage/stats?user_id=${member.id}&from=${detailFrom}&to=${detailTo}&group_by=${groupBy}`),
      apiGet(`/api/usage/admin/team-overview/${member.id}/sessions`
        + `?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&limit=${SESSION_LIMIT}`),
    ]);
    // Both selects and both date inputs refetch, so two loads overlap the moment
    // anyone changes their mind mid-request. Only the newest may write state.
    if (!gate.isCurrent(mine)) return;
    setLoading(false);

    if (!statsRes.ok) { setLoadError(statsRes.error || 'load_failed'); setStats(null); return; }
    setStats(statsRes.data);
    // The conversation list degrades on its own: the totals above it are still
    // worth showing if this one fails.
    setSessions(sessionsRes.ok ? (sessionsRes.data.sessions || []) : null);
    setSessionsFailed(!sessionsRes.ok);
  }, [member.id, detailFrom, detailTo, groupBy, rangeUsable]);

  useEffect(() => { load(); }, [load]);

  const measured = stats?.totals?.has_usage_data === true;
  const cards = detailTotalsVm(stats?.totals, measured);
  const bars = usageBarRows(stats?.series);
  const sessionRows = (sessions || []).map(sessionRowVm);

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-4">
        <h2 className="flex-1 min-w-[160px] text-base font-semibold text-slate-900">
          {t('team_usage.detail.title', { name: member.label })}
        </h2>
        <div>
          <label className="mb-1 block text-xs text-slate-500" htmlFor="detail-from">
            {t('team_usage.filter.from')}
          </label>
          <input
            id="detail-from" type="date" value={detailFrom}
            onChange={(e) => setDetailFrom(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500" htmlFor="detail-to">
            {t('team_usage.filter.to')}
          </label>
          <input
            id="detail-to" type="date" value={detailTo}
            onChange={(e) => setDetailTo(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-slate-500" htmlFor="detail-group">
            {t('team_usage.detail.group_by')}
          </label>
          <select
            id="detail-group" value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {GROUP_BY.map((g) => (
              <option key={g} value={g}>{t(`team_usage.detail.group.${g}`)}</option>
            ))}
          </select>
        </div>
        <button
          type="button" onClick={onClose}
          className="flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
        >
          <X size={14} />
          {t('team_usage.detail.close')}
        </button>
      </div>

      <div className="space-y-4 p-4">
        {!rangeUsable && (
          <p role="alert" className="text-xs text-rose-600">{t('team_usage.filter.reversed')}</p>
        )}
        {loading && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <RefreshCw size={14} className="animate-spin" />
            {t('team_usage.loading')}
          </p>
        )}
        {loadError && (
          <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            {t('team_usage.load_failed')}: {loadError}
          </div>
        )}

        {!loadError && stats && (
          <>
            {/* An exemption does not blank the numbers below — it explains why
                they stop moving. Saying so beats leaving them looking stale. */}
            <p className={`text-xs ${stats.is_exempt ? 'text-amber-600' : 'text-emerald-600'}`}>
              {stats.is_exempt ? t('team_usage.detail.exempt') : t('team_usage.detail.tracking_on')}
            </p>

            {!measured && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                {t('team_usage.reason.no_usage')}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {cards.map((c) => (
                <div key={c.key} className="rounded-xl border border-slate-200 px-3 py-2.5">
                  <div className="text-lg font-bold tabular-nums text-slate-900">
                    {cardValue(c, locale, t)}
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {t(`team_usage.card.${c.key}`)}
                  </div>
                </div>
              ))}
            </div>

            <Card title={t('team_usage.detail.distribution')}>
              {bars.rows.length === 0 ? (
                <NoData>{t('team_usage.detail.no_series')}</NoData>
              ) : !bars.anyTokens ? (
                // Cursor and Antigravity report session counts and no tokens.
                // An empty chart here is a real answer, not a missing one.
                <NoData>{t('team_usage.detail.no_tokens')}</NoData>
              ) : (
                <div className="max-w-2xl space-y-1.5">
                  {bars.rows.map((r) => (
                    <div key={r.key} className="flex items-center gap-2">
                      <div className="w-32 shrink-0 truncate text-xs text-slate-600" title={r.key}>{r.key}</div>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div className="h-full rounded-full bg-sage-500" style={{ width: `${r.pct}%` }} />
                      </div>
                      <div className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-700">
                        {r.tokens.toLocaleString(bcp47Of(locale))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <div>
              <button
                type="button"
                onClick={() => setSessionsOpen((v) => !v)}
                className="flex items-center gap-1 text-sm font-semibold text-slate-700"
              >
                {sessionsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                {t('team_usage.detail.sessions_title')}
                <span className="text-xs font-normal text-slate-400">
                  {sessionsFailed
                    ? t('team_usage.detail.sessions_failed')
                    : t('team_usage.detail.sessions_count', {
                      count: sessionRows.length,
                      limit: SESSION_LIMIT,
                    })}
                </span>
              </button>

              {sessionsOpen && !sessionsFailed && (
                sessionRows.length === 0 ? (
                  <p className="mt-2 text-sm italic text-slate-500">{t('team_usage.detail.no_sessions')}</p>
                ) : (
                  <div className="mt-2 overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-xs text-slate-600">
                        <tr>
                          <th className="whitespace-nowrap px-3 py-2 text-left">{t('team_usage.detail.col.time')}</th>
                          <th className="px-3 py-2 text-left">{t('team_usage.detail.col.tool')}</th>
                          <th className="px-3 py-2 text-left">{t('team_usage.detail.col.model')}</th>
                          <th className="px-3 py-2 text-left">{t('team_usage.detail.col.machine')}</th>
                          <th className="px-3 py-2 text-left">{t('team_usage.detail.col.project')}</th>
                          <th className="px-3 py-2 text-right">{t('team_usage.detail.col.turns')}</th>
                          <th className="px-3 py-2 text-right">{t('team_usage.detail.col.compliance')}</th>
                          <th className="px-3 py-2 text-left">{t('team_usage.detail.col.summary')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sessionRows.map((s) => (
                          <tr key={s.id} className="border-t border-slate-100 align-top">
                            <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">
                              {fmtDate(s.createdAtIso, locale)}
                            </td>
                            <td className="px-3 py-2 text-slate-700">{s.tool ?? <Unreported t={t} />}</td>
                            <td className="px-3 py-2 text-slate-700">{s.model ?? <Unreported t={t} />}</td>
                            <td className="px-3 py-2 text-slate-700">
                              {s.machine ?? <Unreported t={t} />}
                              {s.machineMeta && (
                                <div className="text-[11px] text-slate-400">{s.machineMeta}</div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-slate-700">{s.project ?? <Unreported t={t} />}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                              {s.turns ?? <Unreported t={t} />}
                            </td>
                            <td className={`px-3 py-2 text-right tabular-nums font-semibold ${bandTextClass(s.complianceBand)}`}>
                              {s.complianceRate === null
                                ? (
                                  <span className="text-xs font-normal italic text-slate-400" title={t('team_usage.reason.no_compliance')}>
                                    {t('team_usage.no_data')}
                                  </span>
                                )
                                : `${s.complianceRate}%`}
                            </td>
                            <td className="px-3 py-2 text-xs text-slate-600" title={s.summaryFull}>
                              {s.summary || <Unreported t={t} />}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** A field the collector never sent, said plainly rather than as a dash. */
function Unreported({ t }) {
  return <span className="text-xs italic text-slate-400">{t('team_usage.not_reported')}</span>;
}
