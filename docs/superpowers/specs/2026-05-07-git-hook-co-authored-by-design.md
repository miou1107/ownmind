# Git Hook：阻擋 Co-Authored-By trailer（IR-024 邏輯卡控）

**Date**: 2026-05-07
**Status**: Shipped in v1.17.58
**Iron Rule**: IR-024（commit 不加 Co-Authored-By）+ IR-027（提醒無效，邏輯才有效）
**Backlog source**: project_310 第 1 項

> **實作筆記（2026-05-07）**：實作過程中發現 Vin 機器上 OwnMind 的全域 hooks 目錄
> （`~/.ownmind/git-hooks/`，由 `install.sh` 設為 global `core.hooksPath`）會覆蓋
> 本文 §設計 §1 寫的「per-repo `scripts/git-hooks/commit-msg`」路徑。pivot 為「全域路線」：
> 鉤子實際放在 `hooks/ownmind-git-commit-msg`，由 `install.sh` / `install.ps1` 安裝到
> `~/.ownmind/git-hooks/commit-msg`，跟既有 `pre-commit`、`post-commit` 同套機制。
> 詳見 CHANGELOG v1.17.58 設計決定段落。

## 背景

IR-024 規定 OwnMind commit 不加 `Co-Authored-By` trailer。目前只在 dashboard 顯示提醒、依賴 AI 自覺，違反 IR-027「邏輯才有效」。本次改動把規則從「軟性提醒」升級為「git hook 強卡」。

## 目標

OwnMind repo 內，任何含 `Co-Authored-By` trailer 的 commit message 在本地端被 git 直接 reject，不需要 AI 自覺、不需要 dashboard 提醒。

## 非目標

- 不擋使用者其他 repo（ProjectR、ProjectS 等）— 保留 install 腳本給未來增量做（B 選項）
- 不修改任何 server-side 行為（這是 client-side 強卡）
- 不阻擋 `git commit --no-verify` — git 標準逃生口保留

## 設計

### 元件

#### 1. Hook script
- **路徑**：`scripts/git-hooks/commit-msg`
- **權限**：755（可執行）
- **語言**：bash（與 OwnMind 既有 scripts 一致）
- **觸發點**：git commit-msg hook（拿到第一個參數 `$1` = 暫存的 commit message 檔案）

#### 2. 偵測邏輯

```bash
grep -qiE '^[[:space:]]*Co-Authored-By:' "$1"
```

- `-i`：大小寫不敏感（覆蓋 `Co-Authored-By` / `Co-authored-by` / `co-authored-by`）
- `^[[:space:]]*`：行首允許縮排（git trailer 標準格式）
- `:` 結尾：確保是 trailer 而非巧合字串（例如普通敘述句不會被誤殺）
- `-q`：靜默模式，只看 exit code

#### 3. 錯誤訊息

```
❌ IR-024 violation: commit message contains 'Co-Authored-By' trailer.
   Vin 的鐵律：git commit 不加 Co-Authored-By。
   如需強制覆蓋（不建議），用 git commit --no-verify。
```

對象是 AI agent 跟 Vin 兩種讀者，所以中英並陳。

#### 4. 啟用機制

**選擇：postinstall script 自動設定**（2b）

- `package.json` 加 `"postinstall": "node scripts/install-helpers/setup-git-hooks.js"`
- script 動作：執行 `git config core.hooksPath scripts/git-hooks`
- 失敗 fallback：印 warning 但不中斷 npm install（避免 OwnMind 被當依賴時 break consumer）
- idempotent：重複跑同樣結果

#### 5. 測試

**檔案**：`tests/git-hook-co-authored-by.test.js`（node --test）

**測試矩陣**：

| Case | Commit message | 預期 |
|------|----------------|------|
| 1 | 含 `Co-Authored-By: x <x@x>`（IR-024 標準大小寫） | exit 1 |
| 2 | 含 `Co-authored-by: x <x@x>`（git 標準小寫） | exit 1 |
| 3 | 含 `co-authored-by: x <x@x>`（全小寫） | exit 1 |
| 4 | 含 `  Co-Authored-By: x <x@x>`（縮排） | exit 1 |
| 5 | 純文字 commit、無 trailer | exit 0 |
| 6 | 含 `Reviewed-by: x` 但無 `Co-Authored-By` | exit 0 |
| 7 | 文字內容偶然出現「co-authored」字眼但非 trailer 格式 | exit 0 |

**測試實作**：建臨時 git repo、複製 hook、跑 `git commit-msg <tmpfile>`、檢查 exit code。

## 影響範圍

### 新增檔案
- `scripts/git-hooks/commit-msg`
- `scripts/install-helpers/setup-git-hooks.js`
- `tests/git-hook-co-authored-by.test.js`
- `docs/superpowers/specs/2026-05-07-git-hook-co-authored-by-design.md`（本文）

### 修改檔案
- `package.json`：加 `postinstall`、版本 1.17.57 → 1.17.58
- `README.md` / `docs/README.zh-TW.md` / `docs/README.ja.md`：版號 + 一句說明（IR-032）
- `CHANGELOG.md`：v1.17.58 entry（IR-008）
- `FILELIST.md`：新檔案登記（IR-008）

## 風險 & 緩解

| 風險 | 緩解 |
|------|------|
| postinstall 在 CI / Docker build 時失敗讓 build 中斷 | setup script 用 try/catch 包，失敗只印 warning |
| 既有 hooks（如果有）被 `core.hooksPath` 蓋掉 | 檢查目前 OwnMind repo 沒設定 hooksPath，安全；若 user 自己設過會被覆蓋——postinstall 加 `--global=false` 確保只動 local config |
| `--no-verify` 變成 escape hatch 被濫用 | 接受。git 標準逃生口不該封死，否則使用者完全無法處理 hook bug |
| trailer 偵測誤殺：commit body 內描述「使用 Co-Authored-By trailer」 | `^[[:space:]]*` + `:$` 規則確保只擋行首 trailer 格式，敘述文字無冒號或不在行首不會中 |

## 驗證 & 收尾（IR-012 品管三步驟）

1. **verification-before-completion**：跑 `npm test`，所有 case pass；本機跑一次 commit 觸發 hook 親眼驗證 reject 訊息
2. **requesting-code-review**：commit + PR 前跑 review skill
3. **receiving-code-review**：根據回饋判斷是否真的有問題

## 為什麼不用 OpenSpec

OpenSpec 適合多 step、跨子系統的功能。這個改動是單一檔案 + 單一規則，superpowers spec doc 已足夠。IR-004 與 superpowers 不衝突，superpowers 是 IR-012 三步驟的執行器。
