import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import logger from '../../utils/logger.js';
import {
  recomputeDaily as defaultRecompute,
  deriveTouchedCombos
} from '../../jobs/usage-aggregation.js';

/**
 * POST /api/usage/events — Client scanner 轉發 raw events
 *
 * Flow（per spec S2）：
 *   1. Auth（Bearer token）
 *   2. 驗證必填欄位：tool / session_id / message_id / cumulative_total_tokens / ts
 *   3. Model allowlist：查 model_pricing，未知 → audit log，event 仍接收
 *   4. D7 token_regression：同 (user, tool, session_id) 的 MAX(cumulative_total_tokens)
 *      若新 event < 此值 → audit log，event 仍接收
 *   5. INSERT ... ON CONFLICT DO NOTHING（dedupe by (user, tool, session, message_id)）
 *   6. 對批次涉及的 (tool, session_id, date) 組合執行 recomputeDaily
 *   7. Response: { accepted, duplicated, rejected: [...] }
 *
 * TODO(P3)：Codex 專用 fingerprint override + material canonicalize
 * TODO(P3)：Heartbeat + exemption 處理
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

      const { events } = req.body || {};
      if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ error: 'events 必須是非空 array' });
      }

      if (events.length > 5000) {
        return res.status(413).json({ error: '單次最多 5000 筆 events' });
      }

      // ── 1. 驗證必填 ─────────────────────────────────────────
      const rejected = [];
      const valid = [];
      events.forEach((e, i) => {
        const err = validateEvent(e);
        if (err) rejected.push({ index: i, reason: err });
        else valid.push(e);
      });

      if (valid.length === 0) {
        return res.status(400).json({ accepted: 0, duplicated: 0, rejected });
      }

      // ── 2. Model allowlist（batch 查） ─────────────────────
      const modelKeys = [...new Set(
        valid.map((e) => `${e.tool}::${e.model ?? ''}`).filter((k) => !k.endsWith('::'))
      )];
      const knownModels = await lookupKnownModels({ query }, modelKeys);
      const unknownEvents = [];
      for (const e of valid) {
        if (!e.model) continue;
        if (!knownModels.has(`${e.tool}::${e.model}`)) unknownEvents.push(e);
      }

      // ── 3. D7 token_regression（batch 查每 (tool, session_id) max） ──
      const sessionKeys = [...new Set(valid.map((e) => `${e.tool}::${e.session_id}`))];
      const sessionMax = await loadSessionMaxCumulative({ query }, userId, sessionKeys);
      const regressionEvents = [];
      for (const e of valid) {
        const max = sessionMax.get(`${e.tool}::${e.session_id}`) ?? 0;
        if (Number(e.cumulative_total_tokens) < Number(max)) {
          regressionEvents.push({ event: e, expected_min: Number(max) });
        }
      }

      // ── 4. INSERT + 同筆 audit ── ────────────────────────────
      // 交錯寫入避免「insert 失敗但 audit 已進 DB」或相反（I1 fix）
      // 已知限制（P2）：
      //   - 無 transaction 包覆 insert/audit/aggregation。若 aggregation 失敗，
      //     DB 仍有 raw event，靠 nightly recompute 自我修復（7 天窗口）。
      //   - 並發兩批同 session 可能造成 token_regression 誤報（audit 屬 advisory，
      //     非 enforcement，可接受）。確認篡改前需比對 cumulative 順序。
      const unknownSet = new Set(unknownEvents.map((e) => e.message_id));
      const regressionMap = new Map(
        regressionEvents.map(({ event, expected_min }) => [event.message_id, expected_min])
      );

      let accepted = 0;
      let duplicated = 0;
      for (const e of valid) {
        const inserted = await insertEvent({ query }, userId, e);
        if (!inserted) { duplicated += 1; continue; }
        accepted += 1;

        if (unknownSet.has(e.message_id)) {
          await writeAudit({ query }, userId, e.tool, 'unknown_model', {
            model: e.model, message_id: e.message_id, session_id: e.session_id
          });
        }
        if (regressionMap.has(e.message_id)) {
          await writeAudit({ query }, userId, e.tool, 'token_regression', {
            session_id: e.session_id, message_id: e.message_id,
            expected_min: regressionMap.get(e.message_id),
            actual: Number(e.cumulative_total_tokens)
          });
        }
      }

      // ── 6. Trigger aggregation（同步，小 batch） ─────────────
      const touched = deriveTouchedCombos(valid);
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

      res.json({ accepted, duplicated, rejected });
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

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'event 必須是物件';
  if (!e.tool || typeof e.tool !== 'string') return 'tool 必填';
  if (!e.session_id || typeof e.session_id !== 'string') return 'session_id 必填';
  if (!e.message_id || typeof e.message_id !== 'string') return 'message_id 必填';
  if (!e.ts) return 'ts 必填';
  if (Number.isNaN(new Date(e.ts).getTime())) return 'ts 格式錯誤';

  // Tier 1 必須有 cumulative_total_tokens（D7）
  if (TIER1_TOOLS.has(e.tool)) {
    if (e.cumulative_total_tokens == null) return 'cumulative_total_tokens 必填（Tier 1）';
    if (!Number.isFinite(Number(e.cumulative_total_tokens))) {
      return 'cumulative_total_tokens 必須為數字';
    }
  }
  return null;
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

async function insertEvent({ query }, userId, e) {
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
      userId, e.tool, e.session_id, e.message_id, e.model ?? null, e.ts,
      numOr0(e.input_tokens), numOr0(e.output_tokens),
      numOr0(e.cache_creation_tokens), numOr0(e.cache_read_tokens), numOr0(e.reasoning_tokens),
      e.native_cost_usd ?? null, e.source_file ?? null,
      Number(e.cumulative_total_tokens),
      e.codex_fingerprint_material ? JSON.stringify(e.codex_fingerprint_material) : null
    ]
  );
  return res.rowCount > 0;
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
