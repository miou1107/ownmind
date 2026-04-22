import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import { superAdminAuth as defaultSuperAdminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';

/**
 * Factory：回傳 pricing router。
 * Tests 可注入 mock deps；production code 走 default exports。
 *
 * @param {{ query?: Function, auth?: Function, superAdminAuth?: Function }} deps
 */
export function createPricingRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;
  const superAdminAuth = deps.superAdminAuth ?? defaultSuperAdminAuth;

  const router = Router();

  /**
   * GET /api/usage/pricing
   * 所有已登入 user 皆可讀取（列出所有 effective_date 版本）
   */
  router.get('/', auth, async (req, res) => {
    try {
      const result = await query(
        `SELECT id, tool, model, input_per_1m, output_per_1m,
                cache_write_per_1m, cache_read_per_1m, effective_date, notes, created_at
           FROM model_pricing
          ORDER BY tool ASC, model ASC, effective_date DESC`
      );
      res.json(result.rows);
    } catch (err) {
      logger.error('查詢 pricing 失敗', { error: err.message });
      res.status(500).json({ error: '查詢定價失敗' });
    }
  });

  /**
   * POST /api/usage/pricing — 新增一筆 effective_date row（super_admin only）
   * append-only：不允許刪除、不允許改既有 row，確保歷史可追溯
   *
   * Body: { tool, model, input_per_1m, output_per_1m,
   *         cache_write_per_1m, cache_read_per_1m, effective_date, notes? }
   */
  router.post('/', superAdminAuth, async (req, res) => {
    try {
      const {
        tool, model,
        input_per_1m, output_per_1m,
        cache_write_per_1m, cache_read_per_1m,
        effective_date, notes
      } = req.body || {};

      const missing = [];
      if (!tool) missing.push('tool');
      if (!model) missing.push('model');
      if (input_per_1m == null) missing.push('input_per_1m');
      if (output_per_1m == null) missing.push('output_per_1m');
      if (!effective_date) missing.push('effective_date');
      if (missing.length > 0) {
        return res.status(400).json({ error: `必填欄位缺少：${missing.join(', ')}` });
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effective_date))) {
        return res.status(400).json({ error: 'effective_date 格式需為 YYYY-MM-DD' });
      }

      for (const [key, val] of Object.entries({
        input_per_1m, output_per_1m, cache_write_per_1m, cache_read_per_1m
      })) {
        if (val == null) continue;
        const num = Number(val);
        if (!Number.isFinite(num)) {
          return res.status(400).json({ error: `${key} 需為數字` });
        }
        if (num < 0) {
          return res.status(400).json({ error: `${key} 需為非負數` });
        }
      }

      const result = await query(
        `INSERT INTO model_pricing
           (tool, model, input_per_1m, output_per_1m,
            cache_write_per_1m, cache_read_per_1m, effective_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, tool, model, input_per_1m, output_per_1m,
                   cache_write_per_1m, cache_read_per_1m, effective_date, notes, created_at`,
        [
          tool, model,
          input_per_1m, output_per_1m,
          cache_write_per_1m ?? null, cache_read_per_1m ?? null,
          effective_date, notes ?? null
        ]
      );

      res.status(201).json(result.rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: '相同 tool + model + effective_date 已存在' });
      }
      logger.error('新增 pricing 失敗', { error: err.message });
      res.status(500).json({ error: '新增定價失敗' });
    }
  });

  return router;
}

// Default export：production 用 default deps 建立的 router
export default createPricingRouter();
