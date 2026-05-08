import { query as defaultQuery } from '../utils/db.js';
import defaultLogger from '../utils/logger.js';

/**
 * 把 api_key mask 成可辨識但不洩漏全文的字串。
 * 用於 401 觀測 log，admin 看 prefix-suffix 能跟 users 表反查、又不會把 key 寫進 docker logs。
 *
 * 格式：
 *   - ''/null/undefined → '<empty>'
 *   - 長度 < 12 → '<too-short:N>'
 *   - 長度 ≥ 12 → '前4...後4 (len=N)'
 *
 * 為什麼 12 不是 8：對 8 char key（如 Adam 殘留的 "--update"），slice(0,4)+slice(-4)
 * 會等於整串原文（三個點之間沒遮到任何字元），admin 從 docker logs 直接看到 key 全文。
 * 12 是「中間至少還有 4 char 被遮掉」的最低值。len < 12 的 key 不算合法 OwnMind key
 * （UUID 36、custom prefix ≥ 20），這種 case 由 self-check 的 checkApiKeyFormat 在
 * client 端先抓出來，這裡只負責不在 server log 上洩漏全文即可。
 */
export function maskApiKey(key) {
  if (typeof key !== 'string' || key === '') return '<empty>';
  if (key.length < 12) return `<too-short:${key.length}>`;
  return `${key.slice(0, 4)}...${key.slice(-4)} (len=${key.length})`;
}

/**
 * API Key 認證中介層
 *
 * v1.17.68 IR-038：401 path 加 logger.warn('auth_failed', {...})。
 * 背景：Adam 從 2026-03-26 到 2026-05-08 都吃 401（settings.json 殘留 "--update"），
 * 因為舊版 auth 401 path 沒留結構化 log，admin 從 docker logs 只看到 access log
 * 「POST /api/usage/events 401 3ms」，看不出是誰、key prefix 也沒留。
 *
 * 第 4 個參數 `deps` 為測試注入點：tests 可傳 { logger, query } 覆蓋預設依賴，
 * 不影響 production 呼叫者（route handler 仍以 (req, res, next) 三個參數呼叫）。
 *
 * NB: deps 必須用 default param（`= {}`），不能寫成 positional，這樣 fn.length === 3，
 *     Express 不會把這支 middleware 當 error handler 來叫（error handler 是 4 args
 *     `(err, req, res, next)`）。改 signature 時保留這個不變式。
 */
export default async function auth(req, res, next, deps = {}) {
  const logger = deps.logger || defaultLogger;
  const query = deps.query || defaultQuery;

  const logAuthFailure = (maskedKey) => {
    try {
      // x-forwarded-for 可能是 'client, proxy1, proxy2' 鏈，
      // 401 forensics 要的是最左邊那個 client IP（reviewer M3）。
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
      // log 失敗不能影響 auth 回應
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
    logger.error('認證失敗', { error: err.message });
    res.status(500).json({ error: '認證過程發生錯誤' });
  }
}
