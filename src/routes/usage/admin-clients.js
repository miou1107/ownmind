import { Router } from 'express';
import { createRequire } from 'module';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAdminAuth from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import { isLower } from '../../utils/semver.js';

const SERVER_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require('../../../package.json').version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * GET /api/usage/admin/clients  (admin+)
 *
 * Response:
 * {
 *   server_version: '1.17.0',
 *   coverage: {
 *     total_users, installed, active, stale, offline, not_installed,
 *     needs_upgrade
 *   },
 *   users: [{
 *     user_id, user_name, email, role,
 *     any_active, needs_upgrade, installed,
 *     clients: [
 *       { tool, version, machine, last_heartbeat_at, status, needs_upgrade }
 *     ]
 *   }]
 * }
 *
 * 狀態分類（針對「整體 user」）：
 *   active         = 任一 tool 有 heartbeat 在 24h 內
 *   stale          = 最新 heartbeat 在 24–48h 區間，且無更新
 *   offline        = 最新 heartbeat 超過 48h
 *   not_installed  = 該 user 從未有過任何 heartbeat 紀錄
 *
 * `needs_upgrade` 規則（per-tool）：
 *   client 的 scanner_version 以 semver 比較 < SERVER_VERSION → true
 *   scanner_version 為 null/'unknown' → 視為 true（當作舊版需升級）
 *
 * 權限：admin+（不曝露其他 user 的 email 給一般 member）
 */
export function createAdminClientsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const adminAuth = deps.adminAuth ?? defaultAdminAuth;
  const serverVersion = deps.serverVersion ?? SERVER_VERSION;
  const now = deps.now ?? (() => new Date());

  const router = Router();

  router.get('/', adminAuth, async (_req, res) => {
    try {
      const data = await loadClients({ query, serverVersion, now: now() });
      res.json(data);
    } catch (err) {
      logger.error('admin/clients 查詢失敗', { error: err.message });
      res.status(500).json({ error: '查詢裝機狀況失敗' });
    }
  });

  return router;
}

export async function loadClients({ query, serverVersion, now }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);

  // 一次抓所有 user + 他們的每 (user, tool) heartbeat
  // collector_heartbeat 已有 UNIQUE (user_id, tool)，每對僅一筆 → 直接 LEFT JOIN
  // （移除 DISTINCT ON 與 unused heartbeat_status 欄位，per codex review）
  const result = await query(
    `SELECT u.id AS user_id, u.name AS user_name, u.email, u.role,
            h.tool, h.scanner_version, h.machine, h.last_reported_at
       FROM users u
       LEFT JOIN collector_heartbeat h ON h.user_id = u.id
      ORDER BY u.id, h.tool NULLS LAST`
  );

  // 依 user_id 分組
  const byUser = new Map();
  for (const row of result.rows) {
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, {
        user_id: row.user_id,
        user_name: row.user_name,
        email: row.email,
        role: row.role,
        clients: []
      });
    }
    // row.tool 可能為 null（user 從未有 heartbeat）→ LEFT JOIN 補出的 placeholder
    if (row.tool) {
      const lastAtMs = row.last_reported_at
        ? new Date(row.last_reported_at).getTime()
        : null;
      const age = lastAtMs != null ? nowMs - lastAtMs : null;
      const status = age == null
        ? 'unknown'
        : age <= ACTIVE_WINDOW_MS
          ? 'active'
          : age <= STALE_WINDOW_MS
            ? 'stale'
            : 'offline';
      const version = row.scanner_version || null;
      const needsUpgrade = !version || version === 'unknown'
        ? true
        : isLower(version, serverVersion);

      byUser.get(row.user_id).clients.push({
        tool: row.tool,
        version,
        machine: row.machine,
        last_heartbeat_at: row.last_reported_at,
        status,
        needs_upgrade: needsUpgrade
      });
    }
  }

  const users = Array.from(byUser.values()).map((u) => {
    const installed = u.clients.length > 0;
    const anyActive = u.clients.some((c) => c.status === 'active');
    const needsUpgrade = u.clients.some((c) => c.needs_upgrade);
    return { ...u, installed, any_active: anyActive, needs_upgrade: needsUpgrade };
  });

  // 覆蓋率 summary
  const coverage = {
    total_users: users.length,
    installed: users.filter((u) => u.installed).length,
    active: users.filter((u) => u.any_active).length,
    stale: users.filter((u) =>
      u.installed && !u.any_active
        && u.clients.some((c) => c.status === 'stale')
    ).length,
    offline: users.filter((u) =>
      u.installed && !u.any_active
        && u.clients.every((c) => c.status === 'offline' || c.status === 'unknown')
    ).length,
    not_installed: users.filter((u) => !u.installed).length,
    needs_upgrade: users.filter((u) => u.installed && u.needs_upgrade).length
  };

  // 排序：needs_upgrade 先、未裝最後、其餘依 id
  users.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    if (a.needs_upgrade !== b.needs_upgrade) return a.needs_upgrade ? -1 : 1;
    return a.user_id - b.user_id;
  });

  return {
    server_version: serverVersion,
    coverage,
    users
  };
}

export default createAdminClientsRouter();
