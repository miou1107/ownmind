# /me 敘事報告（HackMD 風格 14 天分析）— 設計文件

**Date**: 2026-05-07
**Author**: Vin
**Status**: Approved (brainstorming)
**Target version**: v1.17.47

---

## 1. 目標

在 `/ownmind/me` 加一個「📊 敘事報告」分頁，照 Vincent 在 HackMD 寫過的那份 14 天分析報告結構，自動產出**一份所有登入者都看得到**的全團隊敘事報告。

機械段（表格、mermaid 圖）開頁即顯示；LLM 段（白話講、洞察、下一步）user 點按鈕才跑。

## 2. 範圍

* 12 個 section（人員、版本、日/時/週分布、動作類型、鐵律、更新失敗、專案排行、磨擦點、各專案合規、洞察、下一步）
* 全員可見、不分個人/管理者版
* 時間範圍跟現有 /me 共用 `range` 選擇器（最近 14/30/90 天）

非範圍：
* 個人化視角（你自己 vs 團隊）— 暫不做
* 匯出 PDF / Markdown — 暫不做
* 排程通知（每週寄 Email）— 暫不做

## 3. 架構

### 3.1 後端

新增 `src/routes/me-narrative.js`，掛 `/api/me/narrative` 路由群（共用 `auth` middleware）。

**Endpoint A — 機械資料**：
```
GET /api/me/narrative?range=14d
→ {
    range, generated_at,
    sections: {
      ranking, versions, daily, hourly, weekday,
      event_types, compliance, update_health,
      project_ranking, project_friction_raw, project_compliance
    }
  }
```

實作：呼叫既有 `/api/me/report` 邏輯重組資料 +
補 2 個新查詢：
1. `project_compliance` — `GROUP BY project_key, rule_code FROM iron_rule_compliance`
2. `project_friction_raw` — `SELECT project_key, body FROM session_logs WHERE generated_at >= now() - interval`，body 內 friction 欄位 raw 傳出（給 LLM 用）

機械段不算 LLM、純 SQL，秒回。

**Endpoint B — LLM 洞察**：
```
GET /api/me/narrative/insights?range=14d
→ {
    cached: true | false,
    summary_one_line,
    section_explanations: { ranking: '白話講...', ... },
    project_friction: { 'funit-v2': ['踩坑1', '踩坑2'], ... },
    insights_for_admin: ['洞察1', '洞察2', '洞察3'],
    next_actions: ['動作1', '動作2', '動作3']
  }
```

* 開頁時 frontend 自動觸發（不需按鈕）
* 走 OpenAI-compatible LLM Switch — `https://kkvin.com/llm-switch/v1/chat/completions`，`model: 'auto'`，Bearer auth
* 強制 `response_format: { type: 'json_object' }` 拿結構化輸出
* Server 端 cache by data hash：
  * Key = `me:narrative:insights:<range>:<sha256(narrative_data)>`
  * TTL 1 小時（in-memory Map；單機；未來上多機再換 Redis）
  * 同 hour 內所有 user 共享，全團隊每 range 每小時最多打 1 次 LLM
* `LLM_SWITCH_API_KEY` 從 env 讀（production `.env`，**不**入 commit）
* 沒設 key 就回 503 + 友善訊息「機械版仍可用」

### 3.2 前端

`src/public/me/index.html` 加第四個 tab：

```html
<button data-tab="narrative">📊 敘事報告</button>
```

對應 `<div id="tab-narrative">`：
* 切到 tab 時 lazy-fetch `/api/me/narrative`（機械段秒回）
* 拿到機械資料同時、平行背景觸發 `/api/me/narrative/insights`（不等使用者按鈕）
* 機械段先 render，每個 section 底下放 `<div class="ai-explain">⏳ 產生洞察中…</div>` placeholder
* LLM 回來後逐節填入「白話講」、頂端插入 summary、底部插入 next actions
* LLM 失敗（503 / timeout）→ placeholder 改顯示「（洞察暫時無法產生）」，機械段照常可看
* 不在 frontend 做 cache（server 已 cache by hash，重複呼叫成本可忽略）

### 3.3 LLM Prompt 結構

呼叫方式（OpenAI-compatible）：
```js
POST https://kkvin.com/llm-switch/v1/chat/completions
Authorization: Bearer <LLM_SWITCH_API_KEY>
{
  model: 'auto',
  response_format: { type: 'json_object' },
  temperature: 0.3,
  max_tokens: 2000,
  messages: [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(narrative_data) }
  ]
}
```

System prompt：
> 你是 OwnMind 內部的數據敘事 agent。輸入是一份團隊使用統計 JSON。
> 請以「白話、不裝專業」風格產出 JSON，schema 如下：
> { summary_one_line, section_explanations: {...}, project_friction: {...},
>   insights_for_admin: [...], next_actions: [...] }
> 只回 JSON，不要 markdown 圍欄。

## 4. 資料流

```
User 切到「敘事報告」tab
  ↓
平行發兩個 request：
  ① GET /api/me/narrative?range=14d         (秒回，純 SQL)
  ② GET /api/me/narrative/insights?range=14d (3-15s，自動跑)
  ↓
①回來 → render 12 section + 各放「⏳ 產生洞察中…」placeholder
  ↓
②回來：
  hit cache（資料 hash 跟上小時一樣）→ 立刻填入
  miss cache → 呼叫 llm-switch → 存 cache → 填入
  ↓
若 ② 失敗 → placeholder 改顯示「（洞察暫時無法產生）」
```

## 5. 錯誤處理

| 情境 | 行為 |
|------|------|
| 機械 endpoint SQL 失敗 | 500 + log，前端 fallback 顯示「資料載入失敗」 |
| LLM endpoint 沒 API key | 503 + 訊息「管理者尚未設定 LLM；機械版報告仍可用」 |
| LLM API rate limit / timeout（30s） | placeholder 改「（洞察暫時無法產生）」，不擋機械版 |
| llm-switch 回非 JSON / parse 失敗 | 同上，並把 raw response 寫 log 供 debug |
| session_logs 太大（>100 筆） | 截斷成最近 50 筆 friction notes 給 LLM；備註「樣本截斷」 |
| 14 天內無資料（新團隊） | 顯示「資料尚不足以產生敘事報告，至少需要 7 天活動」 |

## 6. 測試

* `tests/me-narrative.test.js`（新增）：
  * 機械 endpoint 回傳 schema 完整、各 section 都有
  * 沒 API key 時 LLM endpoint 回 503
  * Hash 一樣時走 cache、不二度打 LLM
* 手動驗測（IR-020）：部署後 kkvin.com/ownmind/me 切到敘事報告 tab，確認 12 section 都 render、按鈕能觸發 LLM、刷新走 cache

## 7. 安全

* 兩個 endpoint 都吃既有 `auth` middleware（須登入 OwnMind）
* `LLM_SWITCH_API_KEY` 從 env 讀，**不**入 commit、**不**入 spec/CHANGELOG
* friction notes 給 LLM 前濾掉 PII（email、IP）— 用既有 `redactPII()` helper
* LLM endpoint 跟機械 endpoint 都吃 `auth` middleware，未登入者拿不到

## 8. 部署

* Server 端 v1.17.47 — 新 routes + 前端 HTML
* `.env.example` 加 `LLM_SWITCH_API_KEY=` 註記（值留空）
* Production env 由 Vin 手動補 key 到 kkvin.com 主機 `.env`，不寫進任何 git-tracked 檔案

## 9. 開放問題

無（brainstorming 階段已釐清完）。

---

## 變更檔案清單

```
src/routes/me-narrative.js               (新增 ~250 行)
src/lib/llm-narrative.js                 (新增 ~120 行 — Claude API 包裝)
src/public/me/index.html                 (加第 4 tab + 12 section render + LLM 按鈕邏輯)
src/app.js                               (掛新 router)
.env.example                             (補 LLM_SWITCH_API_KEY 註記)
tests/me-narrative.test.js               (新增)
package.json / README* / docs/README*    (1.17.46 → 1.17.47)
CHANGELOG.md / FILELIST.md               (v1.17.47 條目)
```
