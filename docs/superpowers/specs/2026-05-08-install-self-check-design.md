# 安裝/升級自動 self-check + 上傳 log（Bob 類 silent fail 早期偵測）

**Date**: 2026-05-08
**Status**: Approved → ready for implementation plan
**Iron Rule**: IR-027（提醒無效，邏輯才有效）+ IR-019（版本檢查不能只看本地）

## 背景

Bob 用 OwnMind 用了一個多月，伺服器端從來沒收到他的 token 事件。挖到 root cause：他 Windows 上 Task Scheduler（工作排程器）沒註冊，scanner 從未跑過，但 install.ps1 沒檢查、Bob 自己也不知道。同樣狀況可能也在其他人身上潛伏。

當前設計的盲點：
- `install.sh` / `install.ps1` 跑完印 ✅，但 ✅ 只代表這個區塊**沒 throw**，不代表後續的元件**真的會運作**
- 例如 Task Scheduler 註冊指令成功 = 不等於 scanner 30 分鐘後真的會被叫起來
- 從伺服器視角又看不到使用者本機到底裝了什麼，要靠使用者自己回報才知道哪邊壞掉

## 目標

每次安裝/升級結束自動跑一遍 self-check，把當下本機所有元件的真實狀態抓下來：
1. 印給使用者看（綠/黃/紅 + 失敗修復指示）
2. 寫成 log 留在本機 `~/.ownmind/logs/self-check-<timestamp>.log`
3. 上傳到伺服器留檔，方便 admin 追蹤所有使用者的安裝健康度

## 非目標

- 不做即時 health monitoring（之後 v3.0 增量）
- 不自動修問題（self-check 只診斷、由使用者或 AI 後續處理）
- 不擋使用者繼續用 — 即使 self-check 失敗也只警告、不中斷

## 設計

### 元件總覽

```
scripts/install-helpers/self-check.cjs   # 跨平台 Node 腳本（單檔）
                                         # 跑所有 check + 印結果 + 寫 log + 上傳
install.sh / install.ps1                 # 結尾呼叫 self-check
interactive-upgrade.sh / .ps1            # 同上
src/routes/debug.js                      # 新 API：POST /api/debug/install-check
src/public/index.html                    # 團隊一覽加 self-check 狀態欄
db/migration NNN                         # 新表 install_check_logs
```

### Self-check 檢查項目（順序 + 修復指示）

每項回傳 `{ name, status: 'pass'|'warn'|'fail', detail, fix? }`。

| # | 名稱 | 怎麼檢查 | 失敗代表什麼 + 修復指示 |
|---|------|---------|------|
| 1 | `mcp_files` | `~/.ownmind/mcp/index.js` 存在、可讀 | 升級沒拉完整。重跑 bootstrap |
| 2 | `package_version` | `~/.ownmind/package.json` version 字串符合 semver | git pull 半路斷掉。重跑 bootstrap |
| 3 | `mcp_node_modules` | `~/.ownmind/mcp/node_modules/` 存在且非空 | npm install 失敗。看 `~/.ownmind/logs/install-*.log` |
| 4 | `server_health` | GET `${API_URL}/health`，2s timeout | 網路問題或 server 掛了 |
| 5 | `api_credentials` | POST `${API_URL}/api/init`，期望 200 | API key 無效 / 過期。重跑 bootstrap 重設 |
| 6 | `git_hooks` | `~/.ownmind/git-hooks/{pre-commit,post-commit,commit-msg}` 存在 + 可執行 | install.sh 沒裝或被覆蓋。重跑 install.sh |
| 7 | `scheduler` | macOS: `launchctl list` 含 `com.ownmind.usage-scanner`；Linux: `systemctl --user is-active ownmind-usage-scanner.timer`；Windows: `Get-ScheduledTask -TaskName 'OwnMind Usage Scanner'` | scanner 不會被排程跑。給對應 OS 的重註冊指令 |
| 8 | `scanner_dryrun` | `node ~/.ownmind/hooks/ownmind-usage-scanner.js --self-check`（要新增 `--self-check` 模式：只跑一次、不送 events，回傳 JSON）| scanner 跑會 throw。把 stderr 印出來 |
| 9 | `recent_heartbeat` | POST `${API_URL}/api/debug/last-heartbeat`，回傳 server 端最新看到此 user 的時間。差距 < 1 小時 PASS、< 24 小時 WARN、其他 FAIL | server 沒在收到此 user 心跳 |
| 10 | `recent_token_events` | 同上，問 server 有沒有最近 7 天 token 事件 | scanner 在跑但事件沒進 server，可能 POST fail |

### Log 檔結構

`~/.ownmind/logs/self-check-YYYYMMDD-HHMMSS.log` 內容是 JSON：

```json
{
  "ts": "2026-05-08T01:23:45+08:00",
  "trigger": "post_upgrade",
  "client_version": "1.17.62",
  "platform": "darwin",
  "node_version": "v22.5.0",
  "machine": "Vin.local",
  "checks": [
    { "name": "mcp_files", "status": "pass", "detail": "..." },
    { "name": "scheduler", "status": "fail", "detail": "...", "fix": "..." }
  ],
  "summary": { "pass": 8, "warn": 1, "fail": 1 }
}
```

stderr 也有人類可讀版（綠勾紅叉）。

### 上傳協定

**預設自動上傳**到 `${API_URL}/api/debug/install-check`（理由：Vin 要 admin 視角看誰壞掉、不用追問）。

opt-out：`~/.ownmind/.no-self-check-upload` 存在 → 跳過上傳但本機 log 還是寫。

privacy：上傳的 JSON 跟 log 一樣，沒有 secrets / API key / commit message / file content；只有：
- 平台、版本、機器名（hostname，跟 heartbeat 一樣）
- 各 check 的 status + detail（detail 字串先過 `sanitizeErrorMessage()` 砍家目錄路徑）

### Server 端

- 新 endpoint `POST /api/debug/install-check`：auth 同其他 API（API key），body 直接存 jsonb
- 新表 `install_check_logs`：`(id, user_id, tool, ts, client_version, platform, summary jsonb, full_log jsonb)`
- index 頁加欄位「最後 self-check」顯示時間 + 整體狀態（綠/黃/紅）+ 點開看完整 log
- 也加進 audit findings：超過 30 天沒 self-check 觸發 finding

### 觸發點

- `install.sh` 結尾呼叫
- `install.ps1` 結尾呼叫
- `interactive-upgrade.sh` 結尾呼叫
- `interactive-upgrade.ps1` 結尾呼叫
- 新增 `~/.ownmind/scripts/self-check.sh|.ps1` 給使用者手動跑
- ownmind-upgrade skill 完成後可選擇加上去（之後增量）

## 影響範圍

### 新檔
- `scripts/install-helpers/self-check.cjs` — 跨平台 self-check 主邏輯
- `scripts/self-check.sh` / `.ps1` — 包裝呼叫，給使用者手動跑
- `src/routes/debug.js` — 新 API endpoint
- `db/0NN_install_check_logs.sql` — schema migration
- `tests/self-check.test.js` — 至少 5 個 case 涵蓋 pass/fail/upload-skip 路徑
- `tests/debug-route.test.js` — endpoint 測試
- `hooks/ownmind-usage-scanner.js` — 加 `--self-check` 模式

### 修改
- `install.sh` / `install.ps1` 結尾加呼叫
- `interactive-upgrade.sh` / `.ps1` 結尾加呼叫
- `src/app.js` 掛 `/api/debug` 路由
- `src/public/index.html` 團隊一覽加欄
- `Dockerfile` `COPY db/` 拉新 migration（IR-034）
- `package.json` 1.17.62 → 1.17.63
- 三語系 README + CHANGELOG + FILELIST

## 風險 + 緩解

| 風險 | 緩解 |
|------|------|
| self-check 自己壞掉、堵住安裝流程 | 整段包 try/catch，self-check fail 只印警告不退非 0；安裝完成的訊息照常印 |
| 個別 check 卡住（network、外部指令）| 每個 check 都有 timeout（2~5s），整支 self-check 上限 30s |
| 上傳隱私意外 | 上傳前 sanitize 路徑；本機 log 永遠保留可給使用者驗證 |
| Windows 跑 .cmd 的老問題 | self-check 內部呼叫 launchctl / schtasks 都用 execFile + shell:true 模式（吃過 v1.17.62 的虧不再踩） |
| Server endpoint 被濫用打爆 | 同其他 API 套 rate limit + admin auth-only audit dashboard |

## 驗證 + 收尾（IR-012 品管三步驟）

1. verification-before-completion：跑 `npm test`，本地手動跑 self-check.cjs 看 log 內容、看 server 真的收到記錄
2. requesting-code-review：commit + PR 前 review
3. receiving-code-review：依回饋處理

## 為什麼這個是純加值、不影響既有流程

- self-check 在所有正常流程**之後**跑、失敗也不阻擋
- 上傳是 fire-and-forget、失敗不擋本機 log
- 既有 `install.sh` / `install.ps1` 行為不變、只是多了一段最後的健康檢查
