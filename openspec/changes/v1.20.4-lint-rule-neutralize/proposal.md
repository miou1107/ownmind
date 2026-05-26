# v1.20.4 — Lint 規則中性化（產品碼去個人鐵律編號）

## 一句話總結

OwnMind 產品程式碼裡寫死了 Vin 的個人鐵律編號（`IR-036` / `IR-037`）、會洩漏給其他 user 看到（白話：別人用 OwnMind、不該看到 Vin 私有的編號）。改用中性事件常數、規則跟產品碼解耦。違反 Vin 的 IR-050（個人鐵律編號不能寫進產品程式碼跟公開文件）。

## 背景

2026-05-26 Eric（另一個 AI session）看到自己對話裡出現「上一版違反 IR-036」字眼、Vin 抓到。grep 後發現：

- `shared/language-lint.js`：`rule: 'IR-037'` / `rule: 'IR-036'` 寫死在違反清單
- `hooks/ownmind-reply-lint.js`：`if (v.rule === 'IR-037')` / `if (v.rule === 'IR-036')` 訊息渲染分支
- `hooks/lib/lint-event-logger.js`：事件紀錄欄位
- `shared/bug-fingerprints.js:106`：v1.20.2 follow-up #3 我新加的指紋描述也寫了 IR-036（我的責任）

整個鏈路：lint 鉤子吐標準錯誤訊息含「IR-036」→ AI 收到指示寫重寫標註時複製「IR-036」→ 其他 user 看到莫名其妙的編號。

v1.19.10 已修過一輪（清掉「IR-041」字串）、但 IR-036 / IR-037 沒清乾淨。本提案徹底修。

## 範圍內

- 新 `shared/lint-event-types.js` 定義兩個中性事件常數
- 改 `shared/language-lint.js` 違反清單 rule 欄位用常數
- 改 `hooks/ownmind-reply-lint.js` 訊息渲染中性化（去 IR-XXX 編號）
- 改 `hooks/lib/build-compliance-events.js` 用規則 metadata 對應事件 → 個人鐵律編號
- 改 `hooks/lib/lint-event-logger.js` 用事件常數
- 清 `shared/bug-fingerprints.js:106` 描述
- 改測試對應新常數
- Vin 個人鐵律 IR-036 / IR-037 metadata 加 `triggered_by_event` 欄位（給合規對應用、不影響其他 user）

## 範圍外

- ❌ 其他個人鐵律編號的 leak（例如 IR-008 / IR-025 在訊息模板出現）：分開處理、留 backlog
- ❌ 把規則本身從 IR-036 編號改成中性命名：規則編號是 Vin 個人記憶結構、不動

## 設計重點

### 中性事件常數命名

用兩個常數：
- `lint_jargon_explanation_required`（行話沒附白話）
- `lint_language_mixed_ratio`（中英混雜比例過高）

蛇形命名（lowercase + 底線）、跟 bug-fingerprints.js 既有命名風格一致。

### 「事件 → 個人鐵律編號」對應

`buildComplianceEvents` 從規則快取找 `metadata.triggered_by_event === eventName` 的規則、用其 `code` 當 rule_code。找不到 → rule_code 空 + 用事件中文名當 rule_title。

Vin 個人鐵律 IR-036 / IR-037 加 metadata：
```json
{
  "triggered_by_event": "lint_jargon_explanation_required"   // IR-036
  "triggered_by_event": "lint_language_mixed_ratio"          // IR-037
}
```

其他 user 沒設、不影響（合規記錄寫事件中文名、user dashboard 還能查）。

### 訊息渲染

舊：`⚠️  IR-036: 行話 / 專有名詞沒附白話說明 — ...`
新：`⚠️  行話品質：行話 / 專有名詞沒附白話說明 — ...`

完全去掉「IR-036」字眼。AI 重寫標註只看到中性名、不會引用個人編號。

## 版號決策

v1.20.4、繼承 v1.20.3 系列。是「修舊設計缺陷」、不是新功能、用 patch 版號。

## 風險

- **既有測試大改**：39 處 `'IR-036'` / `'IR-037'` 字串引用要改成新常數。改錯易導致測試紅
- **合規記錄欄位改動**：rule_code 可能變空（user 沒設 triggered_by_event）、影響 dashboard 既有查詢。但 Vin 自己會加 metadata、其他 user 還沒安裝 dashboard 機制、影響可控
- **本機 hook 同步**：要 cp 5+ 個檔案、重啟 Claude Code 才完整生效
