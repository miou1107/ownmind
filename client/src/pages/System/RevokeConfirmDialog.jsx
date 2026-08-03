import { useT } from '../../i18n/LocaleContext';

// v1.26.50 — small confirm dialog for 撤銷廣播. Destructive button styling
// per the "delete red, kept away from cancel" project rule.

export default function RevokeConfirmDialog({ isOpen, broadcast, onCancel, onConfirm }) {
  const t = useT();
  if (!isOpen || !broadcast) return null;

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-rose-700">
            {t('system.broadcast.revoke.title')}
          </h3>
        </div>

        <div className="p-5 space-y-3">
          <p className="text-sm text-slate-700">
            {t('system.broadcast.revoke.body')}
          </p>
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
            <div className="text-xs text-slate-500">#{broadcast.id} · {broadcast.type} · {broadcast.severity}</div>
            <div className="text-sm font-medium text-slate-900 mt-1">{broadcast.title}</div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-between">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 text-sm bg-rose-600 text-white rounded-lg hover:bg-rose-700"
          >
            {t('system.broadcast.revoke.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
