# v1.18.0 — 鐵律對齊 SKILL.md + 1 big iron-rules skill 落地 IR-027

- **Author**: Vin
- **Date**: 2026-05-13
- **Status**: Draft（v3 — 拍版走 B 方案：1 big skill；等剩 6 個決策拍版）
- **Worktree**: `determined-bouman-20c22a`
- **Branch**: `vin/determined-bouman-20c22a`

---

## 0. 設計演進（v1 → v2 → v3 → v4）

| 版本 | 核心 | 為什麼演進 |
|---|---|---|
| v1 | 自創 7 欄位 schema（do / dont / triggers / ...） | Vin 點到「應該參考 skills 標準和 skill creator 作法」— 自創錯了 |
| v2 | 對齊 Anthropic SKILL.md 標準（name + description + body） + DB-only | Vin 問「快、省資源、卡控更精準？」— 純 DB 沒解 IR-027 卡控本質 |
| v3 | 同 v2 + export 成 1 個 `~/.claude/skills/ownmind-iron-rules/SKILL.md` big skill | Vin 點到「OwnMind 已有 ownmind-memory big skill、35 個 individual 太混亂」— 走 B 方案 |
| **v4** | **同 v3** + **conditional sync（既有 sync_token hash check、99% sessions 跳過 download）** | Vin 點到「應該用 hash 檢查、有需要再同步」— 既有 sync_token 機制只用在寫入端、讀取端從沒利用、補完 |

---

## 1. 為什麼要做這次改動

### 1.1 v1.17.94 lint 卡的是「關鍵字啟發式」、不是真結構

現況 7 條檢查（字數 / trigger:xxx tag / 「適用」「規則」關鍵字 regex / 中英混雜 / 禁 context 詞）— AI 只要塞個「適用」就過。

### 1.2 IR-027「提醒無效、邏輯才有效」沒 80%+ 落地

| State | AI 卡控落地 |
|---|---|
| 現況（SessionStart 塞 35 條 title 列表）| **50%**（要不要遵守 AI 自決）|
| v1.18.0 純 schema 對齊（DB-only） | 60-65%（pushy description 強一點、本質還是 AI 自覺）|
| v1.18.0 + 1 big iron-rules skill（**本版**）| **70%**（Claude Code skill 機制觸發、AI 進 skill 後自挑哪條鐵律適用）|

### 1.3 跨 AI 工具不通用

現況鐵律只 Claude Code 透過 OwnMind hook 看得到、Cursor / Codex / Antigravity 看不到。對齊 SKILL.md 標準後 + export 成檔案、跨 AI 工具一致。

---

## 2. 設計核心

### 2.1 鐵律本身對齊 SKILL.md 標準

每條鐵律的 content 變成 SKILL.md frontmatter + body：

```yaml
---
name: ir-002-no-commit-secrets
description: |
  Use when about to git commit / push any change. Required for ALL commits because
  accidentally pushing .env / API keys / passwords to GitHub causes immediate exposure
  and rotation requirements. Triggers on: git commit, git push, git stash, any change
  staged for commit. ALSO triggers when user mentions "commit", "push", "deploy".
---

# IR-002: 不要 commit .env 或密碼

## 為什麼存在
（故事）

## 該做 / 不該做 / 萬一犯了
（自由 markdown 段落、不強制 YAML list 結構）
```

**SKILL.md 標準只有 2 個必填欄位**（name + description）— 不自創欄位。

### 2.2 Export 成 1 個 big iron-rules skill（B 方案）

跟 OwnMind 已有的 `ownmind-memory` 同模式：

```
~/.claude/skills/ownmind-iron-rules/
├── SKILL.md                      # big skill metadata + 35 條鐵律 trigger 摘要
├── references/
│   ├── IR-002-no-commit-secrets.md    # AI 想看細節才讀（progressive disclosure layer 3）
│   ├── IR-003-bug-reproduction-test.md
│   ├── IR-008-three-doc-sync.md
│   └── ... (35 個 reference 檔、每個是該鐵律完整 SKILL.md frontmatter + body)
└── scripts/                      # 選填、未來可放鐵律自動化腳本
    └── (v1.18.0 不做、留 backlog)
```

### 2.3 為什麼選 B（1 big skill）不選 C（35 individual skills）

| 比較 | A 現況 | B（本版）| C（35 個）|
|---|---|---|---|
| Claude Code skill 列表多幾個 | 0 | +1 | +35（會塞爆）|
| 永遠 in-context tokens | ~400 | ~150 | ~3500 |
| AI 觸發精準度 | 50% | 70% | 80-90% |
| 跟現有 ownmind-memory 一致 | — | ✓ | ✗ |
| Sync 複雜度 | 0 | 低 | 高 |
| Vin 拍版理由 | — | **「跟 ownmind-memory 同模式、不混亂」** | 「35 太混亂」 |

**B 是 C 的 superset、未來想升 C 也不卡**（reference files 已是個別格式、改 sync 寫 individual skill folder 即可）。

### 2.4 graceful 雙軌、永遠不強制 migration

| 路徑 | 行為 |
|---|---|
| 新鐵律寫入 | client 走 SKILL.md frontmatter + body 格式、server 卡 name + description 必填 |
| 既有 35 條鐵律 | **不自動轉**、純文字格式長期支援、Vin 用升級助手手動轉 |
| Server lint | 偵測 frontmatter：有 → schema lint；沒 → 走舊 v1.17.94 regex |
| 舊 client 寫鐵律 | server 走 graceful fallback、不會 reject |
| SessionStart context | 維持現狀（title + tags 一行一條）|
| `~/.claude/skills/ownmind-iron-rules/` | 新增 — 由 sync hook 維護 |
| Sync 機制 | 寫鐵律時主動 push 到本地 + SessionStart 順便對帳（B+A 雙保險）|

---

## 3. lint 規則

對齊 SKILL.md 標準 + 鐵律專屬補強：

| 檢查 | 來源 | 卡 / Warning |
|---|---|---|
| frontmatter 解析合法 YAML | SKILL.md 標準 | reject |
| `name` 必填、kebab-case、3–60 字 | SKILL.md 標準（鐵律加長度限制） | reject |
| `description` 必填、20–500 字 | SKILL.md 標準 | reject |
| `description` 含「when / 何時 / 觸發 / 情境」之類觸發詞 | 鐵律專屬 | reject |
| body 字數 ≥ 100 | 鐵律專屬 | reject |
| body 含「該做 / 不該做 / 規則 / 必須」之類關鍵字 | 沿用 v1.17.94 #5 | reject |
| 中英混雜檢查（IR-037） | 沿用 v1.17.94 | reject |
| `description` 字數 < 50 | 鐵律專屬（鼓勵 pushy 寫法）| **warning（不 reject）** |

**避免再走「自創欄位 + 強制 list 結構」的老路**。description 是 free-text、靠關鍵字微檢查、body 是 free-form markdown — 跟 Anthropic SKILL.md 規範完全一致。

---

## 4. Sync 機制設計

### 4.1 DB ↔ 本地檔案同步（conditional pull、靠既有 sync_token）

**真理之源永遠是 DB**（kkvin.com Postgres）。本地 `~/.claude/skills/ownmind-iron-rules/` 是 read-only mirror。

**關鍵設計**：用 OwnMind 已有的 `sync_token`（`src/utils/syncToken.js`）做 hash check、99% sessions 跳過 download。

```
sync_token = sha256(user_id : max(memory.updated_at) : max(team.updated_at)).slice(0, 12)
```

| 觸發點 | 行為 |
|---|---|
| `ownmind_save` / `ownmind_update` 寫鐵律 | server `updated_at` 自動改 → sync_token 自動變、不需特別處理 |
| SessionStart hook 開頭 | **新流程**：1. 讀 local cache `sync_token` → 2. `GET /api/memory/sync-token`（lightweight、~50 bytes）→ 3. 比對：相同 → 用 local cache 跳過 download；不同 → 跑全量 init download + 重寫 cache + 重寫本地 skill files |
| 鐵律被 disable | server updated_at 改 → 下次 SessionStart 偵測到 sync_token 變 → 自動 refresh |
| 24hr 沒對帳保險 | local cache `saved_at` 超過 24 hr → 強制 refresh、防 sync_token 算錯永久 cache |
| 用戶改鐵律 source 衝突（DB vs local） | DB 為準、本地被覆蓋（Vin 拍版選項 A） |

### 4.2 多機同步

```
你 Mac 改 IR-040 → DB
                ↓ MCP client sync
              Mac local file ✓ 即時
              公司電腦 local file ❓ 下次 SessionStart 對帳時 sync
```

= last-write-wins、sync 是被動 pull、不是 active push 跨機器（OwnMind 沒 push notification 機制）。**v1.18.0 不解多機即時 sync**、留 backlog。

### 4.3 跨 user

- 鐵律是 per-user（`memories.user_id` 隔離）
- 本地路徑 `~/.claude/skills/ownmind-iron-rules/` per-user 自然隔離
- Vin / Adam / Eric 各自 sync 自己的鐵律、互不影響

### 4.4 跨 AI 工具路徑

| 工具 | Skill 路徑 | v1.18.0 處理 |
|---|---|---|
| Claude Code | `~/.claude/skills/` | ✓ 主路徑 |
| Cursor | `~/.cursor/rules/` | sync 也寫一份（IR-006 全層同步精神）|
| Codex | `~/.codex/AGENTS.md` | 加一段 reference 到 ownmind-iron-rules（不是獨立 skill）|
| Antigravity | `~/.antigravity/rules/` | 同 Cursor |
| OpenCode | `~/.opencode/AGENTS.md` | 同 Codex |
| Windsurf | `~/.windsurf/rules/` | 同 Cursor |
| Gemini | `~/.gemini/GEMINI.md` | 同 Codex |

**install.sh / update.sh 既有的「append_upgrade_rule_if_exists」pattern 可以重用**（看 install.sh:300）— 偵測目錄存在才裝、跳過未裝。

---

## 5. 鐵律升級助手（Web UI）

讓 Vin 把既有 35 條鐵律手動 + AI 輔助轉成 SKILL.md 格式。

### 5.1 Admin panel: `/admin/iron-rule-upgrade`

```
┌─ Iron Rule Upgrade Helper ────────────────────────┐
│                                                    │
│ Status: 35 total / 0 SKILL.md / 35 legacy        │
│                                                    │
│ ┌─ IR-002: 不要 commit .env 或密碼 ─ [Legacy] ┐  │
│ │  Title:   不要 commit .env 或密碼               │  │
│ │  Tags:    [trigger:commit, trigger:git]         │  │
│ │  [Suggest SKILL.md format]                       │  │
│ └─────────────────────────────────────────────────┘  │
│                                                    │
│ (其他 34 條...)                                  │
└────────────────────────────────────────────────────┘
```

### 5.2 點 [Suggest] 後

```
┌─ AI Suggestion for IR-002 ────────────────────────┐
│ ┌─ Diff View ────────────────────────────────────┐ │
│ │ - Original (純文字)                             │ │
│ │ + Proposed (SKILL.md frontmatter + body)        │ │
│ │                                                  │ │
│ │ + ---                                            │ │
│ │ + name: ir-002-no-commit-secrets                │ │
│ │ + description: |                                 │ │
│ │ +   Use when about to git commit / push...      │ │
│ │ + ---                                            │ │
│ │ + # IR-002: 不要 commit .env 或密碼              │ │
│ │ + ## 為什麼存在 (從原 content 提取)              │ │
│ │ + ## 該做 / 不該做                                │ │
│ └──────────────────────────────────────────────────┘ │
│                                                    │
│ [Edit Proposed]  [Confirm & Save]  [Skip]         │
└────────────────────────────────────────────────────┘
```

### 5.3 流程

1. Click [Suggest] → server 用 LLM 把 title + content + tags 推 SKILL.md
2. Vin 看 diff → [Edit] 微調 / [Skip] 留純文字 / [Confirm] 寫 DB
3. [Confirm] 後 server 跑 schema lint、過 → 寫 DB + 觸發 sync
4. 不想轉的鐵律永遠留純文字、graceful 雙軌

預估：35 條 × ~1 分鐘 ≈ 35 分鐘、可分多次。

---

## 6. 不做什麼（明確排除）

- ❌ 自創 schema 欄位（v1 的錯）
- ❌ 35 個 individual skills（C 方案、Vin 拍版排除）
- ❌ 強制 migration script
- ❌ lazy migration（自動轉）
- ❌ 改 SessionStart context 載入 body（避免 token 膨脹）
- ❌ 改 DB schema 拆欄位（content 還是 TEXT）
- ❌ 強制所有新鐵律都要走 SKILL.md
- ❌ 鐵律 bundled scripts（v1.18.0 預留 scripts/ dir 不放任何 script、實際 script 化留 v1.18.x）
- ❌ 多機即時 sync（用 SessionStart 對帳就好）
- ❌ DB vs local 衝突偵測機制（DB 永遠贏、不做選擇 UI）

---

## 7. 風險

| 風險 | 機率 | 後果 | Mitigation |
|---|---|---|---|
| YAML frontmatter parser 寫不嚴 | 中 | lint 接受不該接受的內容 | 用 `js-yaml` 套件（業界標準）、別自寫 parser |
| `js-yaml` 帶來新 npm dep | 低 | server bundle ~50KB | 接受、無安全顧慮 |
| 升級助手 LLM 提錯 description | 中 | 鐵律寫不準、AI 看不到 trigger | Vin diff view 必看、按確認才存 |
| 舊 client 寫的純文字鐵律觸發新 lint warning | 低 | UX 困擾 | warning 加 env 抑制 |
| 升級助手寫壞 DB | 中 | 鐵律 content 損毀 | 寫之前 backup 原值到 `memories.previous_content` JSONB（小 ALTER） |
| Sync hook bug 把本地 skill 檔案寫壞 | 中 | Claude Code skill 載入失敗 | sync 失敗 fallback 不動本地、log 警告；DB 永遠是 source of truth |
| 跨工具路徑寫錯 / 工具沒裝硬寫 | 低 | 寫到不存在 / 不正確的目錄 | 沿用 install.sh:300 既有「目錄存在才裝」pattern |
| description 太短/太空泛 lint 過 warning 不卡 | 中 | 鐵律 AI 想不到 | warning + 升級助手會主動建議補強 |

---

## 8. Acceptance criteria（高層）

- [ ] **新鐵律走 SKILL.md** — `ownmind_save` 接受 frontmatter + body、server lint 卡 name + description 必填、含觸發詞、body 含規則段落
- [ ] **舊鐵律繼續用** — 既有 35 條 0 動作、SessionStart 載入正常、`ownmind_get` 取回正常
- [ ] **舊 client 寫鐵律不爆** — graceful fallback、走 regex lint
- [ ] **鐵律升級助手** — admin web UI panel、列 35 條 status、選一條開 diff view、確認後存
- [ ] **本地 sync** — `~/.claude/skills/ownmind-iron-rules/SKILL.md` + reference files 自動建/更新、Vin 寫鐵律後即時看到、SessionStart 對帳
- [ ] **跨 AI 工具** — Cursor / Antigravity / OpenCode / Codex / Gemini / Windsurf 已裝的工具都收到鐵律 sync（沿用 install.sh:300 pattern）
- [ ] **三同步**（IR-008）— README / CHANGELOG / FILELIST
- [ ] **OpenSpec spec.md** — SKILL.md schema 完整定義 + sync 機制 + lint 規則 GIVEN/WHEN/THEN
- [ ] **回歸**：v1.17.99 全部 1054 條測試 + 新增 schema lint 測試 + parser 測試 + sync 測試 + 升級助手 test、合計 ≥ 1100 條 全綠

---

## 9. 預估工作量

| 階段 | 內容 | 估時 |
|---|---|---|
| Spec | spec.md GIVEN/WHEN/THEN | 30 min |
| Tasks | tasks.md 拆分 | 15 min |
| 後端：parser + schema lint + MCP API | js-yaml + lintIronRule v2 + ownmind_save schema 接受 | 2-3 hr |
| 後端：新 endpoint `GET /api/memory/sync-token` + sync hook + 跨工具路徑寫入 | conditional pull + DB 寫鐵律後 trigger sync | 2.5-3.5 hr（+0.5 hr）|
| Web UI 升級助手 | admin panel + diff view + LLM suggest + confirm flow | 2-3 hr |
| Migration（Vin 自己轉 35 條）| 用升級助手手動轉 | 35 min × N 次 |
| Test | schema lint + parser + sync flow + conditional pull + UI flow | 2.5 hr（+0.5 hr）|
| Code review + receiving | 走品管三步驟 | 1 hr |
| Deploy + browser 實測 | IR-018 / 020 / 023 | 30 min |
| **總計（不含 Vin 手動轉舊鐵律）** | | **11-14 小時**（+1 hr 加 conditional sync） |

可以拆 3 個 commit：
- v1.18.0-rc1：parser + schema lint + MCP API（後端、~3 hr）
- v1.18.0-rc2：sync hook + 跨工具路徑（~3 hr）
- v1.18.0-rc3：升級助手 web UI + 整合（~3 hr）
- v1.18.0：文件 + tag + deploy

---

## 10. 待 Vin 拍版的剩餘 6 個決策

1. **Migration 策略**：手動 + AI 輔助分批（透過 Web UI 升級助手）✓ — 預設這個、要改？
2. **lint description pushy 程度**：< 50 字 warning（不 reject）、≥ 20 字才能存 — OK 嗎？
3. **`js-yaml` 引入**：50KB bundle add、業界標準 — 同意嗎？
4. **DB 加 `previous_content` 備援欄位**：升級助手寫壞時可救 — 要嗎？(若不要、改鐵律前不備份原值)
5. **跨工具 sync 範圍**：要寫到 Cursor / Codex / Antigravity / OpenCode / Windsurf / Gemini 全部？還是只 Claude Code（`~/.claude/skills/`）+ Codex（`~/.codex/AGENTS.md`）？
6. **Sync 衝突處理**：DB 永遠贏（覆蓋本地）— 接受嗎？(替代：偵測衝突 → 提示 Vin 手動選、複雜度高)
