# Critical 鐵律卡控（提醒層升級到邏輯層）— 漸進推 v1.19.20 → v1.19.24

- **Author**: Vin
- **Date**: 2026-05-22（原版）/ 2026-05-22（依 Gemini 對抗審查重定 10 條候選）/ 2026-05-24（重編版號：原 v1.19.6 → v1.19.10 被別的功能用掉、改為 v1.19.20 → v1.19.24）
- **Status**: 拍板執行中（v1.19.20 動工）
- **策略**: 拆成 v1.19.20 ~ v1.19.24 五個小版本、永遠停在 v1.19.x、不升大版號
- **原規格資料夾**: 原名 `openspec/changes/v1.20-iron-rule-enforcement/`、2026-05-24 重命名為 `openspec/changes/v1.19.20-rule-enforcer-core/`（即第一個小版本範圍）

---

## 0. 一句話總結

把 10 條最關鍵的鐵律從「提醒」升級到「卡控」——違反時 hook 直接擋下動作（commit、工具呼叫、回應送出），而不是只跳警告。

> 白話：以前鐵律是「貼在牆上的告示」、AI 看到也可能照犯；這版改成「電子門禁」、違反就過不去。對應 IR-027「提醒無效、邏輯才有效」。

---

## 1. 設計緣由

### 1.1 提醒模式已驗證失效

直接觀察證據：

- **v1.19.0 啟動時就跳 13 條 reply-lint 警告**（IR-036、IR-037）——同一條規則在同一個 session 內反覆觸發
- **本次 session resume 時 SessionStart 一口氣顯示 8 段歷史回話品質警告**——AI 看到提醒、下次依然違反
- v1.19 iron-rule-tier 提案 §1.2 自己就用「告警疲勞」當設計緣由

這些都是 IR-027 的活樣本：**提醒沒擋住違反、只擋住使用者對警告的耐心**。

### 1.2 v1.19 留下的伏筆

v1.19 提案明確寫：

> | critical | 跟 default 相同（**本版不動執行邏輯**） | 直接卡控：pre-commit 擋 commit、PreToolUse 擋工具呼叫、reply-lint 中斷回應 |

本提案就是來填這個坑。

### 1.3 OwnMind 的差異化定位

別人的記憶系統：「我幫你記住事情」。
OwnMind v1.19.20+ 後的記憶系統：「我幫你記住規則、而且會擋下違反」。

---

## 2. Gemini 對抗審查結論（2026-05-22）

原 v1.20 提案列了 10 條 critical 候選、經 Gemini 苛刻審查後拍板調整：

### 2.1 被剔除（降為警告級）

| 鐵律 | 剔除原因 |
|---|---|
| **IR-005** 不要 blind edit | MCP 是無狀態的；user 手動在編輯器點開檔案、AI 沒走 Read 攔截器看不到 → 大量誤判把人機協同改全擋下 |
| **IR-008** commit 同步 README/FILELIST/CHANGELOG | 改錯字、改 CSS padding、加一行 log 都要動 CHANGELOG → user 會塞廢話進去或關掉 hook |
| **IR-048** 部署前查未套用 migration | 偵測要連正式環境 DB；VPN/跳板機斷線時、緊急修復會死在半路 |

這三條留在「警告層」、由現有 verification engine 處理、不上 v1.19.20+ 的硬擋。

### 2.2 排程順序大翻轉

原 v1.20 排程：先做零誤判靜態檢查（IR-009/024）、後做高誤判 regex（IR-002/041）。
Gemini 批判：「前期風平浪靜、後期突然亂擋」、違背提早排雷原則。

新排程：**先做高誤判要早磨的、後做零誤判收尾**。

---

## 3. 最終 10 條候選（按 Gemini「絕對靜態 + 零/低誤判 + 災難型」原則）

### 3.1 S 級（絕對靜態、零誤判、災難型）— 7 條

| 編號 | 鐵律 | 主要落點 | 偵測邏輯 | 誤判 |
|---|---|---|---|---|
| **IR-002** | 不要 commit .env / 密碼 | pre-commit + PreToolUse | 掃 staged diff 找 `.env*` 檔名 + secret-detect 字串樣式比對（v1.19.1 已有）| 低 |
| **IR-009** | git contributors = Vin | pre-commit | `git config user.name` 是否為 Vin | 極低 |
| **IR-024** | commit 不加 Co-Authored-By | commit-msg | 比對訊息含 `Co-Authored-By` | 極低 |
| **IR-031** | 三處版號同步 | pre-tag | 解析 package.json / SERVER_VERSION / 即將打的 tag | 極低 |
| **IR-023** | 部署用 docker compose build、不用 docker build | PreToolUse | 指令樣式比對（含 docker build 不含 compose）| 極低 |
| **IR-018** | docker build 要加 --no-cache | PreToolUse | 指令樣式比對 | 極低 |
| **IR-044** | paramiko sudo 不能 stdin.write 密碼 | PreToolUse | 掃 Edit/Write 內容找 `stdin.write` 出現在 `sudo -S` 附近 | 低 |

### 3.2 A 級（指令樣式、實戰踩過）— 2 條

| 編號 | 鐵律 | 主要落點 | 偵測邏輯 |
|---|---|---|---|
| **IR-043** | Windows AI ssh 帶密碼用 paramiko、不用 sshpass | PreToolUse | 指令樣式比對 |
| **IR-046** | 跑超過 5 分鐘背景任務必須用 nohup | PreToolUse | 指令樣式比對 |

### 3.3 B 級（高誤判要早磨）— 1 條

| 編號 | 鐵律 | 主要落點 | 偵測邏輯 | 誤判 |
|---|---|---|---|---|
| **IR-041** | 不收集使用者隱私（身分證／信箱／電話）| reply-lint + pre-commit | 字串樣式比對 + user prompt 例外（即 user 自己提的 email 不算）| 中 |

### 3.4 加碼：Reply-lint 切擋下模式

已偵測有效的 IR-036（行話無白話）/ IR-037（中英混雜）只是 exit code 0 沒擋下、純切退出碼 + 死循環防護（連續 3 次擋了降警告）即可。

---

## 4. 漸進切法（5 個小版本、v1.19.6 → v1.19.22）

| 規格小版本 | 實際發版 | 範圍 | 狀態 |
|---|---|---|---|
| 第 1 版 | **v1.19.6** | 共用判定核心 `hooks/lib/rule-enforcer.js` + 放行通道 `hooks/lib/bypass-handler.js` + 審計紀錄擴充 | ✅ 完工 2026-05-22 |
| 第 2 版 | **v1.19.7** | IR-041（隱私）+ IR-002（密碼進 commit）+ reply-lint 切擋下模式（IR-036 / IR-037） | ✅ 完工 |
| 第 3 版 | **v1.19.20** | 指令樣式類 5 條：IR-044 / IR-023 / IR-018 / IR-046 / IR-043 | ⏳ 待動工（本批次先做） |
| 第 4 版 | **v1.19.21** | 靜態檢查收尾：IR-009 / IR-024 / IR-031 | ⏳ 待動工 |
| 第 5 版 | **v1.19.22** | 兩週觀察期、根據誤判紀錄調規則 | ⏳ 待動工 |

> **歷史脈絡：** 原規劃連續編號 v1.19.6-v1.19.10；前兩版（v1.19.6 + v1.19.7）按計畫完工後、Vin 把後續版號讓給其他功能（v1.19.8 setup wizard、v1.19.9 password recovery 等）、剩 3 個小版本延後到 v1.19.20 起再做。

關鍵原則（採納 Gemini）：**前兩版先磨高誤判 + 切 reply-lint 擋下、後一版做零誤判收尾**。兩週觀察期收的是「字串樣式比對怎麼調」的真實回饋、不是「靜態檢查零驚喜」的假平靜。

---

## 5. 卡控的三個落點

```
┌─────────────────────────────────────────────────────────┐
│ 1. PreToolUse hook（AI 呼叫工具前、本機 hook）            │
│    覆蓋：IR-023 / IR-018 / IR-044 / IR-043 / IR-046       │
│    平台：Claude Code ✓ / Codex ✓ / Cursor ✗ / Gemini ?    │
└─────────────────────────────────────────────────────────┘
         ↓ 通過
┌─────────────────────────────────────────────────────────┐
│ 2. Reply-lint hook（AI 回應送出前、本機 hook）            │
│    覆蓋：IR-036 / IR-037 / IR-041                         │
│    平台：Claude Code ✓ / Codex ✓ / 其他依各家 hook 點      │
└─────────────────────────────────────────────────────────┘
         ↓ 通過
┌─────────────────────────────────────────────────────────┐
│ 3. Git pre-commit / commit-msg / pre-tag hook            │
│    覆蓋：IR-002 / IR-009 / IR-024 / IR-031 / IR-041       │
│    平台：跨所有 AI 工具通用（git 在哪 hook 在哪）          │
└─────────────────────────────────────────────────────────┘
```

**設計重點**：git hook 是**跨工具最穩的卡控點**。PreToolUse 是「擋在 AI 端、防範未然」、git hook 是「擋在 git 端、保底防線」。兩層都要有。

---

## 6. v1.19.20 範圍（本批次：PreToolUse 指令樣式 5 條）

### 6.1 範圍內

- **PreToolUse hook 整合 rule-enforcer**：把 v1.19.6 已寫好的 `hooks/lib/rule-enforcer.js` 接到 Claude Code / Codex 的 PreToolUse hook（AI 呼叫工具前先檢查）
- **5 條 detector**（用指令字串樣式比對）：
  - IR-023 部署用 docker compose build、不用 docker build
  - IR-018 docker build 要加 --no-cache
  - IR-044 paramiko sudo 不能 stdin.write 密碼（會洩漏到下游）
  - IR-046 跑超過 5 分鐘背景任務必須用 nohup（脫離 session）
  - IR-043 Windows AI ssh 帶密碼用 paramiko、不用 sshpass
- **測試**：5 條 detector 各 3-5 個 case + PreToolUse hook 整合測試

### 6.2 已完工（前批次、不需再做）

- ✅ 共用判定核心 `hooks/lib/rule-enforcer.js`（v1.19.6、36 個測試綠）
- ✅ 放行通道 `hooks/lib/bypass-handler.js`（v1.19.6）
- ✅ 審計紀錄擴充 `shared/compliance.js`（v1.19.6、新 action 值 block / bypass / hook_internal_error）
- ✅ IR-041 隱私 detector（v1.19.7）
- ✅ IR-002 密碼進 commit detector（v1.19.7、reuse v1.19.1 secret-detect）
- ✅ reply-lint 切擋下模式（v1.19.7、exit 2 + 連續 3 次降警告）

### 6.3 不範圍（後續版本處理）

- ❌ Git pre-commit / commit-msg / pre-tag 整合 IR-009 / IR-024 / IR-031（→ 第 4 版 v1.19.21）
- ❌ Admin UI Bypass 紀錄分頁（→ 第 5 版 v1.19.22 觀察期結束後再評估）

---

## 7. 待 Vin 拍板（已拍板）

✅ Bypass 機制：**A. 環境變數 + audit log**（`OWNMIND_BYPASS=IR-008 git commit ...`）
✅ Reply-lint 卡控模式：**A. 硬擋（exit 2）讓 AI 重做**、連續擋 3 次後降警告
✅ Hook 效能 SLA：**< 100ms p95**
✅ 既有 user 升級：v1.19.20 純基礎建設、不影響既有 hook、不需 migrate

---

## 8. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|---|---|---|---|
| Hook 誤擋、卡死工作流 | 中 | 高 | Bypass 機制 + 完整 audit log + v1.19.21~9 漸進上線、每版兩週觀察 |
| Hook 跑得慢、commit 變難用 | 中 | 中 | < 100ms p95 SLA + benchmark + 並行偵測 |
| 跨工具不一致 | 高 | 中 | git pre-commit 當保底防線（跨所有工具）+ 接受「Cursor 只走 git 層」 |
| Reply-lint 硬擋造成死循環 | 中 | 高 | 連續擋 3 次後降為 warning |
| Bypass 被濫用 | 高 | 中 | audit log + 後續 admin UI 可視化 + 每週 review |

---

## 9. 跟既有專案的關係

| 項目 | 關係 |
|---|---|
| v1.19 iron-rule-tier | 直接接續、本提案是 v1.19 的執行邏輯實作 |
| v1.19.1 secret-tool-routing | 共用 `shared/scanners/`、IR-002 的 pre-commit 偵測直接 reuse |
| project_373（v3 路線 C） | 不衝突；路線 C 是鐵律品質指標、本提案是執行；同願景不同層 |
| project_342（LLM 鐵律 lint） | 不衝突；LLM lint 是 default tier 升級、不在本提案 |
| IR-027（提醒無效） | 本提案是 IR-027 的長期解 |

---

## 10. 一句話定位

> v1.19 給鐵律掛了等級標籤。v1.19.20 開始讓標籤真的有意義。

沒做這版、OwnMind 的鐵律系統等於「貼在牆上的告示」——AI 看到了、然後該違反還是違反。
