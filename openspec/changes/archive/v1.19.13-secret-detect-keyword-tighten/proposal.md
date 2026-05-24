# v1.19.13 — 收緊掃密 keyword 偵測、降低誤判

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: 待 Vin 拍板
- **Branch**: 待開（沿用 main 工作流、TDD 走完再 commit）

---

## 0. 一句話總結

把 `shared/secret-detect.js` 的 value-side keyword 偵測（白話：掃內容裡有沒有「password / token / secret」這些字眼）從「**只要出現就擋**」改成「**出現在 KEY: VALUE 或 KEY=VALUE 樣式、且 VALUE 看起來像值才擋**」，順手把 400 回應加上 `matched_text`（白話：哪一段觸發的）、讓 AI 第一次寫就能改對、不用試 3 次。

> 為什麼：對應專案 469「OwnMind 內容掃密誤判改善」、2026-05-23 已記錄 3 次連續誤擋、加上 2026-05-24 第 4 次、觸發專案裡寫的「連續 3 次擋同樣內容就動工」條件。

---

## 1. 設計緣由

### 1.1 真實事件（2026-05-23 → 2026-05-24）

AI 試著存 type=`env` 的記憶「bot.kkvin.com 遠端訪問方式總覽」、內容含：

- AnyDesk 連線編號 `1901091212`（公開資訊、不是密碼）
- Tailscale 私網位址 `100.72.72.60`（白話：公司內網才看得到的虛擬位址）
- 密鑰**名稱**字串 `anydesk.bot_kkvin.unattended_password`（白話：「鑰匙的名字」而不是鑰匙本身、真鑰匙在 OwnMind 密鑰管理工具裡）

API 連續回 400「偵測到此內容看起來是敏感資料（密碼／token／API key）」3 次、第 4 次（2026-05-24）又擋。Vin 評估「好像很容易擋住」、要動工修。

### 1.2 追根究柢：實際是哪段邏輯擋下來的？

跑 `detectSecretLike()` 一步一步追：

| 步驟 | 結果 |
|------|------|
| Regex 7 條（WP / JWT / GH PAT / AWS / OpenAI / OwnMind 預定金鑰 / 預設密碼字面） | **全沒命中** |
| Title／description keyword | 沒命中（title 就「bot.kkvin.com 遠端訪問方式總覽」、不含密碼字樣） |
| **Value keyword 掃描** | **命中 `keyword:password`** — value 裡的 `anydesk.bot_kkvin.unattended_password` 含 `password` 字樣 |
| Length heuristic | 沒跑到 |

`type=env` 不在「跳 keyword 偵測」白名單（白名單只放 iron_rule、principle、coding_standard、team_standard、session_log、standard_detail、project、portfolio 這些敘述型）、所以 keyword 全程跑、就被擋了。

### 1.3 為什麼之前的規劃白名單方案打不準

專案 469 規劃過三條白名單：

| 規劃白名單 | 實際是不是這次的觸發點？ |
|---|---|
| CGNAT 私網 IP 段（100.64-127.x.x） | ❌ 不是 — IP 只 12 字、長度啟發式要 ≥ 20、根本沒進到啟發式那步 |
| 9-10 位純數字（AnyDesk ID 樣式） | ❌ 不是 — 同理、長度不夠 |
| 點分隔含 password／token 識別字 reference | ✅ 是 — 真兇 |

加 IP / 純數字白名單不會解決現在的誤判（因為本來就沒擋下這兩類）、只是擋未來不存在的問題。**這條算規劃失真、本提案重新對焦。**

### 1.4 為什麼 keyword 邏輯這樣改

現況：value 裡只要出現 `password / passwd / token / api_key / apikey / secret / credential / bearer` 任一字樣、就視為敏感。

問題：日常文件、説明、reference（白話：指向真鑰匙存放位置的描述）大量會提到這些字、誤判率高。

新規則：value-side keyword 偵測**只有在這兩種情境之一才命中**：

1. **賦值樣式**：`<keyword>` 後接 `:` 或 `=` 或 `=>`、再接「看起來像值」的東西（長度 ≥ 8）
2. **字面密鑰**（已經透過 regex 抓）— 不在 keyword 層處理

不滿足賦值樣式就放行、由其他偵測（regex、length heuristic）兜底。

> **設計決定 — 不加「值不是常見英文片語」條件**：早期草稿曾考慮再加一層「值看起來不像英文片語」濾網（避免 `password: hello world this is fine` 這種誤判）、但實作上太脆弱（要維護常見英文片語清單）、且現有「值 ≥ 8 字、且不含空白／引號／逗號／分號」的限制已能濾掉大多數短句、不是非加不可。提案落地版不收此條件、留 backlog。

> Title／description 的 keyword 掃描**維持原本「出現就命中」邏輯**、不動。理由：title/description 是「這筆記憶在講什麼」的概要、會出現密碼字樣就代表記憶主題涉敏感、保守一點合理；narrative 類型已有 `skip_keyword` opt-in 例外。

---

## 2. 設計方案

### 2.1 改 `shared/secret-detect.js` value-side keyword 邏輯

```js
// 原本：
const valueLower = value.toLowerCase();
for (const keyword of SECRET_KEYWORDS_EN) {
  if (valueLower.includes(keyword)) {
    return { detected: true, rule: `keyword:${keyword}`, ... };
  }
}

// 改成：賦值樣式才命中
const ASSIGNMENT_REGEX =
  /\b(password|passwd|token|api[_\- ]?key|apikey|secret|credential|bearer)\s*[:=]\s*["']?([^\s"'`,;]{8,})["']?/i;
const match = value.match(ASSIGNMENT_REGEX);
if (match) {
  return {
    detected: true,
    rule: `keyword:${match[1].toLowerCase().replace(/[-_ ]/g, '_')}`,
    reason: `value 含 ${match[1]} 賦值樣式（值長度 ${match[2].length}）`,
    matched_text: match[0].slice(0, 80),  // 截 80 字、給 AI 看哪段觸發
  };
}
```

### 2.2 加 `matched_text` 到偵測回傳體

`detectSecretLike()` 在 detected=true 時、額外回 `matched_text`：

- Regex 命中 → `match[0]` 截 80 字
- Keyword 命中 → 賦值片段截 80 字
- Length heuristic → value 前 80 字

長度截斷理由：避免 echo 整段真實密鑰回去日誌或 console、防止敏感資料外漏到第二處。

### 2.3 改 `src/utils/memory-secret-guard.js` 把 matched_text 帶進 400 回應

```js
return {
  ok: false,
  status: 400,
  body: {
    error: '偵測到此內容看起來是敏感資料（密碼／token／API key）',
    hint: '...',
    redirect_tool: 'ownmind_set_secret',
    detected_by: detection.rule,
    matched_text: detection.matched_text,  // 新增
  },
};
```

讓 AI 看到「`anydesk.bot_kkvin.unattended_password` 觸發」就能判斷「這是 reference 不是密碼、改寫法」、第一次就改對。

### 2.4 測試覆蓋

新增以下測試到 `tests/secret-detect-unit.test.js`：

1. **正向（仍要擋）**：
   - `password: MyP@ssw0rd123` → 擋
   - `API_TOKEN=abc123XYZ987` → 擋
   - `bearer eyJhbGc...` → 已被 jwt regex 抓、不在 keyword 範圍
   - `secret = "supersecretvalue"` → 擋
2. **反向（過去誤擋、現在要放行）**：
   - `anydesk.bot_kkvin.unattended_password` → 放行
   - `hermes.telegram.bot_token` → 放行
   - `process.env.MY_PASSWORD` → 放行
   - `the password is in the vault` → 放行
   - `見 ssh.bot.kkvin.com.vin.password` → 放行
3. **邊界**：
   - `password: hi`（值 < 8 字） → 放行（避免誤判 form label）
   - `password:abc12345` （沒空白）→ 擋
4. **完整原案例 regression**：把 bot.kkvin.com 那段內容餵進去、放行

---

## 3. 範圍 vs 不範圍

### 3.1 範圍內

- ✅ `shared/secret-detect.js` value-side keyword 邏輯改寫
- ✅ `detectSecretLike()` 回傳體加 `matched_text`
- ✅ `src/utils/memory-secret-guard.js` 400 回應加 `matched_text`
- ✅ `tests/secret-detect-unit.test.js` 加正向／反向／邊界／regression 測試
- ✅ 同步更新：README 三語系、FILELIST、CHANGELOG、package.json 版號 → 1.19.13

### 3.2 不範圍

- ❌ Title／description keyword 掃描邏輯（維持原樣、由 narrative 類型 opt-in 跳過）
- ❌ Length heuristic（沒誤判紀錄、不動）
- ❌ Regex 那 7 條（沒誤判紀錄、不動）
- ❌ CGNAT IP / AnyDesk ID 白名單（追根究柢確認不是本次觸發點、不做）
- ❌ Pre-commit hook 行為改變（hook 本來就用 `skip_keyword: true`、原本就不跑 keyword、不受影響）

---

## 4. 影響範圍

### 4.1 程式碼

| 檔案 | 改動 |
|------|------|
| `shared/secret-detect.js` | value-side keyword 從 includes 改賦值 regex、回傳體加 matched_text |
| `src/utils/memory-secret-guard.js` | 400 body 加 matched_text |
| `tests/secret-detect-unit.test.js` | 加 8~12 條測試 |

### 4.2 跨端影響（IR-022 check）

| 端 | 影響？ | 說明 |
|----|-------|------|
| Server `src/routes/memory.js` | 無 — 透過 memory-secret-guard 間接接、不直接呼叫 | |
| Pre-commit hook `hooks/ownmind-git-pre-commit.js` | 無 — 已用 `skip_keyword: true`、value-side keyword 本來就不跑 | |
| MCP `mcp/index.js` 工具描述 | 無 — 描述文字不變 | |
| Admin UI | 微正向 — 400 回應多一個 matched_text 欄、可選擇顯示給 admin 看；不顯示也不會壞 | |
| Iron rules / Skills | 無 | |

### 4.3 文件

| 檔案 | 改動 |
|------|------|
| `README.md` / `docs/README.zh-TW.md` / `docs/README.ja.md` | 三語系同步加一段「secret-detect v1.19.13：value-side keyword 偵測收緊」 |
| `CHANGELOG.md` | 加 v1.19.13 條目 |
| `FILELIST.md` | 不變（沒新增檔） |
| `package.json` | version 1.19.12 → 1.19.13 |

---

## 5. 風險與緩解

| 風險 | 機率 | 影響 | 緩解 |
|------|------|------|------|
| 真實密碼以非賦值樣式貼進去（例：`「密碼是 qwerty12345」`）會放行 | 低 | 中 | length heuristic 仍會抓 ≥20 字英數字；regex 仍會抓常見密鑰格式；narrative 主題的本來就 opt-in 不跑 keyword、現況也擋不住 |
| matched_text 把真實密鑰回 echo 回去 | 低 | 中 | 截 80 字 + 已經是 400 錯誤、本來就要告訴 caller 哪邊壞；rate-limit 跟 audit log 不變 |
| 賦值 regex 寫漏某個分隔符（例：`password\nabc12345`） | 中 | 小 | 寫測試覆蓋常見變體；漏掉的 case 走 length heuristic 或下一輪修 |
| 既有測試破掉 | 低 | 小 | TDD 流程先跑紅燈、看現有測試是不是因為這個改動該調整 |

---

## 6. 拍板紀錄

| # | 議題 | 待拍板選項 |
|---|------|-----------|
| 1 | value-side keyword 偵測強度 | **A. 只認賦值樣式（本提案推薦）** / B. 同時加點分隔識別字白名單（雙重防護） / C. 不動 |
| 2 | matched_text 截斷長度 | **A. 80 字（推薦、夠看上下文）** / B. 40 字（更保守） / C. 不截（簡單但風險高） |
| 3 | title / description keyword 是否同步收緊 | A. 一起收 / **B. 不動（推薦、不同職責）** |

---

## 7. 下一步

1. Vin 拍板上述 3 點
2. 寫 `spec.md`（GIVEN/WHEN/THEN 場景）
3. 寫 `tasks.md`（任務清單）
4. 走 TDD（IR-003）：先寫紅燈測試 → 跑紅 → 實作 → 跑綠
5. 品管三步驟（IR-045）：verification → request review → handle review
6. 同步 README / FILELIST / CHANGELOG（IR-008、IR-032）
7. 三處版號同步（IR-031）：package.json + git tag + （無 SERVER_VERSION 常數、用 package.json 為準）
8. Tag v1.19.13、push、Vin 決定要不要部署 prod
