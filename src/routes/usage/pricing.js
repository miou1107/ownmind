import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import { superAdminAuth as defaultSuperAdminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import { requireFields } from '../../utils/require-fields.js';

/**
 * Factory: returns the pricing router.
 * Tests inject mock deps; production code uses the default exports.
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
   * Readable by any authenticated user (lists every effective_date row).
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
      logger.error('pricing query failed', { error: err.message });
      res.status(500).json({ error: 'Pricing query failed' });
    }
  });

  /**
   * POST /api/usage/pricing — add an effective_date row (super_admin only).
   * Append-only: deletes and edits to existing rows are not allowed, so the
   * history is fully auditable.
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

      const validation = requireFields(req.body, ['tool', 'model', 'input_per_1m', 'output_per_1m', 'effective_date']);
      if (validation) return res.status(400).json(validation);

      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effective_date))) {
        return res.status(400).json({ error: 'effective_date must be in YYYY-MM-DD format' });
      }

      for (const [key, val] of Object.entries({
        input_per_1m, output_per_1m, cache_write_per_1m, cache_read_per_1m
      })) {
        if (val == null) continue;
        const num = Number(val);
        if (!Number.isFinite(num)) {
          return res.status(400).json({ error: `${key} must be a number` });
        }
        if (num < 0) {
          return res.status(400).json({ error: `${key} must be non-negative` });
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
        return res.status(409).json({ error: 'A row with the same tool + model + effective_date already exists' });
      }
      logger.error('pricing insert failed', { error: err.message });
      res.status(500).json({ error: 'Failed to add pricing' });
    }
  });

  return router;
}

// Default export: the router built from default deps for production.
export default createPricingRouter();
