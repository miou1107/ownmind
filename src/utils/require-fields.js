/**
 * 全站 API 必填欄位驗證 helper（v1.19.19）
 *
 * 取代各 endpoint 各自手寫的 `if (!x || !y) return 400 「必填欄位：x, y」` 樣板。
 * 回的 payload 含 missing / received / expected、讓客戶端（含 AI）能精準診斷
 * 「我以為傳了但 server 沒收到」的場景。
 *
 * 用法：
 *   const validation = requireFields(req.body, ['tool', 'model', 'summary']);
 *   if (validation) return res.status(400).json(validation);
 *
 * 安全：received 中已知敏感 key（password / token / secret / value 等）自動
 * 遮蔽成 '<REDACTED>'。endpoint 可透過 options.sensitiveKeys 加客製欄位。
 */

const DEFAULT_SENSITIVE_KEYS = [
  'password', 'passwd', 'pwd',
  'token', 'access_token', 'refresh_token',
  'secret', 'api_key', 'apikey',
  'value', // secret.js 的 value 欄位
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

  // 遮蔽 received 中的敏感欄位
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
