import { useState, useEffect, useMemo, useCallback } from 'react';
import { ClipboardList, RefreshCw, Search } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { buildWorkLogQuery } from './work-log-query.js';
import { workLogRowVm } from './work-log-row-vm.js';

// v1.26.51 — 工作紀錄 page. Ports src/public/index.html:538-582.
//
// Three-source merged timeline (activity / compliance / session). Filters
// applied server-side; pagination is offset-based, load-more style.

const PAGE_SIZE = 100;

function sourceBadgeClass(color) {
  switch (color) {
    case 'activity':   return 'bg-sky-100 text-sky-800';
    case 'compliance': return 'bg-rose-100 text-rose-800';
    case 'session':    return 'bg-emerald-100 text-emerald-800';
    default:           return 'bg-slate-100 text-slate-700';
  }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function thirtyDaysAgoIso() {
  return new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
}

export default function WorkLogPage() {
  const t = useT();

  const [filters, setFilters] = useState({
    from: thirtyDaysAgoIso(),
    to: todayIso(),
    source: '',
    user_id: '',
    tool: '',
    event_type: '',
    q: '',
  });

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [users, setUsers] = useState([]);
  const [tools, setTools] = useState([]);
  const [eventTypes, setEventTypes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const setFilter = (key, value) => setFilters((f) => ({ ...f, [key]: value }));

  // Load /filters once on mount.
  useEffect(() => {
    (async () => {
      const res = await apiGet('/api/admin/work-log/filters');
      if (!res.ok) return;
      setUsers(res.data.users || []);
      setTools(res.data.tools || []);
      setEventTypes(res.data.event_types || []);
    })();
  }, []);

  const runQuery = useCallback(async (nextOffset, append) => {
    setLoading(true);
    setLoadError('');
    const query = buildWorkLogQuery(filters, nextOffset, PAGE_SIZE);
    const res = await apiGet(`/api/admin/work-log/?${query.toString()}`);
    setLoading(false);
    if (!res.ok) {
      setLoadError(res.error || 'load_failed');
      return;
    }
    const newRows = res.data.rows || [];
    setRows((prev) => (append ? [...prev, ...newRows] : newRows));
    setTotal(res.data.total || 0);
    setOffset(nextOffset + newRows.length);
  }, [filters]);

  // Initial load once on mount.
  useEffect(() => { runQuery(0, false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleQuery = () => runQuery(0, false);
  const loadMore = () => runQuery(offset, true);

  const vms = useMemo(() => rows.map((r) => workLogRowVm(r)), [rows]);
  const hasMore = offset < total;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ClipboardList size={20} />
            {t('work_log.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t('work_log.subtitle')}</p>
        </div>
      </div>

      <div className="bg-indigo-50 border-l-4 border-indigo-500 rounded-r-lg p-3 text-xs text-indigo-900 leading-relaxed">
        {t('work_log.notice')}
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div>
            <label className="text-xs text-slate-500 block mb-1">{t('work_log.filter.from')}</label>
            <input
              type="date"
              value={filters.from}
              onChange={(e) => setFilter('from', e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">{t('work_log.filter.to')}</label>
            <input
              type="date"
              value={filters.to}
              onChange={(e) => setFilter('to', e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            />
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">{t('work_log.filter.source')}</label>
            <select
              value={filters.source}
              onChange={(e) => setFilter('source', e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            >
              <option value="">{t('work_log.filter.all_sources')}</option>
              <option value="activity">{t('work_log.source.activity')}</option>
              <option value="compliance">{t('work_log.source.compliance')}</option>
              <option value="session">{t('work_log.source.session')}</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">{t('work_log.filter.user')}</label>
            <select
              value={filters.user_id}
              onChange={(e) => setFilter('user_id', e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            >
              <option value="">{t('work_log.filter.all_users')}</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.name || u.email}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">{t('work_log.filter.tool')}</label>
            <select
              value={filters.tool}
              onChange={(e) => setFilter('tool', e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            >
              <option value="">{t('work_log.filter.all_tools')}</option>
              {tools.map((tv) => (
                <option key={tv} value={tv}>{tv}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 block mb-1">{t('work_log.filter.event_type')}</label>
            <select
              value={filters.event_type}
              onChange={(e) => setFilter('event_type', e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
            >
              <option value="">{t('work_log.filter.all_events')}</option>
              {eventTypes.map((et) => (
                <option key={et} value={et}>{et}</option>
              ))}
            </select>
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-slate-500 block mb-1">{t('work_log.filter.q')}</label>
            <input
              type="text"
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
              placeholder={t('work_log.filter.q_placeholder')}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm w-full"
              onKeyDown={(e) => { if (e.key === 'Enter') handleQuery(); }}
            />
          </div>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            onClick={handleQuery}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
            {t('work_log.query')}
          </button>
        </div>
      </div>

      <div className="text-xs text-slate-500">
        {t('work_log.count', { total, shown: rows.length })}
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {rows.length === 0 && !loading ? (
        <p className="text-sm text-slate-500">{t('work_log.empty')}</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="text-left px-3 py-2 whitespace-nowrap">{t('work_log.col.ts')}</th>
                <th className="text-left px-3 py-2">{t('work_log.col.source')}</th>
                <th className="text-left px-3 py-2">{t('work_log.col.user')}</th>
                <th className="text-left px-3 py-2">{t('work_log.col.tool')}</th>
                <th className="text-left px-3 py-2">{t('work_log.col.event')}</th>
                <th className="text-left px-3 py-2">{t('work_log.col.details')}</th>
              </tr>
            </thead>
            <tbody>
              {vms.map((vm, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-xs text-slate-500 font-mono whitespace-nowrap">
                    {new Date(vm.timestampIso).toLocaleString('zh-TW')}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${sourceBadgeClass(vm.sourceColor)}`}>
                      {vm.sourceColor}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-700">{vm.userLabel}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{vm.toolLabel}</td>
                  <td className="px-3 py-2 text-xs font-mono text-slate-600">{vm.eventLabel}</td>
                  <td
                    className="px-3 py-2 text-xs font-mono text-slate-500 truncate max-w-md"
                    title={vm.detailsFull}
                  >
                    {vm.detailsPreview}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="text-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            {t('work_log.load_more')}
          </button>
        </div>
      )}
    </div>
  );
}
