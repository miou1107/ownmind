# v1.19.11 — Lint UX 改善任務清單

## 範圍

### 方案 A：誤判降低
- [ ] 改 `src/routes/memory.js` POST 流程、擴大 skip_keyword 適用類型
- [ ] 新測試：寫 project 記憶含程式碼路徑不被擋

### AI 自我標註
- [ ] 改 `hooks/ownmind-reply-lint.js` 的 formatBlockReason、指令文字加標註要求 + markdown 引述範例
- [ ] 新測試：stderr 內容含「請開頭加標註」字眼

### 分級顯示
- [ ] 改 hook 主流程、根據 `block_count_in_session` 決定指令文字版本
- [ ] 新測試：連續擋下時、第 2-3 次訊息簡短、第 4 次降警告完整

### log 保底
- [ ] 寫 `hooks/lib/lint-event-logger.js`（純函式、好測試）
- [ ] 整合到 hook 主流程、擋下時 append 紀錄
- [ ] rotate 機制（5MB cap）
- [ ] 寫入失敗不擋主流程
- [ ] 新測試：擋下後檔內容檢查

### 文件
- [ ] package.json 版號 1.19.10 → 1.19.11
- [ ] CHANGELOG 加 v1.19.11 段
- [ ] FILELIST 加新檔
- [ ] 三語系 README FAQ 補一條「為什麼有時 AI 會看似說兩次」

### 驗證
- [ ] `npm test` 全套綠
- [ ] 走 superpowers:requesting-code-review
- [ ] commit

## 風險檢查點

- [ ] 寫真實 project 記憶含 `random-password.js` 字串成功
- [ ] 跑 dogfood、看 Claude 重寫時是否加標註
- [ ] 連續觸發 4 次、確認分級顯示不同
- [ ] 確認 `reply-lint-events.jsonl` 有寫入
- [ ] 舊 reply-lint test（v1.19.3 / v1.19.7）全綠

## 非任務

- ❌ 自動套用優化建議（v2.0 才做）
- ❌ ML 誤判辨識（資料量不夠）
- ❌ 強制驗證 AI 是否加標註（接受 best-effort）
