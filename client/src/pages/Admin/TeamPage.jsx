import { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, UserPlus, Copy, MoreHorizontal } from 'lucide-react';
import { useT } from '../../i18n/LocaleContext';
import { useSession } from '../../session/SessionContext';
import { apiGet } from '../../api';
import { mergeUsersWithUsage } from './user-merge.js';
import { buildInstallPrompt, currentApiUrl } from '../../utils/install-prompt.js';
import RowMenu from './RowMenu.jsx';
import AddUserModal from './AddUserModal.jsx';
import EditUserModal from './EditUserModal.jsx';
import PasswordModal from './PasswordModal.jsx';
import DeleteUserModal from './DeleteUserModal.jsx';

// 使用者管理 — Stage 2 of the single-console consolidation.
//
// Two parallel API calls: /api/admin/users (auth-owning source of truth for
// name/role/api_key/must_change_password) and /api/usage/team-stats (per-user
// tokens + session count for the 用量資料 column). They merge on user.id via
// mergeUsersWithUsage(); users with no team-stats row render as "尚無資料"
// italic — not zero. This is the only console page where every member is
// reviewed one by one, so it's the right place to surface whose data is
// missing (umbrella spec Requirement 7).

function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function roleBadgeClass(role) {
  switch (role) {
    case 'super_admin': return 'bg-purple-100 text-purple-700';
    case 'admin':       return 'bg-blue-100 text-blue-700';
    default:            return 'bg-slate-100 text-slate-600';
  }
}

export default function TeamPage() {
  const t = useT();
  const session = useSession();

  const [users, setUsers] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState('');
  const [menuOpenFor, setMenuOpenFor] = useState(null);
  const [modal, setModal] = useState(null);   // { type, user } | null

  const load = async () => {
    setLoading(true);
    setLoadError('');
    const today = new Date();
    const past = new Date(today.getTime() - 6 * 86_400_000);
    const [usersRes, statsRes] = await Promise.all([
      apiGet('/api/admin/users'),
      apiGet(`/api/usage/team-stats?from=${ymd(past)}&to=${ymd(today)}`),
    ]);
    setLoading(false);
    if (!usersRes.ok) {
      setLoadError(usersRes.error || 'load_failed');
      return;
    }
    setUsers(usersRes.data || []);
    setStats(statsRes.ok ? statsRes.data : null);
  };

  useEffect(() => { load(); }, []);

  const rows = useMemo(() => mergeUsersWithUsage(users, stats), [users, stats]);

  const adminCount = useMemo(
    () => users.filter((u) => u.role === 'admin' || u.role === 'super_admin').length,
    [users],
  );

  const actor = useMemo(
    () => ({ id: session.id, role: session.role }),
    [session.id, session.role],
  );

  const showToast = (msg) => {
    setToast(msg);
    window.setTimeout(() => setToast(''), 3000);
  };

  const handleSelect = async (menuId, row) => {
    if (menuId === 'install-prompt') {
      try {
        const prompt = buildInstallPrompt(row, currentApiUrl(window.location));
        await navigator.clipboard.writeText(prompt);
        showToast(t('team.toast.copied_install'));
      } catch (err) {
        showToast(err.message || t('team.toast.copy_failed'));
      }
      return;
    }
    setModal({ type: menuId, user: row });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-900">{t('team.title')}</h1>
          <p className="text-sm text-slate-500 mt-1">{t('team.subtitle')}</p>
        </div>
        <button
          onClick={() => setModal({ type: 'add' })}
          className="flex items-center gap-1.5 px-3 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800"
        >
          <UserPlus size={14} />
          {t('team.add_button')}
        </button>
      </div>

      {adminCount <= 1 && !loading && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-2 text-sm text-amber-800">
          <AlertTriangle size={16} />
          <span>{t('team.single_admin_banner')}</span>
        </div>
      )}

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
          {loadError}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500">{t('common.empty')}</p>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-visible shadow-sm">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">{t('team.col.email_name')}</th>
                <th className="text-left px-3 py-2">{t('team.col.api_key')}</th>
                <th className="text-left px-3 py-2">{t('team.col.role')}</th>
                <th className="text-left px-3 py-2">{t('team.col.password_status')}</th>
                <th className="text-left px-3 py-2">{t('team.col.usage_7d')}</th>
                <th className="text-right px-3 py-2 w-14"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-slate-100">
                  <td className="px-3 py-3">
                    <div className="font-medium text-slate-900 break-all">{row.email}</div>
                    <div className="text-xs text-slate-500">{row.name || '—'}</div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-500">
                    <span className="inline-flex items-center gap-1">
                      {row.api_key?.slice(0, 8)}…
                      <button
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(row.api_key || '');
                            showToast(t('team.toast.copied_key'));
                          } catch { showToast(t('team.toast.copy_failed')); }
                        }}
                        aria-label={t('common.copy')}
                        className="text-slate-400 hover:text-slate-700"
                      >
                        <Copy size={12} />
                      </button>
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${roleBadgeClass(row.role)}`}>
                      {row.role}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    {row.must_change_password ? (
                      <span className="text-xs text-amber-700">{t('team.password_status.pending')}</span>
                    ) : (
                      <span className="text-xs text-emerald-700">{t('team.password_status.done')}</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-xs">
                    {row.usage.measured ? (
                      <>
                        <div className="tabular-nums text-slate-700">
                          {row.usage.total_tokens.toLocaleString()} tokens
                        </div>
                        <div className="text-slate-500">
                          {row.usage.session_count} {t('team.sessions_unit')}
                        </div>
                      </>
                    ) : (
                      <span className="italic text-slate-400">{t('team.usage.unmeasured')}</span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right relative">
                    <button
                      onClick={() => setMenuOpenFor(menuOpenFor === row.id ? null : row.id)}
                      aria-label={t('common.actions')}
                      className="p-1 text-slate-400 hover:text-slate-700 rounded hover:bg-slate-100"
                    >
                      <MoreHorizontal size={16} />
                    </button>
                    {menuOpenFor === row.id && (
                      <RowMenu
                        actor={actor}
                        row={row}
                        onSelect={(id) => handleSelect(id, row)}
                        onDismiss={() => setMenuOpenFor(null)}
                      />
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

      <AddUserModal
        isOpen={modal?.type === 'add'}
        onClose={() => setModal(null)}
        onCreated={() => load()}
        actorCanCreateSuperAdmin={session.role === 'super_admin'}
      />
      <EditUserModal
        isOpen={modal?.type === 'edit'}
        onClose={() => setModal(null)}
        user={modal?.user}
        actorCanEditRole={session.role === 'super_admin' && modal?.user?.id !== session.id}
        onSaved={() => load()}
      />
      <PasswordModal
        isOpen={modal?.type === 'password'}
        onClose={() => setModal(null)}
        user={modal?.user}
        isSelfChange={modal?.user?.id === session.id}
        onDone={() => { load(); showToast(t('team.toast.password_updated')); }}
      />
      <DeleteUserModal
        isOpen={modal?.type === 'delete'}
        onClose={() => setModal(null)}
        user={modal?.user}
        onDeleted={() => load()}
      />
    </div>
  );
}
