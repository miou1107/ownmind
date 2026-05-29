# v1.21.0 — 任務清單

1. 新 `shared/validators/` 目錄 + 3 個 module
   - jargon-explanation.js（包裝既有 checkJargonExplanation）
   - language-mixed-ratio.js（包裝既有 checkMixedLanguage）
   - privacy-detect.js（從 hooks/ownmind-reply-lint.js 抽出）
   - index.js 註冊表 + findValidator / listAvailableValidators

2. 寫 validator 單元測試 `tests/validators/`：
   - jargon-explanation.test.js
   - language-mixed-ratio.test.js
   - privacy-detect.test.js
   - registry.test.js

3. 改 `shared/language-lint.js`：
   - lintReply 接受 enabledValidators 第二參數
   - 內部 loop 跑每個 validator.check
   - violations 加 sourceRule 欄位
   - 既有兩個 check 函式保留（給 validator 內部用）

4. 改 `hooks/ownmind-reply-lint.js`：
   - 新 helper extractEnabledValidators(rulesCache)
   - 餵 enabledValidators 給 lintReply
   - 拿掉內部 privacy_check 直跑、改走 validator 介面
   - 違反清單渲染 sourceRule（若有）

5. 改 `hooks/lib/build-compliance-events.js`：
   - violation.sourceRule（若有）→ 直接當 rule_code、不用走 findUserRuleByEvent

6. 改 Vin 個人鐵律 metadata：
   - IR-036（id=300）加 lint_validator: { name: 'jargon_explanation', params: {} }
   - IR-037（id=312）加 lint_validator: { name: 'language_mixed_ratio', params: { threshold: 0.15 } }

7. 改既有測試對應新架構：
   - tests/reply-lint.test.js
   - tests/reply-lint-hook.test.js
   - tests/build-compliance-events.test.js
   - 其他用到 lintReply / violations 的測試

8. 版號 1.20.4 → 1.21.0 + 三語 README + CHANGELOG + FILELIST

9. cp 同步 ~/.ownmind/ + verification + code-review 合規 + commit + push
