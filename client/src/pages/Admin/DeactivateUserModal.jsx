import { useState } from 'react';
import { Modal } from '../../components/common';
import { useT } from '../../i18n/LocaleContext';
import { apiPost } from '../../api';

// Turning an account off (src/routes/admin-account-status.js). Unlike delete it can be
// undone, so the box says what stops working and that the data stays.

export default function DeactivateUserModal({ isOpen, onClose, user, onDone }) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!user) return;
    setSubmitting(true);
    setError('');
    const r = await apiPost(`/api/admin/users/${user.id}/deactivate`);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.error || 'unknown_error');
      return;
    }
    onDone && onDone(user);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? () => {} : onClose}
      title={t('team.deactivate.title', { email: user?.email })}
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
            disabled={submitting}
            className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50"
          >
            {submitting ? t('common.submitting') : t('team.menu.deactivate')}
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
        <p className="text-sm text-slate-700">{t('team.deactivate.body')}</p>
      </div>
    </Modal>
  );
}
