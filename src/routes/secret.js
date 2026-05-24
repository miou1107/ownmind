import { Router } from 'express';
import { query } from '../utils/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { requireFields } from '../utils/require-fields.js';

const router = Router();
router.use(auth);

/**
 * GET / - 列出所有 secret keys（不含值）
 */
router.get('/', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, key, description FROM secrets
       WHERE user_id = $1
       ORDER BY key`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('列出 secrets 失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * GET /:key - 取得 secret 值（解密）
 */
router.get('/:key', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, key, encrypted_value, description FROM secrets
       WHERE key = $1 AND user_id = $2`,
      [req.params.key, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該 secret' });
    }

    const secret = result.rows[0];
    const decryptedValue = decrypt(secret.encrypted_value);

    logger.info('Secret 被存取', { key: req.params.key, user_id: req.user.id });

    res.json({
      id: secret.id,
      key: secret.key,
      value: decryptedValue,
      description: secret.description
    });
  } catch (err) {
    logger.error('取得 secret 失敗', { error: err.message });
    res.status(500).json({ error: '取得 secret 失敗' });
  }
});

/**
 * POST / - 建立或更新 secret（upsert）
 *
 * v1.17.91: 行為 = upsert（ON CONFLICT DO UPDATE）。
 *
 * Description 語意：
 *   - 沒帶 description 或 description = null 時 → 保留既有 description 不蓋
 *   - 帶非 null description → 覆蓋
 *   - **想清空 description 請用 PUT /:key 明確帶 description: null**（POST 無法清空）
 *
 * 為什麼這樣設計：set_secret 主要使用情境是 AI 主動寫 secret、AI 不一定每次都
 * 帶 description；如果 POST 把沒帶當清空、AI 不小心會把使用者手動寫的 description
 * 洗掉。要清空是 explicit action、走 PUT。
 */
router.post('/', async (req, res) => {
  try {
    const validation = requireFields(req.body, ['key', 'value']);
    if (validation) return res.status(400).json(validation);

    const { key, value, description } = req.body;

    const encryptedValue = encrypt(value);

    // v1.17.91: POST 改成 upsert（ON CONFLICT DO UPDATE）
    // 修法背景：MCP `ownmind_set_secret` 描述寫「儲存或更新」、但舊版 POST
    // 純 INSERT、重複 set 同 key 會 23505 unique violation 直接 500、AI 想改
    // secret 會炸。改 upsert 跟工具描述對齊、也避免邊界錯誤。
    // description 用 COALESCE(EXCLUDED, secrets.description) — 呼叫端沒帶
    // description 時保留原值不蓋成 null。
    const result = await query(
      `INSERT INTO secrets (user_id, key, encrypted_value, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, key) DO UPDATE
       SET encrypted_value = EXCLUDED.encrypted_value,
           description = COALESCE(EXCLUDED.description, secrets.description),
           updated_at = NOW()
       RETURNING id, key, description, (xmax = 0) AS inserted`,
      [req.user.id, key, encryptedValue, description || null]
    );

    // v1.17.91: 寫 activity_log audit（IR-002 不洩漏 value、只記 key + 動作 + 是新增還是更新）
    const row = result.rows[0];
    try {
      await query(
        `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
         VALUES ($1, NOW(), 'secret_set', 'server', 'api', $2)`,
        [req.user.id, JSON.stringify({ key, action: row.inserted ? 'create' : 'update' })]
      );
    } catch (e) {
      // v1.17.91 reviewer M-2: 用 error level 讓 audit 失敗能被 alert 抓到
      // （這是 secret 操作、audit 缺漏比一般 log 嚴重）
      logger.error('secret_set activity_log 寫入失敗（不阻擋主流程）', { error: e.message });
    }

    res.status(row.inserted ? 201 : 200).json({
      id: row.id, key: row.key, description: row.description,
    });
  } catch (err) {
    logger.error('建立/更新 secret 失敗', { error: err.message });
    res.status(500).json({ error: '建立/更新 secret 失敗' });
  }
});

/**
 * PUT /:key - 更新 secret
 */
router.put('/:key', async (req, res) => {
  try {
    const { value, description } = req.body;

    const updates = [];
    const params = [];
    let paramIndex = 1;

    if (value) {
      updates.push(`encrypted_value = $${paramIndex++}`);
      params.push(encrypt(value));
    }
    if (description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      params.push(description);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '請提供要更新的欄位' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(req.params.key, req.user.id);

    const result = await query(
      `UPDATE secrets
       SET ${updates.join(', ')}
       WHERE key = $${paramIndex++} AND user_id = $${paramIndex}
       RETURNING id, key, description`,
      params
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該 secret' });
    }

    // v1.17.91: PUT 也要寫 activity_log audit（v1.17.91 first round 漏掉、reviewer I-1 抓到）
    // 記哪些欄位被改、但不記具體值（IR-002 不洩漏 secret material）
    const changedFields = [];
    if (req.body.value !== undefined) changedFields.push('value');
    if (req.body.description !== undefined) changedFields.push('description');
    try {
      await query(
        `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
         VALUES ($1, NOW(), 'secret_update', 'server', 'api', $2)`,
        [req.user.id, JSON.stringify({ key: req.params.key, changed_fields: changedFields })]
      );
    } catch (e) {
      logger.error('secret_update activity_log 寫入失敗（不阻擋主流程）', { error: e.message });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('更新 secret 失敗', { error: err.message });
    res.status(500).json({ error: '更新 secret 失敗' });
  }
});

/**
 * DELETE /:key - 刪除 secret
 */
router.delete('/:key', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM secrets WHERE key = $1 AND user_id = $2 RETURNING id, key',
      [req.params.key, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該 secret' });
    }

    // v1.17.91: 寫 activity_log audit（IR-002 不洩漏 value、只記 key + 動作）
    try {
      await query(
        `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
         VALUES ($1, NOW(), 'secret_delete', 'server', 'api', $2)`,
        [req.user.id, JSON.stringify({ key: result.rows[0].key })]
      );
    } catch (e) {
      // v1.17.91 reviewer M-2: 改 error level（secret audit 缺漏比一般 log 嚴重）
      logger.error('secret_delete activity_log 寫入失敗（不阻擋主流程）', { error: e.message });
    }

    res.json({ message: 'Secret 已刪除', key: result.rows[0].key });
  } catch (err) {
    logger.error('刪除 secret 失敗', { error: err.message });
    res.status(500).json({ error: '刪除 secret 失敗' });
  }
});

export default router;
