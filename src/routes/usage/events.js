import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import logger from '../../utils/logger.js';
import {
  recomputeDaily as defaultRecompute,
  deriveTouchedCombos
} from '../../jobs/usage-aggregation.js';
import {
  canonicalizeCodexMaterial,
  codexMessageId,
  materialsEqual
} from '../../../shared/scanners/id-helper.js';

/**
 * Server-side heartbeat rate limit (defense-in-depth, v1.17.5).
 *
 * Even with the client's once-per-process cap (mcp/index.js `heartbeatSent`),
 * a misconfigured scanner or rogue client could still spam the endpoint.
 * The UPSERT's ON CONFLICT WHERE clause suppresses writes when the last
 * heartbeat for this (user, tool) was less than this many seconds ago.
 * Atomic, single-query, zero extra round-trips.
 *
 * 30s ≈ balances "dashboard feels live" with "spam doesn't hit DB".
 */
const HEARTBEAT_RATE_LIMIT_SECONDS = 30;

/**
 * POST /api/usage/events — Client scanner 轉發 raw events
 *
 * P3 新增：
 *   - Exemption check：exempt user 的資料不入 token_events，只寫 audit
 *   - Codex fingerprint flow（D13）：material 必填 → canonicalize → expectedId override
 *     → collision / mismatch audit（仍接收，只做觀測）
 *   - Heartbeat：body.heartbeat { tool, scanner_version, machine } → UPSERT collector_heartbeat
 *
 * 已知限制（P2 既有）：
 *   - insert/audit/aggregation 無 transaction；若 aggregation throw 靠 nightly recompute 修復
 *   - 並發兩批同 session 可能造成 token_regression 誤報（audit 屬 advisory）
 */
export function createEventsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;
  const recomputeDaily = deps.recomputeDaily ?? defaultRecompute;

  const router = Router();

  router.post('/', auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: '未認證' });

      const { events = [], heartbeat, sessions = [] } = req.body || {};
      if (!Array.isArray(events)) {
        return res.status(400).json({ error: 'events 必須是 array' });
      }
      if (!Array.isArray(sessions)) {
        return res.status(400).json({ error: 'sessions 必須是 array' });
      }
      // 允許 heartbeat-only / sessions-only 呼叫（Tier 2 Cursor / Antigravity）
      if (events.length === 0 && sessions.length === 0 && !heartbeat) {
        return res.status(400).json({ error: 'events/sessions/heartbeat 至少一個必須存在' });
      }
      if (events.length > 5000) {
        return res.status(413).json({ error: '單次最多 5000 筆 events' });
      }
      if (sessions.length > 1000) {
        return res.status(413).json({ error: '單次最多 1000 筆 sessions' });
      }
      if (events.length === 0 && sessions.length === 0) {
        await writeHeartbeatIfPresent({ query }, userId, heartbeat);
        return res.json({ accepted: 0, duplicated: 0, rejected: [], sessions_upserted: 0 });
      }

      // ── 0. Exemption check（最早處理） ─────────────────────
      // 備註：isExempt → INSERT 有微小 race（grant exemption 過程中到達的批次
      //      可能仍入 DB）。可接受：下一批就會被擋，coverage 資料僅錯一批。
      const exempt = await isExempt({ query }, userId);
      if (exempt) {
        const tools = [
          ...new Set([
            ...events.map((e) => e?.tool).filter(Boolean),
            ...sessions.map((s) => s?.tool).filter(Boolean)
          ])
        ];
        await writeAudit({ query }, userId, null, 'ingestion_suppressed_exempt', {
          event_count: events.length, session_count: sessions.length,
          tools, reason: exempt.reason
        });
        await writeHeartbeatIfPresent({ query }, userId, heartbeat);
        return res.json({
          accepted: 0, duplicated: 0, rejected: [],
          sessions_upserted: 0, exempted: true
        });
      }

      // ── 1. 驗證必填 + Codex canonicalize ──────────────────
      const rejected = [];
      const processed = []; // { event, originalMessageId, canonicalMaterial, isCodex }
      for (let i = 0; i < events.length; i += 1) {
        const e = events[i];
        const basicErr = validateEvent(e);
        if (basicErr) { rejected.push({ index: i, reason: basicErr }); continue; }

        if (e.tool === 'codex') {
          try {
            const canonical = canonicalizeCodexMaterial(e.codex_fingerprint_material);
            const expectedId = codexMessageId(e.session_id, canonical);
            processed.push({
              event: e, originalMessageId: e.message_id,
              canonicalMaterial: canonical, expectedId, isCodex: true
            });
          } catch (err) {
            rejected.push({ index: i, reason: `codex material: ${err.message}` });
            await writeAudit({ query }, userId, 'codex', 'codex_missing_material', {
              session_id: e.session_id, message_id: e.message_id,
              error: err.message
            });
          }
        } else {
          processed.push({ event: e, isCodex: false });
        }
      }

      // 若只有 sessions（Tier 2，events 為空）→ 跳過 Tier 1 流程直接 upsert sessions + heartbeat
      if (processed.length === 0 && sessions.length === 0) {
        await writeHeartbeatIfPresent({ query }, userId, heartbeat);
        return res.status(400).json({ accepted: 0, duplicated: 0, rejected });
      }

      // ── 2. Model allowlist（batch 查；無 events 時略過） ─
      const modelKeys = [...new Set(
        processed.map((p) => `${p.event.tool}::${p.event.model ?? ''}`)
          .filter((k) => !k.endsWith('::'))
      )];
      const knownModels = await lookupKnownModels({ query }, modelKeys);
      const unknownMessageIds = new Set();
      for (const p of processed) {
        if (!p.event.model) continue;
        if (!knownModels.has(`${p.event.tool}::${p.event.model}`)) {
          unknownMessageIds.add(effectiveMessageId(p));
        }
      }

      // ── 3. D7 token_regression（batch 查每 (tool, session_id) max） ──
      const sessionKeys = [...new Set(
        processed.map((p) => `${p.event.tool}::${p.event.session_id}`)
      )];
      const sessionMax = await loadSessionMaxCumulative({ query }, userId, sessionKeys);
      const regressionMap = new Map(); // effectiveId → expected_min
      for (const p of processed) {
        const max = sessionMax.get(`${p.event.tool}::${p.event.session_id}`) ?? 0;
        if (Number(p.event.cumulative_total_tokens) < Number(max)) {
          regressionMap.set(effectiveMessageId(p), Number(max));
        }
      }

      // ── 4. INSERT + per-event audit（交錯，避免 insert 失敗卻 audit 已 commit） ──
      let accepted = 0;
      let duplicated = 0;
      for (const p of processed) {
        const { event: e, isCodex, canonicalMaterial, expectedId, originalMessageId } = p;
        const messageId = isCodex ? expectedId : e.message_id;

        // Codex：client 送的 id ≠ server 算的 → 寫 mismatch（接收後 insert 仍用 expectedId）
        if (isCodex && originalMessageId !== expectedId) {
          await writeAudit({ query }, userId, 'codex', 'fingerprint_mismatch', {
            session_id: e.session_id,
            client_message_id: originalMessageId,
            expected_message_id: expectedId
          });
        }

        const insertRes = await insertEvent({ query }, userId, e, messageId, canonicalMaterial);
        if (insertRes.inserted) {
          accepted += 1;
        } else {
          duplicated += 1;
          // Codex collision detection：讀既存 row 的 material 跟本次比對
          if (isCodex) {
            const existing = await query(
              `SELECT codex_fingerprint_material
                 FROM token_events
                WHERE user_id = $1 AND tool = 'codex'
                  AND session_id = $2 AND message_id = $3`,
              [userId, e.session_id, expectedId]
            );
            const existingMaterial = existing.rows[0]?.codex_fingerprint_material;
            if (existingMaterial && !materialsEqual(existingMaterial, canonicalMaterial)) {
              await writeAudit({ query }, userId, 'codex', 'fingerprint_collision', {
                session_id: e.session_id, message_id: expectedId,
                existing: existingMaterial, incoming: canonicalMaterial
              });
            }
          }
        }

        if (insertRes.inserted) {
          if (unknownMessageIds.has(messageId)) {
            await writeAudit({ query }, userId, e.tool, 'unknown_model', {
              model: e.model, message_id: messageId, session_id: e.session_id
            });
          }
          if (regressionMap.has(messageId)) {
            await writeAudit({ query }, userId, e.tool, 'token_regression', {
              session_id: e.session_id, message_id: messageId,
              expected_min: regressionMap.get(messageId),
              actual: Number(e.cumulative_total_tokens)
            });
          }
        }
      }

      // ── 4b. Sessions UPSERT（Tier 2：Cursor / Antigravity） ──
      let sessionsUpserted = 0;
      let sessionErrors = 0;
      for (const s of sessions) {
        const err = validateSession(s);
        if (err) { rejected.push({ index: `session:${s?.tool ?? '?'}`, reason: err }); continue; }
        const upserted = await upsertSessionCount({ query }, userId, s);
        if (upserted) sessionsUpserted += 1;
        else sessionErrors += 1;
      }

      // ── 5. Heartbeat ──────────────────────────────────────
      await writeHeartbeatIfPresent({ query }, userId, heartbeat);

      // ── 6. Trigger aggregation ────────────────────────────
      const touched = deriveTouchedCombos(processed.map((p) => p.event));
      for (const t of touched) {
        try {
          await recomputeDaily({ query }, {
            userId, tool: t.tool, sessionId: t.session_id, date: t.date
          });
        } catch (err) {
          logger.error('aggregation 失敗', {
            error: err.message, userId, tool: t.tool, session: t.session_id, date: t.date
          });
        }
      }

      res.json({
        accepted, duplicated, rejected,
        sessions_upserted: sessionsUpserted,
        ...(sessionErrors > 0 ? { session_errors: sessionErrors } : {})
      });
    } catch (err) {
      logger.error('ingestion 失敗', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'ingestion 失敗' });
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────
// 純函式 / helper
// ────────────────────────────────────────────────────────────

const TIER1_TOOLS = new Set(['claude-code', 'codex', 'opencode']);

export function validateSession(s) {
  if (!s || typeof s !== 'object') return 'session 必須是物件';
  if (!s.tool || typeof s.tool !== 'string') return 'session.tool 必填';
  if (!s.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) {
    return 'session.date 需為 YYYY-MM-DD';
  }
  if (s.count != null && !(Number(s.count) >= 0)) return 'session.count 需為非負整數';
  if (s.wall_seconds != null && !(Number(s.wall_seconds) >= 0)) {
    return 'session.wall_seconds 需為非負整數';
  }
  return null;
}

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'event 必須是物件';
  if (!e.tool || typeof e.tool !== 'string') return 'tool 必填';
  if (!e.session_id || typeof e.session_id !== 'string') return 'session_id 必填';
  // Codex: message_id 由 server 覆寫，這裡不強制（但欄位仍須存在，避免錯字 bug）
  if (e.tool !== 'codex') {
    if (!e.message_id || typeof e.message_id !== 'string') return 'message_id 必填';
  }
  if (!e.ts) return 'ts 必填';
  if (Number.isNaN(new Date(e.ts).getTime())) return 'ts 格式錯誤';
  // Tier 1 含 codex：spec P5 line 237 要求 scanner 同時設定 top-level
  // cumulative_total_tokens（= material.total_cumulative），因為 D7 regression
  // 查詢是 top-level 欄位，不解析 JSONB material。兩處冗餘是 by-design。
  if (TIER1_TOOLS.has(e.tool)) {
    if (e.cumulative_total_tokens == null) return 'cumulative_total_tokens 必填（Tier 1）';
    if (!Number.isFinite(Number(e.cumulative_total_tokens))) {
      return 'cumulative_total_tokens 必須為數字';
    }
  }
  // Codex: material 必填欄位由 canonicalize 檢查；這邊只攔非物件
  if (e.tool === 'codex' && (!e.codex_fingerprint_material || typeof e.codex_fingerprint_material !== 'object')) {
    return 'codex event 缺 codex_fingerprint_material';
  }
  return null;
}

function effectiveMessageId(p) {
  return p.isCodex ? p.expectedId : p.event.message_id;
}

async function isExempt({ query }, userId) {
  const res = await query(
    `SELECT reason, expires_at FROM usage_tracking_exemption
      WHERE user_id = $1
        AND (expires_at IS NULL OR expires_at > NOW())
      LIMIT 1`,
    [userId]
  );
  return res.rows[0] || null;
}

async function lookupKnownModels({ query }, keys) {
  const known = new Set();
  if (keys.length === 0) return known;
  const pairs = keys.map((k) => k.split('::'));
  const tools = pairs.map((p) => p[0]);
  const models = pairs.map((p) => p[1]);
  const res = await query(
    `SELECT DISTINCT tool, model FROM model_pricing
      WHERE (tool, model) IN (SELECT * FROM UNNEST($1::text[], $2::text[]))`,
    [tools, models]
  );
  for (const r of res.rows) known.add(`${r.tool}::${r.model}`);
  return known;
}

async function loadSessionMaxCumulative({ query }, userId, sessionKeys) {
  const map = new Map();
  if (sessionKeys.length === 0) return map;
  const pairs = sessionKeys.map((k) => k.split('::'));
  const tools = pairs.map((p) => p[0]);
  const sessions = pairs.map((p) => p[1]);
  const res = await query(
    `SELECT tool, session_id, MAX(cumulative_total_tokens) AS max_cum
       FROM token_events
      WHERE user_id = $1
        AND (tool, session_id) IN (SELECT * FROM UNNEST($2::text[], $3::text[]))
      GROUP BY tool, session_id`,
    [userId, tools, sessions]
  );
  for (const r of res.rows) map.set(`${r.tool}::${r.session_id}`, r.max_cum);
  return map;
}

async function insertEvent({ query }, userId, e, messageId, canonicalMaterial) {
  const res = await query(
    `INSERT INTO token_events
       (user_id, tool, session_id, message_id, model, ts,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, reasoning_tokens,
        native_cost_usd, source_file, cumulative_total_tokens, codex_fingerprint_material)
     VALUES ($1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11,
             $12, $13, $14, $15)
     ON CONFLICT (user_id, tool, session_id, message_id) DO NOTHING
     RETURNING id`,
    [
      userId, e.tool, e.session_id, messageId, e.model ?? null, e.ts,
      numOr0(e.input_tokens), numOr0(e.output_tokens),
      numOr0(e.cache_creation_tokens), numOr0(e.cache_read_tokens), numOr0(e.reasoning_tokens),
      e.native_cost_usd ?? null, e.source_file ?? null,
      Number(e.cumulative_total_tokens),
      canonicalMaterial ? JSON.stringify(canonicalMaterial) : null
    ]
  );
  return { inserted: res.rowCount > 0 };
}

async function upsertSessionCount({ query }, userId, s) {
  try {
    // 政策：GREATEST(舊, 新)
    // - count: Tier 2 adapter 每日只會 emit 一次 count=1；GREATEST 等同 "至少 1"。
    //   若未來 Tier 2 要計真 session count，需改成 EXCLUDED（覆寫）或 sum（累加）
    //   — 當天邏輯要一併考慮 race。目前語義為「該日是否有活動」的 boolean-ish。
    // - wall_seconds: 目前恆為 0，GREATEST 無害。若未來要累加需改 +。
    // 此策略避免 race 導致計數回退，但犧牲了累加的可能性。
    await query(
      `INSERT INTO session_count (user_id, tool, date, count, wall_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, tool, date) DO UPDATE SET
         count = GREATEST(session_count.count, EXCLUDED.count),
         wall_seconds = GREATEST(session_count.wall_seconds, EXCLUDED.wall_seconds)`,
      [userId, s.tool, s.date, Number(s.count ?? 1), Number(s.wall_seconds ?? 0)]
    );
    return true;
  } catch (err) {
    logger.error('session_count upsert 失敗', { error: err.message });
    return false;
  }
}

async function writeHeartbeatIfPresent({ query }, userId, heartbeat) {
  if (!heartbeat || typeof heartbeat !== 'object' || !heartbeat.tool) return;
  try {
    // Rate-limited UPSERT: if an existing row's last_reported_at is younger
    // than HEARTBEAT_RATE_LIMIT_SECONDS, DO UPDATE is suppressed by the WHERE
    // clause → no write, zero audit noise. First-time inserts always land
    // because ON CONFLICT only fires when a matching row already exists.
    await query(
      `INSERT INTO collector_heartbeat
         (user_id, tool, last_reported_at, scanner_version, machine, status)
       VALUES ($1, $2, NOW(), $3, $4, 'active')
       ON CONFLICT (user_id, tool) DO UPDATE SET
         last_reported_at = NOW(),
         scanner_version  = EXCLUDED.scanner_version,
         machine          = EXCLUDED.machine,
         status           = 'active'
       WHERE collector_heartbeat.last_reported_at < NOW() - INTERVAL '${HEARTBEAT_RATE_LIMIT_SECONDS} seconds'`,
      [userId, heartbeat.tool,
       heartbeat.scanner_version ?? null, heartbeat.machine ?? null]
    );
  } catch (err) {
    logger.error('heartbeat 更新失敗', { error: err.message });
  }
}

async function writeAudit({ query }, userId, tool, eventType, details) {
  try {
    await query(
      `INSERT INTO usage_audit_log (user_id, tool, event_type, details)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [userId, tool, eventType, JSON.stringify(details)]
    );
  } catch (err) {
    logger.error('usage_audit_log 寫入失敗', { error: err.message });
  }
}

function numOr0(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export default createEventsRouter();
