import { useState, useEffect } from 'react';
import { Modal } from '../../components/common';
import { useT } from '../../i18n/LocaleContext';
import { apiPost } from '../../api';

// Self-change vs super_admin-resetting-other. The two shapes differ only in
// whether oldPassword is asked (and sent). The server also enforces the
// distinction at src/routes/admin.js:345-357.

export default function PasswordModal({ isOpen, onClose, user, isSelfChange, onDone }) {
  const t = useT();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setOldPassword(''); setNewPassword(''); setConfirm('');
      setSubmitting(false); setError('');
    }
  }, [isOpen]);

  const submit = async () => {
    if (!user) return;
    if (newPassword !== confirm) {
      setError(t('team.password.mismatch'));
      return;
    }
    if (newPassword.length < 8) {
      setError(t('team.password.too_short'));
      return;
    }
    setSubmitting(true);
    setError('');
    const body = { newPassword };
    if (isSelfChange) body.oldPassword = oldPassword;
    const r = await apiPost(`/api/admin/users/${user.id}/password`, body);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.error || 'unknown_error');
      return;
    }
    onDone && onDone();
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isSelfChange ? t('team.password.self_title') : t('team.password.reset_title')}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={submitting || !newPassword || !confirm}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? t('common.submitting') : t('common.save')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-2 text-xs text-red-700">
            {error}
          </div>
        ) : null}
        {!isSelfChange && (
          <p className="text-xs text-slate-500">
            {t('team.password.reset_body', { email: user?.email })}
          </p>
        )}
        {isSelfChange && (
          <label className="block">
            <span className="text-xs text-slate-600">{t('team.password.old')}</span>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            />
          </label>
        )}
        <label className="block">
          <span className="text-xs text-slate-600">{t('team.password.new')}</span>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-600">{t('team.password.confirm')}</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
