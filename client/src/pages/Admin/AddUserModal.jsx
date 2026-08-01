import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Modal } from '../../components/common';
import { useT } from '../../i18n/LocaleContext';
import { apiPost } from '../../api';

// Two-shape modal:
//   1. entry form → POST /api/admin/users
//   2. if the server returns default_password, the form is replaced with a
//      one-shot panel; the password is shown exactly once. Closing the modal
//      cannot recall it. This matches the server's one-shot contract at
//      src/routes/admin.js:172-195.

export default function AddUserModal({ isOpen, onClose, onCreated, actorCanCreateSuperAdmin }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('user');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [defaultPassword, setDefaultPassword] = useState(null);

  const needsPassword = role === 'admin' || role === 'super_admin';

  const close = () => {
    setEmail(''); setName(''); setRole('user'); setPassword('');
    setError(''); setDefaultPassword(null); setSubmitting(false);
    onClose();
  };

  const submit = async () => {
    setSubmitting(true);
    setError('');
    const body = { email, name: name || null, role };
    if (needsPassword && password) body.password = password;
    const r = await apiPost('/api/admin/users', body);
    setSubmitting(false);
    if (!r.ok) {
      setError(r.error || 'unknown_error');
      return;
    }
    if (r.data?.default_password) {
      setDefaultPassword({ email: r.data.email, password: r.data.default_password });
    } else {
      onCreated && onCreated(r.data);
      close();
      return;
    }
    onCreated && onCreated(r.data);
  };

  const copyOneShot = async () => {
    if (!defaultPassword) return;
    try {
      await navigator.clipboard.writeText(defaultPassword.password);
    } catch { /* clipboard blocked; the value is visible on screen */ }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={close}
      title={defaultPassword ? t('team.add.oneshot_title') : t('team.add.title')}
      footer={
        defaultPassword ? (
          <button
            onClick={close}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800"
          >
            {t('common.close')}
          </button>
        ) : (
          <>
            <button
              onClick={close}
              disabled={submitting}
              className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={submit}
              disabled={submitting || !email}
              className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {submitting ? t('common.submitting') : t('common.submit')}
            </button>
          </>
        )
      }
    >
      {defaultPassword ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-700">{t('team.add.oneshot_body')}</p>
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="text-xs text-amber-700 mb-1">{defaultPassword.email}</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-sm font-mono text-amber-900 select-all break-all">
                {defaultPassword.password}
              </code>
              <button
                onClick={copyOneShot}
                className="p-1.5 text-amber-700 hover:text-amber-900"
                aria-label={t('common.copy')}
              >
                <Copy size={14} />
              </button>
            </div>
          </div>
          <p className="text-xs text-slate-500">{t('team.add.oneshot_warning')}</p>
        </div>
      ) : (
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
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
              required
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
              className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
              {actorCanCreateSuperAdmin && <option value="super_admin">super_admin</option>}
            </select>
          </label>
          {needsPassword && (
            <label className="block">
              <span className="text-xs text-slate-600">{t('team.field.password')}</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
                required
              />
              <span className="text-xs text-slate-500 mt-1 block">
                {t('team.field.password_required_hint')}
              </span>
            </label>
          )}
          {!needsPassword && (
            <p className="text-xs text-slate-500">{t('team.field.password_autogen_hint')}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
