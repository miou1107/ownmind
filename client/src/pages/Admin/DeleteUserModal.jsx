import { useState } from 'react';
import { Modal } from '../../components/common';
import { useT } from '../../i18n/LocaleContext';
import { apiDelete } from '../../api';

// Destructive action: red confirm button, plain text explanation, no clever
// safeguards beyond what the server enforces. The "delete is red, kept away
// from edit" project rule is honoured at the row-menu level; here it's just
// the confirmation gate.

export default function DeleteUserModal({ isOpen, onClose, user, onDeleted }) {
  const t = useT();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!user) return;
    setSubmitting(true);
    setError('');
    const r = await apiDelete(`/api/admin/users/${user.id}`);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.error || 'unknown_error');
      return;
    }
    onDeleted && onDeleted(user.id);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('team.delete.title')}
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
            {submitting ? t('common.submitting') : t('team.delete.confirm')}
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
        <p className="text-sm text-slate-700">
          {t('team.delete.body', { email: user?.email, name: user?.name || '—' })}
        </p>
        <p className="text-xs text-slate-500">{t('team.delete.warning')}</p>
      </div>
    </Modal>
  );
}
