// v1.26.56 — 統計儀表板 (Stage 5). Ports src/public/index.html:292-369.
//
// One control bar, two views. Empty user select → the cross-user overview;
// a user id → that user's detail, which needs two requests (/stats and
// /stats/rules). The console had never called /api/activity/* before this page.

import { useState, useEffect, useCallback, useRef } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { makeRequestGate } from './request-gate.js';
import StatsOverview from './StatsOverview.jsx';
import StatsDetail from './StatsDetail.jsx';

// Same three the legacy select offered. Not free-form: the endpoint clamps at
// 365 anyway, and every extra option is another range nobody has looked at.
const RANGES = [7, 30, 90];
const DEFAULT_RANGE = 30;

export default function StatsPage() {
  const t = useT();

  const [userId, setUserId] = useState('');
  const [days, setDays] = useState(DEFAULT_RANGE);
  const [users, setUsers] = useState([]);
  const [overview, setOverview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [ruleStats, setRuleStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  // Captured per load so every row in one render bands its activity dot against
  // the same instant.
  const [nowMs, setNowMs] = useState(() => Date.now());

  // The user dropdown, same source the team page uses.
  useEffect(() => {
    (async () => {
      const res = await apiGet('/api/admin/users');
      // GET /api/admin/users answers with a bare array, same as the team page.
      if (res.ok) setUsers(Array.isArray(res.data) ? res.data : []);
    })();
  }, []);

  // Both controls refetch on change, so two loads overlap the moment someone
  // clicks twice. Only the newest may write state; see request-gate.js for the
  // failure this prevents. Every setState after an await is behind the check.
  const gate = useRef(makeRequestGate()).current;

  const load = useCallback(async () => {
    const mine = gate.begin();
    setLoading(true);
    setLoadError('');
    setNowMs(Date.now());

    if (!userId) {
      const res = await apiGet(`/api/activity/stats/all?days=${days}`);
      if (!gate.isCurrent(mine)) return;
      setLoading(false);
      if (!res.ok) { setLoadError(res.error || 'load_failed'); return; }
      setOverview(res.data);
      setDetail(null);
      setRuleStats(null);
      return;
    }

    // Both detail requests together: the rule table is not a drill-down, it is
    // part of the same view, and serialising them doubles the wait for nothing.
    const [statsRes, rulesRes] = await Promise.all([
      apiGet(`/api/activity/stats?user_id=${userId}&days=${days}`),
      apiGet(`/api/activity/stats/rules?user_id=${userId}&days=${days}`),
    ]);
    if (!gate.isCurrent(mine)) return;
    setLoading(false);

    if (!statsRes.ok) { setLoadError(statsRes.error || 'load_failed'); return; }
    setDetail(statsRes.data);
    setOverview(null);
    // The rule table degrades on its own: if /stats/rules fails, the rest of
    // the page is still worth showing.
    setRuleStats(rulesRes.ok ? rulesRes.data : null);
  }, [userId, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
          <BarChart3 size={20} />
          {t('stats.title')}
        </h1>
        <p className="text-sm text-slate-500 mt-1">{t('stats.subtitle')}</p>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[220px]">
            <label className="text-xs text-slate-500 block mb-1" htmlFor="stats-user">
              {t('stats.filter.user')}
            </label>
            <select
              id="stats-user"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm w-full"
            >
              <option value="">{t('stats.filter.all_users')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email}</option>
              ))}
            </select>
          </div>
          <div className="w-40">
            <label className="text-xs text-slate-500 block mb-1" htmlFor="stats-days">
              {t('stats.filter.range')}
            </label>
            <select
              id="stats-days"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm w-full"
            >
              {RANGES.map((d) => (
                <option key={d} value={d}>{t('stats.filter.last_days', { days: d })}</option>
              ))}
            </select>
          </div>
          {loading && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500 pb-2">
              <RefreshCw size={14} className="animate-spin" />
              {t('stats.loading')}
            </div>
          )}
        </div>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {t('stats.load_failed')}: {loadError}
        </div>
      )}

      {!loadError && !userId && overview && (
        <StatsOverview users={overview.users} nowMs={nowMs} />
      )}

      {!loadError && userId && detail && (
        <StatsDetail detail={detail} ruleStats={ruleStats} />
      )}
    </div>
  );
}
