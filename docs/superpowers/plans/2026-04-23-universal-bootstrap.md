# Universal Bootstrap Implementation Plan (v1.17.6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** One sentence to AI ("升級 OwnMind" / "裝 OwnMind" / "修 OwnMind") triggers auto-detection of OS + install state, runs the right action (fresh install / upgrade / repair / no-op), reports step-by-step. Replaces the scattered install.sh + install.ps1 + interactive-upgrade.sh + interactive-upgrade.ps1 mental model with a single universal entry.

**Architecture:**
- Two cross-platform bootstrap scripts (`scripts/bootstrap.sh`, `scripts/bootstrap.ps1`) with three-branch logic: no install → clone+install; broken (no .git) → backup+reclone; normal → delegate to `interactive-upgrade.*`.
- Express route serving the scripts at `https://kkvin.com/ownmind/bootstrap.sh|.ps1` for one-line curl/iwr install on fresh machines.
- `skills/ownmind-upgrade.md` expanded: new trigger vocabulary (`裝`, `重裝`, `修`, `OwnMind 壞了`), new mode D (fresh install), auto OS detection, falls back to curl/iwr when `~/.ownmind/scripts/bootstrap.sh` not yet present.

**Tech Stack:** Bash / PowerShell bootstrap scripts; Express static-file route; skill markdown.

---

## File Structure

- Create: `scripts/bootstrap.sh` — universal bash entry (Mac/Linux/Git Bash)
- Create: `scripts/bootstrap.ps1` — universal PowerShell entry (Windows)
- Modify: `src/app.js` — add `GET /bootstrap.sh` + `GET /bootstrap.ps1` public static routes (no auth, no rate limit — user retries must always work)
- Modify: `skills/ownmind-upgrade.md` — expand trigger phrases, add Mode D (fresh install), OS detection logic
- Modify: `package.json` — version 1.17.5 → 1.17.6
- Modify: `CHANGELOG.md` — v1.17.6 entry
- Modify: `FILELIST.md` — register new scripts
- Modify: `README.md`, `docs/README.ja.md`, `docs/README.zh-TW.md` — install one-liner examples (IR-032)
- Create: `tests/bootstrap-script.test.js` — static source-text checks on bootstrap.sh / bootstrap.ps1
- Create: `tests/bootstrap-routes.test.js` — Express route test (public access, correct content-type, file served)

---

## Task 1: Create `scripts/bootstrap.sh` (bash, cross-shell)

**Files:**
- Create: `scripts/bootstrap.sh`
- Test: `tests/bootstrap-script.test.js` (covers both scripts)

**Requirements:**
- Works on macOS / Linux / Git Bash / WSL.
- Three branches by environment state:
  1. `$HOME/.ownmind/` doesn't exist → `git clone` + `bash install.sh`
  2. `$HOME/.ownmind/` exists but not a git repo → move to `$HOME/.ownmind.broken.$TIMESTAMP`, clone fresh, `bash install.sh`
  3. `$HOME/.ownmind/.git` exists → `exec bash $HOME/.ownmind/scripts/interactive-upgrade.sh` (normal upgrade path)
- Output uses the existing `INFO:<code>:<msg>` / `OK:<code>:<msg>` / `ERROR:<code>:<msg>` convention (same as `interactive-upgrade.sh`), so the skill reads output uniformly.
- `OWNMIND_DIR` and `OWNMIND_REPO` env vars can override defaults (for testing).
- `set -e` style error handling, exit 0 on success, exit 1 on any fatal.
- Safe to `curl ... | bash` (doesn't rely on $0, doesn't read from stdin after pipe).

**Test file — write this FIRST:**

```javascript
// tests/bootstrap-script.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const shPath = join(__dirname, '..', 'scripts', 'bootstrap.sh');
const ps1Path = join(__dirname, '..', 'scripts', 'bootstrap.ps1');

test('bootstrap.sh exists and is executable', () => {
  const stat = statSync(shPath);
  assert.ok(stat.mode & 0o100, 'bootstrap.sh must have user-execute bit (chmod +x)');
});

test('bootstrap.sh handles all three install states', () => {
  const src = readFileSync(shPath, 'utf8');
  // Branch 1: no install → clone
  assert.match(src, /if\s+\[\s*!\s+-d\s+"?\$(?:HOME|OWNMIND_DIR)[^"]*"?\s*\]/,
    'expected "no install" branch (test for missing ~/.ownmind)');
  assert.match(src, /git\s+clone\s+"?\$(?:OWNMIND_)?REPO"?/,
    'expected git clone command');
  // Branch 2: broken (has dir, no .git) → backup + reclone
  assert.match(src, /\.broken\./,
    'expected timestamp-suffixed backup directory name for broken state');
  // Branch 3: normal → delegate to interactive-upgrade.sh
  assert.match(src, /interactive-upgrade\.sh/,
    'expected delegation to interactive-upgrade.sh for normal upgrade path');
});

test('bootstrap.sh uses INFO/OK/ERROR logging convention', () => {
  const src = readFileSync(shPath, 'utf8');
  assert.match(src, /INFO:[a-z_]+:/, 'expected INFO:<code>: log lines');
  assert.match(src, /OK:[a-z_]+:/,   'expected OK:<code>: log lines');
  // ERROR is optional per branch but must be defined/used somewhere
  assert.match(src, /ERROR:[a-z_]+:/, 'expected ERROR:<code>: log lines');
});

test('bootstrap.sh supports curl-pipe-bash (no stdin reads)', () => {
  const src = readFileSync(shPath, 'utf8');
  // The script must not try to read from stdin after the pipe (would hang).
  // Forbid `read ` at line start (interactive prompts) unless guarded by a TTY check.
  const hasUnguardedRead = /^read\s/m.test(src) && !/\[\s*-t\s+0\s*\]/.test(src);
  assert.equal(hasUnguardedRead, false,
    'bootstrap.sh must not prompt for input (would hang under curl | bash). Guard any `read` with a TTY check.');
});

test('bootstrap.ps1 exists', () => {
  statSync(ps1Path); // throws if missing
});

test('bootstrap.ps1 handles all three install states', () => {
  const src = readFileSync(ps1Path, 'utf8');
  assert.match(src, /Test-Path\s+(?:-?\w+\s+)?\$OwnmindDir/i,
    'expected Test-Path $OwnmindDir check (no install branch)');
  assert.match(src, /git\s+clone\s+\$Repo/i,
    'expected git clone $Repo command');
  assert.match(src, /\.broken\./,
    'expected timestamp-suffixed backup path for broken state');
  assert.match(src, /interactive-upgrade\.ps1/,
    'expected delegation to interactive-upgrade.ps1');
});

test('bootstrap.ps1 uses INFO/OK/ERROR logging convention', () => {
  const src = readFileSync(ps1Path, 'utf8');
  assert.match(src, /"INFO:[a-z_]+:/i);
  assert.match(src, /"OK:[a-z_]+:/i);
});
```

**Implementation — `scripts/bootstrap.sh`:**

```bash
#!/usr/bin/env bash
# OwnMind Universal Bootstrap — install / upgrade / repair in one script
#
# Usage:
#   Local:  bash ~/.ownmind/scripts/bootstrap.sh
#   Remote: curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash
#
# Branches:
#   1. ~/.ownmind not present         → fresh clone + install
#   2. ~/.ownmind present, no .git    → backup + re-clone + install (repair)
#   3. ~/.ownmind is a git repo       → delegate to scripts/interactive-upgrade.sh
#
# Env overrides (for testing):
#   OWNMIND_DIR   — install path (default: $HOME/.ownmind)
#   OWNMIND_REPO  — git URL      (default: https://github.com/miou1107/ownmind.git)

set -e

OWNMIND_DIR="${OWNMIND_DIR:-$HOME/.ownmind}"
OWNMIND_REPO="${OWNMIND_REPO:-https://github.com/miou1107/ownmind.git}"
TS=$(date +%Y%m%d-%H%M%S)

log_info() { echo "INFO:$1:$2"; }
log_ok()   { echo "OK:$1:$2"; }
log_err()  { echo "ERROR:$1:$2" >&2; }

log_info detect "檢查 OwnMind 安裝狀態（$OWNMIND_DIR）"

# Branch 1: no install
if [ ! -d "$OWNMIND_DIR" ]; then
  log_info fresh "首次安裝，clone repo"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  if [ ! -d "$OWNMIND_DIR/.git" ]; then
    log_err git_clone "git clone 失敗，請檢查網路或 GitHub 權限"
    exit 1
  fi
  log_ok clone "clone 完成"
  cd "$OWNMIND_DIR"
  log_info install "執行 install.sh"
  bash install.sh || { log_err install "install.sh 失敗"; exit 1; }
  log_ok done "首次安裝完成"
  exit 0
fi

# Branch 2: broken
if [ ! -d "$OWNMIND_DIR/.git" ]; then
  BAK="${OWNMIND_DIR}.broken.${TS}"
  log_info broken "$OWNMIND_DIR 存在但不是 git repo，備份至 $BAK"
  mv "$OWNMIND_DIR" "$BAK" || { log_err backup "備份失敗"; exit 1; }
  log_ok backup "已備份"
  log_info fresh "重新 clone"
  git clone "$OWNMIND_REPO" "$OWNMIND_DIR" 2>&1 | while IFS= read -r line; do echo "  $line"; done
  cd "$OWNMIND_DIR"
  bash install.sh || { log_err install "install.sh 失敗"; exit 1; }
  log_ok done "修復完成（舊資料保留於 $BAK，3 天後可手動刪除）"
  exit 0
fi

# Branch 3: normal upgrade
log_info upgrade "已安裝，交給 interactive-upgrade.sh"
exec bash "$OWNMIND_DIR/scripts/interactive-upgrade.sh"
```

- [ ] **Step 1: Write the failing test file**

Save the above `tests/bootstrap-script.test.js` content.

- [ ] **Step 2: Run test — should FAIL**

Run: `node --test tests/bootstrap-script.test.js`
Expected: FAIL with "ENOENT: no such file or directory ... scripts/bootstrap.sh" (test can't even stat the file).

- [ ] **Step 3: Create bootstrap.sh with content above**

Write `scripts/bootstrap.sh` exactly as in the Implementation block.

- [ ] **Step 4: Make it executable**

Run: `chmod +x scripts/bootstrap.sh`

- [ ] **Step 5: Run tests for sh — should PASS** (ps1 will still fail; that's Task 2)

Run: `node --test tests/bootstrap-script.test.js` — expect the `.sh` tests to pass and the `.ps1` tests to fail.

- [ ] **Step 6: Commit Task 1 (bash only)**

```bash
git add scripts/bootstrap.sh tests/bootstrap-script.test.js
git commit -m "feat(scripts): add bootstrap.sh for unified install/upgrade/repair"
```

---

## Task 2: Create `scripts/bootstrap.ps1` (PowerShell)

**Files:**
- Create: `scripts/bootstrap.ps1`

**Implementation — `scripts/bootstrap.ps1`:**

```powershell
# OwnMind Universal Bootstrap for Windows PowerShell
#
# Usage:
#   Local:  powershell -ExecutionPolicy Bypass -File $HOME\.ownmind\scripts\bootstrap.ps1
#   Remote: iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
#
# Branches:
#   1. ~/.ownmind not present         → fresh clone + install
#   2. ~/.ownmind present, no .git    → backup + re-clone + install (repair)
#   3. ~/.ownmind is a git repo       → delegate to scripts/interactive-upgrade.ps1
#
# Env overrides (for testing):
#   $env:OWNMIND_DIR   — install path (default: $env:USERPROFILE\.ownmind)
#   $env:OWNMIND_REPO  — git URL      (default: https://github.com/miou1107/ownmind.git)

$ErrorActionPreference = "Stop"

$OwnmindDir = if ($env:OWNMIND_DIR) { $env:OWNMIND_DIR } else { "$env:USERPROFILE\.ownmind" }
$Repo = if ($env:OWNMIND_REPO) { $env:OWNMIND_REPO } else { "https://github.com/miou1107/ownmind.git" }
$Ts = Get-Date -Format "yyyyMMdd-HHmmss"

function Log-Info($code, $msg) { Write-Host "INFO:${code}:${msg}" }
function Log-Ok($code, $msg)   { Write-Host "OK:${code}:${msg}" }
function Log-Err($code, $msg)  { Write-Host "ERROR:${code}:${msg}" -ForegroundColor Red }

Log-Info detect "檢查 OwnMind 安裝狀態（$OwnmindDir）"

# Branch 1: no install
if (-not (Test-Path $OwnmindDir)) {
  Log-Info fresh "首次安裝，clone repo"
  git clone $Repo $OwnmindDir
  if (-not (Test-Path "$OwnmindDir\.git")) {
    Log-Err git_clone "git clone 失敗，請檢查網路或 GitHub 權限"
    exit 1
  }
  Log-Ok clone "clone 完成"
  Set-Location $OwnmindDir
  Log-Info install "執行 install.ps1"
  & powershell -ExecutionPolicy Bypass -File .\install.ps1
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 失敗"; exit 1 }
  Log-Ok done "首次安裝完成"
  exit 0
}

# Branch 2: broken
if (-not (Test-Path "$OwnmindDir\.git")) {
  $Bak = "$OwnmindDir.broken.$Ts"
  Log-Info broken "$OwnmindDir 存在但不是 git repo，備份至 $Bak"
  Move-Item $OwnmindDir $Bak
  Log-Ok backup "已備份"
  Log-Info fresh "重新 clone"
  git clone $Repo $OwnmindDir
  Set-Location $OwnmindDir
  & powershell -ExecutionPolicy Bypass -File .\install.ps1
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 失敗"; exit 1 }
  Log-Ok done "修復完成（舊資料保留於 $Bak，3 天後可手動刪除）"
  exit 0
}

# Branch 3: normal upgrade
Log-Info upgrade "已安裝，交給 interactive-upgrade.ps1"
& powershell -ExecutionPolicy Bypass -File "$OwnmindDir\scripts\interactive-upgrade.ps1"
exit $LASTEXITCODE
```

- [ ] **Step 1: Create bootstrap.ps1 with content above**

- [ ] **Step 2: Run tests — all bootstrap-script.test.js must PASS now**

Run: `node --test tests/bootstrap-script.test.js`
Expected: all tests pass.

- [ ] **Step 3: Full test suite**

Run: `npm test` — expect 472 + new tests all pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/bootstrap.ps1
git commit -m "feat(scripts): add bootstrap.ps1 for Windows PowerShell"
```

---

## Task 3: Serve bootstrap scripts via Express public route

**Files:**
- Modify: `src/app.js:82` (after `/health` route) — add two `GET` handlers
- Test: `tests/bootstrap-routes.test.js` (new)

**Requirements:**
- `GET /bootstrap.sh` returns file content with `Content-Type: text/x-shellscript; charset=utf-8`
- `GET /bootstrap.ps1` returns file content with `Content-Type: text/plain; charset=utf-8`
- No auth required (fresh machines don't have API key yet)
- Routes mounted BEFORE the error-handling middleware, AFTER `/health`
- Does NOT pass through `apiLimiter` (paths don't start with `/api`)

**Test — write FIRST:**

```javascript
// tests/bootstrap-routes.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import app from '../src/app.js';

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = {
      method, url: path, headers: {},
      on() {}, pipe() {}, resume() {}, read() { return null; },
    };
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      getHeader(k) { return this.headers[k.toLowerCase()]; },
      writeHead(code, hdrs) { this.statusCode = code; if (hdrs) Object.assign(this.headers, hdrs); },
      write(chunk) { chunks.push(Buffer.from(chunk)); },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({
          status: this.statusCode,
          headers: this.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      },
      on() {},
      emit() {},
    };
    app(req, res);
    setTimeout(() => reject(new Error('timeout')), 5000);
  });
}

test('GET /bootstrap.sh serves bash script without auth', async () => {
  const res = await request('GET', '/bootstrap.sh');
  assert.equal(res.status, 200);
  assert.match(res.body, /^#!\/usr\/bin\/env bash/);
  assert.match(res.body, /INFO:detect:/);
});

test('GET /bootstrap.ps1 serves PowerShell script without auth', async () => {
  const res = await request('GET', '/bootstrap.ps1');
  assert.equal(res.status, 200);
  assert.match(res.body, /\$ErrorActionPreference/);
  assert.match(res.body, /Test-Path\s+\$OwnmindDir/);
});
```

NOTE: the above `request` shim is simplistic. If it doesn't work with Express, the implementer MUST use whatever the other tests use (search the existing test files with `grep -l "app\b" tests/` to see if there's a test helper or use `supertest` if available).

**Implementation — add to `src/app.js`:**

Find the block:
```js
// 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 錯誤處理中介層
```

Insert between:

```js
// 健康檢查
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Public bootstrap scripts — served without auth so fresh machines can
// `curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash` before they
// have an API key. See docs/superpowers/plans/2026-04-23-universal-bootstrap.md.
app.get('/bootstrap.sh', (req, res) => {
  res.type('text/x-shellscript; charset=utf-8');
  res.sendFile(join(__dirname, '..', 'scripts', 'bootstrap.sh'));
});
app.get('/bootstrap.ps1', (req, res) => {
  res.type('text/plain; charset=utf-8');
  res.sendFile(join(__dirname, '..', 'scripts', 'bootstrap.ps1'));
});

// 錯誤處理中介層
```

- [ ] **Step 1: Inspect test infrastructure to pick right harness**

Run: `grep -l "import app\|import.*app.js" tests/ 2>/dev/null` and `head -40 tests/broadcast.test.js` — figure out how existing tests spin up Express. Use the same harness.

- [ ] **Step 2: Write the failing test (adapt to actual harness)**

- [ ] **Step 3: Run — should FAIL (routes not yet added)**

- [ ] **Step 4: Add the 2 routes to `src/app.js`**

- [ ] **Step 5: Run — should PASS**

Run: `node --test tests/bootstrap-routes.test.js`
Expected: both tests pass.

- [ ] **Step 6: Full suite**

Run: `npm test` — 472 + all new tests.

- [ ] **Step 7: Commit**

```bash
git add src/app.js tests/bootstrap-routes.test.js
git commit -m "feat(server): serve bootstrap.sh and bootstrap.ps1 as public routes"
```

---

## Task 4: Expand `ownmind-upgrade` skill

**Files:**
- Modify: `skills/ownmind-upgrade.md` — add Mode D (fresh install) + new trigger vocab + OS detection logic

**Changes:**

Add a new "Mode D: Fresh install / repair" section that:
- Triggers on: 「裝 OwnMind」「重裝」「修 OwnMind」「OwnMind 壞了」「安裝 OwnMind」
- Detects: `~/.ownmind/` doesn't exist → fresh install via curl-pipe-bash
- Runs: `curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash` (Mac/Linux) or `iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex` (Windows)
- Falls through to Mode B (upgrade) if `~/.ownmind/` already exists

Update Mode B to call the local `scripts/bootstrap.sh` instead of directly `interactive-upgrade.sh` (which bootstrap delegates to) — this way Mode B handles broken-state repair too.

Add "OS auto-detection" helper at the top of the skill:
```
# Mac/Linux detection: uname -s returns Darwin or Linux
# Windows: $env:OS == "Windows_NT" or use PowerShell
```

- [ ] **Step 1: Read current `skills/ownmind-upgrade.md`**

- [ ] **Step 2: Rewrite with new Mode D + expanded trigger vocab + OS logic**

- [ ] **Step 3: Commit**

```bash
git add skills/ownmind-upgrade.md
git commit -m "feat(skill): ownmind-upgrade handles fresh install + repair (Mode D)"
```

---

## Task 5: Version bump + docs sync (IR-008, IR-031, IR-032)

**Files:**
- Modify: `package.json` → 1.17.6
- Regenerate: `package-lock.json` via `npm install --package-lock-only`
- Modify: `CHANGELOG.md` — prepend v1.17.6 entry
- Modify: `FILELIST.md` — register new scripts + tests + plan file
- Modify: `README.md` — update install/upgrade section (add one-liner)
- Modify: `docs/README.zh-TW.md` — mirror
- Modify: `docs/README.ja.md` — mirror

**CHANGELOG entry:**

```markdown
## v1.17.6 — Universal Bootstrap（一句指令搞定安裝/升級/修復）

**背景**：之前 install / upgrade 分成 4 支腳本（`install.sh`、`install.ps1`、`interactive-upgrade.sh`、`interactive-upgrade.ps1`），user 得自己判斷該跑哪一支；新用戶更慘，完全不知道從哪開始。

**新增**
- `scripts/bootstrap.sh` + `scripts/bootstrap.ps1`：單一入口，三分支處理
  1. 沒裝 → git clone + install
  2. 壞掉（存在但不是 git repo）→ 備份至 `~/.ownmind.broken.<timestamp>` + 重 clone + install
  3. 已裝 → 轉交 `interactive-upgrade.*`
- Express 新增兩個 public route：`GET /bootstrap.sh` / `GET /bootstrap.ps1`（不需 auth，給新機器 curl-pipe-bash 用）
- `skills/ownmind-upgrade.md` 擴充：新觸發詞（「裝」「重裝」「修」「OwnMind 壞了」）、新 Mode D（fresh install）、自動 OS 偵測

**使用方式（任何平台 / 任何狀態）**

對 AI 說一句：
- 「升級 OwnMind」 / 「裝 OwnMind」 / 「修 OwnMind」 / 「OwnMind 壞了」

AI 自動判斷並執行。

**或命令列 one-liner（不靠 AI 也可）**

Mac / Linux：
\`\`\`bash
curl -fsSL https://kkvin.com/ownmind/bootstrap.sh | bash
\`\`\`

Windows PowerShell：
\`\`\`powershell
iwr -useb https://kkvin.com/ownmind/bootstrap.ps1 | iex
\`\`\`

---
```

- [ ] **Step 1-7: Bump, sync locks, write CHANGELOG/FILELIST, update READMEs, run tests, commit, tag**

---

## Task 6: Verification before completion

- [ ] Run: `npm test` — all pass
- [ ] Run: `bash scripts/bootstrap.sh` in a throwaway dir with `OWNMIND_DIR=/tmp/ownmind-test-$$` to smoke-test the bash script actually clones + installs without errors
- [ ] Run: tag + git log check
- [ ] Invoke: `Skill("superpowers:verification-before-completion")` gate

---

## Task 7: Code review (pre-merge)

Dispatch superpowers:code-reviewer subagent. BASE=823531b (v1.17.5), HEAD=current tip.

---

## Task 8: Merge + push + deploy + replace broadcast

- [ ] Merge `claude/bootstrap` → `main` (--ff-only)
- [ ] `git push origin main`
- [ ] `git push origin v1.17.6`
- [ ] Cleanup worktree + branch
- [ ] SSH deploy: `ssh root@kkvin.com "cd /VinService/ownmind && git pull && docker compose build --no-cache api && docker compose up -d api"`
- [ ] Verify `/api/memory/init` returns `server_version: 1.17.6`
- [ ] Smoke test: `curl -sS https://kkvin.com/ownmind/bootstrap.sh | head -5` — should stream the bash script
- [ ] Revoke old v1.17.4 broadcast (id=4) + send new v1.17.6 broadcast with updated text recommending the one-prompt flow

---

## Self-Review

**Spec coverage:**
- One-prompt trigger → Task 4 skill ✓
- Auto-detect environment → scripts branch logic (Task 1/2) + skill OS detection (Task 4) ✓
- Auto-detect state → scripts branch logic (Task 1/2) ✓
- Host at kkvin.com → Express route (Task 3) ✓
- Skill keeps name `ownmind-upgrade` (non-breaking) → Task 4 ✓
- Backup on repair → Task 1/2 ✓
- IR-008 CHANGELOG + README + FILELIST → Task 5 ✓
- IR-022 Server+Client → Client (scripts) + Server (route) both touched ✓
- IR-024 no Co-Authored-By → confirmed in commit templates ✓
- IR-031 version sync → Task 5 + Task 8 tag ✓
- IR-032 README 三語系 → Task 5 ✓

**Placeholder scan:** No TBDs, all code blocks complete.

**Type consistency:** `$OwnmindDir` / `$OWNMIND_DIR` / `.ownmind` paths consistent across scripts + tests.
