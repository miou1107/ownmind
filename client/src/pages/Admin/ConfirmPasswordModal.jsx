import { useState, useEffect } from 'react';
import { Modal } from '../../components/common';
import { useT } from '../../i18n/LocaleContext';

// Asked when a copy or key replacement needs a login from the last 15 minutes and this one
// is older. onConfirm(password) does the whole thing — confirm, then copy — and rejects
// with err.wrongPassword when the password was wrong, so the box stays open to retry.
//
// onConfirm is called first thing in the click, with no await before it: the copy it
// starts has to begin inside the click for Safari to allow it.

export default function ConfirmPasswordModal({ isOpen, onClose, onConfirm }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) { setPassword(''); setSubmitting(false); setError(''); }
  }, [isOpen]);

  const submit = () => {
    if (!password || submitting) return;
    const done = onConfirm(password);
    setSubmitting(true);
    setError('');
    done.catch((err) => {
      setSubmitting(false);
      setError(err.message);
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      // Not closable mid-request: the copy finishing later would close whatever box was
      // opened in the meantime.
      onClose={submitting ? () => {} : onClose}
      title={t('team.reauth.title')}
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
            disabled={submitting || !password}
            className="px-4 py-2 text-sm bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
          >
            {submitting ? t('common.submitting') : t('team.reauth.confirm')}
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
        <p className="text-sm text-slate-600">{t('team.reauth.body')}</p>
        <label className="block">
          <span className="text-xs text-slate-600">{t('team.password.old')}</span>
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            className="mt-1 w-full px-3 py-2 border border-slate-200 rounded-lg text-sm"
          />
        </label>
      </div>
    </Modal>
  );
}
