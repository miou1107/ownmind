# 規範強制執行機制 設計文件

日期：2026-08-13
狀態：待 Vin 審查
審查歷程：agy／Gemini 3.1 Pro 一輪、Fable 5 一輪，十五項發現全數採納（見 §10）
範圍調整：2026-08-13 Vin 兩次校正 —— (1) 題目不是「擋住禁區檔案」，是「AI 違反任何規範而不自覺」；(2) 卡控對象先只有 Vin 一人，跑順了再擴大

---

## 0. 最高理念（本設計的第一原則）

**規範的讀者是 AI，不是人。使用者把「要盯 AI 的事」寫一次，之後由系統來盯，人不再重複提醒。**（Vin 2026-08-13 拍板，OwnMind 記憶 principle id=904、CLAUDE.md 頂端）

推論：每一條規範預設要被強制執行；「提醒」只是機率不算執行；「留紀錄」只是過渡不是終點；「AI 沒讀／沒遵守已存規範」的事故是產品存在理由的失敗。

## 1. 真正的問題

2026-08-13 的事故（AI 讀完規範仍提出規範禁止的做法）只是一個樣本。**通案是：AI 違反了任何一條鐵律／團隊規範／原則／記憶，而且自己不知道。**

### 1.1 現況：147 條沒有任何東西在看

實查結果：

| 層 | 現在檢查什麼 | 什麼時候 |
|---|---|---|
| 回話層（`shared/validators/`） | 只有三支：夾生術語、中英混雜、隱私外洩。全部是字串比對 | 每一輪即時 |
| 動作層（PreToolUse hook） | 列出相關鐵律標題給 AI 看；critical 鐵律可擋 commit／deploy | 動作前 |
| 稽核層（`mcp/index.js` 第 1215 行 `session_audit`） | 逐條比對違規，準確 | **收工才跑** |

也就是說：150 條鐵律裡，對話進行中真正被核對的是 3 條的形狀（而且是字串層級）。其餘全部靠 AI 自律，出事後由稽核層寫成報告 —— 那正是 §0 第 3 條說的「留紀錄只是過渡」。

### 1.2 現有手段抓不到的規範長什麼樣

| 規範 | 為什麼字串比對抓不到 |
|---|---|
| IR-125 跟 Vin 講話第一句就是結論、不報工作過程 | 沒有特定字串，要判斷「這段是不是在報過程」 |
| IR-148 回報審查結果，一個決定只准寫一段 | 要先數出「他要做幾個決定」 |
| IR-136 發版部署前一定先問 | 要判斷「這個動作算不算發版」＋「本 session 有沒有問過」 |
| IR-003 修 bug 前先寫重現測試 | 要判斷順序，跨多輪 |
| IR-137 宣布修好前逐段標記親眼驗過／假設 | 要理解語意 |
| 412 禁區路徑 | ✅ 這條字串比對抓得到 —— 但它是少數 |

**原設計（禁區路徑閘）只救得了最後一行那種。把個案當成通案，是這份文件前兩版最大的錯誤。**

### 1.3 病根有三個，不是一個

1. **沒有優先權規則**：AI 在 `ci/projects.yml` 看到 `admins:` 有自己人，就讓 repo 檔案內容壓過 OwnMind 規範。全產品沒有一處說過衝突時誰贏。
2. **禁止事項被埋在文件中段**：3500 字文件裡的一張表格。原樣搬到更前面，只是換個地方埋。
3. **沒有獨立的檢查者**：唯一在核對規範的是 AI 自己，而事故已經證明「讀過還是會違反」。**自查不算查。**

## 2. 方案：把檢查員換成會判斷的，管道沿用現成的

### 2.1 管道是現成的、而且已經在跑

Claude Code 官方在三個時機把當下內容交給 OwnMind，全部已接：

| 時機 | 拿得到什麼 | 能做什麼 | 現況 |
|---|---|---|---|
| PreToolUse | 工具名、指令、檔案路徑、內容 | 硬擋（`decision: block`） | 已用於 critical 鐵律 |
| Stop（每輪講完） | **整份逐字稿路徑**（`transcript_path`），可讀 AI 剛講的全文與最近的使用者訊息 | 退回要求重寫（`exit 2` ＋ stderr） | 已用於三支字串檢查 |
| SessionStart | session 身分 | 注入上下文 | 已用於載入記憶 |

**證據不需要推論：本設計撰寫過程中，作者自己的一則回覆就被 Stop 這條管道退回重寫過。** 管道有效，缺的是插在上面的檢查員太笨。

### 2.2 本期做的三件事

| # | 名稱 | 對象 | 判斷方式 | 強度 |
|---|---|---|---|---|
| **一** | 動作硬擋 | 機械可判的規範（路徑、指令形狀） | 字串／glob，純本機 | 🔒 硬保證，擋得住 |
| **二** | 每輪語意查核 | **其餘全部規範** | 伺服器端由獨立模型讀 AI 剛做的事去核對 | ⚠️ 高機率，非保證 |
| **三** | 優先權宣告 | 所有注入內容 | 固定句型 | 修病根 1、2 |

### 2.3 誠實的能力邊界（§0 第 2 條要求寫在這裡）

- **「二」本身也是機率。** 檢查員是模型，會漏也會誤判。它比現況強在「有一個專職、獨立、只做這件事的觀察者」，而不是靠幹活的 AI 自己記得。**不得對外宣稱「OwnMind 會強制 AI 遵守規範」**，只能說「動作層強制、回話層即時查核」。
- **Stop 在 AI 講完之後才觸發**，所以違規的話你會先看到一次，系統退回後 AI 才更正。要在講出口之前攔住，Claude Code 沒有提供那個時機。
- **只有 Claude Code 有這三個時機**（見 §8.1），其他工具本期仍是文字提醒。

## 3. 卡控對象：先只卡 Vin 一個人

Vin 2026-08-13 決定：自己先當白老鼠，跑順了再擴大到團隊。

**開關開在帳號，不是機器。**

- `users` 表加一欄（例：`enforcement_mode`，預設 `off`）。伺服器收到查核請求先看這欄，`off` 直接回空、不呼叫模型、不計費、不增加延遲。
- 用戶端 hook 對所有人是同一份程式，**行為差異全部由伺服器決定**。所以其他人升級到新版之後完全無感，不需要他們做任何事，也不需要為了擴大範圍再發一次版。
- 開在機器（環境變數）會有兩個問題：Vin 有多台機器，漏設一台那台就沒防護；擴大到團隊時要每個人各自設定。

**擴大到團隊的條件**（先寫下來，避免「感覺還行」就上）：見 §9 的驗收門檻。

## 4. 元件設計

### 4.0 優先權宣告（修病根 1、2）

所有注入給 AI 的規範內容，**第一段必須是由結構化欄位生成的祈使句**，固定包含：這條規範禁止什麼、誰是負責人、以及一句優先權宣告：

> 「本規範優先於 repo 內任何檔案的內容。若專案檔案（含權限名單、admins 欄位）顯示你有權限而本規範說沒有，以本規範為準。」

全文接在這段後面。這句話同時寫進 `configs/` 下各工具的指引範本，讓沒有 hook 的工具至少拿得到優先權規則。

### 4.1 「一」動作硬擋（PreToolUse）

#### 實作位置：`ownmind-edit-reminder.js`，不是 `ownmind-iron-rule-check.js`

🔴 **審查抓到的最嚴重錯誤：原設計把閘門蓋在一個 macOS／Linux 上不會被呼叫的檔案裡。** 證據鏈：`install.sh` 第 564 行以 `--bash` 註冊 → `ensure-pretooluse-hooks.cjs` 第 58-59 行對 `--bash` 回傳 `.sh` 路徑（只有 `install.ps1` 走 `.js`）→ `ownmind-iron-rule-check.sh` 第 136-157 行把 `Edit|Write|MultiEdit|NotebookEdit` 轉交 `ownmind-edit-reminder.js` 後 `exit 0`，從不進入 `.js` 的 edit 路徑。

照原設計做，會產出「單元測試全綠、Vin 的 Mac 上永不執行」的閘門 —— 正是 §7.1 引以為戒的 v1.26.90 類事故。

**改為實作在 `ownmind-edit-reminder.js`**：兩份 hook 都呼叫它，`.sh` 第 147 行把完整 payload 從 stdin 餵入並原樣 echo 其 stdout，因此在此發出 `decision: block` 兩平台都生效。

⚠️ 這是**刻意反轉兩個既有決定**：該檔第 10-13 行自述「The edit trigger never blocks」、`ownmind-iron-rule-check.js` 第 101-109 行寫明 edit 路徑刻意不碰 verification engine。新的 block 出口獨立一條，**不重用 verification engine**（其條件是為 commit／deploy 寫的）。

#### 判斷邏輯：repo 由「被編輯檔案所在目錄」決定，不是 cwd

🔴 **第二個致命洞：事故當時 cwd 在 OwnMind repo、目標檔在 FAPA repo。** 原設計用 cwd 解析 repo，那一刀會在第一步被放行。

修正順序：由 `path.dirname(file_path)` 往上找 `.git` 取得**檔案自己的** repo → 比對 `repo_match` → 轉相對路徑比對 `paths` glob → 命中則 `decision: block`，訊息含規範 id、負責人、正確做法。

#### 快取：本期必須新建一條配送路徑（上一版此節整段是錯的）

🔴 **上一版寫錯，而且錯得比原本要修的還嚴重。** 它宣稱「`conditional-sync.js` 第 96 行的同步型別已含 `team_standard`」。實際去讀那一行：

```js
export function holdsInitPayload(cache) {
  for (const typeKeyed of ['iron_rule', 'coding_standard', 'team_standard', 'standard_detail']) {
    if (Array.isArray(data[typeKeyed])) return false;   // ← 這是「拒收」
  }
  return true;
}
```

那是**拒收判斷**：資料裡出現這些型別的陣列，代表它不屬於這個消費者。我把拒收清單讀成同步清單，還把這個誤讀當成「更正」寫進上一版。

**實機驗證（2026-08-13，直接讀 Vin 本機的快取檔）：**

| 檔案 | 實際內容 |
|---|---|
| `cache/memories.json` | `data` 內只有 `iron_rules_digest`、`team_standards_digest`、`team_standards_hash`、`invocable_standards`（**只有 id／title／hint**）、`principles` 等。**沒有任何一條 team_standard 的內文、metadata 或 fragment** |
| `cache/iron_rules.json` | 20 條完整鐵律（含 metadata），不是 150 條 —— `filterCacheableRules` 只留帶 verification 設定的 |

`shared/init-cache.js` 開頭也明寫 compact init 回應「no `team_standards` … at all」，而 hook 同步打的正是 `/api/memory/init?compact=true`（`conditional-sync.js:160`）。

**結論：今天沒有任何機制把團隊規範的內容送到用戶端。** 照上一版做，硬擋在每台真實機器上都讀到空陣列、永不觸發，而所有測試（都自己注入 standards）照樣全綠。

#### 新的配送設計：只送「選擇鍵」與「禁區規則」，不送內文

新增 `GET /api/memory/enforcement-bundle`，兩塊都**不含規範內文**：

| 區塊 | 內容 | 用途 |
|---|---|---|
| `selectors` | 每條啟用中的規範：`{id, type, tags, keywords, always_check}` | 用戶端本機先篩；沒有任何規範可能相關就完全不連網 |
| `guards` | 帶 `enforcement.guard` 的規範：`{id, title, repo_match, paths, owner}` | 用戶端硬擋 |

**實測大小**（真 Postgres）：每條規範的 enforcement metadata 是 39～171 位元組，150 條約 20KB，一次同步、每小時刷新，可忽略。

規範**內文留在伺服器**，判官在伺服器端直接查資料庫。因此沒有內文配送問題、沒有把 150 條規範散佈到每台機器的體積與隱私問題，而且 Vin 說的「全部規範都做」得以成立 —— 判官查的是資料庫，不受用戶端快取涵蓋率限制。

用戶端寫入自己的 `~/.ownmind/cache/enforcement.json`（不能塞進 `memories.json`：那份的形狀由 init 回應決定，且 `holdsInitPayload` 會拒收型別鍵），並套用「空回應不得覆蓋既有快取」保護（`iron-rule-sync.js:45-52` 的教訓：一次空回應曾繳械所有鐵律）。

#### 伺服器查詢：必須用 `buildReadableWhere`，且必須組 fragment

🔴 **真資料庫實測**（pgvector:pg16 容器 ＋ 本 repo 全部 migration ＋ 事故形狀 fixture：規範 412 由 **Eric（user 2）** 上傳，禁止清單在子 fragment 413，Vin 是 user 1）：

| 查詢 | 結果 |
|---|---|
| `WHERE user_id = $1`（上一版計畫寫的） | **只回 Vin 自己的 125，看不到 412** |
| 加 `buildReadableWhere` 的述詞 | 回 125 ＋ **412** |
| 依 `metadata->>'parent_id' = '412'` 撈 | 撈到 413，內文「NEVER edit ci/projects.yml…」 |

**照上一版的查詢，這套系統對它自己要防的那條規範是全盲的**，因為那條規範不是 Vin 上傳的。`src/routes/memory.js:866` 早已註明 team_standard 跨帳號共享、要靠 `buildReadableWhere` 才撈得到。

規則：判官查詢一律用 `buildReadableWhere`，並用既有的 `attachStandardFragments`（`src/utils/standard-fragments.js:201`）把 fragment 併進送審文字。**禁止清單住在 fragment 裡是常態，不是特例。**

#### 判官呼叫：`callLLMSwitch` 回傳已解析物件，不是字串

**實測**（stub HTTP server ＋ 真的 `callLLMSwitch`）：

```
RETURN TYPE   object
RETURN VALUE  {"verdicts":[{"ruleId":412,"violated":true,...}]}
.content      undefined
模型回散文     throw: LLM JSON parse failed
送出的 body   model=auto, max_tokens=2000, response_format={"type":"json_object"}
```

因此**直接取 `result.verdicts`**。上一版寫 `result?.content ?? ''`，實跑必得空字串 → 每次判 `failed` → 永遠抓不到違規。散文會 throw，由呼叫端 catch 成 `failed`，行為正確。

`model: 'auto'` 與 `max_tokens: 2000` 由 `buildRequestBody` 寫死。本期給 `callLLMSwitch` 加一個選填 model 參數以釘住便宜階層；在那之前成本由閘道決定，屬已知風險。6 條規範的裁決 JSON 遠小於 2000 tokens。

#### 硬擋管道：已實測可行

**實測**（真的 `ownmind-iron-rule-check.sh` ＋ 拋棄式 HOME ＋ 樁模組）：`ownmind-edit-reminder.js` 印出的 `{"decision":"block",...}` 原封不動出現在 `.sh` 的 stdout，exit 0；完整 payload（含 `tool_input.file_path` 與 `content`）確實被灌進來；`Edit`／`Write`／`MultiEdit`／`NotebookEdit` 四種工具都會走到該模組。**硬擋的設計成立，上一版只是把它寫在錯的檔案裡。**

#### 涵蓋範圍

- **Edit / Write / MultiEdit / NotebookEdit**（`ensure-pretooluse-hooks.cjs` 第 47 行含 MultiEdit，原設計漏列）。
- **內容比對**：事故真正的產出是一份寫在合法路徑的**計畫文件**，純比對路徑會放它過。補一條：當某規範已在本 session 觸發，同 session 內任何 Edit/Write 的 `content`／`new_string` 含該規範禁區路徑字串時一併攔下。
- **已知缺口**：Bash 的 `echo > file` 繞得過，交給「二」的語意層。不假裝涵蓋（安全清單要長出來，不手寫湊數）。

### 4.2 「二」每輪語意查核（Stop）—— 本期主體

#### 流程

1. Stop hook 觸發，讀 `transcript_path` 取得：AI 這一輪的完整輸出、最近幾則使用者訊息、本輪用過的工具（既有 `readTranscriptTail` 已做同類事，第 417 行起）。
2. 連同 session 身分、cwd／repo 送伺服器 `POST /api/compliance/check`。
3. 伺服器：
   a. **先看使用者的 `enforcement_mode`，`off` 立刻回空**（其他人零成本、零延遲）；
   b. **挑規範**：由觸發標籤 ＋ 關鍵字 ＋ repo 上下文 ＋ 一組「永遠在場」的規範（例：溝通類 IR-125／127／148）選出候選，上限 8～12 條，取全文（含 `standard_detail` fragment，見下）；
   c. 呼叫模型（沿用既有 `OWNMIND_LLM_API_BASE` ／ `LLM_SWITCH_API_KEY` 通道，`src/lib/llm-narrative.js` 第 132-144 行已有），要求逐條回：有無違反、違反的證據原句、該怎麼改；
   d. 全程寫進查核紀錄表（§9 要靠它算誤判率）。
4. Hook 收到違規 → `exit 2` ＋ stderr → 內容成為 AI 下一個提示，AI 必須更正。

#### 挑規範這件事是本設計最脆弱的一環

150 條不可能每輪全送。挑錯＝該擋的沒擋，而且**靜靜地沒擋**。因此：

- 寧可多挑不可少挑，上限用 token 預算控制而不是用「相關度夠高才送」；
- **每一次查核都記錄「挑了哪幾條」**，Vin 事後若發現漏抓，要能一眼看出是「沒挑到」還是「挑到了但判斷錯」。這兩種病因的修法完全不同，混在一起就永遠修不好；
- fragment 問題：team_standard 有摘要層與 `standard_detail` 分段（`mcp/index.js` 第 474-475 行；`shared/invocable-standards.js` 第 56 行「Only the team_standard summary layer is loaded at session start」）。**送去查核的必須是摘要層＋所有 fragment**，否則禁止清單落在 fragment 時，查核員拿到的是一份沒有禁止事項的摘要 —— 那正是這次事故的形狀。

#### 成本與延遲控制

| 手段 | 說明 |
|---|---|
| 帳號開關 | 名單外的人在伺服器第一行就返回，不呼叫模型 |
| 跳過空轉輪次 | 純澄清、純提問、沒有產出的輪次不查 |
| 規範上限 | 每次 8～12 條，用 token 預算卡 |
| 便宜模型 | 查核是分類任務不是生成任務，用最便宜的那一階 |
| 逾時放行 | 超過設定秒數放行，但**必須留痕**（見下） |
| 退避 | 伺服器連不上時退避，不要每輪都付逾時代價（`shared/edit-reminder-state.js` 第 38-45 行的教訓） |

#### 壞掉不能看起來像好的

逾時、模型出錯、伺服器不通 → 一律放行（不擋工作），但**當下必須在終端機留一行「本輪查核未執行」**，且寫進紀錄。靜默放行等於把「沒查」偽裝成「查過沒事」，是本產品最嚴重的失敗形態。

#### 回話檢查的既有機制要改三處

實查 `ownmind-reply-lint.js`：

- 第 95 行 `BLOCK_THRESHOLD = 4`：**前三次違規 AI 完全收不到**，只寫 `/dev/tty`（第 717 行），而該通道刻意設計成 AI 看不到（第 19-20 行）。→ 規範違規**不走共用門檻，第一次命中就回饋**。
- 第 261 行計數器**每 session 一個、所有檢查共用**。→ 規範查核用**獨立計數器**，不消耗也不觸發其他檢查的門檻。
- `MODE=warn`（第 610 行，產品自己的降級通知教使用者設的）、`/ownmind-off`（第 174 行）會整支關掉。→ 這兩種狀態下查核仍只提示不擋，但**必須留一行「規範查核目前是關閉的」**，不得靜默。
- validator 目前只能靠鐵律的 `metadata.lint_validator` 啟用（`shared/validators/index.js` 第 56-60 行），team_standard 無啟用路徑。→ 新增啟用路徑。

### 4.3 「三」注入（SessionStart／UserPromptSubmit）

- 使用者送出訊息時，把相關規範**全文**（含 §4.0 的優先權開頭）注入 AI 上下文。
- **純本機比對**，不把使用者訊息送伺服器（原設計要 POST 訊息全文，是新的資料外流面＋每則訊息一次網路來回）。讀「一」已經需要的同一份本機快取。
- 實查：全 repo **零處註冊 UserPromptSubmit**（`grep -r` 無命中），`ensure-pretooluse-hooks.cjs` 只處理 PreToolUse。本期必須新增註冊路徑（`install.sh`、`install.ps1`、既有使用者的升級路徑），否則 hook 檔存在、測試全綠、永不被呼叫。
- 每 session 每規範只注入一次（新 state schema；`shared/edit-reminder-state.js` 第 54-59 行的 `isEntry` 只認三個數字欄位，存不下規範 id 清單，是共用目錄不是沿用 schema）。
- **缺口**：subagent 不經過 UserPromptSubmit，注入只在父 session（「一」仍涵蓋 subagent 的工具呼叫）。

## 5. 資料模型

`team_standard` / `iron_rule` / `principle` 的 metadata 新增 `enforcement`，全欄位選填：

```jsonc
{
  "enforcement": {
    "keywords": ["FAPA", "搬遷", "onboarding"],   // 注入用觸發詞
    "always_check": false,                         // true = 每輪都送進語意查核（溝通類規範用）
    "guard": {                                     // 有這塊才進「一」的硬擋
      "repo_match": "fontrip-agentic-process-automation",
      "paths": ["ci/**", ".gitlab-ci.yml"],
      "owner": "Eric"
    }
  }
}
```

沒有 `enforcement` 的規範仍會進「二」的語意查核（靠標籤與上下文挑選），只是不進硬擋。設定沿用現有 metadata 管道，不新做編輯介面；Admin UI 唯讀顯示。

⚠️ **`ownmind_update` 的 metadata 是整包取代不是合併**（`mcp/index.js` 第 561 行明載）。AI 只要為了改一個 `invocation_hint` 而更新規範，就會把 `enforcement` 一起抹掉，機制靜靜失效且測試全綠。→ 伺服器端必須拒絕或大聲警告「移除既有 enforcement」的更新。

## 6. 資料流（事故重演的正確版）

1. Vin：「ownmind 要搬到 FAPA」→ 注入命中 → 412／422 全文（優先權宣告在最前面）進上下文。
2. AI 仍寫出「我來改 ci/projects.yml、你是 admin 有權限」→ 該輪結束 → 語意查核拿 412 全文比對這段輸出 → 判定違反 → `exit 2` 回饋 → **下一輪 AI 更正**。Vin 仍會看到那句錯話一次。
3. AI 若真的動手編輯 `ci/projects.yml` → 硬擋，訊息指名 Eric 與開單做法。

分工：注入降低發生機率、語意查核限制它活多久、硬擋保證它到不了檔案。**沒有一道能保證錯話不出現在 Vin 眼前** —— Claude Code 沒有「講出口之前」的攔截時機。

## 7. 測試

| 對象 | 案例 |
|---|---|
| 注入 | keyword 命中／repo 命中／都不中不注入／同 session 不重注入／逾時放行且留痕 |
| 硬擋 | 真 git repo fixture：repo 對＋路徑中→擋；repo 不對→放；跨 repo（cwd 在 A、改 B 的禁區檔）→擋；連跑兩次結果一致（IR-135）；快取缺失→放行且留痕 |
| 語意查核 | 用**真實違規語料**（本 session 的逐字稿就是現成的）：該抓的要抓到；守規矩的回覆不得誤判；帳號開關 off 時完全不呼叫模型；逾時放行且留痕 |
| 端到端 | 以 412／422 為真實 fixture 重演 §6 |

### 7.1 突變測試（本設計最重要的一項）

本 repo 有前科：`ownmind-iron-rule-check.js` 註解記載 v1.26.90/92 兩個 hook 因開頭就 `exit 0`，**數個月完全沒執行過而且看起來正常**。每一道都必須先看它紅一次：

| 突變 | 必須有測試會紅 |
|---|---|
| **經由 `.sh` 入口跑完整流程**（不是直接呼叫 `.js`） | 禁區編輯測試必須從 `bash ownmind-iron-rule-check.sh` 走完才算數 |
| 硬擋的 block 出口改成 `process.exit(0)` | 禁區編輯測試轉紅 |
| repo 判斷從「檔案所在目錄」改回 cwd | 跨 repo 編輯測試轉紅 |
| 語意查核固定回「無違規」 | 真實違規語料測試轉紅 |
| 挑規範固定回空陣列 | 同上，且要能分辨「沒挑到」與「判斷錯」 |
| 設 `OWNMIND_REPLY_LINT_MODE=warn` | 要能分辨「阻擋」與「只提示但有留痕」，後者必須驗留痕 |
| 規範違規改回走共用計數器 | 「第一次命中就回饋」測試轉紅 |
| 刪掉 `settings.json` 的 UserPromptSubmit 註冊（hook 檔仍在） | 端到端註冊測試轉紅 |
| 讓伺服器回空陣列覆蓋既有 `memories.json` | 「空回應不得覆蓋快取」測試轉紅 |
| 用 `ownmind_update` 更新 metadata 但不回填 `enforcement` | 伺服器必須拒絕或警告；對應測試轉紅 |
| 把 fragment 抽掉只送摘要層 | 「禁止清單在 fragment 裡」的案例轉紅 |

上表每一列真的紅過一次之前，不得宣稱完成。

## 8. 邊界與不做的事

### 8.1 只有 Claude Code 擋得住

實查 `install.sh` 第 502-507 行：Codex、Cursor、Copilot、Antigravity、OpenCode 拿到的是**附加在指引 markdown 的規則文字**；`configs/copilot-instructions.md`、`configs/antigravity.md` 是純文字告誡。依 §0 第 2 條，**那些只是提醒**。

| 工具 | 本期能做到 |
|---|---|
| Claude Code | 注入、硬擋、語意查核 |
| Cursor | 指引文字＋既有 shell 攔截；無檔案編輯硬擋 |
| Codex / Copilot / Antigravity / OpenCode / Gemini | 只有指引文字＝機率 |

README 與對外說明不得宣稱「OwnMind 會強制 AI 遵守規範」。

### 8.2 路徑歸屬這類規範，正確位置其實在被保護的 repo 上

412 防的是所有工程師與所有工具，不只 AI。一體適用的做法是在 FAPA 的 GitLab 設 push rule／CODEOWNERS。兩者互補：伺服器端擋「推得上去」，用戶端擋「浪費一整輪才發現推不上去」。**要不要一併請 Eric 加，待 Vin 決定。**

### 8.3 其餘不做

- 不做 embedding 語意檢索挑規範（標籤＋關鍵字＋上下文先行，量到不夠再說）。
- 不改既有 71 標題清單的輸出行為。
- 不做 enforcement 編輯 UI（沿用 metadata 管道）。
- 不涵蓋 Bash 寫檔繞過硬擋（交給語意層）。
- 不涵蓋 subagent 的注入。

## 9. 白老鼠階段與擴大條件

Vin 一人先跑。**先寫下擴大的門檻，避免「感覺還行」就上。**

必須量的四個數字（全部由 §4.2 的查核紀錄表算得出來）：

| 指標 | 定義 | 建議門檻 |
|---|---|---|
| 誤判率 | 判定違規、但 Vin 認定沒違規的比例 | < 10% |
| 漏抓 | Vin 事後發現的違規中，查核沒抓到的；且要分「沒挑到規範」vs「挑到了判斷錯」 | 逐案檢討，不設數字門檻 |
| 延遲 | 每輪多出來的等待，p95 | < 5 秒 |
| 未執行率 | 逾時／出錯／伺服器不通而沒查的比例 | < 5% |

Vin 要能一鍵標記誤判（終端機那行附帶做法，或 Admin UI 清單），否則誤判率算不出來。

觀察期至少一週且涵蓋一次真實的多輪工作，四項達標才討論擴大；擴大只是把別人的 `enforcement_mode` 打開，不需改程式、不需再發版。

## 10. 對抗審查紀錄

### 第一輪：agy／Gemini 3.1 Pro (High)

| # | 發現 | 處置 |
|---|---|---|
| 1 | 回話檢查掛在 Stop，錯話已到使用者眼前才觸發，不能宣稱「攔截」 | 採納，§2.3 寫明邊界 |
| 2 | 原「讀取回執閘」是安全劇場：注入即清償，而事故正是在全文已在上下文時發生 | 採納，**刪除該機制** |
| 3 | edit 路徑刻意永不 block，設計等於要反轉既有決定 | 採納，§4.1 明示並要求獨立 block 出口 |
| 4 | 誤述用戶端快取現況 | 採納，§4.1 更正 |
| 5 | keywords 脆弱，建議改用 repo 比對 | **部分採納**：實查事故當時 cwd 在 OwnMind repo，改用 repo 比對反而會漏掉本次事故 → 兩條路徑 OR 並存 |

建議「只做硬擋、砍掉其餘」**不採納**：本次事故損害全發生在對話裡，硬擋要等真的動手編輯才觸發，救不了已花掉的注意力。

### 第二輪：Fable 5

四項 Critical 全部經原始碼複查屬實，全數採納。

| # | 等級 | 發現 | 處置 |
|---|---|---|---|
| 1 | Critical | 閘門蓋在 `.js`，但 mac／Linux 註冊的是 `.sh`，**Vin 的機器上永不執行** | §4.1 改為實作在 `ownmind-edit-reminder.js`，補「經 `.sh` 入口」突變測試 |
| 2 | Critical | 由 cwd 解析 repo，事故當時 cwd 在別的 repo，**那一刀會被放行** | §4.1 改為由被編輯檔案所在目錄解析 |
| 3 | Critical | 前三次違規 AI 收不到；計數器與其他檢查共用；`MODE=warn` 直接關閉 | §4.2 改為不走共用門檻、第一次即回饋、獨立計數器、降級留痕 |
| 4 | Critical | 事故真正產出是計畫文件，路徑合法，三道機制都看不到內容 | §4.1 補內容比對；根本解法即本版主體「二」 |
| 5 | Important | `ownmind_update` 整包取代 metadata，一次不回填就抹掉 enforcement | §5 要求伺服器端擋，列入突變表 |
| 6 | Important | UserPromptSubmit 全 repo 零註冊 | §4.3 補註冊路徑與突變測試 |
| 7 | Important | 只有 Claude Code 擋得住 | §8.1 明示，並禁止對外宣稱 |
| 8 | Important | 每則訊息打伺服器＝延遲稅＋訊息全文外流 | §4.3 改純本機比對 |
| 9 | Important | 三處對既有程式碼的誤述 | 全部更正 |
| 10 | 深層 | 病根是優先權與呈現，不是送達 | §4.0 新增優先權宣告 |

### 第三輪：Vin 本人（最重要的一輪）

| 校正 | 結果 |
|---|---|
| 「我的重點不是禁區檔案，是 AI 違反任何規範而不自覺」 | **整份重寫**：語意查核從「下一階段」升為本期主體，硬擋降為其中一種手段 |
| 「卡控對象可以只卡我自己嗎、我先做白老鼠」 | 新增 §3 帳號層開關與 §9 擴大門檻 |
