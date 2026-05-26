# v1.20.2 — 任務清單

## 高階階段

1. **寫 reproduction test**（IR-003）
   - `tests/verification.test.js` 加新 describe block：`FIX_HINTS.recent_event_exists`
   - 至少 3 個 case：
     - verification 缺失 → hint 含完整呼叫範例
     - code-review 缺失 → hint 含完整呼叫範例
     - 通過時 hint 不被觸發
   - 先讓 test 紅
2. **改 FIX_HINT**
   - `shared/verification.js`：`FIX_HINTS.recent_event_exists` 改成回傳含 `ownmind_report_compliance({rule_title: '<event>', action: 'comply'})` + 「不要帶 rule_code」提示的字串
   - 讓 reproduction test 變綠
3. **跑全測試確認沒回歸**
   - `node --test tests/verification.test.js`
   - `npm test`（整套）
4. **更新版號**
   - `package.json`：1.20.1 → 1.20.2
   - 找 SERVER_VERSION 同步點（src/server-version.js 或類似）
5. **更新 CHANGELOG**
   - `CHANGELOG.md` 最上方加 v1.20.2 條目
6. **更新 FILELIST**
   - `FILELIST.md` 加新提案資料夾路徑
7. **README 三語系檢查**
   - `README.md` / `README.en.md` / `README.ja.md` grep 「verification」「code-review」「recent_event_exists」、有提到就改
8. **品管三步驟**
   - `superpowers:verification-before-completion` → `ownmind_report_compliance({rule_title: 'verification', action: 'comply'})`
   - `superpowers:requesting-code-review` → `ownmind_report_compliance({rule_title: 'code-review', action: 'comply'})`
   - `superpowers:receiving-code-review` 處理 review 回饋
9. **commit + push**
   - 預期自家鉤子放行
