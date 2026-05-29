import { query as defaultQuery } from '../utils/db.js';
import defaultLogger from '../utils/logger.js';

/**
 * Mask an api_key into an identifiable string that doesn't leak the full value.
 * Used in 401 observation logs: an admin can cross-reference the prefix-suffix against
 * the users table without the key being written into docker logs.
 *
 * Format:
 *   - ''/null/undefined → '<empty>'
 *   - length < 12 → '<too-short:N>'
 *   - length ≥ 12 → 'first4...last4 (len=N)'
 *
 * Why 12 and not 8: for an 8-char key (like Bob's leftover "--update"), slice(0,4)+slice(-4)
 * would equal the whole original (nothing is masked between the dots), and the admin would
 * see the full key directly in docker logs. 12 is the minimum where "at least 4 chars in the
 * middle are masked". A key with len < 12 is not a valid OwnMind key (UUID is 36, custom
 * prefix ≥ 20); that case is caught client-side first by the self-check's checkApiKeyFormat,
 * so here we just need to not leak the full value in the server log.
 */
export function maskApiKey(key) {
  if (typeof key !== 'string' || key === '') return '<empty>';
  if (key.length < 12) return `<too-short:${key.length}>`;
  return `${key.slice(0, 4)}...${key.slice(-4)} (len=${key.length})`;
}

/**
 * API Key authentication middleware
 *
 * v1.17.68: the 401 path adds logger.warn('auth_failed', {...}).
 * Background: Bob got 401s from 2026-03-26 to 2026-05-08 (settings.json had a leftover
 * "--update"), because the old auth 401 path kept no structured log, so the admin only
 * saw the access log "POST /api/usage/events 401 3ms" in docker logs — no way to tell
 * who it was, and no key prefix recorded.
 *
 * The 4th parameter `deps` is the test injection point: tests can pass { logger, query }
 * to override the default dependencies, without affecting production callers (the route
 * handler still calls with the three (req, res, next) parameters).
 *
 * NB: deps must use a default param (`= {}`), not positional, so that fn.length === 3 and
 *     Express does not call this middleware as an error handler (error handlers have 4 args
 *     `(err, req, res, next)`). Preserve this invariant when changing the signature.
 */
export default async function auth(req, res, next, deps = {}) {
  const logger = deps.logger || defaultLogger;
  const query = deps.query || defaultQuery;

  const logAuthFailure = (maskedKey) => {
    try {
      // x-forwarded-for may be a 'client, proxy1, proxy2' chain;
      // 401 forensics wants the leftmost client IP (reviewer M3).
      const xff = req.headers?.['x-forwarded-for'];
      const xffFirst = xff ? String(xff).split(',')[0].trim() : null;
      logger.warn('auth_failed', {
        route: req.path || req.originalUrl || '<unknown>',
        ip: req.ip || xffFirst || req.connection?.remoteAddress || '<unknown>',
        masked_key: maskedKey,
        ua: (req.headers?.['user-agent'] || req.get?.('user-agent') || '<unknown>')
          .toString()
          .slice(0, 80),
      });
    } catch {
      // a logging failure must not affect the auth response
    }
  };

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logAuthFailure('<no-bearer>');
      return res.status(401).json({ error: '未提供認證令牌' });
    }

    const apiKey = authHeader.slice(7);

    const result = await query(
      'SELECT id, email, name, role, settings, created_at FROM users WHERE api_key = $1',
      [apiKey]
    );

    if (result.rows.length === 0) {
      logAuthFailure(maskApiKey(apiKey));
      return res.status(401).json({ error: '無效的 API Key' });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    logger.error('Authentication error', { error: err.message });
    res.status(500).json({ error: '認證過程發生錯誤' });
  }
}
