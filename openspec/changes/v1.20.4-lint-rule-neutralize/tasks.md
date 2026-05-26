# v1.20.4 — 任務清單

1. 寫 `shared/lint-event-types.js`（事件常數 + 中文事件名對應表）
2. 改 `shared/language-lint.js`：違反清單 rule 用常數、註解去 IR-036/IR-037
3. 改 `hooks/ownmind-reply-lint.js`：訊息渲染 formatBlockReason / formatViolations 用中性事件名
4. 改 `hooks/lib/build-compliance-events.js`：透過規則 metadata 對應事件 → rule_code
5. 改 `hooks/lib/lint-event-logger.js`：事件欄位用常數
6. 清 `shared/bug-fingerprints.js:106` 描述去 IR-036
7. 改測試（lint-event-logger / build-compliance-events / reply-lint-hook / reply-lint-pending-spool / flush-compliance-spool / iron-rule-origin-context）對應新常數
8. 改 Vin 個人鐵律 IR-036 + IR-037 metadata 加 `triggered_by_event`
9. 版號 1.20.3 → 1.20.4 + CHANGELOG + FILELIST + 三語 README
10. cp 同步 ~/.ownmind/ + verification + code-review 合規 + commit + push
