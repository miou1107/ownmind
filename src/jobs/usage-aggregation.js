/**
 * usage-aggregation.js — token_events → token_usage_daily 重算邏輯
 *
 * Aggregation 由 server 全權負責（D1）：
 *   - Cost 一律 server-side 從 model_pricing 算，client 的 native_cost_usd 只是 advisory
 *   - Wall seconds = last_ts - first_ts
 *   - Active seconds = 相鄰 event 時距 ≤ 600s 者累加
 *
 * 冪等：對同一 (user_id, tool, session_id, date) 重跑結果相同，
 *      因為一律 `SELECT ... GROUP BY model` 重算再 UPSERT。
 */

import { pickPricing, computeCost } from '../utils/pricing-lookup.js';

export const DEFAULT_ACTIVE_GAP_SECONDS = 600;

/**
 * 從一串 timestamps 計算 wall / active seconds。純函式。
 * @param {Array<Date|string>} timestamps - 未排序即可
 * @param {number} gapSeconds - 間距超過此值視為離線（預設 600 = 10 分鐘）
 */
export function computeTimeSpans(timestamps, gapSeconds = DEFAULT_ACTIVE_GAP_SECONDS) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) {
    return { wall_seconds: 0, active_seconds: 0, first_ts: null, last_ts: null };
  }

  const sorted = timestamps
    .map((t) => (t instanceof Date ? t : new Date(t)))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  if (sorted.length === 0) {
    return { wall_seconds: 0, active_seconds: 0, first_ts: null, last_ts: null };
  }

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const wall = Math.round((last.getTime() - first.getTime()) / 1000);

  let active = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const dt = (sorted[i].getTime() - sorted[i - 1].getTime()) / 1000;
    if (dt <= gapSeconds) active += dt;
  }

  return {
    wall_seconds: wall,
    active_seconds: Math.round(active),
    first_ts: first,
    last_ts: last
  };
}

/**
 * 把 events 按 model 分組，累加 tokens 與 message_count。純函式。
 * @param {Array} events - 每個元素要有 model + *_tokens 欄位
 * @returns {Map<string, object>} - model → { tokens, message_count }
 */
export function groupByModel(events) {
  const map = new Map();
  for (const e of events) {
    const key = e.model ?? '__unknown__';
    if (!map.has(key)) {
      map.set(key, {
        model: e.model ?? null,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        reasoning_tokens: 0,
        message_count: 0
      });
    }
    const g = map.get(key);
    g.input_tokens += Number(e.input_tokens ?? 0);
    g.output_tokens += Number(e.output_tokens ?? 0);
    g.cache_creation_tokens += Number(e.cache_creation_tokens ?? 0);
    g.cache_read_tokens += Number(e.cache_read_tokens ?? 0);
    g.reasoning_tokens += Number(e.reasoning_tokens ?? 0);
    g.message_count += 1;
  }
  return map;
}

/**
 * 從 events + 所有相關 pricing rows 算出 daily row。純函式。
 * @param {{user_id, tool, session_id, date}} keys
 * @param {Array} events
 * @param {Array} pricingRows - 所有可能的 pricing（同 tool、可能多 model、多 effective_date）
 * @returns {object} 準備好 UPSERT 的 token_usage_daily row
 */
export function buildDailyRow(keys, events, pricingRows) {
  const { user_id, tool, session_id, date } = keys;

  const totals = {
    input_tokens: 0, output_tokens: 0,
    cache_creation_tokens: 0, cache_read_tokens: 0,
    reasoning_tokens: 0, message_count: 0
  };
  let cost_usd = 0;
  let anyUnknownPricing = false;

  const byModel = groupByModel(events);

  for (const group of byModel.values()) {
    totals.input_tokens += group.input_tokens;
    totals.output_tokens += group.output_tokens;
    totals.cache_creation_tokens += group.cache_creation_tokens;
    totals.cache_read_tokens += group.cache_read_tokens;
    totals.reasoning_tokens += group.reasoning_tokens;
    totals.message_count += group.message_count;

    const pricing = pickPricing(pricingRows, tool, group.model, date);
    const groupCost = computeCost(pricing, group);
    if (groupCost == null) anyUnknownPricing = true;
    else cost_usd += groupCost;
  }

  // 政策：任何 model 查不到 pricing → 整筆 cost_usd = null
  // 理由：部分 cost 看起來像真數字比 null 更危險（讀者以為總額完整）
  if (anyUnknownPricing) cost_usd = null;

  const spans = computeTimeSpans(events.map((e) => e.ts));

  // 取最晚 event 的 model 做為 daily.model（單值欄位）
  let latestModel = null;
  let latestTs = -Infinity;
  for (const e of events) {
    const t = new Date(e.ts).getTime();
    if (t > latestTs) { latestTs = t; latestModel = e.model ?? null; }
  }

  return {
    user_id, tool, session_id, date,
    model: latestModel,
    ...totals,
    cost_usd,
    wall_seconds: spans.wall_seconds,
    active_seconds: spans.active_seconds,
    first_ts: spans.first_ts,
    last_ts: spans.last_ts
  };
}

/**
 * DB 版：重算 (user, tool, session, date) 的 daily aggregate 並 UPSERT。
 * 冪等：重跑不會 double count。
 *
 * @param {{query: Function}} deps
 * @param {{userId, tool, sessionId, date}} keys - date 為 YYYY-MM-DD
 */
export async function recomputeDaily({ query }, keys) {
  const { userId, tool, sessionId, date } = keys;

  const eventsRes = await query(
    `SELECT model, ts,
            input_tokens, output_tokens,
            cache_creation_tokens, cache_read_tokens, reasoning_tokens
       FROM token_events
      WHERE user_id = $1 AND tool = $2 AND session_id = $3
        AND (ts AT TIME ZONE 'Asia/Taipei')::date = $4
      ORDER BY ts ASC`,
    [userId, tool, sessionId, date]
  );

  // 沒 event 就不寫（也不刪既存 row，留給上游判斷）
  if (eventsRes.rows.length === 0) return { skipped: true };

  // 撈該 tool 可能用到的 pricing（一次查完，純函式 pick）
  const models = [...new Set(eventsRes.rows.map((e) => e.model).filter(Boolean))];
  const pricingRes = models.length === 0
    ? { rows: [] }
    : await query(
        `SELECT id, tool, model, input_per_1m, output_per_1m,
                cache_write_per_1m, cache_read_per_1m, effective_date
           FROM model_pricing
          WHERE tool = $1 AND model = ANY($2::text[])`,
        [tool, models]
      );

  const row = buildDailyRow(
    { user_id: userId, tool, session_id: sessionId, date },
    eventsRes.rows,
    pricingRes.rows
  );

  await query(
    `INSERT INTO token_usage_daily
       (user_id, tool, session_id, date, model,
        input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, reasoning_tokens,
        message_count, cost_usd, wall_seconds, active_seconds, first_ts, last_ts, recomputed_at)
     VALUES ($1, $2, $3, $4, $5,
             $6, $7, $8, $9, $10,
             $11, $12, $13, $14, $15, $16, NOW())
     ON CONFLICT (user_id, tool, session_id, date) DO UPDATE SET
       model = EXCLUDED.model,
       input_tokens = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens,
       cache_creation_tokens = EXCLUDED.cache_creation_tokens,
       cache_read_tokens = EXCLUDED.cache_read_tokens,
       reasoning_tokens = EXCLUDED.reasoning_tokens,
       message_count = EXCLUDED.message_count,
       cost_usd = EXCLUDED.cost_usd,
       wall_seconds = EXCLUDED.wall_seconds,
       active_seconds = EXCLUDED.active_seconds,
       first_ts = EXCLUDED.first_ts,
       last_ts = EXCLUDED.last_ts,
       recomputed_at = NOW()`,
    [
      row.user_id, row.tool, row.session_id, row.date, row.model,
      row.input_tokens, row.output_tokens, row.cache_creation_tokens,
      row.cache_read_tokens, row.reasoning_tokens,
      row.message_count, row.cost_usd, row.wall_seconds, row.active_seconds,
      row.first_ts, row.last_ts
    ]
  );

  return { row };
}

/**
 * 根據 event timestamps 推導出該批次涉及的 (session, date) 組合。
 * ts 的 date 以 Asia/Taipei 時區切分（IR-011）。
 */
export function deriveTouchedCombos(events) {
  const combos = new Map();
  for (const e of events) {
    const date = toTaipeiYmd(e.ts);
    const key = `${e.tool}::${e.session_id}::${date}`;
    if (!combos.has(key)) {
      combos.set(key, { tool: e.tool, session_id: e.session_id, date });
    }
  }
  return [...combos.values()];
}

function toTaipeiYmd(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  // Asia/Taipei = UTC+8；用 Intl 格式避免手刻時區偏移
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(d); // en-CA → YYYY-MM-DD
}
