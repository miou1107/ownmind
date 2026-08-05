import { useState, useEffect, useRef } from 'react';
import { useT } from '../../i18n/LocaleContext';
import { apiGet, apiPost } from '../../api';
import { validateBroadcastFormClient } from './broadcast-payload-validate.js';
import { filterMembers } from './broadcast-recipient-filter.js';
import { defaultEndsAtLocal } from './broadcast-ends-at.js';
import { buildBroadcastPayload } from './broadcast-payload-build.js';

// v1.26.50 — 新增廣播 modal. Ports src/public/index.html:926-966 field-for-field
// into the console shell. Validates client-side via
// validateBroadcastFormClient (mirrors the server's own check) so an invalid
// submit does not spend a round-trip to learn what the issue is.
//
// v1.26.62 — two fields stop speaking schema:
//   * Recipients are picked by name from `/api/admin/users` instead of typed
//     as user_id. Ids never appear in the interface; they are resolved on
//     submit, so the API contract is untouched.
//   * The end time is a date picker prefilled 30 days out, replacing a text
//     box that defaulted to blank — and blank meant permanent, which is why
//     every broadcast on the page reads 永久.
// `target_users` is deliberately no longer fed to validateBroadcastFormClient:
// ids now come from a list of real members, so its `target_users_invalid`
// branch is unreachable from here. That function still mirrors the server's
// rule and keeps its own tests.

function makeInitial() {
  return {
    type: 'announcement',
    severity: 'info',
    title: '',
    body: '',
    cta_text: '',
    allow_snooze: false,
    snooze_hours: 24,
    cooldown_minutes: 1440,
    // Computed per open, not held in a module constant, so a dialog opened
    // tomorrow defaults to 30 days from tomorrow.
    ends_at: defaultEndsAtLocal(new Date()),
  };
}

export default function NewBroadcastModal({ isOpen, onClose, onCreated }) {
  const t = useT();

  const [form, setForm] = useState(makeInitial);
  const [errorKey, setErrorKey] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [members, setMembers] = useState([]);
  const [membersState, setMembersState] = useState('loading'); // loading | ready | failed
  const [selected, setSelected] = useState([]);
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const queryRef = useRef(null);
  const listRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    setForm(makeInitial());
    setErrorKey('');
    setSubmitting(false);
    setSelected([]);
    setQuery('');
    setMenuOpen(false);
    setMembersState('loading');

    let cancelled = false;
    apiGet('/api/admin/users').then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setMembersState('failed');
        return;
      }
      setMembers(res.data || []);
      setMembersState('ready');
    });
    return () => { cancelled = true; };
  }, [isOpen]);

  if (!isOpen) return null;

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const suggestions = filterMembers(members, query, selected.map((m) => m.id));
  const active = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));

  const pick = (member) => {
    // Guarded against re-adding: holding Enter fires the handler faster than
    // React re-renders, so `suggestions[0]` is still the same person on the
    // second shot and the payload would carry a duplicate id.
    setSelected((s) => (s.some((m) => m.id === member.id) ? s : [...s, member]));
    setQuery('');
    setActiveIndex(0);
    queryRef.current?.focus();
  };

  const unpick = (id) => setSelected((s) => s.filter((m) => m.id !== id));

  const onQueryKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setMenuOpen(true);
      setActiveIndex((i) => (suggestions.length === 0 ? 0 : (i + 1) % suggestions.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (suggestions.length === 0 ? 0 : (i - 1 + suggestions.length) % suggestions.length));
    } else if (e.key === 'Enter' && menuOpen && suggestions[active]) {
      e.preventDefault();
      pick(suggestions[active]);
    } else if (e.key === 'Escape') {
      setMenuOpen(false);
    }
  };

  const submit = async () => {
    setErrorKey('');
    const invalid = validateBroadcastFormClient(form);
    if (invalid) {
      setErrorKey(invalid);
      return;
    }

    const payload = buildBroadcastPayload(form, selected);

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
            <div
              className="w-full border border-slate-300 rounded-lg px-2 py-1 flex flex-wrap gap-1.5 items-center min-h-[38px]"
              onClick={() => queryRef.current?.focus()}
            >
              {selected.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 text-sm rounded px-2 py-0.5"
                >
                  {m.name || m.email}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); unpick(m.id); }}
                    aria-label={t('system.broadcast.field.remove_recipient', { name: m.name || m.email })}
                    className="text-emerald-600 hover:text-emerald-900"
                  >
                    ✕
                  </button>
                </span>
              ))}
              <input
                ref={queryRef}
                type="text"
                value={query}
                disabled={membersState !== 'ready'}
                role="combobox"
                aria-expanded={menuOpen && suggestions.length > 0}
                aria-controls="broadcast-recipient-listbox"
                aria-activedescendant={
                  menuOpen && suggestions[active] ? `broadcast-recipient-opt-${suggestions[active].id}` : undefined
                }
                autoComplete="off"
                onChange={(e) => { setQuery(e.target.value); setMenuOpen(true); setActiveIndex(0); }}
                onFocus={() => setMenuOpen(true)}
                // relatedTarget, not a setTimeout. Clicking an option cannot
                // blur this input anyway — the option's onMouseDown prevents
                // default — so the old 120ms delay guarded nothing and instead
                // tore the list out from under anyone who reached it with Tab.
                onBlur={(e) => { if (!listRef.current?.contains(e.relatedTarget)) setMenuOpen(false); }}
                onKeyDown={onQueryKeyDown}
                placeholder={
                  membersState === 'loading'
                    ? t('system.broadcast.field.members_loading')
                    : t('system.broadcast.field.target_users_placeholder')
                }
                className="flex-1 min-w-[140px] text-sm px-1 py-1 outline-none disabled:bg-transparent"
              />
            </div>

            {menuOpen && suggestions.length > 0 && (
              <ul
                ref={listRef}
                id="broadcast-recipient-listbox"
                role="listbox"
                className="border border-slate-200 rounded-lg mt-1 max-h-48 overflow-y-auto divide-y divide-slate-100"
              >
                {suggestions.map((m, i) => (
                  <li key={m.id} role="option" id={`broadcast-recipient-opt-${m.id}`} aria-selected={i === active}>
                    <button
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); pick(m); }}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`w-full text-left px-3 py-2 text-sm flex justify-between gap-3 ${
                        i === active ? 'bg-slate-100' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className="text-slate-800">{m.name || '—'}</span>
                      <span className="text-slate-400">{m.email}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {membersState === 'failed' ? (
              <p className="text-xs text-rose-600 mt-1">
                {t('system.broadcast.field.members_load_failed')}
              </p>
            ) : (
              <p className="text-xs text-slate-500 mt-1">
                {selected.length === 0
                  ? t('system.broadcast.field.target_users_all')
                  : t('system.broadcast.field.target_users_count', { count: selected.length })}
              </p>
            )}
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
              type="datetime-local"
              value={form.ends_at}
              onChange={(e) => set('ends_at', e.target.value)}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
            <p className="text-xs text-slate-500 mt-1">
              {t('system.broadcast.field.ends_at_hint')}
            </p>
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
