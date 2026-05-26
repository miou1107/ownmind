/**
 * Setup wizard endpoints — v1.19.8.
 *
 * Corresponds to openspec/changes/v1.19.8-setup-wizard/spec.md scenarios
 * 4–10, 13, 14.
 *
 * Solves the first-install chicken-and-egg problem: before v1.19.7 a new
 * user finished deploying the server but had no account to log into the
 * admin UI; they had to set the SETUP_TOKEN env var plus a manual SQL
 * INSERT of a super_admin row, averaging 30+ minutes of being stuck.
 *
 * Design principles:
 *   - first-run detection: as soon as the users table contains any
 *     admin/super_admin, setup is considered done and the wizard endpoint
 *     is permanently closed.
 *   - Race-condition protection: pg_advisory_xact_lock ensures only one
 *     concurrent init request can succeed (DB-level serialization of the
 *     single write).
 *   - Coexists with the older /admin/setup + SETUP_TOKEN: first_run looks
 *     at an empty users table; the old path looks at password_hash IS NULL;
 *     the two are independent.
 *   - Factory pattern: deps are injected for unit testing
 *     (mirroring the style of admin-work-log.js etc.).
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { query as defaultQuery, withTransaction as defaultWithTransaction } from '../utils/db.js';
import defaultLogger from '../utils/logger.js';

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;

// Fixed identifier for pg_advisory_xact_lock used by the setup flow (the
// number itself has no special meaning; it just needs to be unique).
const SETUP_LOCK_ID = 19198;

const FIRST_RUN_CACHE_TTL_MS = 60 * 1000;

/**
 * Build the first-run detector (with cache).
 *
 * Could be module-level, but a separate factory makes it easier to flush
 * the cache during tests.
 *
 * @param {{ query: Function, logger?: object }} deps
 * @returns {{ detectFirstRun: Function, invalidate: Function, _resetForTests: Function }}
 */
export function createFirstRunDetector({ query = defaultQuery, logger = defaultLogger } = {}) {
  let cache = null;
  let cacheAt = 0;

  async function detectFirstRun() {
    const now = Date.now();
    if (cache && now - cacheAt < FIRST_RUN_CACHE_TTL_MS) {
      return cache;
    }
    try {
      const r = await query(
        `SELECT COUNT(*)::int AS n FROM users WHERE role IN ('admin', 'super_admin')`
      );
      const n = r.rows[0]?.n ?? 0;
      const result = { firstRun: n === 0, usersCount: n };
      // Only cache first_run=false; first_run=true must be re-queried each
      // time to avoid races.
      if (!result.firstRun) {
        cache = result;
        cacheAt = now;
      }
      return result;
    } catch (err) {
      logger.warn?.('detectFirstRun query failed', { error: err.message });
      return { firstRun: false, usersCount: -1 };
    }
  }

  function invalidate() {
    cache = null;
    cacheAt = 0;
  }

  return { detectFirstRun, invalidate, _resetForTests: invalidate };
}

// Default singleton (for production).
const defaultDetector = createFirstRunDetector({});
export const detectFirstRun = defaultDetector.detectFirstRun;
export const invalidateFirstRunCache = defaultDetector.invalidate;

/**
 * Build the setup wizard router.
 *
 * @param {object} deps - dependency injection (tests can pass mocks).
 * @param {Function} deps.query - DB query function.
 * @param {Function} deps.withTransaction - DB transaction wrapper.
 * @param {{ detectFirstRun, invalidate }} deps.detector - first-run detector.
 * @param {object} deps.logger
 * @returns {import('express').Router}
 */
export function createSetupRouter(deps = {}) {
  const {
    query = defaultQuery,
    withTransaction = defaultWithTransaction,
    detector = defaultDetector,
    logger = defaultLogger,
  } = deps;

  const router = Router();

  /**
   * GET /status — public, returns the first_run status.
   */
  router.get('/status', async (req, res) => {
    const { firstRun, usersCount } = await detector.detectFirstRun();
    res.json({ first_run: firstRun, users_count: usersCount });
  });

  /**
   * POST /init — public, only available when first_run=true.
   */
  router.post('/init', async (req, res) => {
    const { email, password, name } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: '請填寫 email 跟 password 兩個欄位' });
    }
    if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'email 格式不正確' });
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
      return res.status(400).json({ error: `密碼至少 ${MIN_PASSWORD_LEN} 個字元` });
    }

    try {
      const result = await withTransaction(async (client) => {
        // Advisory lock: only one concurrent init request can enter this
        // section (race-condition protection).
        await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_ID]);

        // Re-check first-run after acquiring the lock (scenarios 6 + 10).
        const r = await client.query(
          `SELECT COUNT(*)::int AS n FROM users WHERE role IN ('admin', 'super_admin')`
        );
        if ((r.rows[0]?.n ?? 0) > 0) {
          return { conflict: true };
        }

        const apiKey = randomUUID();
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        const insertResult = await client.query(
          `INSERT INTO users (name, email, role, api_key, password_hash, must_change_password)
           VALUES ($1, $2, 'super_admin', $3, $4, FALSE)
           RETURNING id, name, email, role, api_key, created_at`,
          [name || 'admin', email, apiKey, passwordHash]
        );
        const newUser = insertResult.rows[0];

        try {
          await client.query(
            `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              newUser.id,
              'setup_init',
              'user',
              newUser.id,
              JSON.stringify({ email: newUser.email, source: 'setup_wizard' }),
            ]
          );
        } catch (auditErr) {
          logger.warn?.('setup_init audit_log write failed', { error: auditErr.message });
        }

        return { user: newUser };
      });

      if (result.conflict) {
        return res
          .status(403)
          .json({ error: 'setup wizard 已完成、請走 /admin/login' });
      }

      detector.invalidate();
      return res.status(201).json(result.user);
    } catch (err) {
      if (err.code === '23505') {
        logger.warn?.('setup_init email conflict', { error: err.message });
        return res.status(409).json({ error: 'email 已被佔用、請改用其他' });
      }
      logger.error?.('setup_init failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: '初始化失敗、請查 server log' });
    }
  });

  return router;
}

// Default export so production app.js can mount it directly.
export default createSetupRouter();
