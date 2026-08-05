// v1.26.62 — turns the 新增廣播 form state into the request body.
//
// Pulled out of the modal's submit handler so the claim this release rests on
// — the payload says what the screen says — is tested rather than eyeballed.
// Both changed fields are *derived* now: recipients from a chosen member list,
// the end time from a zone-less field value. Derivation is where a payload
// quietly stops matching the form, so it lives somewhere a test can reach.

import { localToIso } from './broadcast-ends-at.js';

/**
 * @param {object} form  The modal's live form state.
 * @param {Array<{id:number}>} selected  Members picked in the recipient field.
 * @returns {object} The body for `POST /api/broadcast/admin`. Optional fields
 *   are omitted rather than sent empty, because the server reads an absent
 *   `target_users` as "everyone" and an absent `ends_at` as "permanent".
 */
export function buildBroadcastPayload(form, selected) {
  const payload = {
    type: form.type,
    severity: form.severity,
    title: String(form.title ?? '').trim(),
    body: String(form.body ?? '').trim(),
    allow_snooze: Boolean(form.allow_snooze),
    snooze_hours: Number(form.snooze_hours) || 24,
    cooldown_minutes: numberOr(form.cooldown_minutes, 1440),
  };

  const cta = String(form.cta_text ?? '').trim();
  if (cta) payload.cta_text = cta;

  const endsAt = localToIso(form.ends_at);
  if (endsAt) payload.ends_at = endsAt;

  if (Array.isArray(selected) && selected.length > 0) {
    payload.target_users = selected.map((m) => m.id);
  }

  return payload;
}

/**
 * `Number(v) || fallback` is wrong wherever zero is a legitimate value, and for
 * cooldown it is: the field accepts 0 and the validator rejects only negatives,
 * so an admin typing 0 for "repeatable immediately" was silently given 1440.
 */
function numberOr(value, fallback) {
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
