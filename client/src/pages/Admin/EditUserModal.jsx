import { useState, useEffect } from 'react';
import { Modal } from '../../components/common';
import { useT } from '../../i18n/LocaleContext';
import { apiPut } from '../../api';

// Edit name and role. Email is read-only in this stage — server allows it,
// legacy UI never exposed it, and enabling it without an audit trail change
// on the server is a bigger scope than this stage carries.

export default function EditUserModal({ isOpen, onClose, user, onSaved, actorCanEditRole }) {
  const t = useT();
  const [name, setName] = useState('');
  const [role, setRole] = useState('user');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setRole(user.role);
      setError('');
    }
  }, [user]);

  const submit = async () => {
    if (!user) return;
    setSubmitting(true);
    setError('');
    const body = {};
    if (name !== (user.name || '')) body.name = name;
    if (role !== user.role) body.role = role;
    if (Object.keys(body).length === 0) { onClose(); return; }
    const r = await apiPut(`/api/admin/users/${user.id}`, body);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.error || 'unknown_error');
      return;
    }
    onSaved && onSaved(r.data);
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('team.edit.title')}
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
        <label className="block">
          <span className="text-xs text-slate-600">{t('team.field.email')}</span>
          <input
            type="email"
            value={user?.email || ''}
            disabled
            className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-50 text-slate-500"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-600">{t('team.field.name')}</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
          />
        </label>
        <label className="block">
          <span className="text-xs text-slate-600">{t('team.field.role')}</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            disabled={!actorCanEditRole}
            className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm disabled:bg-slate-50"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
            <option value="super_admin">super_admin</option>
          </select>
          {!actorCanEditRole && (
            <span className="text-xs text-slate-500 mt-1 block">
              {t('team.edit.role_locked')}
            </span>
          )}
        </label>
      </div>
    </Modal>
  );
}
