# P0+P1 越用越聰明 + 數據驅動進化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 OwnMind 自動從使用行為中學習——偵測高頻 friction、生成週/月報、擴充 init API 回傳上週摘要、新增 dashboard 週/月報頁籤、更新 AI skill 支援模式偵測與暫存區確認。

**Architecture:** Hybrid 方案——Server 負責資料聚合（週報 job、friction 統計、report API、init 擴充），AI client 負責對話中語意判斷（模式偵測、pending_review 暫存）。DB 不新增表，週/月報存 session_log，friction issue 存 project。

**Tech Stack:** Node.js 24（ESM）、Express 5、PostgreSQL + pg、node:test（內建測試框架）、HTML/vanilla JS（dashboard）

**Spec:** `docs/superpowers/specs/2026-03-30-p0-p1-smart-learning-design.md`

---

## File Map

| 檔案 | 動作 | 說明 |
|------|------|------|
| `db/004_weekly_summary_marker.sql` | 新增 | users 表加 weekly_summary_sent_at 欄位 |
| `src/utils/report.js` | 新增 | 週/月報計算純函式（可單獨測試） |
| `src/routes/session.js` | 修改 | 新增 GET /report endpoint |
| `src/jobs/weeklyReport.js` | 新增 | 週/月報 cron job |
| `src/index.js` | 修改 | 啟動時掛載 job |
| `src/routes/memory.js` | 修改 | init 回傳 weekly_summary |
| `src/public/admin.html` | 修改 | 新增週/月報頁籤 |
| `~/.ownmind/skills/ownmind-memory.md` | 修改 | 模式偵測 A + 暫存區 B + SessionStart 週摘要 |
| `~/.claude/commands/ownmind-memory.md` | 修改 | 同步上方 skill |
| `package.json` | 修改 | 加 test script + node-cron 依賴 |
| `tests/report.test.js` | 新增 | report.js 單元測試 |

---

## Task 1：DB Migration — 新增 weekly_summary_sent_at

**Files:**
- Create: `db/004_weekly_summary_marker.sql`

- [ ] **Step 1：建立 migration 檔**

```sql
-- db/004_weekly_summary_marker.sql
-- Description: Add weekly_summary_sent_at to users for per-user init marker

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS weekly_summary_sent_at TIMESTAMPTZ DEFAULT NULL;
```

- [ ] **Step 2：在 kkvin.com 執行 migration**

```bash
ssh root@kkvin.com "cd /VinService/ownmind && docker exec ownmind-db psql -U ownmind -d ownmind -f /dev/stdin" < db/004_weekly_summary_marker.sql
```

預期輸出：`ALTER TABLE`

- [ ] **Step 3：確認欄位存在**

```bash
ssh root@kkvin.com "docker exec ownmind-db psql -U ownmind -d ownmind -c '\d users'"
```

確認輸出中有 `weekly_summary_sent_at | timestamp with time zone`

- [ ] **Step 4：commit**

```bash
git add db/004_weekly_summary_marker.sql
git commit -m "feat: add weekly_summary_sent_at to users for init marker"
```

---

## Task 2：測試環境 + 報表計算工具 report.js

**Files:**
- Modify: `package.json`
- Create: `src/utils/report.js`
- Create: `tests/report.test.js`

- [ ] **Step 1：新增 test script 和 node-cron 到 package.json**

在 `package.json` 的 scripts 加：
```json
"test": "node --test tests/**/*.test.js",
"test:watch": "node --test --watch tests/**/*.test.js"
```

在 dependencies 加（稍後 npm install）：
```json
"node-cron": "^3.0.3"
```

- [ ] **Step 2：寫 report.js 的失敗測試**

建立 `tests/report.test.js`：
```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePeriodRange, groupFrictions, computeReportData } from '../src/utils/report.js';

describe('computePeriodRange', () => {
  it('week offset=0 回傳本週週一到週日', () => {
    // 固定一個週三：2026-03-25（週三）
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { start, end } = computePeriodRange('week', 0, now);
    assert.equal(start.toISOString().slice(0, 10), '2026-03-23'); // 週一
    assert.equal(end.toISOString().slice(0, 10), '2026-03-29');   // 週日
  });

  it('week offset=1 回傳上週', () => {
    const now = new Date('2026-03-25T12:00:00+08:00');
    const { start, end } = computePeriodRange('week', 1, now);
    assert.equal(start.toISOString().slice(0, 10), '2026-03-16');
    assert.equal(end.toISOString().slice(0, 10), '2026-03-22');
  });

  it('month offset=0 回傳本月', () => {
    const now = new Date('2026-03-15T12:00:00+08:00');
    const { start, end } = computePeriodRange('month', 0, now);
    assert.equal(start.toISOString().slice(0, 10), '2026-03-01');
    assert.equal(end.toISOString().slice(0, 10), '2026-03-31');
  });
});

describe('groupFrictions', () => {
  it('同前 20 字元歸為同類，計數正確', () => {
    const frictions = [
      'SSH timeout 連不上伺服器',
      'SSH timeout 連不上，重試無效',
      'SSH timeout 已被 fail2ban 封',
      'Docker cache 沒更新',
    ];
    const result = groupFrictions(frictions);
    assert.equal(result[0].count, 3);
    assert.equal(result[0].text.startsWith('SSH timeout'), true);
    assert.equal(result[1].count, 1);
  });

  it('大小寫視為相同', () => {
    const frictions = ['SSH Timeout 問題', 'ssh timeout 問題再現'];
    const result = groupFrictions(frictions);
    assert.equal(result[0].count, 2);
  });

  it('空陣列回傳空陣列', () => {
    assert.deepEqual(groupFrictions([]), []);
  });
});

describe('computeReportData', () => {
  it('正常回傳報表結構', () => {
    const sessions = [
      { details: { friction_points: 'SSH timeout 連不上', suggestions: '加 retry' } },
      { details: { friction_points: 'SSH timeout 重試無效', suggestions: null } },
      { details: null },
    ];
    const result = computeReportData(sessions, 5, '2026-03-23 ~ 2026-03-29');
    assert.equal(result.period, '2026-03-23 ~ 2026-03-29');
    assert.equal(result.new_memories, 5);
    assert.equal(result.top_frictions[0].count, 2);
    assert.equal(result.top_suggestions[0].text, '加 retry');
    assert.ok(result.generated_at);
  });

  it('空 sessions 回傳空陣列', () => {
    const result = computeReportData([], 0, '2026-03-23 ~ 2026-03-29');
    assert.deepEqual(result.top_frictions, []);
    assert.deepEqual(result.top_suggestions, []);
    assert.equal(result.new_memories, 0);
  });
});
```

- [ ] **Step 3：確認測試失敗（在 VPS 上執行）**

```bash
ssh root@kkvin.com "cd /VinService/ownmind && git pull && npm test"
```

預期：`ERR_MODULE_NOT_FOUND` 或 `SyntaxError`（report.js 尚未建立）

- [ ] **Step 4：實作 report.js**

建立 `src/utils/report.js`：
```javascript
/**
 * 週/月報計算工具
 * 所有計算邏輯抽成純函式，方便測試
 */

/**
 * 計算指定 period 的時間範圍（Asia/Taipei，UTC+8）
 * @param {'week'|'month'} period
 * @param {number} offset - 0=本期, 1=上一期
 * @param {Date} [now] - 可注入，方便測試
 * @returns {{ start: Date, end: Date, label: string }}
 */
export function computePeriodRange(period, offset = 0, now = new Date()) {
  // 轉成 UTC+8 時間
  const tz = 8 * 60 * 60 * 1000;
  const local = new Date(now.getTime() + tz);

  if (period === 'week') {
    // 週一為一週開始
    const day = local.getUTCDay(); // 0=Sunday
    const daysFromMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(local);
    monday.setUTCDate(local.getUTCDate() - daysFromMonday - offset * 7);
    monday.setUTCHours(0, 0, 0, 0);

    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);

    // 轉回 UTC
    const start = new Date(monday.getTime() - tz);
    const end = new Date(sunday.getTime() - tz);
    const label = `${monday.toISOString().slice(0, 10)} ~ ${sunday.toISOString().slice(0, 10)}`;
    return { start, end, label };
  }

  if (period === 'month') {
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth() - offset;

    const firstDay = new Date(Date.UTC(year, month, 1) - tz);
    const lastDay = new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999) - tz);

    const localFirst = new Date(firstDay.getTime() + tz);
    const localLast = new Date(lastDay.getTime() + tz);
    const label = `${localFirst.toISOString().slice(0, 10)} ~ ${localLast.toISOString().slice(0, 10)}`;
    return { start: firstDay, end: lastDay, label };
  }

  throw new Error(`Unknown period: ${period}`);
}

/**
 * 把 friction_points 字串陣列群組化（前 20 字元 key，不分大小寫）
 * @param {string[]} frictions
 * @returns {{ text: string, count: number }[]} 降序排列
 */
export function groupFrictions(frictions) {
  const map = new Map();
  for (const f of frictions) {
    if (!f || typeof f !== 'string') continue;
    const key = f.toLowerCase().trim().slice(0, 20);
    if (!map.has(key)) {
      map.set(key, { text: f.trim(), count: 0 });
    }
    map.get(key).count++;
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

/**
 * 從已查好的 DB rows 計算報表資料（純函式）
 * @param {object[]} sessionRows - session_logs rows（含 details）
 * @param {number} newMemoriesCount
 * @param {string} periodLabel
 * @returns {object} report data
 */
export function computeReportData(sessionRows, newMemoriesCount, periodLabel) {
  const frictions = [];
  const suggestions = [];

  for (const row of sessionRows) {
    const d = row.details;
    if (!d) continue;
    if (d.friction_points && typeof d.friction_points === 'string') {
      frictions.push(d.friction_points);
    }
    if (d.suggestions && typeof d.suggestions === 'string') {
      suggestions.push(d.suggestions);
    }
  }

  const topFrictions = groupFrictions(frictions).slice(0, 10);
  const topSuggestions = groupFrictions(suggestions).slice(0, 10);

  return {
    period: periodLabel,
    new_memories: newMemoriesCount,
    friction_issues_created: 0, // 由 job 填入，API 即時計算時為 0
    top_frictions: topFrictions,
    top_suggestions: topSuggestions,
    generated_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 5：跑測試確認通過（在 VPS 上）**

```bash
ssh root@kkvin.com "cd /VinService/ownmind && npm test"
```

預期：所有 tests pass，`groupFrictions`、`computePeriodRange`、`computeReportData` 測試都綠燈

- [ ] **Step 6：安裝 node-cron**

```bash
cd /Users/vincentkao/SourceCode/OwnMind && npm install node-cron
```

- [ ] **Step 7：commit**

```bash
git add package.json package-lock.json src/utils/report.js tests/report.test.js
git commit -m "feat: report computation utils + test setup (node:test)"
```

---

## Task 3：Report API — GET /api/session/report

**Files:**
- Modify: `src/routes/session.js` — 在 `export default router` 前新增 endpoint

- [ ] **Step 1：在 tests/report.test.js 新增 API 整合測試（optional，若本地有 DB 可跑）**

若本地無 DB，跳過此步，改在 Task 3 Step 4 部署後用 curl 驗證。

- [ ] **Step 2：在 session.js 新增 GET /report endpoint**

在 `src/routes/session.js` 的 `export default router` 前加入：

```javascript
import { computePeriodRange, computeReportData } from '../utils/report.js';

/**
 * GET /report - 取週/月報
 * Query: period=week|month, offset=0,1,2...
 */
router.get('/report', async (req, res) => {
  try {
    const period = req.query.period;
    const offset = parseInt(req.query.offset, 10) || 0;

    if (!['week', 'month'].includes(period)) {
      return res.status(400).json({ error: 'period 必須是 week 或 month' });
    }
    if (offset < 0 || offset > 52) {
      return res.status(400).json({ error: 'offset 範圍 0~52' });
    }

    const { start, end, label } = computePeriodRange(period, offset);

    // 查詢該 period 的 session logs（含 friction/suggestions）
    const sessions = await query(
      `SELECT tool, model, details FROM session_logs
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND details IS NOT NULL AND details != '{}'::jsonb
         AND compressed = false`,
      [req.user.id, start, end]
    );

    // 查詢新增記憶數（排除 pending_review）
    const memoriesResult = await query(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND status = 'active'
         AND NOT (tags @> ARRAY['pending_review'])`,
      [req.user.id, start, end]
    );
    const newMemoriesCount = parseInt(memoriesResult.rows[0].cnt, 10);

    // 查詢該 period 自動建立的 friction issue 數
    const frictionIssuesResult = await query(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE user_id = $1
         AND created_at >= $2
         AND created_at <= $3
         AND tags @> ARRAY['friction-issue', 'auto-generated']`,
      [req.user.id, start, end]
    );
    const frictionIssuesCreated = parseInt(frictionIssuesResult.rows[0].cnt, 10);

    const report = computeReportData(sessions.rows, newMemoriesCount, label);
    report.friction_issues_created = frictionIssuesCreated;

    res.json(report);
  } catch (err) {
    logger.error('取週/月報失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});
```

注意：`import { computePeriodRange, computeReportData } from '../utils/report.js';` 加在 session.js 頂部 import 區塊。

- [ ] **Step 3：commit**

```bash
git add src/routes/session.js
git commit -m "feat: GET /api/session/report — weekly/monthly report API"
```

- [ ] **Step 4：部署到 kkvin.com 並驗證**

```bash
ssh root@kkvin.com "cd /VinService/ownmind && git pull && docker compose build --no-cache api && docker compose up -d api"
```

驗證（換成實際 api_key）：
```bash
curl "http://kkvin.com:3100/api/session/report?period=week&offset=1" \
  -H "Authorization: Bearer <your_api_key>"
```

預期回傳 JSON 含 `period`, `new_memories`, `top_frictions`, `top_suggestions`

---

## Task 4：Scheduled Job — 週/月報生成

**Files:**
- Create: `src/jobs/weeklyReport.js`
- Modify: `src/index.js` — import 並啟動 job

- [ ] **Step 1：建立 weeklyReport.js**

```javascript
// src/jobs/weeklyReport.js
import cron from 'node-cron';
import { query } from '../utils/db.js';
import { computePeriodRange, groupFrictions } from '../utils/report.js';
import logger from '../utils/logger.js';

const FRICTION_THRESHOLD = 3; // >= 3 次才建 issue

/**
 * 建立高頻 friction 的 project 記憶（去重）
 */
async function createFrictionIssues(userId, topFrictions, periodLabel) {
  let created = 0;
  for (const f of topFrictions) {
    if (f.count < FRICTION_THRESHOLD) continue;

    const key = f.text.toLowerCase().trim().slice(0, 20);
    const titlePrefix = `⚠️ 高頻 friction：`;
    const titleSnippet = f.text.slice(0, 50);

    // 檢查是否已存在（避免重複）
    const existing = await query(
      `SELECT id FROM memories
       WHERE user_id = $1
         AND tags @> ARRAY['friction-issue']
         AND LOWER(title) LIKE $2
         AND status = 'active'
       LIMIT 1`,
      [userId, `%${key}%`]
    );

    if (existing.rows.length > 0) continue;

    await query(
      `INSERT INTO memories (user_id, type, title, content, tags, status)
       VALUES ($1, 'project', $2, $3, $4, 'active')`,
      [
        userId,
        `${titlePrefix}${titleSnippet}`,
        `${periodLabel} 期間出現 ${f.count} 次。`,
        ['friction-issue', 'auto-generated'],
      ]
    );
    created++;
  }
  return created;
}

/**
 * 執行週報 job（可傳入 userId 做單使用者處理，預設處理全部）
 */
export async function runWeeklyReport(targetUserId = null) {
  logger.info('週報 job 開始執行');
  const { start, end, label } = computePeriodRange('week', 1); // 上週

  try {
    // 取所有 active users（或指定 user）
    const usersResult = await query(
      targetUserId
        ? `SELECT id FROM users WHERE id = $1`
        : `SELECT id FROM users WHERE role IN ('admin', 'user')`,
      targetUserId ? [targetUserId] : []
    );

    for (const user of usersResult.rows) {
      const userId = user.id;

      // 取上週 session logs
      const sessions = await query(
        `SELECT details FROM session_logs
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND details IS NOT NULL AND details != '{}'::jsonb
           AND compressed = false`,
        [userId, start, end]
      );

      // 收集 friction / suggestions
      const frictions = sessions.rows
        .map(r => r.details?.friction_points)
        .filter(Boolean);
      const suggestions = sessions.rows
        .map(r => r.details?.suggestions)
        .filter(Boolean);

      const topFrictions = groupFrictions(frictions).slice(0, 10);
      const topSuggestions = groupFrictions(suggestions).slice(0, 10);

      // 建立高頻 friction issues
      const frictionIssuesCreated = await createFrictionIssues(userId, topFrictions, label);

      // 統計新增記憶數
      const memoriesResult = await query(
        `SELECT COUNT(*) as cnt FROM memories
         WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
           AND status = 'active' AND NOT (tags @> ARRAY['pending_review'])`,
        [userId, start, end]
      );
      const newMemories = parseInt(memoriesResult.rows[0].cnt, 10);

      // 建週報快照（存 session_logs）
      const weekNum = getWeekNumber(start);
      const year = new Date(start.getTime() + 8 * 3600000).getUTCFullYear();
      const title = `週報 ${year}-W${String(weekNum).padStart(2, '0')}`;

      // 去重：同 title 的週報不重複建立
      const existingReport = await query(
        `SELECT id FROM session_logs WHERE user_id = $1 AND summary = $2 LIMIT 1`,
        [userId, title]
      );

      if (existingReport.rows.length === 0) {
        await query(
          `INSERT INTO session_logs (user_id, tool, model, summary, details, compressed)
           VALUES ($1, 'system', 'weekly-job', $2, $3, false)`,
          [
            userId,
            title,
            JSON.stringify({
              period: label,
              new_memories: newMemories,
              friction_issues_created: frictionIssuesCreated,
              top_frictions: topFrictions.slice(0, 5),
              top_suggestions: topSuggestions.slice(0, 5),
            }),
          ]
        );
        logger.info(`週報建立完成: ${title}`, { userId, frictionIssuesCreated, newMemories });
      }
    }
  } catch (err) {
    logger.error('週報 job 失敗', { error: err.message });
  }
}

/**
 * 月報 job：聚合當月所有週報快照
 */
export async function runMonthlyReport(targetUserId = null) {
  logger.info('月報 job 開始執行');
  const { start, end, label } = computePeriodRange('month', 1); // 上月

  const year = new Date(start.getTime() + 8 * 3600000).getUTCFullYear();
  const month = new Date(start.getTime() + 8 * 3600000).getUTCMonth() + 1;
  const title = `月報 ${year}-${String(month).padStart(2, '0')}`;

  try {
    const usersResult = await query(
      targetUserId
        ? `SELECT id FROM users WHERE id = $1`
        : `SELECT id FROM users WHERE role IN ('admin', 'user')`,
      targetUserId ? [targetUserId] : []
    );

    for (const user of usersResult.rows) {
      const userId = user.id;

      // 去重
      const existing = await query(
        `SELECT id FROM session_logs WHERE user_id = $1 AND summary = $2 LIMIT 1`,
        [userId, title]
      );
      if (existing.rows.length > 0) continue;

      // 聚合當月週報
      const weeklyReports = await query(
        `SELECT details FROM session_logs
         WHERE user_id = $1 AND tool = 'system' AND model = 'weekly-job'
           AND created_at >= $2 AND created_at <= $3`,
        [userId, start, end]
      );

      let newMemories = 0;
      let frictionIssuesCreated = 0;
      const allFrictions = [];
      const allSuggestions = [];

      for (const r of weeklyReports.rows) {
        const d = r.details;
        if (!d) continue;
        newMemories += d.new_memories || 0;
        frictionIssuesCreated += d.friction_issues_created || 0;
        if (Array.isArray(d.top_frictions)) allFrictions.push(...d.top_frictions.map(f => f.text));
        if (Array.isArray(d.top_suggestions)) allSuggestions.push(...d.top_suggestions.map(s => s.text));
      }

      await query(
        `INSERT INTO session_logs (user_id, tool, model, summary, details, compressed)
         VALUES ($1, 'system', 'monthly-job', $2, $3, false)`,
        [
          userId,
          title,
          JSON.stringify({
            period: label,
            new_memories: newMemories,
            friction_issues_created: frictionIssuesCreated,
            top_frictions: groupFrictions(allFrictions).slice(0, 5),
            top_suggestions: groupFrictions(allSuggestions).slice(0, 5),
          }),
        ]
      );
      logger.info(`月報建立完成: ${title}`, { userId });
    }
  } catch (err) {
    logger.error('月報 job 失敗', { error: err.message });
  }
}

function getWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

/**
 * 啟動定時 job
 * 週報：每週一 00:00 Asia/Taipei = UTC Sunday 16:00
 * 月報：每月 1 號 00:00 Asia/Taipei = UTC last-day 16:00
 */
export function startJobs() {
  // 週報：UTC 週日 16:00 = Asia/Taipei 週一 00:00
  cron.schedule('0 16 * * 0', () => {
    runWeeklyReport().catch(err => logger.error('週報 cron 失敗', { error: err.message }));
  }, { timezone: 'UTC' });

  // 月報：UTC 每月 1 號 16:00 = Asia/Taipei 每月 2 號 00:00
  // 注意：與 spec 差一天（spec 是每月 1 號 00:00 Asia/Taipei），
  // 但可保證上月資料完整，且 node-cron 不支援 last-day-of-month 語法
  cron.schedule('0 16 1 * *', () => {
    runMonthlyReport().catch(err => logger.error('月報 cron 失敗', { error: err.message }));
  }, { timezone: 'UTC' });

  logger.info('週/月報 job 已啟動');
}
```

- [ ] **Step 2：修改 src/index.js 啟動 job**

在 `src/index.js` 加入：
```javascript
import { startJobs } from './jobs/weeklyReport.js';

// 在 app.listen callback 內加：
app.listen(PORT, () => {
  logger.info(`OwnMind API 伺服器已啟動，監聽埠號 ${PORT}`);
  startJobs(); // 啟動週/月報 job
});
```

- [ ] **Step 3：commit**

```bash
git add src/jobs/weeklyReport.js src/index.js
git commit -m "feat: weekly/monthly report cron job with friction-issue auto-creation"
```

- [ ] **Step 4：部署並確認 job 啟動**

```bash
ssh root@kkvin.com "cd /VinService/ownmind && git pull && docker compose build --no-cache api && docker compose up -d api && docker logs ownmind-api --tail=20"
```

預期 log 含：`週/月報 job 已啟動`

---

## Task 5：Init API 擴充 — weekly_summary

**Files:**
- Modify: `src/routes/memory.js` — init endpoint，新增 weekly_summary 邏輯

- [ ] **Step 1：在 memory.js 的 init endpoint 加入 weekly_summary 計算**

在 `src/routes/memory.js` 的 `router.get('/init', ...)` 內，`res.json({...})` 前加入：

```javascript
// weekly_summary：每週第一次 init 才回傳，其他靜默
let weeklySummary = null;
const now = new Date();
const weekStart = (() => {
  const d = new Date(now.getTime() + 8 * 3600000);
  const day = d.getUTCDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - daysFromMonday);
  monday.setUTCHours(0, 0, 0, 0);
  return new Date(monday.getTime() - 8 * 3600000); // 轉回 UTC
})();

// 查 marker
const markerResult = await query(
  `SELECT weekly_summary_sent_at FROM users WHERE id = $1`,
  [req.user.id]
);
const lastSent = markerResult.rows[0]?.weekly_summary_sent_at;
const shouldSend = !lastSent || new Date(lastSent) < weekStart;

if (shouldSend) {
  // 取上週報表（priority：先找快照，無則即時計算）
  // computePeriodRange, groupFrictions 已在頂部靜態 import（見下方說明）
  const { start, end, label } = computePeriodRange('week', 1);

  const snapshotResult = await query(
    `SELECT details FROM session_logs
     WHERE user_id = $1 AND tool = 'system'
       AND summary LIKE '週報%'
       AND created_at >= $2
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.id, start]
  );

  if (snapshotResult.rows.length > 0) {
    const d = snapshotResult.rows[0].details;
    weeklySummary = {
      period: d.period || label,
      new_memories: d.new_memories || 0,
      friction_issues_created: d.friction_issues_created || 0,
      top_frictions: (d.top_frictions || []).slice(0, 3).map(f => f.text || f),
    };
  } else {
    // 即時計算（job 還沒跑時的 fallback）
    const sessions = await query(
      `SELECT details FROM session_logs
       WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
         AND details IS NOT NULL AND details != '{}'::jsonb`,
      [req.user.id, start, end]
    );
    const frictions = sessions.rows.map(r => r.details?.friction_points).filter(Boolean);
    const topFrictions = groupFrictions(frictions).slice(0, 3).map(f => f.text);

    const memCount = await query(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
         AND status = 'active' AND NOT (tags @> ARRAY['pending_review'])`,
      [req.user.id, start, end]
    );

    weeklySummary = {
      period: label,
      new_memories: parseInt(memCount.rows[0].cnt, 10),
      friction_issues_created: 0,
      top_frictions: topFrictions,
    };
  }

  // 更新 marker
  await query(
    `UPDATE users SET weekly_summary_sent_at = NOW() WHERE id = $1`,
    [req.user.id]
  );
}
```

在 `res.json({...})` 的物件裡加上：
```javascript
weekly_summary: weeklySummary,
```

**重要：** 在 `src/routes/memory.js` 頂部 import 區塊加入靜態 import（與其他 import 並列）：
```javascript
import { computePeriodRange, groupFrictions } from '../utils/report.js';
```
這行必須加在頂部，不是在函式內動態 import。

- [ ] **Step 2：commit**

```bash
git add src/routes/memory.js
git commit -m "feat: init API returns weekly_summary (once per week per user)"
```

- [ ] **Step 3：部署並驗證**

```bash
ssh root@kkvin.com "cd /VinService/ownmind && git pull && docker compose build --no-cache api && docker compose up -d api"
```

驗證：
```bash
curl "http://kkvin.com:3100/api/memory/init?compact=true" \
  -H "Authorization: Bearer <your_api_key>" | jq '.weekly_summary'
```

第一次呼叫回傳 `weekly_summary` 物件（可能是 null 如果上週沒有 session logs）；
同週第二次呼叫回傳 `"weekly_summary": null`。

---

## Task 6：Dashboard 週/月報頁籤

**Files:**
- Modify: `src/public/admin.html` — 新增第三個 tab 及其內容

- [ ] **Step 1：在 tabs div 加入新頁籤按鈕**

在 `admin.html` 找到：
```html
<div class="tab" onclick="switchTab('stats')">統計儀表板</div>
```
後面加：
```html
<div class="tab" onclick="switchTab('reports')">週/月報</div>
```

- [ ] **Step 2：新增 tab-reports div（在 tab-stats 結尾後）**

找到 `</div><!-- end tab-stats -->` 或最後一個 tab-content 後加入：

```html
<div id="tab-reports" class="tab-content">
  <div style="display:flex;gap:12px;align-items:center;margin-bottom:20px;">
    <select id="report-period" style="padding:6px 12px;border:1px solid #d2d2d7;border-radius:6px;font-size:14px;">
      <option value="week">週報</option>
      <option value="month">月報</option>
    </select>
    <select id="report-offset" style="padding:6px 12px;border:1px solid #d2d2d7;border-radius:6px;font-size:14px;">
      <option value="0">本期</option>
      <option value="1">上一期</option>
      <option value="2">兩期前</option>
      <option value="3">三期前</option>
    </select>
    <button onclick="loadReport()" style="padding:6px 16px;background:#7c3aed;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;">載入</button>
  </div>

  <div id="report-period-label" style="color:#86868b;font-size:13px;margin-bottom:16px;">—</div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px;">
    <div class="card">
      <div style="font-size:13px;color:#86868b;margin-bottom:4px;">新增記憶</div>
      <div id="report-new-memories" style="font-size:32px;font-weight:700;color:#1d1d1f;">—</div>
    </div>
    <div class="card">
      <div style="font-size:13px;color:#86868b;margin-bottom:4px;">自動建立 Friction Issue</div>
      <div id="report-friction-issues" style="font-size:32px;font-weight:700;color:#1d1d1f;">—</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
    <div>
      <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">⚠️ Top Frictions</h3>
      <div id="report-frictions-list" style="font-size:14px;color:#3a3a3c;"></div>
    </div>
    <div>
      <h3 style="font-size:15px;font-weight:600;margin-bottom:12px;">💡 Top Suggestions</h3>
      <div id="report-suggestions-list" style="font-size:14px;color:#3a3a3c;"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 3：新增 loadReport() 函式**

在 admin.html 的 `<script>` 區塊加入：

```javascript
async function loadReport() {
  const period = document.getElementById('report-period').value;
  const offset = document.getElementById('report-offset').value;

  try {
    const res = await fetch(`/api/session/report?period=${period}&offset=${offset}`, {
      headers: headers()  // 使用現有的 headers() helper，內含 API_KEY
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    document.getElementById('report-period-label').textContent = data.period || '—';
    document.getElementById('report-new-memories').textContent = data.new_memories ?? '—';
    document.getElementById('report-friction-issues').textContent = data.friction_issues_created ?? '—';

    // Frictions（純文字列表，不做 modal 跳轉，dashboard 目前無 memory detail modal）
    const frictionEl = document.getElementById('report-frictions-list');
    if (data.top_frictions && data.top_frictions.length > 0) {
      frictionEl.innerHTML = data.top_frictions.map(f => {
        return `<div style="padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-weight:600;color:#e65c00;">${f.count}x</span>
          <span style="margin-left:8px;">${esc(f.text)}</span>
        </div>`;
      }).join('');
    } else {
      frictionEl.innerHTML = '<div style="color:#86868b;">本期無 friction 資料</div>';
    }

    // Suggestions
    const suggestEl = document.getElementById('report-suggestions-list');
    if (data.top_suggestions && data.top_suggestions.length > 0) {
      suggestEl.innerHTML = data.top_suggestions.map(s => {
        return `<div style="padding:8px 0;border-bottom:1px solid #f0f0f0;">
          <span style="font-weight:600;color:#7c3aed;">${s.count}x</span>
          <span style="margin-left:8px;">${esc(s.text)}</span>
        </div>`;
      }).join('');
    } else {
      suggestEl.innerHTML = '<div style="color:#86868b;">本期無 suggestion 資料</div>';
    }
  } catch (err) {
    alert('載入報表失敗：' + err.message);
  }
}
```

注意：使用現有的 `headers()` 函式（內含 `API_KEY`）和 `esc()` 函式，不需新增。Friction 項目為純文字（dashboard 目前無 memory detail modal 基礎設施，modal 功能列為後續 P3+）。

- [ ] **Step 4：commit**

```bash
git add src/public/admin.html
git commit -m "feat: dashboard 週/月報頁籤 — friction + suggestion 列表"
```

- [ ] **Step 5：部署並瀏覽器實測**

```bash
ssh root@kkvin.com "cd /VinService/ownmind && git pull && docker compose build --no-cache api && docker compose up -d api"
```

開瀏覽器到 `http://kkvin.com:3100/admin`，點「週/月報」頁籤，選期間，點「載入」，確認資料顯示正確。

---

## Task 7：ownmind-memory Skill 更新 — AI Client

**Files:**
- Modify: `~/.ownmind/skills/ownmind-memory.md`
- Modify: `~/.claude/commands/ownmind-memory.md`

- [ ] **Step 1：在 skill 的「存取提示」區塊找到 SessionStart 載入格式**

搜尋 `weekly_summary` 或 `記憶載入` 的段落，確認 SessionStart 顯示邏輯的位置。

- [ ] **Step 2：在「載入時」格式加入 weekly_summary 顯示邏輯**

找到「### 載入時」或 `ownmind_init 載入記憶時` 的段落，加入：

```markdown
### SessionStart 週摘要（init 回傳 weekly_summary 時）

若 init 回傳 `weekly_summary`（非 null），**必須**在載入摘要後顯示：

【OwnMind v1.9.x】學習回顧：上週摘要（{weekly_summary.period}）
   - 新增記憶：{weekly_summary.new_memories} 筆
   - 自動建立 friction issue：{weekly_summary.friction_issues_created} 個
   - 最常遇到的 friction：{top_frictions[0]}、{top_frictions[1]}（若有）

若 `weekly_summary: null` → 靜默跳過，不顯示任何訊息。
```

- [ ] **Step 3：在「主動彙整觸發」區塊加入 pending_review 確認流程**

找到「主動彙整觸發」段落，加入：

```markdown
### Pending Review 確認

Session 結束彙整時，除列出本 session 學到的東西外，也列出 `tags=["pending_review"]` 的記憶：

【OwnMind v1.9.x】彙整建議：偵測到 {N} 筆暫存記憶待確認

| # | 分類 | 標題 | 來源 |
|---|------|------|------|
| 1 | ... | ... | 自動暫存 |

要保留哪些？（輸入編號、「全部」、或「跳過」）

- 使用者確認 → 呼叫 `ownmind_update(id, tags=[...移除 pending_review...])` 正式寫入
- 使用者拒絕 → 呼叫 `ownmind_disable(id, reason="使用者在 session 結束時拒絕")`
```

- [ ] **Step 4：在工作流程加入模式偵測說明**

在 skill 的「什麼時候該記」→「立即儲存」段落後加入：

```markdown
### 模式偵測（A）

對話中，若偵測到以下情況，**主動詢問是否記起來**：
- 同一個問題在本 session 第 2 次遇到（AI 判斷語意相似，in-memory heuristic）
- 踩到坑並解決，但沒有對應 iron_rule
- 做了重要技術決策但沒有記錄

提示格式：
【OwnMind v1.9.x】行為觸發：偵測到重複模式「{摘要}」
   這是本次 session 第 2 次遇到類似情況，要記起來嗎？
   → 輸入「記」或「跳過」

使用者說「跳過」→ 本 session 不再提示同一模式（in-memory，不寫 DB）

### 自動暫存（B）

以下情況直接靜默存入 `pending_review`，不打擾使用者：
- 解決了一個 bug
- 完成一個 feature 或 milestone
- 學到新的工具用法或指令
- 發現重要的環境/設定資訊

呼叫：`ownmind_save(type, title, content, tags=["pending_review", ...])`

**不觸發：** 純聊天、查詢類問答、臨時指令、已記錄過的內容
```

- [ ] **Step 5：同步到 ~/.claude/commands/**

```bash
cp ~/.ownmind/skills/ownmind-memory.md ~/.claude/commands/ownmind-memory.md
```

- [ ] **Step 6：commit skill 到 repo**

```bash
cd ~/.ownmind && git add skills/ownmind-memory.md && git commit -m "feat: skill 支援模式偵測(A) + 自動暫存(B) + SessionStart 週摘要"
```

- [ ] **Step 7：推送並確認**

```bash
cd ~/.ownmind && git push
```

---

## Task 8：版本號與文件同步（IR-008）

**Files:**
- Modify: `package.json` — version bump to 1.10.0
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `FILELIST.md`

- [ ] **Step 1：更新 package.json 版本**

將 `"version": "1.9.0"` 改為 `"version": "1.10.0"`

同步更新 `src/routes/memory.js` 的 `SERVER_VERSION`：
```javascript
const SERVER_VERSION = '1.10.0';
```

- [ ] **Step 2：更新 CHANGELOG.md**

在頂部加入：
```markdown
## 2026-03-30 — v1.10.0 越用越聰明 + 數據驅動進化

### 新功能
1. **週/月報 API** — `GET /api/session/report?period=week|month&offset=N`
2. **週報 Cron Job** — 每週一 00:00 Asia/Taipei 自動執行，高頻 friction 建立 project 記憶
3. **月報 Cron Job** — 每月 2 號 00:00 Asia/Taipei 聚合月度數據
4. **Init API 擴充** — 每週第一次 init 回傳 `weekly_summary`（跨裝置共用 marker）
5. **Dashboard 週/月報頁籤** — friction 列表 + suggestions 列表
6. **AI Skill 模式偵測** — 重複問題主動詢問、自動暫存 pending_review、SessionStart 週摘要

### 技術細節
- `src/utils/report.js`：純函式 computePeriodRange / groupFrictions / computeReportData
- `src/jobs/weeklyReport.js`：cron job（node-cron）
- `db/004_weekly_summary_marker.sql`：users.weekly_summary_sent_at
- `tests/report.test.js`：node:test 單元測試
```

- [ ] **Step 3：更新 FILELIST.md**

加入新檔案：`src/utils/report.js`、`src/jobs/weeklyReport.js`、`db/004_weekly_summary_marker.sql`、`tests/report.test.js`

- [ ] **Step 4：Final commit**

```bash
git add package.json src/routes/memory.js CHANGELOG.md FILELIST.md README.md
git commit -m "docs: v1.10.0 changelog, filelist, version bump"
git tag v1.10.0
git push && git push --tags
```

---

## 驗收清單

- [ ] `npm test` 全部綠燈
- [ ] `GET /api/session/report?period=week&offset=1` 回傳正確 JSON
- [ ] 週報 job log 有 `週/月報 job 已啟動`
- [ ] Init API 第一次呼叫有 `weekly_summary`，同週第二次為 `null`
- [ ] Dashboard 週/月報頁籤可載入資料
- [ ] Skill 有模式偵測和 pending_review 確認流程的說明
