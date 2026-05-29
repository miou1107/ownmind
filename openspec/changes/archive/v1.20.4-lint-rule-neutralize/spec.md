# v1.20.4 — 規格：Lint 規則中性化

## Scenario 1：lintReply 違反清單用中性事件常數

**GIVEN** content 含中英混雜超過 15%
**WHEN** lintReply(content) 被呼叫
**THEN** 違反清單第一筆 `rule` 欄位 = 字串 `'lint_language_mixed_ratio'`
**AND NOT** 含字串 `'IR-037'`

## Scenario 2：lintReply 違反清單行話事件

**GIVEN** content 含未解釋的行話
**WHEN** lintReply(content) 被呼叫
**THEN** 違反清單該筆 `rule` 欄位 = 字串 `'lint_jargon_explanation_required'`
**AND NOT** 含字串 `'IR-036'`

## Scenario 3：訊息渲染不含個人鐵律編號

**GIVEN** lint 鉤子偵測違反、要 block
**WHEN** formatBlockReason(violations) 被呼叫
**THEN** 回的字串不含「IR-036」也不含「IR-037」
**AND** 含中文事件描述（例如「行話品質」/「中英混雜」）

## Scenario 4：合規記錄透過規則對應到個人編號

**GIVEN** 規則快取有 Vin 的 IR-036、metadata.triggered_by_event = 'lint_jargon_explanation_required'
**AND** 違反清單有 `{ rule: 'lint_jargon_explanation_required' }`
**WHEN** buildComplianceEvents(violations, rules, getTier) 被呼叫
**THEN** 回的事件 details.rule_code = 'IR-036'
**AND** details.tier 從規則快取查得

## Scenario 5：規則快取無對應 → fallback 留空

**GIVEN** 規則快取沒任何規則有 triggered_by_event 欄位
**AND** 違反清單有 `{ rule: 'lint_jargon_explanation_required' }`
**WHEN** buildComplianceEvents 被呼叫
**THEN** 回的事件 details.rule_code = '' （空字串）
**AND** details.message 含中文事件描述
**AND** 不 crash

## Scenario 6：bug-fingerprints 描述不含個人編號

**GIVEN** 讀 `shared/bug-fingerprints.js` 的 `lint_context_memory_missing` 註冊項
**THEN** description 不含「IR-036」字串
**AND** 仍清楚描述問題（用中性名「行話判斷」）

## Scenario 7：lint-event-logger 寫入用事件常數

**GIVEN** 違反清單 rule 用常數 `'lint_jargon_explanation_required'`
**WHEN** writeLintEvent({ ruleCodes: ['lint_jargon_explanation_required'], ... }) 被呼叫
**THEN** jsonl 寫入的 rule_codes 欄位 = 該常數
**AND** parser / 統計工具能識別

## 非功能性需求

- **零外部依賴**：`lint-event-types.js` 純常數模組、無 IO
- **向後相容測試**：所有既有測試經改動後 npm test 全綠
- **本機鉤子立即生效**：cp 5 個檔案到 ~/.ownmind/ 即生效（hook 是 spawn 新進程）
