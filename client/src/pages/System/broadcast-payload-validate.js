// v1.26.50 — client-side validator for POST /broadcast/admin. Mirrors the
// server's validateBroadcastPayload at src/routes/broadcast.js so an invalid
// submit fails fast without a network round-trip. Server still checks its
// own rules for defence in depth.
//
// Returns null on valid, a stable string key on invalid. The key is not the
// end-user text — the page maps it through i18n so error phrasing lives in
// zh.json / en.json / ja.json.

const VALID_TYPES = new Set(['announcement', 'upgrade_reminder', 'maintenance', 'rule_change']);
const VALID_SEVERITY = new Set(['info', 'warning', 'critical']);

/**
 * @param {object} form  The modal's live form state.
 * @returns {string|null}
 */
export function validateBroadcastFormClient(form) {
  if (!form || typeof form !== 'object') return 'form_missing';

  if (!VALID_TYPES.has(form.type)) return 'type_invalid';
  if (form.severity && !VALID_SEVERITY.has(form.severity)) return 'severity_invalid';

  const title = String(form.title || '').trim();
  if (title.length === 0) return 'title_required';
  if (title.length > 200) return 'title_too_long';

  const body = String(form.body || '').trim();
  if (body.length === 0) return 'body_required';
  if (body.length > 2000) return 'body_too_long';

  if (form.allow_snooze) {
    const h = Number(form.snooze_hours);
    if (!Number.isFinite(h) || h <= 0) return 'snooze_hours_invalid';
  }

  if (form.cooldown_minutes !== undefined && form.cooldown_minutes !== null && form.cooldown_minutes !== '') {
    const c = Number(form.cooldown_minutes);
    if (!Number.isFinite(c) || c < 0) return 'cooldown_minutes_invalid';
  }

  if (form.ends_at) {
    const d = new Date(form.ends_at);
    if (!Number.isFinite(d.getTime())) return 'ends_at_invalid';
  }

  if (form.target_users && String(form.target_users).trim().length > 0) {
    const parts = String(form.target_users).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    for (const p of parts) {
      const n = Number(p);
      if (!Number.isInteger(n) || n <= 0) return 'target_users_invalid';
    }
  }

  return null;
}
