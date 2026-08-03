import { useState, useEffect } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { apiPost } from '../../api';

// v1.26.51 — spam suspect confirm / dismiss modal. Two actions:
//   - 不是 spam · 撤銷 → POST /spam-suspects/:id/dismiss (secondary)
//   - 確認 spam · 封鎖 24 小時 → POST /spam-suspects/:id/confirm (destructive)
//
// Destructive button styled red and separated from cancel per project rule.

export default function SpamSuspectModal({ suspect, userLabel, onCancel, onDone }) {
  const t = useT();

  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (suspect) {
      setReason('');
      setSubmitting(false);
      setErrorMsg('');
    }
  }, [suspect]);

  if (!suspect) return null;

  const confirmSpam = async () => {
    setErrorMsg('');
    setSubmitting(true);
    const res = await apiPost(`/api/bug-reports/spam-suspects/${suspect.id}/confirm`, {
      reason: reason.trim() || null,
    });
    setSubmitting(false);
    if (!res.ok) {
      setErrorMsg(res.error || 'confirm_failed');
      return;
    }
    onDone(t('bug_reports.spam.toast.confirmed'));
  };

  const dismissSuspect = async () => {
    setErrorMsg('');
    setSubmitting(true);
    const res = await apiPost(`/api/bug-reports/spam-suspects/${suspect.id}/dismiss`, {});
    setSubmitting(false);
    if (!res.ok) {
      setErrorMsg(res.error || 'dismiss_failed');
      return;
    }
    onDone(t('bug_reports.spam.toast.dismissed'));
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-slate-200">
          <h3 className="text-lg font-semibold text-slate-900">
            {t('bug_reports.spam.modal.title')} <span className="text-slate-400 font-normal">#{suspect.id}</span>
          </h3>
        </div>

        <div className="p-5 space-y-3 text-sm">
          <div>
            <span className="text-slate-500">{t('bug_reports.spam.modal.user')}: </span>
            <span className="font-medium text-slate-900">{userLabel}</span>
          </div>
          <div>
            <span className="text-slate-500">{t('bug_reports.spam.modal.rule')}: </span>
            <code className="text-xs">{suspect.trigger_rule}</code>
          </div>
          <div>
            <span className="text-slate-500">{t('bug_reports.spam.modal.report_ids')}: </span>
            {(suspect.report_ids || []).join(', ') || '—'}
          </div>

          <p className="text-xs text-slate-500 leading-relaxed">
            {t('bug_reports.spam.modal.explain')}
          </p>

          <div className="space-y-1">
            <label className="text-xs text-slate-500 block">
              {t('bug_reports.spam.modal.reason_label')}
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder={t('bug_reports.spam.modal.reason_placeholder')}
              className="border border-slate-300 rounded-md px-2 py-1.5 text-sm w-full"
            />
          </div>

          {errorMsg && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700">
              {errorMsg}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-between">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={dismissSuspect}
              disabled={submitting}
              className="px-3 py-2 text-sm text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
            >
              {t('bug_reports.spam.action.dismiss')}
            </button>
            <button
              onClick={confirmSpam}
              disabled={submitting}
              className="px-3 py-2 text-sm bg-rose-600 text-white rounded-lg hover:bg-rose-700 disabled:opacity-50"
            >
              {t('bug_reports.spam.action.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
