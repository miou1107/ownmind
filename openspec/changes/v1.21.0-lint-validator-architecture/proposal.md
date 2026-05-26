# v1.21.0 — Lint 驗證器架構（規則驅動、user 自選啟用）

## 一句話總結

把 lint 邏輯從「OwnMind 系統硬寫」改成「user 鐵律驅動」。每個 user 在自己的鐵律 metadata 宣告要啟用哪個 validator 套件、OwnMind 鉤子只跑該 user 啟用的檢查。其他 user 不會被 Vin 的個人語言偏好強迫。

## 背景

2026-05-26 Vin 抓到 v1.20.4 雖然把 user-facing 訊息中性化（IR-036 字串改成「行話品質」）、但根本問題沒解：

**`shared/language-lint.js` 硬寫 `checkJargonExplanation` 跟 `checkMixedLanguage` 兩個檢查函式、所有 user 都被強迫跑**。

Eric 之類其他 user 沒「中英混雜」「行話品質」這兩條鐵律、但 OwnMind 鉤子還是會擋他們的回話。這違反 OwnMind 核心理念「記憶屬於使用者」 — lint 邏輯也該屬於使用者、不是系統內建。

## 範圍內

- 新 `shared/validators/` 目錄、3 個 validator 模組：
  - `jargon-explanation.js`（行話品質檢查、原 checkJargonExplanation 邏輯包裝）
  - `language-mixed-ratio.js`（中英混雜檢查、原 checkMixedLanguage 邏輯包裝）
  - `privacy-detect.js`（隱私偵測、從 hooks/ownmind-reply-lint.js 抽出）
- 新 `shared/validators/index.js`：註冊表 + `findValidator` / `listAvailableValidators`
- 改 `shared/language-lint.js` 的 `lintReply`：接受 `enabledValidators` 參數、規則驅動
- 改 `hooks/ownmind-reply-lint.js`：從規則快取掃出有 `lint_validator` 設定的鐵律、跑對應檢查
- user 鐵律 metadata 新欄位 `lint_validator: { name, params }`
- Vin 自己的 IR-036 / IR-037 加 lint_validator 啟用、向後維持相同行為
- 既有測試對應新架構

## 範圍外

- ❌ 自動轉移既有規則：user 沒手動加 `lint_validator` 就不啟用、不替 user 推斷
- ❌ Dashboard / UI 提供「validator 套件目錄」給 user 選用：留下版本做
- ❌ 第三方自訂 validator：本版只支援內建 3 個套件、未來再開放外掛
- ❌ validator 套件市集：太遠、不在範圍

## 設計重點

### validator 套件介面

每個 validator 是純函式 module、export：

```js
export const name = 'jargon_explanation';
export function check(content, params = {}, context = {}) {
  // params: user 從 metadata 傳進來的設定（可選）
  // context: { historicalCorpus, userPrompts, ... }
  // return: { ok: true } 或 { ok: false, violation: { event, message, detail } }
}
```

### user 鐵律 metadata 設計

```json
// IR-036（Vin 的「行話品質」鐵律）
{
  "lint_validator": {
    "name": "jargon_explanation",
    "params": {}
  },
  "triggered_by_event": "lint_jargon_explanation_required"
}

// IR-037（中英混雜）
{
  "lint_validator": {
    "name": "language_mixed_ratio",
    "params": { "threshold": 0.15 }
  },
  "triggered_by_event": "lint_language_mixed_ratio"
}

// 沒設 lint_validator 的鐵律 → 鉤子完全不跑那個檢查
```

### 鉤子流程改造

舊（v1.20.4）：
```
lintReply(content, historicalCorpus)
  → 硬跑 checkMixedLanguage + checkJargonExplanation
  → 回 violations
```

新（v1.21.0）：
```
extractEnabledValidators(rulesCache)
  → 掃 user 鐵律找 lint_validator 設定
  → 回 [{rule, validator, params}, ...]
lintReply(content, enabledValidators, context)
  → loop 跑每個 validator.check
  → 回 violations + sourceRule 對應
```

### 向後相容

- 對 Vin：透過 `ownmind_update` 改 IR-036 / IR-037 加 `lint_validator` metadata、行為跟 v1.20.4 一樣
- 對其他 user（Eric / 未來新增）：沒設 metadata = 鉤子完全不擋 = 安靜
- 鉤子本身：找不到任何 enabledValidator → exit 0、不擋

## 版號決策

v1.21.0、不是 patch 而是 minor。理由：
- 這是架構大改、新 validator 介面 + 規則驅動流程
- 既有 user 要手動加 metadata 才會繼續 enforce（破壞既有預設行為）
- 符合 semver：minor 表示「新功能 + 可能改變預設行為但不破壞 API」

## 風險

- **既有 lint enforcement 暫時靜默**：Vin 自己的 IR-036 / IR-037 要加 metadata、不然 v1.21 上線後 lint 不擋 Vin。手動更新可控
- **規則快取讀失敗**：fail-open（白話：讀不到 user 鐵律就視為沒啟用 validator、安靜）
- **validator 套件升級難**：套件 API 改變要兼顧 user metadata 的 `params` 格式、新版加欄位但不刪舊欄位
- **測試重寫**：既有 6 個測試檔要對應「規則驅動」風格、工程量中等
