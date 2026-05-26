# v1.20.2 — 規格：recent_event_exists 失敗訊息加上具體呼叫範例

## Scenario 1：失敗訊息含具體 ownmind_report_compliance 呼叫範例

**GIVEN** 一條 IR-025 verification 條件 `{ type: 'recent_event_exists', params: { event: 'verification', action: 'comply' } }`
**AND** 合規記錄 `ctx.complianceEvents` 內沒有 `event='verification' AND action='comply'` 的記錄
**WHEN** 跑 `evaluateConditions(conditions, ctx)`
**THEN** 回傳 `{ pass: false, failures: [...] }`
**AND** `failures[0]` 字串裡必須包含字面值：
  - `ownmind_report_compliance`
  - `rule_title: 'verification'`（或 `rule_title="verification"`）
  - `action: 'comply'`（或 `action="comply"`）
**AND** `failures[0]` 字串裡必須包含「不要帶 rule_code」這類提示字眼（白話提示 AI 不要誤帶 rule_code 觸發備援邏輯）

## Scenario 2：code-review 事件缺失也同樣產生具體呼叫範例

**GIVEN** 一條條件 `{ type: 'recent_event_exists', params: { event: 'code-review', action: 'comply' } }`
**AND** 合規記錄沒對應 event
**WHEN** 跑 `evaluateConditions`
**THEN** `failures[0]` 內含 `rule_title: 'code-review'` + `action: 'comply'` + 不要帶 rule_code 提示

## Scenario 3：原本通過的條件不受影響

**GIVEN** 合規記錄已有 `{ event: 'verification', action: 'comply' }`
**WHEN** 跑 `evaluateConditions` 帶同樣條件
**THEN** 回傳 `{ pass: true, failures: [] }`

## Scenario 4：其他 CHECK_HANDLERS 的 hint 文字不變

**GIVEN** 一條 `staged_files_include` 條件失敗
**WHEN** 跑 `evaluateConditions`
**THEN** `failures[0]` 維持原本格式「，請 git add ... 後重試」、不被影響

## Scenario 5：失敗訊息保留原本規則 message 開頭 + 長度上限

**GIVEN** `recent_event_exists` 失敗
**WHEN** 跑 `evaluateConditions`
**THEN** `failures[0]` 開頭仍是規則本身的 `message`（例：「還沒做 verification」）、後面才接具體呼叫範例
**AND** `failures[0].length <= 250`（單筆失敗訊息不超過 250 字）

## 非功能性需求

- **零外部依賴**：`verification.js` 仍是純函式模組、不引入新套件
- **向後相容**：context 缺失 complianceEvents 時、handler 仍 return true（跳過檢查）、行為不變
- **其他 CHECK_HANDLERS 不受影響**：見 Scenario 4、`staged_files_include` / `staged_files_exclude` / `commit_message_*` 等 hint 文字維持原狀
