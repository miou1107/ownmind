# v1.21.0 — 規格：Lint 驗證器架構

## Scenario 1：validator 套件介面合約

**GIVEN** validator 模組 `shared/validators/jargon-explanation.js`
**THEN** 該模組 export 至少：
  - `name`（字串、validator 識別碼）
  - `check(content, params, context)` 函式
**AND** `check` 回值符合 `{ ok: boolean, violation?: { event, message, detail } }`

## Scenario 2：規則啟用 validator → 鉤子跑該檢查

**GIVEN** user 鐵律 IR-036 metadata 含 `lint_validator: { name: 'jargon_explanation', params: {} }`
**AND** lint 鉤子讀到該規則
**WHEN** 跑 `lintReply(content, enabledValidators)`
**THEN** 對應 validator.check 被呼叫
**AND** 違反清單含 `{ event: 'lint_jargon_explanation_required', sourceRule: 'IR-036' }`

## Scenario 3：規則沒啟用 validator → 鉤子跳過

**GIVEN** user 鐵律快取內無任何規則設 `lint_validator`
**WHEN** lint 鉤子跑
**THEN** `enabledValidators` 為空陣列
**AND** `lintReply` 違反清單為空
**AND** 鉤子 exit 0、不擋

## Scenario 4：規則啟用未註冊的 validator → 安全跳過

**GIVEN** 規則 metadata 含 `lint_validator: { name: 'nonexistent_validator' }`
**WHEN** 鉤子呼叫 `findValidator('nonexistent_validator')`
**THEN** 回 null
**AND** 不 crash、跳過該規則繼續處理其他規則

## Scenario 5：params 傳到 validator

**GIVEN** IR-037 metadata 含 `lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.20 } }`
**WHEN** validator 跑
**THEN** `check` 收到 `params = { threshold: 0.20 }`
**AND** 用該 threshold 取代預設 0.15

## Scenario 6：違反清單含 sourceRule 對應原規則

**GIVEN** Vin 的 IR-036 啟用 jargon_explanation validator
**WHEN** 某 reply 違反
**THEN** 違反清單記錄 `sourceRule: 'IR-036'`
**AND** `buildComplianceEvents` 用該 sourceRule 當 rule_code（不用走 triggered_by_event 查表）

## Scenario 7：規則快取為空 / 損毀 → fail-open

**GIVEN** `~/.ownmind/cache/iron_rules.json` 不存在或損毀
**WHEN** lint 鉤子跑
**THEN** `enabledValidators` 為空
**AND** 鉤子 exit 0、安靜
**AND** 不擋使用者

## Scenario 8：privacy_detect validator 替代既有 inline 邏輯

**GIVEN** user 啟用 privacy_detect validator
**AND** reply 含電子郵件位址
**WHEN** validator.check 跑
**THEN** 違反清單含 `{ event: 'lint_privacy_check', ... }`
**AND** detail.matches 不洩漏原值（隱私保護）

## 非功能性需求

- **零外部依賴**：validator 套件純函式、不引入新套件
- **向後相容**：既有 lintReply API 保留兼容簽名（接受 `content, historicalCorpus` 仍能跑、但內部用新流程）
- **fail-open**：所有讀規則 / 找 validator 失敗一律「視為沒啟用、安靜」、不擋使用者
