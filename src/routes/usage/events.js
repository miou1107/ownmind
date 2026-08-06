import { Router } from 'express';
import { query as defaultQuery } from '../../utils/db.js';
import defaultAuth from '../../middleware/auth.js';
import logger from '../../utils/logger.js';
import { isReason } from '../../../shared/scanners/reasons.js';
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
 * POST /api/usage/events — client scanner forwarding raw events.
 *
 * P3 additions:
 *   - Exemption check: exempt users' data does not enter token_events;
 *     only audit is written.
 *   - Codex fingerprint flow (D13): material is required → canonicalize →
 *     expectedId override → collision / mismatch audit (still accepted, just
 *     observed).
 *   - Heartbeat: body.heartbeat { tool, scanner_version, machine } → UPSERT
 *     collector_heartbeat.
 *
 * Known limitations (carried over from P2):
 *   - insert/audit/aggregation is not wrapped in a transaction; if
 *     aggregation throws, the nightly recompute repairs it.
 *   - Two concurrent batches for the same session may cause spurious
 *     token_regression audits (audit is advisory).
 */
export function createEventsRouter(deps = {}) {
  const query = deps.query ?? defaultQuery;
  const auth = deps.auth ?? defaultAuth;
  const recomputeDaily = deps.recomputeDaily ?? defaultRecompute;

  const router = Router();

  router.post('/', auth, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'unauthenticated' });

      const { events = [], heartbeat, sessions = [] } = req.body || {};
      if (!Array.isArray(events)) {
        return res.status(400).json({ error: 'events must be an array' });
      }
      if (!Array.isArray(sessions)) {
        return res.status(400).json({ error: 'sessions must be an array' });
      }
      // Allow heartbeat-only / sessions-only calls (Tier 2 Cursor / Antigravity).
      if (events.length === 0 && sessions.length === 0 && !heartbeat) {
        return res.status(400).json({ error: 'at least one of events/sessions/heartbeat is required' });
      }
      if (events.length > 5000) {
        return res.status(413).json({ error: 'at most 5000 events per request' });
      }
      if (sessions.length > 1000) {
        return res.status(413).json({ error: 'at most 1000 sessions per request' });
      }
      if (events.length === 0 && sessions.length === 0) {
        await writeHeartbeatIfPresent({ query }, userId, heartbeat);
        return res.json({ accepted: 0, duplicated: 0, rejected: [], sessions_upserted: 0 });
      }

      // ── 0. Exemption check (very first thing) ─────────────────────
      // Note: isExempt → INSERT has a tiny race window (batches arriving
      //      during the grant could still make it into the DB). Acceptable:
      //      the next batch is blocked, only one batch of coverage data is off.
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

      // ── 1. Validate required fields + Codex canonicalize ──────────────────
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

      // When there are only sessions (Tier 2, events empty) → skip the
      // Tier 1 pipeline and just upsert sessions + heartbeat.
      if (processed.length === 0 && sessions.length === 0) {
        await writeHeartbeatIfPresent({ query }, userId, heartbeat);
        return res.status(400).json({ accepted: 0, duplicated: 0, rejected });
      }

      // ── 2. Model allowlist (batch query; skipped when no events) ─
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

      // ── 3. D7 token_regression (batch-query per-(tool, session_id) max) ──
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

      // ── 4. INSERT + per-event audit (interleaved so we don't commit
      //       audits whose insert failed) ──
      let accepted = 0;
      let duplicated = 0;
      for (const p of processed) {
        const { event: e, isCodex, canonicalMaterial, expectedId, originalMessageId } = p;
        const messageId = isCodex ? expectedId : e.message_id;

        // Codex: client-sent id ≠ server-computed → write a mismatch audit
        // (still accept and use expectedId for the insert).
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
          // Codex collision detection: read the existing row's material and
          // compare against the current one.
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

      // ── 4b. Sessions UPSERT (Tier 2: Cursor / Antigravity) ──
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
          logger.error('aggregation failed', {
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
      logger.error('ingestion failed', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'ingestion failed' });
    }
  });

  return router;
}

// ────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────

const TIER1_TOOLS = new Set(['claude-code', 'codex', 'opencode']);

export function validateSession(s) {
  if (!s || typeof s !== 'object') return 'session must be an object';
  if (!s.tool || typeof s.tool !== 'string') return 'session.tool is required';
  if (!s.date || !/^\d{4}-\d{2}-\d{2}$/.test(String(s.date))) {
    return 'session.date must be YYYY-MM-DD';
  }
  if (s.count != null && !(Number(s.count) >= 0)) return 'session.count must be a non-negative integer';
  if (s.wall_seconds != null && !(Number(s.wall_seconds) >= 0)) {
    return 'session.wall_seconds must be a non-negative integer';
  }
  return null;
}

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'event must be an object';
  if (!e.tool || typeof e.tool !== 'string') return 'tool is required';
  if (!e.session_id || typeof e.session_id !== 'string') return 'session_id is required';
  // Codex: server overwrites message_id; not strictly required here (but the
  // field must still exist to catch typo bugs).
  if (e.tool !== 'codex') {
    if (!e.message_id || typeof e.message_id !== 'string') return 'message_id is required';
  }
  if (!e.ts) return 'ts is required';
  if (Number.isNaN(new Date(e.ts).getTime())) return 'ts has invalid format';
  // Tier 1 (including codex): spec P5 line 237 requires the scanner to set the
  // top-level cumulative_total_tokens (= material.total_cumulative); D7
  // regression queries this top-level column and does not parse the JSONB
  // material. The duplication is by design.
  if (TIER1_TOOLS.has(e.tool)) {
    if (e.cumulative_total_tokens == null) return 'cumulative_total_tokens is required (Tier 1)';
    if (!Number.isFinite(Number(e.cumulative_total_tokens))) {
      return 'cumulative_total_tokens must be a number';
    }
  }
  // Codex: required material fields are checked by canonicalize; here we only
  // reject non-objects.
  if (e.tool === 'codex' && (!e.codex_fingerprint_material || typeof e.codex_fingerprint_material !== 'object')) {
    return 'codex event missing codex_fingerprint_material';
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
    // Policy: GREATEST(old, new).
    // - count: each Tier 2 adapter emits count=1 per day at most; GREATEST
    //   is therefore equivalent to "at least 1". If Tier 2 ever needs to
    //   carry true session count, switch to EXCLUDED (overwrite) or sum
    //   (accumulate) — and consider the same-day race. Current semantics
    //   are a boolean-ish "was there activity today".
    // - wall_seconds: currently always 0; GREATEST is harmless. Switch to
    //   += if we ever want to accumulate.
    // This policy avoids count regression from races but trades off
    // accumulation.
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
    logger.error('session_count upsert failed', { error: err.message });
    return false;
  }
}

/**
 * The hostname a heartbeat identifies itself by.
 *
 * `machine` is part of the row identity since v1.26.73, so it has to be a definite value
 * and it has to fit the column. Trimmed because a name arriving with surrounding space
 * would otherwise be a second computer.
 */
const MACHINE_UNKNOWN = 'unknown';
const MACHINE_MAX_LEN = 128;   // matches collector_heartbeat.machine VARCHAR(128)

/**
 * How many machines one person may register for one tool.
 *
 * v1.26.73 put a client-supplied string into the row identity. Before that the key had no
 * client-controlled component and no client could make this table grow; now a machine
 * whose hostname changes on every boot inserts a row each time, and the per-row rate
 * limit cannot help because every one of them is a first insert.
 *
 * The cap bounds **new** machines only. A machine already on record keeps updating past
 * it, so hitting the limit never silences a computer that is genuinely reporting.
 *
 * 20 is far above anything real — the largest account here runs two — and far below
 * anything that matters to the database.
 */
const MAX_MACHINES_PER_TOOL = 20;

export function normaliseMachine(raw) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) return MACHINE_UNKNOWN;
  return name.length > MACHINE_MAX_LEN ? name.slice(0, MACHINE_MAX_LEN) : name;
}

async function writeHeartbeatIfPresent({ query }, userId, heartbeat) {
  if (!heartbeat || typeof heartbeat !== 'object' || !heartbeat.tool) return;
  try {
    // Rate-limited UPSERT: if an existing row's last_reported_at is younger
    // than HEARTBEAT_RATE_LIMIT_SECONDS, DO UPDATE is suppressed by the WHERE
    // clause → no write, zero audit noise. First-time inserts always land
    // because ON CONFLICT only fires when a matching row already exists.
    // v1.26.69 — the reason is checked against the closed set here, at the boundary,
    // so an unrecognised value never reaches a sized column inside the ingest path
    // where the failure would cost the whole batch.
    //
    // "no reason field" and "a reason this server does not recognise" are different
    // events and must not both mean null. The first is an older collector, or the MCP,
    // which cannot say — leave whatever is stored alone. The second is a newer collector
    // reporting a change, so the stale value has to go, or a collector that has started
    // failing keeps displaying its last healthy state.
    const reasonProvided = heartbeat.reason !== undefined && heartbeat.reason !== null;
    const reason = isReason(heartbeat.reason) ? heartbeat.reason : null;
    // v1.26.73 — `machine` is part of the row identity now, and a NULL cannot be. Postgres
    // treats NULLs as distinct in a unique index, so a client that sends no machine would
    // insert a brand new row on every single heartbeat instead of conflicting with its own
    // previous one. Anything old enough not to report a hostname is old enough that the
    // answer genuinely is unknown.
    const machine = normaliseMachine(heartbeat.machine);
    await query(
      `INSERT INTO collector_heartbeat
         (user_id, tool, last_reported_at, scanner_version, machine, os, status, reason)
       SELECT $1, $2, NOW(), $3, $4, $5, 'active', $6
        WHERE EXISTS (
                SELECT 1 FROM collector_heartbeat
                 WHERE user_id = $1 AND tool = $2 AND machine = $4)
           OR (SELECT count(*) FROM collector_heartbeat
                WHERE user_id = $1 AND tool = $2) < ${MAX_MACHINES_PER_TOOL}
       ON CONFLICT (user_id, tool, machine) DO UPDATE SET
         last_reported_at = NOW(),
         scanner_version  = EXCLUDED.scanner_version,
         os               = EXCLUDED.os,
         status           = 'active',
         -- machine is deliberately not assigned: it is the conflict target, so writing
         -- it would be writing the key. Before v1.26.73 it was assigned here, and that
         -- assignment is exactly how one person's two computers erased each other.
         --
         -- Only a heartbeat that actually carried a reason may write this column. The MCP
         -- and the scanner share one row per (user_id, tool, machine) and only the scanner
         -- knows a reason; letting a reasonless MCP beat null it out would make the two
         -- disagree on every beat, so the IS DISTINCT clause below would always be true
         -- and the rate limit would stop working for the busiest tool on the machine.
         reason           = CASE WHEN $7 THEN $6 ELSE collector_heartbeat.reason END
       WHERE collector_heartbeat.last_reported_at < NOW() - INTERVAL '${HEARTBEAT_RATE_LIMIT_SECONDS} seconds'
          OR ($7 AND collector_heartbeat.reason IS DISTINCT FROM $6)`,
      [userId, heartbeat.tool,
       heartbeat.scanner_version ?? null,
       machine,
       heartbeat.os ?? null,
       reason,
       reasonProvided]
    );
  } catch (err) {
    logger.error('heartbeat update failed', { error: err.message });
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
    logger.error('usage_audit_log write failed', { error: err.message });
  }
}

function numOr0(v) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export default createEventsRouter();
