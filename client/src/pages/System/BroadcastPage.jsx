import { useState, useEffect, useMemo } from 'react';
import { Megaphone, Plus, RefreshCw } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet, apiDelete } from '../../api';
import { broadcastRowVm, formatEffectiveRange } from './broadcast-row-vm.js';
import NewBroadcastModal from './NewBroadcastModal.jsx';
import RevokeConfirmDialog from './RevokeConfirmDialog.jsx';

// v1.26.50 — 廣播管理.
//
// Ports the legacy super-admin card at src/public/index.html:610-628. Same
// CRUD, same is_auto rule (auto rows are not revocable — the nightly job
// re-creates them). Ends_at semantics unchanged from the legacy card: past
// ends_at → row at 45% opacity, no revoke button.

function badgeClass(color) {
  switch (color) {
    case 'danger':  return 'bg-rose-100 text-rose-700';
    case 'warning': return 'bg-amber-100 text-amber-700';
    case 'success': return 'bg-emerald-100 text-emerald-700';
    case 'purple':  return 'bg-purple-100 text-purple-700';
    default:        return 'bg-slate-100 text-slate-700';
  }
}

export default function BroadcastPage() {
  const t = useT();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState(null);   // row | null

  const load = async () => {
    setLoading(true);
    setLoadError('');
    const res = await apiGet('/api/broadcast/admin?include_ended=true');
    setLoading(false);
    if (!res.ok) {
      setLoadError(res.error || 'load_failed');
      return;
    }
    setRows(res.data || []);
  };

  useEffect(() => { load(); }, []);

  const now = useMemo(() => new Date(), [rows]);
  const vms = useMemo(() => rows.map((r) => ({ row: r, vm: broadcastRowVm(r, now) })), [rows, now]);

  const showToast = (msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3000);
  };

  const handleRevokeConfirm = async () => {
    if (!revokeTarget) return;
    const res = await apiDelete(`/api/broadcast/admin/${revokeTarget.id}`);
    setRevokeTarget(null);
    if (!res.ok) {
      showToast(res.error || t('system.broadcast.toast.revoke_failed'));
      return;
    }
    showToast(t('system.broadcast.toast.revoked'));
    await load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Megaphone size={20} />
            {t('system.broadcast.title')}
          </h1>
          <p className="text-sm text-slate-500 mt-1">{t('system.broadcast.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => load()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={14} />
            {t('system.broadcast.refresh')}
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800"
          >
            <Plus size={14} />
            {t('system.broadcast.add_button')}
          </button>
        </div>
      </div>

      <div className="bg-emerald-50 border-l-4 border-emerald-500 rounded-r-lg p-3 text-xs text-emerald-900 leading-relaxed">
        {t('system.broadcast.notice')}
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : vms.length === 0 ? (
        <p className="text-sm text-slate-500">{t('system.broadcast.empty')}</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">{t('system.broadcast.col.created_at')}</th>
                <th className="text-left px-3 py-2">{t('system.broadcast.col.type')}</th>
                <th className="text-left px-3 py-2">{t('system.broadcast.col.severity')}</th>
                <th className="text-left px-3 py-2">{t('system.broadcast.col.title')}</th>
                <th className="text-left px-3 py-2">{t('system.broadcast.col.effective_range')}</th>
                <th className="text-left px-3 py-2">{t('system.broadcast.col.snooze')}</th>
                <th className="text-right px-3 py-2">{t('system.broadcast.col.action')}</th>
              </tr>
            </thead>
            <tbody>
              {vms.map(({ row, vm }) => (
                <tr
                  key={row.id}
                  className="border-t border-slate-100"
                  style={vm.isActive ? undefined : { opacity: 0.45 }}
                >
                  <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                    {new Date(row.created_at).toLocaleString('zh-TW')}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${badgeClass(vm.typeColor)}`}>
                      {row.type}
                    </span>
                    {vm.isAuto && (
                      <span className="ml-1 text-[10px] text-slate-500">(auto)</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${badgeClass(vm.severityColor)}`}>
                      {row.severity}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-slate-800">{row.title}</td>
                  <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                    {formatEffectiveRange(vm, t('system.broadcast.effective.permanent'))}
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500">
                    {vm.snoozeLabel || '—'}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {vm.isRevocable ? (
                      <button
                        onClick={() => setRevokeTarget(row)}
                        className="px-2 py-1 text-xs text-rose-600 border border-rose-300 rounded hover:bg-rose-50"
                      >
                        {t('system.broadcast.action.revoke')}
                      </button>
                    ) : vm.isAuto && vm.isActive ? (
                      <span className="text-[11px] text-slate-500">{t('system.broadcast.auto_managed')}</span>
                    ) : (
                      <span className="text-[11px] text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-slate-900 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
          {toast}
        </div>
      )}

      <NewBroadcastModal
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => { setShowCreate(false); load(); showToast(t('system.broadcast.toast.created')); }}
      />

      <RevokeConfirmDialog
        isOpen={Boolean(revokeTarget)}
        broadcast={revokeTarget}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={handleRevokeConfirm}
      />
    </div>
  );
}
