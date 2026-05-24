# v1.19.11 — Lint UX 改善規格

## 一、方案 A：敘述型記憶跳過關鍵字比對

### 場景 1：寫 project 記憶含 `random-password.js` 字串 → 不被擋

**GIVEN** type=project 的記憶寫入請求、content 含 `shared/random-password.js`

**WHEN** POST `/api/memory`

**THEN**
- HTTP 200、寫入成功
- 不會被 detectSecretLike 的 keyword 偵測攔下

### 場景 2：寫 project 記憶含真的金鑰樣式 → 仍被擋

**GIVEN** type=project 的記憶 content 含 `sk-proj-abc123XYZdef456ghi789jkl`

**WHEN** POST `/api/memory`

**THEN**
- HTTP 400、被 regex 偵測攔下（樣式比對仍跑）

### 場景 3：寫 iron_rule 含 `password` 詞 → 不被擋（既有行為）

**GIVEN** type=iron_rule 寫入、content 含 `不要 commit password 進 git`

**WHEN** POST `/api/memory`

**THEN** 200、不被擋（向後相容、既有行為）

### 場景 4：寫 memory（一般記憶）含 `password` 詞 → 仍被擋

**GIVEN** type=memory 或未列入敘述型清單的類型、content 含敏感 keyword

**WHEN** POST `/api/memory`

**THEN** 400、仍走原 keyword 偵測

---

## 二、AI 自我標註

### 場景 5：擋下時指令文字含「請開頭加標註」要求

**GIVEN** session_id=X 違反 IR-036 累積到第 4 次

**WHEN** hook 擋下、stderr 寫指令文字

**THEN** stderr 內容含：
- 「重寫時開頭必須加一段標註」字眼
- markdown 引述格式範例（`> ⚠️ 上一版違反 IR-XXX`）
- 分隔線範例（`---`）

### 場景 6：指令文字不強制驗證 AI 標註

**GIVEN** AI 收到指令後重寫、但沒加標註

**WHEN** 下次 hook 跑

**THEN**
- 不二次擋下（hook 沒法看 AI 重寫的內容是否照做、只能信任）
- 不寫額外的「沒照做」紀錄

---

## 三、分級顯示

### 場景 7：第 1 次擋下、完整標註

**GIVEN** session_id=X 達到 BLOCK_THRESHOLD（第 4 次違規）、`block_count_in_session=0`

**WHEN** hook 擋下

**THEN** stderr 內容含完整訊息：
- 違反規則編號清單
- 違規詞清單
- 改寫格式範例
- 標註要求（含 markdown 引述範例）

### 場景 8：第 2-3 次擋下、簡短訊息

**GIVEN** session_id=X、`block_count_in_session=1` 或 `2`

**WHEN** hook 擋下

**THEN** stderr 內容含簡短訊息：
- 「↻ 上版違反 IR-XXX、已被指示重寫」
- 不重複列違規詞細節（避免疲勞）

### 場景 9：第 4 次擋下、達 downgrade limit、降警告

**GIVEN** session_id=X、`block_count_in_session=3`

**WHEN** hook 處理

**THEN**
- exit code = 1（warning、非 block）
- stderr 含完整警告訊息：「reply-lint 連續擋下 N 次、降警告避免死循環」
- 不再 increment block_count

---

## 四、結構化擋下紀錄

### 場景 10：擋下時寫一筆到 reply-lint-events.jsonl

**GIVEN** hook 擋下事件

**WHEN** 處理完 stderr 寫入後

**THEN** `~/.ownmind/logs/reply-lint-events.jsonl` append 一筆 JSON：
```json
{
  "ts": "<ISO8601>",
  "session_id": "<sid>",
  "event": "blocked" | "downgraded_to_warning",
  "rule_codes": [...],
  "violated_words": { "ir036_jargon": [...], "ir037_mixed": [...] },
  "violation_count_in_session": <int>,
  "block_count_in_session": <int>,
  "downgraded_to_warning": <bool>,
  "ai_instructed_to_annotate": <bool>
}
```

### 場景 11：紀錄檔超過 5MB 自動 rotate

**GIVEN** `reply-lint-events.jsonl` 大小 > 5MB

**WHEN** hook 即將寫新一筆

**THEN**
- 把現有檔 rename 成 `reply-lint-events.jsonl.old`
- 新一筆寫進空的 `reply-lint-events.jsonl`
- 舊 .old 檔保留供查詢

### 場景 12：紀錄檔寫入失敗不擋主流程

**GIVEN** 磁碟滿 / 權限問題、寫入失敗

**WHEN** hook 處理

**THEN**
- 擋下訊息仍正常寫 stderr（給 Claude）
- log 寫入失敗只記在 logger.warn、不丟例外
- exit code 仍依擋下邏輯回 2 或 1

### 場景 13：未擋下時不寫紀錄

**GIVEN** AI 回應通過 lint、不需擋下

**WHEN** hook 跑完

**THEN** `reply-lint-events.jsonl` 不新增任何資料

### 場景 14：降警告事件也寫紀錄

**GIVEN** session 已連續擋 3 次、第 4 次降警告

**WHEN** hook 處理

**THEN** 紀錄一筆 `event: "downgraded_to_warning"`、`downgraded_to_warning: true`
