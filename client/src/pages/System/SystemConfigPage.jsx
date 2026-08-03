import { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { observedUsers, rollupCounts } from './observed-users.js';

// v1.26.50 — 系統設定 (裝機狀況).
//
// Two parallel API calls: /api/usage/admin/clients (per-user heartbeat +
// per-tool status) and /api/usage/team-stats (per-user token totals for the
// observation window). Joined via observedUsers() into rows with an explicit
// four-state classification.
//
// The banner is the whole reason this page exists as a rebuild rather than a
// signpost: it surfaces the "heartbeat yes, usage no" state that the old
// coverage metric collapsed into a single "已裝" count. Umbrella spec
// Requirement 7.

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function statusColor(status) {
  return status === 'active'  ? 'text-emerald-600'
       : status === 'stale'   ? 'text-amber-600'
       : status === 'offline' ? 'text-rose-600'
       :                        'text-slate-500';
}

function overallBadge(row, t) {
  if (!row.installed) return <span className="text-slate-400">⚪ {t('system.config.overall.not_installed')}</span>;
  if (row.needs_upgrade) return <span className="text-amber-600">🟡 {t('system.config.overall.needs_upgrade')}</span>;
  if (row.any_active) return <span className="text-emerald-600">🟢 {t('system.config.overall.active')}</span>;
  const anyStale = (row.clients || []).some((c) => c.status === 'stale');
  if (anyStale) return <span className="text-amber-500">🟠 {t('system.config.overall.stale')}</span>;
  return <span className="text-rose-600">🔴 {t('system.config.overall.offline')}</span>;
}

function formatAgo(iso, t) {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return '—';
  const ms = Date.now() - ts;
  if (ms < -60_000) return t('system.config.time.future');
  if (ms < 60_000) return t('system.config.time.just_now');
  const min = Math.floor(ms / 60_000);
  if (min < 60) return t('system.config.time.minutes_ago').replace('{n}', min);
  const h = Math.floor(min / 60);
  if (h < 24) return t('system.config.time.hours_ago').replace('{n}', h);
  const d = Math.floor(h / 24);
  return t('system.config.time.days_ago').replace('{n}', d);
}

export default function SystemConfigPage() {
  const t = useT();

  const [clients, setClients] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = async () => {
    setLoading(true);
    setLoadError('');
    const today = new Date();
    const past = new Date(today.getTime() - 6 * 86_400_000);
    const [clientsRes, statsRes] = await Promise.all([
      apiGet('/api/usage/admin/clients'),
      apiGet(`/api/usage/team-stats?from=${ymd(past)}&to=${ymd(today)}`),
    ]);
    setLoading(false);
    if (!clientsRes.ok) {
      setLoadError(clientsRes.error || 'load_failed');
      return;
    }
    setClients(clientsRes.data || null);
    setStats(statsRes.ok ? statsRes.data : null);
  };

  useEffect(() => { load(); }, []);

  const rows = useMemo(() => observedUsers(clients, stats), [clients, stats]);
  const counts = useMemo(() => rollupCounts(rows), [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t('system.config.title')}</h1>
          <p className="text-sm text-slate-500 mt-1">{t('system.config.subtitle')}</p>
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} />
          {t('system.config.refresh')}
        </button>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {counts.silent > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-amber-900">
            <AlertTriangle size={16} />
            {t('system.config.silent_banner.title')}
          </div>
          <p className="text-sm text-amber-800">
            {t('system.config.silent_banner.body')
              .replace('{count}', counts.silent)
              .replace('{names}', counts.silent_names.join('、'))}
          </p>
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3">
          <div className="text-2xl font-bold text-emerald-700 tabular-nums">{counts.flowing}</div>
          <div className="text-xs text-emerald-800 mt-1">{t('system.config.state.flowing')}</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
          <div className="text-2xl font-bold text-amber-700 tabular-nums">{counts.silent}</div>
          <div className="text-xs text-amber-800 mt-1">{t('system.config.state.silent')}</div>
        </div>
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-3">
          <div className="text-2xl font-bold text-rose-700 tabular-nums">{counts.offline}</div>
          <div className="text-xs text-rose-800 mt-1">{t('system.config.state.offline')}</div>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
          <div className="text-2xl font-bold text-slate-700 tabular-nums">{counts.not_installed}</div>
          <div className="text-xs text-slate-700 mt-1">{t('system.config.state.not_installed')}</div>
        </div>
      </div>

      <div className="bg-blue-50 border-l-4 border-blue-400 rounded-r-lg p-3 text-xs text-blue-900">
        {t('system.config.server_version_hint').replace('{version}', clients?.server_version || '—')}
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t('common.empty')}</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">{t('system.config.col.user')}</th>
                <th className="text-left px-3 py-2">{t('system.config.col.email')}</th>
                <th className="text-left px-3 py-2">{t('system.config.col.role')}</th>
                <th className="text-left px-3 py-2">{t('system.config.col.overall')}</th>
                <th className="text-left px-3 py-2">{t('system.config.col.tools')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user_id} className="border-t border-slate-100">
                  <td className="px-3 py-3 font-medium text-slate-900">
                    {row.user_name || `#${row.user_id}`}
                    {row.state === 'silent' && (
                      <span className="ml-2 inline-block text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                        {t('system.config.badge.silent')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-500 break-all">{row.email || '—'}</td>
                  <td className="px-3 py-3">
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-slate-100 text-slate-700">
                      {row.role}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs">{overallBadge(row, t)}</td>
                  <td className="px-3 py-3 text-xs">
                    {(!row.clients || row.clients.length === 0) ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <div className="space-y-1">
                        {row.clients.map((c) => (
                          <div key={c.tool} className="flex items-center gap-2">
                            <b className="text-slate-700">{c.tool}</b>
                            <code className={statusColor(c.status)}>{c.version || t('system.config.version.unknown')}</code>
                            {c.needs_upgrade && (
                              <span className="text-[10px] text-amber-700">↑ {t('system.config.tool.needs_upgrade')}</span>
                            )}
                            <span className="text-slate-500">· {formatAgo(c.last_heartbeat_at, t)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
