# Iron Rule Auto-Numbering

**Date:** 2026-03-31
**Status:** Draft

## Problem

鐵律的 `code` 欄位（如 IR-001）是手動填入的，沒有自動編號機制。導致後來新增的鐵律 `code` 為 null，引用時不一致。

## Solution

### 1. Server 端自動編號

**位置：** `src/routes/memory.js` — `POST /api/memory`

**邏輯：**
- 當 `type === 'iron_rule'` 且 `code` 為空（null/undefined/空字串）時
- 查詢該 user 現有最大 iron_rule code：
  ```sql
  SELECT code FROM memories
  WHERE user_id = $1 AND type = 'iron_rule' AND code LIKE 'IR-%'
  ORDER BY code DESC LIMIT 1
  ```
- 解析數字部分，+1，格式 `IR-XXX`（三位數補零）
- 如果沒有任何既有編號，從 IR-001 開始
- 如果 caller 已帶 `code`，尊重 caller 的值不覆蓋

**邊界情況：**
- 並發建立：機率極低（單人使用），不需 advisory lock
- disabled 的鐵律：編號不回收，繼續往上加

### 2. 補齊現有缺編號的鐵律

透過一次性 SQL 或 API 呼叫，將 `code IS NULL` 的 iron_rule 按 `created_at` 順序從 IR-014 開始補上。

現有缺編號的鐵律（共 11 條）：
| id | title | 預計編號 |
|----|-------|---------|
| 43 | Windows 上 Claude Code MCP 不能用短指令啟動 | IR-014 |
| 49 | fail2ban 白名單設定 | IR-015 |
| 50 | Docker build 要加 --no-cache | IR-016 |
| 53 | 版本檢查不能只看本地 origin | IR-017 |
| 58 | 部署後必須瀏覽器實測 | IR-018 |
| 88 | 開始工作前先 git pull 確認遠端最新狀態 | IR-019 |
| 101 | OwnMind 功能修改必須同時檢查 Server + Client 兩端 | IR-020 |
| 118 | 部署必須用 docker compose build | IR-021 |
| 119 | Git commit 絕對不加 Co-Authored-By | IR-022 |
| 120 | 完成實作 ≠ 完成工作 | IR-023 |
| 121 | 改完程式碼後立即檢查 README/FILELIST/CHANGELOG | IR-024 |
| 122 | 提醒無效，邏輯才有效 | IR-025 |

### 3. 同步文件

更新 CHANGELOG 記錄此改動。

## Affected Files

| File | Change |
|------|--------|
| `src/routes/memory.js` | POST /api/memory 加入 iron_rule auto-numbering |
| CHANGELOG.md | 記錄此功能 |

## Not In Scope

- 其他 memory type 不需要自動編號
- 不需要 DB migration（code 欄位已存在）
- 不需要改 MCP client 或 skill（server 自動處理）
