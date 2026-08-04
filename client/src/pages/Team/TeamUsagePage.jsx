// v1.26.58 — 團隊用量 (Stage 6). Ports src/public/index.html:416-506.
//
// Two endpoints feed the ranking: /api/usage/team-stats has a row for every
// member, /api/usage/admin/team-overview only for members with logged
// conversations. They are joined on user id here, and what each one is missing
// means something different — see team-usage-vm.js.
//
// Two things the legacy tab did are deliberately gone: the Notional cost column
// (Requirement 8 removes the calculation rather than fixing it) and the coverage
// number counted from collector heartbeats, which reported 8 of 9 members
// covered while three of them had no usage data at all.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Users, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { makeRequestGate } from './request-gate.js';
import { teamUsageRowVm, sortTeamRows, coverageVm, dayBoundsIso, SORT_KEYS } from './team-usage-vm.js';
import TeamUsageTable from './TeamUsageTable.jsx';
import MemberDetail from './MemberDetail.jsx';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_DAYS = 7;

/** Today in Asia/Taipei, which is the day every usage table is bucketed by. */
function taipeiYmd(offsetDays = 0) {
  const at = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

export default function TeamUsagePage() {
  const t = useT();

  const [from, setFrom] = useState(() => taipeiYmd(-DEFAULT_DAYS));
  const [to, setTo] = useState(() => taipeiYmd());
  const [sortBy, setSortBy] = useState('usage');
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState(null);

  const rangeUsable = ISO_DATE.test(from) && ISO_DATE.test(to) && from <= to;

  const gate = useRef(makeRequestGate()).current;

  const load = useCallback(async () => {
    // The flag has to be cleared on the way out, or a range that is unusable on
    // the first render leaves the spinner up permanently. See MemberDetail.
    if (!rangeUsable) { setLoading(false); return; }
    const mine = gate.begin();
    setLoading(true);
    setLoadError('');

    // team-overview parses instants, not dates; see dayBoundsIso for why the
    // bare date could not be passed through.
    const { fromIso, toIso } = dayBoundsIso(from, to);
    const [statsRes, overviewRes] = await Promise.all([
      apiGet(`/api/usage/team-stats?from=${from}&to=${to}`),
      apiGet('/api/usage/admin/team-overview'
        + `?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`),
    ]);
    if (!gate.isCurrent(mine)) return;
    setLoading(false);

    if (!statsRes.ok) { setLoadError(statsRes.error || 'load_failed'); setPayload(null); return; }
    setPayload({
      coverage: statsRes.data.coverage,
      users: statsRes.data.users || [],
      // The activity columns degrade on their own: a failure here must not take
      // the token figures down with it, and null is not an empty member list.
      members: overviewRes.ok ? (overviewRes.data.members || []) : null,
    });
  }, [from, to, rangeUsable]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    if (!payload) return [];
    const byId = new Map((payload.members || []).map((m) => [m.user_id, m]));
    return sortTeamRows(
      payload.users.map((u) => teamUsageRowVm(u, byId.get(u.user.id) ?? null)),
      sortBy,
    );
  }, [payload, sortBy]);

  const coverage = useMemo(() => coverageVm(payload?.coverage), [payload]);
  const activityUnavailable = payload != null && payload.members === null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold text-slate-900">
          <Users size={20} />
          {t('team_usage.title')}
        </h1>
        <p className="mt-1 text-sm text-slate-500">{t('team_usage.subtitle')}</p>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500" htmlFor="team-from">
              {t('team_usage.filter.from')}
            </label>
            <input
              id="team-from" type="date" value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500" htmlFor="team-to">
              {t('team_usage.filter.to')}
            </label>
            <input
              id="team-to" type="date" value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </div>
          <div className="w-44">
            <label className="mb-1 block text-xs text-slate-500" htmlFor="team-sort">
              {t('team_usage.filter.sort')}
            </label>
            <select
              id="team-sort" value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            >
              {SORT_KEYS.map((k) => (
                <option key={k} value={k}>{t(`team_usage.sort.${k}`)}</option>
              ))}
            </select>
          </div>
          {loading && (
            <div className="flex items-center gap-1.5 pb-2 text-xs text-slate-500">
              <RefreshCw size={14} className="animate-spin" />
              {t('team_usage.loading')}
            </div>
          )}
        </div>
        {!rangeUsable && (
          <p role="alert" className="mt-2 text-xs text-rose-600">{t('team_usage.filter.reversed')}</p>
        )}
      </div>

      {/* Coverage, stated before the ranking rather than under it: it is the
          denominator the rows below are a fraction of. */}
      <div className={`rounded-xl border p-4 shadow-sm ${
        coverage.incomplete ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
      >
        <h2 className="mb-2 text-sm font-semibold text-slate-800">{t('team_usage.coverage.title')}</h2>
        {!coverage.known ? (
          <p className="text-sm text-slate-500">{t('team_usage.coverage.unknown')}</p>
        ) : (
          <>
            <p className="text-sm text-slate-700">
              {t('team_usage.coverage.summary', {
                total: coverage.totalUsers,
                measured: coverage.measured,
                unmeasured: coverage.unmeasured,
                exempt: coverage.optedOut,
              })}
            </p>
            {coverage.missingNames.length > 0 && (
              <p className="mt-1.5 text-xs text-amber-700">
                {t('team_usage.coverage.missing', { names: coverage.missingNames.join('、') })}
              </p>
            )}
            {coverage.exemptNames.length > 0 && (
              <p className="mt-1 text-xs text-slate-500">
                {t('team_usage.coverage.exempt', { names: coverage.exemptNames.join('、') })}
              </p>
            )}
            {coverage.incomplete && (
              <p className="mt-2 text-xs font-semibold text-amber-800">
                {t('team_usage.coverage.incomplete', { pct: coverage.pct })}
              </p>
            )}
          </>
        )}
      </div>

      {loadError && (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {t('team_usage.load_failed')}: {loadError}
        </div>
      )}

      {activityUnavailable && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {t('team_usage.activity_unavailable')}
        </div>
      )}

      {!loadError && payload && <TeamUsageTable rows={rows} onSelect={setSelected} />}

      {selected && (
        // Keyed by member, so clicking a second row while the first is open
        // remounts rather than reusing the state. Without it React keeps the
        // component and its `stats` alive, the heading switches to the new
        // member immediately, and until the refetch lands the cards, the chart
        // and the conversation list are the previous member's numbers under the
        // new member's name. That is the same defect the stats page shipped with
        // in v1.26.56 and is worth closing structurally rather than by
        // remembering to null four pieces of state.
        <MemberDetail
          key={selected.id}
          member={selected}
          from={from}
          to={to}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
