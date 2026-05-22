/**
 * Setup wizard endpoints — v1.19.8
 *
 * 對應 openspec/changes/v1.19.8-setup-wizard/spec.md 場景 4~10、13、14。
 *
 * 解決首次安裝 chicken-and-egg 問題：v1.19.7 之前新使用者部署完 server、
 * 沒帳號可以登入 admin UI、必須手動設 SETUP_TOKEN 環境變數 + SQL INSERT
 * 一筆 super_admin 紀錄才能用、平均卡 30 分鐘以上。
 *
 * 設計原則：
 *   - first-run 偵測：users 表有任何 admin/super_admin 就視為已完成 setup、
 *     wizard endpoint 永久關閉
 *   - Race condition 防護：用 pg_advisory_xact_lock 確保並發 init 請求只有
 *     一個能成功（資料庫層級的單一寫入序列化）
 *   - 跟舊 /admin/setup + SETUP_TOKEN 並存：first_run 看 users 表為空、
 *     舊路徑看 password_hash IS NULL、各管各的
 *   - Factory pattern：依賴用注入、方便單元測試（對齊 admin-work-log.js 等既有風格）
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
import { query as defaultQuery, withTransaction as defaultWithTransaction } from '../utils/db.js';
import defaultLogger from '../utils/logger.js';

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;

// pg_advisory_xact_lock 用的固定數字、setup 流程獨佔（不會跟其他 advisory lock 撞）
// 數字本身沒有特殊含義、純粹要一個唯一識別碼（白話：給這個鎖取個身分證號）
const SETUP_LOCK_ID = 19198;

const FIRST_RUN_CACHE_TTL_MS = 60 * 1000;

/**
 * 建立 first-run 偵測器（含 cache）
 *
 * 純 module-level 也行、但獨立工廠方便測試時清空 cache
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
      // 只 cache first_run=false（first_run=true 應每次重查、避免 race）
      if (!result.firstRun) {
        cache = result;
        cacheAt = now;
      }
      return result;
    } catch (err) {
      logger.warn?.('detectFirstRun 查詢失敗', { error: err.message });
      return { firstRun: false, usersCount: -1 };
    }
  }

  function invalidate() {
    cache = null;
    cacheAt = 0;
  }

  return { detectFirstRun, invalidate, _resetForTests: invalidate };
}

// 預設單例（給 production 用）
const defaultDetector = createFirstRunDetector({});
export const detectFirstRun = defaultDetector.detectFirstRun;
export const invalidateFirstRunCache = defaultDetector.invalidate;

/**
 * 建立 setup wizard router
 *
 * @param {object} deps - 依賴注入（測試時可傳入 mock）
 * @param {Function} deps.query - DB query 函式
 * @param {Function} deps.withTransaction - DB transaction wrapper
 * @param {{ detectFirstRun, invalidate }} deps.detector - first-run 偵測器
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
   * GET /status — 公開、回 first_run 狀態
   */
  router.get('/status', async (req, res) => {
    const { firstRun, usersCount } = await detector.detectFirstRun();
    res.json({ first_run: firstRun, users_count: usersCount });
  });

  /**
   * POST /init — 公開、僅 first_run=true 時開放
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
        // Advisory lock：並發 init 請求只有一個能進這段（race condition 防護）
        await client.query('SELECT pg_advisory_xact_lock($1)', [SETUP_LOCK_ID]);

        // 拿到鎖後再次 check first-run（場景 6 + 10）
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
          logger.warn?.('setup_init audit_log 寫入失敗', { error: auditErr.message });
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
        logger.warn?.('setup_init email 衝突', { error: err.message });
        return res.status(409).json({ error: 'email 已被佔用、請改用其他' });
      }
      logger.error?.('setup_init 失敗', { error: err.message, stack: err.stack });
      res.status(500).json({ error: '初始化失敗、請查 server log' });
    }
  });

  return router;
}

// Default export：給 production app.js 直接 mount 用
export default createSetupRouter();
