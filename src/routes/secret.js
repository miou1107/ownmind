import { Router } from 'express';
import { query } from '../utils/db.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { requireFields } from '../utils/require-fields.js';

const router = Router();
router.use(auth);

/**
 * GET / - list all secret keys (without values).
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
    logger.error('list secrets failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * GET /:key - fetch a secret value (decrypted).
 */
router.get('/:key', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, key, encrypted_value, description FROM secrets
       WHERE key = $1 AND user_id = $2`,
      [req.params.key, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Secret not found' });
    }

    const secret = result.rows[0];
    const decryptedValue = decrypt(secret.encrypted_value);

    logger.info('Secret accessed', { key: req.params.key, user_id: req.user.id });

    res.json({
      id: secret.id,
      key: secret.key,
      value: decryptedValue,
      description: secret.description
    });
  } catch (err) {
    logger.error('get secret failed', { error: err.message });
    res.status(500).json({ error: 'Failed to fetch secret' });
  }
});

/**
 * POST / - create or update a secret (upsert).
 *
 * v1.17.91: behavior = upsert (ON CONFLICT DO UPDATE).
 *
 * Description semantics:
 *   - No description / description = null → keep the existing one.
 *   - Non-null description → overwrite.
 *   - **To explicitly clear description, use PUT /:key with description:
 *     null** (POST cannot clear it).
 *
 * Why: set_secret is mostly used by AI writing secrets, and the AI doesn't
 * always include a description. If POST treated missing as "clear", an
 * accidental AI write could overwrite a user-supplied description. Clearing
 * is therefore an explicit action and uses PUT.
 */
router.post('/', async (req, res) => {
  try {
    const validation = requireFields(req.body, ['key', 'value']);
    if (validation) return res.status(400).json(validation);

    const { key, value, description } = req.body;

    const encryptedValue = encrypt(value);

    // v1.17.91: POST switched to upsert (ON CONFLICT DO UPDATE).
    // Rationale: the MCP tool `ownmind_set_secret` is described as
    // "store or update", but the old POST was pure INSERT; setting the same
    // key twice triggered a 23505 unique-violation 500, blowing up any AI
    // that wanted to edit a secret. Upsert aligns with the tool description
    // and removes edge-case errors.
    // description uses COALESCE(EXCLUDED, secrets.description) — when the
    // caller does not include description the existing value is preserved
    // rather than blanked.
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

    // v1.17.91: write an activity_log audit (IR-002 — don't leak the value;
    // only log the key + action + whether it was an insert or update).
    const row = result.rows[0];
    try {
      await query(
        `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
         VALUES ($1, NOW(), 'secret_set', 'server', 'api', $2)`,
        [req.user.id, JSON.stringify({ key, action: row.inserted ? 'create' : 'update' })]
      );
    } catch (e) {
      // v1.17.91 reviewer M-2: use error level so audit failure can be alerted
      // (this is a secret operation; an audit gap is worse than a normal log).
      logger.error('secret_set activity_log write failed (main flow not blocked)', { error: e.message });
    }

    res.status(row.inserted ? 201 : 200).json({
      id: row.id, key: row.key, description: row.description,
    });
  } catch (err) {
    logger.error('create/update secret failed', { error: err.message });
    res.status(500).json({ error: 'Failed to create/update secret' });
  }
});

/**
 * PUT /:key - update a secret.
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
      return res.status(400).json({ error: 'Please provide a field to update' });
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
      return res.status(404).json({ error: 'Secret not found' });
    }

    // v1.17.91: PUT must also write an activity_log audit (missed in the
    // first round of v1.17.91; reviewer I-1 caught it).
    // Records which fields changed but not their values (IR-002 — never
    // leak secret material).
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
      logger.error('secret_update activity_log write failed (main flow not blocked)', { error: e.message });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('update secret failed', { error: err.message });
    res.status(500).json({ error: 'Failed to update secret' });
  }
});

/**
 * DELETE /:key - delete a secret.
 */
router.delete('/:key', async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM secrets WHERE key = $1 AND user_id = $2 RETURNING id, key',
      [req.params.key, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Secret not found' });
    }

    // v1.17.91: write an activity_log audit (IR-002 — don't leak the
    // value; only log key + action).
    try {
      await query(
        `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
         VALUES ($1, NOW(), 'secret_delete', 'server', 'api', $2)`,
        [req.user.id, JSON.stringify({ key: result.rows[0].key })]
      );
    } catch (e) {
      // v1.17.91 reviewer M-2: use error level (secret audit gaps are worse
      // than ordinary log gaps).
      logger.error('secret_delete activity_log write failed (main flow not blocked)', { error: e.message });
    }

    res.json({ message: 'Secret deleted', key: result.rows[0].key });
  } catch (err) {
    logger.error('delete secret failed', { error: err.message });
    res.status(500).json({ error: 'Failed to delete secret' });
  }
});

export default router;
