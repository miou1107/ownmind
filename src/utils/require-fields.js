/**
 * Site-wide API required-field validation helper (v1.19.19)
 *
 * Replaces the hand-written `if (!x || !y) return 400 "required fields: x, y"`
 * boilerplate in each endpoint. The returned payload includes missing / received /
 * expected, so clients (including the AI) can precisely diagnose the
 * "I thought I sent it but the server didn't receive it" scenario.
 *
 * Usage:
 *   const validation = requireFields(req.body, ['tool', 'model', 'summary']);
 *   if (validation) return res.status(400).json(validation);
 *
 * Security: known sensitive keys in received (password / token / secret / value etc.)
 * are automatically masked to '<REDACTED>'. Endpoints can add custom fields via
 * options.sensitiveKeys.
 */

const DEFAULT_SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd',
  'token', 'access_token', 'refresh_token',
  'secret', 'api_key', 'apikey',
  'value', // secret.js value field
];

export function requireFields(body, required, options = {}) {
  const received = (body && typeof body === 'object') ? body : {};
  const sensitiveKeys = new Set(
    [...DEFAULT_SENSITIVE_KEYS, ...(options.sensitiveKeys || [])].map(k => k.toLowerCase())
  );

  const missing = required.filter(f => {
    const v = received[f];
    if (v === undefined || v === null) return true;
    if (typeof v === 'string' && v === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  });

  if (missing.length === 0) return null;

  // mask sensitive fields in received
  const redacted = {};
  for (const [k, v] of Object.entries(received)) {
    redacted[k] = sensitiveKeys.has(k.toLowerCase()) ? '<REDACTED>' : v;
  }

  return {
    error: '必填欄位缺少',
    missing,
    expected: required,
    received: redacted,
  };
}
