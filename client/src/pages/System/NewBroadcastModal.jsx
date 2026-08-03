import { useState, useEffect } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { apiPost } from '../../api';
import { validateBroadcastFormClient } from './broadcast-payload-validate.js';

// v1.26.50 — 新增廣播 modal. Ports src/public/index.html:926-966 field-for-field
// into the console shell. Validates client-side via
// validateBroadcastFormClient (mirrors the server's own check) so an invalid
// submit does not spend a round-trip to learn what the issue is.

const INITIAL = {
  type: 'announcement',
  severity: 'info',
  title: '',
  body: '',
  cta_text: '',
  target_users: '',
  allow_snooze: false,
  snooze_hours: 24,
  cooldown_minutes: 1440,
  ends_at: '',
};

export default function NewBroadcastModal({ isOpen, onClose, onCreated }) {
  const t = useT();

  const [form, setForm] = useState(INITIAL);
  const [errorKey, setErrorKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setForm(INITIAL);
      setErrorKey('');
      setSubmitting(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const submit = async () => {
    setErrorKey('');
    const invalid = validateBroadcastFormClient(form);
    if (invalid) {
      setErrorKey(invalid);
      return;
    }

    const payload = {
      type: form.type,
      severity: form.severity,
      title: form.title.trim(),
      body: form.body.trim(),
      allow_snooze: Boolean(form.allow_snooze),
      snooze_hours: Number(form.snooze_hours) || 24,
      cooldown_minutes: Number(form.cooldown_minutes) || 1440,
    };
    if (form.cta_text.trim()) payload.cta_text = form.cta_text.trim();
    if (form.ends_at.trim()) payload.ends_at = form.ends_at.trim();

    const targetStr = String(form.target_users || '').trim();
    if (targetStr) {
      const ids = targetStr.split(/[,\s]+/).map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length > 0) payload.target_users = ids;
    }

    setSubmitting(true);
    const res = await apiPost('/api/broadcast/admin', payload);
    setSubmitting(false);
    if (!res.ok) {
      setErrorKey(res.error || 'submit_failed');
      return;
    }
    onCreated();
  };

  return (
    <div
      className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-xl shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-slate-900">{t('system.broadcast.modal.title')}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>

        <div className="p-5 space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.type')} <span className="text-rose-500">*</span>
            </label>
            <select
              value={form.type}
              onChange={(e) => set('type', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="announcement">{t('system.broadcast.type.announcement')}</option>
              <option value="maintenance">{t('system.broadcast.type.maintenance')}</option>
              <option value="rule_change">{t('system.broadcast.type.rule_change')}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.severity')}
            </label>
            <select
              value={form.severity}
              onChange={(e) => set('severity', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="info">info</option>
              <option value="warning">warning</option>
              <option value="critical">critical</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.title')} <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              maxLength={200}
              placeholder={t('system.broadcast.field.title_placeholder')}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.body')} <span className="text-rose-500">*</span>
            </label>
            <textarea
              value={form.body}
              onChange={(e) => set('body', e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder={t('system.broadcast.field.body_placeholder')}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.cta_text')}
            </label>
            <input
              type="text"
              value={form.cta_text}
              onChange={(e) => set('cta_text', e.target.value)}
              placeholder={t('system.broadcast.field.cta_text_placeholder')}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.target_users')}
            </label>
            <input
              type="text"
              value={form.target_users}
              onChange={(e) => set('target_users', e.target.value)}
              placeholder={t('system.broadcast.field.target_users_placeholder')}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-2 pt-4">
              <input
                id="allow-snooze"
                type="checkbox"
                checked={form.allow_snooze}
                onChange={(e) => set('allow_snooze', e.target.checked)}
              />
              <label htmlFor="allow-snooze" className="text-sm text-slate-700">
                {t('system.broadcast.field.allow_snooze')}
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                {t('system.broadcast.field.snooze_hours')}
              </label>
              <input
                type="number"
                min={1}
                value={form.snooze_hours}
                onChange={(e) => set('snooze_hours', e.target.value)}
                disabled={!form.allow_snooze}
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm disabled:bg-slate-100"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.cooldown_minutes')}
            </label>
            <input
              type="number"
              min={0}
              value={form.cooldown_minutes}
              onChange={(e) => set('cooldown_minutes', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">
              {t('system.broadcast.field.ends_at')}
            </label>
            <input
              type="text"
              value={form.ends_at}
              onChange={(e) => set('ends_at', e.target.value)}
              placeholder={t('system.broadcast.field.ends_at_placeholder')}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>

          {errorKey && (
            <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-sm text-rose-700">
              {t(`system.broadcast.error.${errorKey}`) || errorKey}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t border-slate-200 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={submitting}
            className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50"
          >
            {submitting ? t('system.broadcast.modal.submitting') : t('system.broadcast.modal.submit')}
          </button>
        </div>
      </div>
    </div>
  );
}
