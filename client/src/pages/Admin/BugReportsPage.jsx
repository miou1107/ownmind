import { useState, useEffect, useMemo } from 'react';
import { Bug, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet } from '../../api';
import { bugReportRowVm } from './bug-report-row-vm.js';
import BugReportDetailModal from './BugReportDetailModal.jsx';
import SpamSuspectModal from './SpamSuspectModal.jsx';

// v1.26.51 — 錯誤回報 admin page.
//
// Ports the legacy tab at src/public/index.html:734-816. Two sub-tabs (回報列表 /
// spam suspect), two stat cards (未處理回報 / 疑似 spam), status editor via a
// modal. The 封鎖期內使用者 stat card from the legacy tab is intentionally not
// ported — its element was defined but never populated, so a rebuild that
// shows `0` would misrepresent state the codebase never measured. See the
// change proposal.

function severityClass(color) {
  switch (color) {
    case 'critical': return 'text-rose-700 font-bold';
    case 'high':     return 'text-rose-600';
    case 'medium':   return 'text-amber-600';
    default:         return 'text-slate-500';
  }
}

function statusBadgeClass(color) {
  switch (color) {
    case 'new':          return 'bg-amber-100 text-amber-800';
    case 'triaged':      return 'bg-blue-100 text-blue-800';
    case 'in_progress':  return 'bg-indigo-100 text-indigo-800';
    case 'fixed':        return 'bg-emerald-100 text-emerald-800';
    case 'wontfix':      return 'bg-rose-100 text-rose-800';
    default:             return 'bg-slate-100 text-slate-700';
  }
}

const PENDING_CAP = 50;

export default function BugReportsPage() {
  const t = useT();

  const [subTab, setSubTab] = useState('reports');
  const [statusFilter, setStatusFilter] = useState('');
  const [reports, setReports] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [suspects, setSuspects] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [detailTargetId, setDetailTargetId] = useState(null);
  const [suspectTarget, setSuspectTarget] = useState(null);

  const userMap = useMemo(() => {
    const m = {};
    for (const u of users) {
      m[u.id] = u.name || u.email || `user#${u.id}`;
    }
    return m;
  }, [users]);

  const showToast = (msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3000);
  };

  const loadAll = async () => {
    setLoading(true);
    setLoadError('');

    const [reportsRes, pendingRes, suspectsRes, usersRes] = await Promise.all([
      apiGet(`/api/bug-reports?scope=all&size=50${statusFilter ? `&status=${statusFilter}` : ''}`),
      apiGet('/api/bug-reports?scope=all&status=new&size=' + PENDING_CAP),
      apiGet('/api/bug-reports/spam-suspects?status=pending'),
      apiGet('/api/admin/users'),
    ]);

    setLoading(false);

    if (!reportsRes.ok) setLoadError(reportsRes.error || 'load_reports_failed');
    setReports(reportsRes.ok ? (reportsRes.data?.items || []) : []);

    if (pendingRes.ok) {
      const list = pendingRes.data?.items || [];
      // Legacy shows "50+" when we hit the cap because we don't count-fetch.
      setPendingCount(list.length >= PENDING_CAP ? PENDING_CAP : list.length);
    }

    setSuspects(suspectsRes.ok ? (suspectsRes.data?.items || []) : []);
    setUsers(usersRes.ok ? (usersRes.data?.items || usersRes.data || []) : []);
  };

  useEffect(() => { loadAll(); }, [statusFilter]);

  const vms = useMemo(() => reports.map((r) => bugReportRowVm(r, userMap)), [reports, userMap]);

  const pendingLabel = pendingCount >= PENDING_CAP ? `${PENDING_CAP}+` : String(pendingCount);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Bug size={20} />
            {t('bug_reports.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t('bug_reports.subtitle')}</p>
        </div>
        <button
          onClick={loadAll}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={14} />
          {t('bug_reports.refresh')}
        </button>
      </div>

      <div className="bg-amber-50 border-l-4 border-amber-500 rounded-r-lg p-3 text-xs text-amber-900 leading-relaxed">
        {t('bug_reports.notice')}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="text-3xl font-bold text-slate-900">{pendingLabel}</div>
          <div className="text-xs text-slate-500 mt-1">{t('bug_reports.stat.pending')}</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="text-3xl font-bold text-amber-600">{suspects.length}</div>
          <div className="text-xs text-slate-500 mt-1">{t('bug_reports.stat.spam_pending')}</div>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-200">
        <button
          onClick={() => setSubTab('reports')}
          className={`px-4 py-2 text-sm border-b-2 -mb-px ${
            subTab === 'reports'
              ? 'border-slate-900 text-slate-900 font-medium'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          {t('bug_reports.sub.reports')}
        </button>
        <button
          onClick={() => setSubTab('spam')}
          className={`px-4 py-2 text-sm border-b-2 -mb-px ${
            subTab === 'spam'
              ? 'border-slate-900 text-slate-900 font-medium'
              : 'border-transparent text-slate-500 hover:text-slate-700'
          }`}
        >
          {t('bug_reports.sub.spam')}
        </button>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {subTab === 'reports' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-500">{t('bug_reports.filter.status')}:</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-slate-300 rounded-md px-2 py-1 text-sm"
            >
              <option value="">{t('bug_reports.filter.all')}</option>
              <option value="new">new</option>
              <option value="triaged">triaged</option>
              <option value="in_progress">in_progress</option>
              <option value="fixed">fixed</option>
              <option value="wontfix">wontfix</option>
            </select>
          </div>

          {loading ? (
            <p className="text-sm text-slate-500">{t('common.loading')}</p>
          ) : vms.length === 0 ? (
            <p className="text-sm text-slate-500">{t('bug_reports.empty')}</p>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">ID</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.col.title')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.col.severity')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.col.component')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.col.status')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.col.user')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.col.created_at')}</th>
                    <th className="text-right px-3 py-2">{t('bug_reports.col.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {vms.map((vm) => (
                    <tr key={vm.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 text-xs text-slate-500">#{vm.id}</td>
                      <td className="px-3 py-2 text-slate-800">{vm.title}</td>
                      <td className={`px-3 py-2 text-xs ${severityClass(vm.severityColor)}`}>
                        {vm.severityColor}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">{vm.componentLabel}</td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadgeClass(vm.statusColor)}`}>
                          {vm.statusLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{vm.userLabel}</td>
                      <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{vm.createdAtLabel}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => setDetailTargetId(vm.id)}
                          className="px-2 py-1 text-xs text-slate-700 border border-slate-300 rounded hover:bg-slate-50"
                        >
                          {t('bug_reports.action.view')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {subTab === 'spam' && (
        <div className="space-y-3">
          {loading ? (
            <p className="text-sm text-slate-500">{t('common.loading')}</p>
          ) : suspects.length === 0 ? (
            <p className="text-sm text-slate-500">{t('bug_reports.spam.empty')}</p>
          ) : (
            <div className="bg-white border border-slate-200 rounded-xl overflow-x-auto shadow-sm">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-600">
                  <tr>
                    <th className="text-left px-3 py-2">ID</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.spam.col.user')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.spam.col.rule')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.spam.col.triggered_at')}</th>
                    <th className="text-left px-3 py-2">{t('bug_reports.spam.col.report_count')}</th>
                    <th className="text-right px-3 py-2">{t('bug_reports.col.action')}</th>
                  </tr>
                </thead>
                <tbody>
                  {suspects.map((s) => {
                    const userLabel = userMap[s.user_id] || `user#${s.user_id}`;
                    const triggeredAt = String(s.triggered_at || '').slice(0, 16).replace('T', ' ');
                    return (
                      <tr key={s.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 text-xs text-slate-500">#{s.id}</td>
                        <td className="px-3 py-2 text-slate-800">{userLabel}</td>
                        <td className="px-3 py-2 text-xs font-mono text-slate-600">{s.trigger_rule}</td>
                        <td className="px-3 py-2 text-xs text-slate-500">{triggeredAt}</td>
                        <td className="px-3 py-2 text-xs text-slate-600">{(s.report_ids || []).length}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            onClick={() => setSuspectTarget(s)}
                            className="px-2 py-1 text-xs text-slate-700 border border-slate-300 rounded hover:bg-slate-50"
                          >
                            {t('bug_reports.spam.action.review')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}

      <BugReportDetailModal
        reportId={detailTargetId}
        onClose={() => setDetailTargetId(null)}
        onSaved={() => {
          setDetailTargetId(null);
          showToast(t('bug_reports.toast.saved'));
          loadAll();
        }}
      />

      <SpamSuspectModal
        suspect={suspectTarget}
        userLabel={suspectTarget ? (userMap[suspectTarget.user_id] || `user#${suspectTarget.user_id}`) : ''}
        onCancel={() => setSuspectTarget(null)}
        onDone={(msg) => {
          setSuspectTarget(null);
          if (msg) showToast(msg);
          loadAll();
        }}
      />
    </div>
  );
}
