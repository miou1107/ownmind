# Git Hook：阻擋 Co-Authored-By Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OwnMind repo 用 git commit-msg hook + postinstall 自動啟用，把 IR-024（commit 不加 Co-Authored-By）從軟性提醒升級為邏輯卡控。

**Architecture:** 三檔聯動 — `scripts/git-hooks/commit-msg`（hook 本體）+ `scripts/install-helpers/setup-git-hooks.js`（設 `core.hooksPath`）+ `package.json` postinstall 觸發。Hook 用 grep 偵測行首 trailer，case-insensitive，誤殺率最小化。

**Tech Stack:** bash（hook）、Node.js（setup script + tests）、node:test framework、git config.

**Spec:** [`docs/superpowers/specs/2026-05-07-git-hook-co-authored-by-design.md`](../specs/2026-05-07-git-hook-co-authored-by-design.md)

---

## File Structure

| Path | Type | Responsibility |
|------|------|----------------|
| `scripts/git-hooks/commit-msg` | Create | bash hook，偵測 Co-Authored-By trailer 並 reject |
| `scripts/install-helpers/setup-git-hooks.js` | Create | postinstall 跑這支設 `core.hooksPath` |
| `tests/git-hook-co-authored-by.test.js` | Create | 7 case 測偵測邏輯 |
| `tests/setup-git-hooks.test.js` | Create | 3 case 測 setup script |
| `package.json` | Modify | 加 postinstall、版本 1.17.57 → 1.17.58 |
| `README.md` | Modify | 版號 + 加一句 IR-024 強卡說明（IR-032 三語系同步） |
| `docs/README.zh-TW.md` | Modify | 同上 |
| `docs/README.ja.md` | Modify | 同上 |
| `CHANGELOG.md` | Modify | v1.17.58 entry（IR-008） |
| `FILELIST.md` | Modify | 新檔案登記（IR-008） |

---

### Task 1: Commit-msg hook（TDD）

**Files:**
- Create: `tests/git-hook-co-authored-by.test.js`
- Create: `scripts/git-hooks/commit-msg`

- [ ] **Step 1: Write the failing test**

Create `tests/git-hook-co-authored-by.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const HOOK = path.join(__dirname, '..', 'scripts', 'git-hooks', 'commit-msg');

function runHook(message) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-hook-test-'));
  const msgFile = path.join(tmpDir, 'COMMIT_EDITMSG');
  fs.writeFileSync(msgFile, message);
  try {
    execFileSync(HOOK, [msgFile], { stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (e) {
    return { code: e.status ?? -1, stderr: e.stderr?.toString() ?? '' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('rejects Co-Authored-By trailer (IR-024 standard case)', () => {
  const r = runHook('feat: x\n\nCo-Authored-By: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /IR-024/);
});

test('rejects Co-authored-by trailer (git standard lowercase)', () => {
  const r = runHook('feat: x\n\nCo-authored-by: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
});

test('rejects co-authored-by (full lowercase)', () => {
  const r = runHook('feat: x\n\nco-authored-by: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
});

test('rejects indented Co-Authored-By trailer', () => {
  const r = runHook('feat: x\n\n  Co-Authored-By: Claude <a@b>\n');
  assert.strictEqual(r.code, 1);
});

test('accepts plain commit message', () => {
  const r = runHook('feat: add new feature\n');
  assert.strictEqual(r.code, 0);
});

test('accepts other trailers (Reviewed-by)', () => {
  const r = runHook('feat: x\n\nReviewed-by: Vin\n');
  assert.strictEqual(r.code, 0);
});

test('accepts prose mentioning co-authored without trailer format', () => {
  const r = runHook('docs: explain co-authored convention in body text\n');
  assert.strictEqual(r.code, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/git-hook-co-authored-by.test.js`
Expected: FAIL — `ENOENT: no such file or directory` for HOOK path.

- [ ] **Step 3: Write the hook**

Create `scripts/git-hooks/commit-msg`:

```bash
#!/usr/bin/env bash
# OwnMind IR-024 enforcement: reject commits adding Co-Authored-By trailer.
# Bypass (not recommended): git commit --no-verify
set -e

MSG_FILE="$1"
if [ -z "$MSG_FILE" ] || [ ! -f "$MSG_FILE" ]; then
  exit 0
fi

if grep -qiE '^[[:space:]]*Co-Authored-By:' "$MSG_FILE"; then
  echo "❌ IR-024 violation: commit message contains 'Co-Authored-By' trailer." >&2
  echo "   Vin 的鐵律：git commit 不加 Co-Authored-By。" >&2
  echo "   如需強制覆蓋（不建議），用 git commit --no-verify。" >&2
  exit 1
fi

exit 0
```

Make executable:

```bash
chmod +x scripts/git-hooks/commit-msg
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/git-hook-co-authored-by.test.js`
Expected: 7 pass, 0 fail.

---

### Task 2: postinstall setup script（TDD）

**Files:**
- Create: `tests/setup-git-hooks.test.js`
- Create: `scripts/install-helpers/setup-git-hooks.js`

- [ ] **Step 1: Write the failing test**

Create `tests/setup-git-hooks.test.js`:

```javascript
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SETUP = path.join(__dirname, '..', 'scripts', 'install-helpers', 'setup-git-hooks.js');

function withTempRepo(initGit, fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-setup-'));
  try {
    if (initGit) execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    return fn(tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

test('sets core.hooksPath to scripts/git-hooks in a git repo', () => {
  withTempRepo(true, (cwd) => {
    execFileSync('node', [SETUP], { cwd, stdio: 'pipe' });
    const got = execFileSync('git', ['config', '--local', 'core.hooksPath'], { cwd })
      .toString().trim();
    assert.strictEqual(got, 'scripts/git-hooks');
  });
});

test('is idempotent (running twice = same result, exit 0)', () => {
  withTempRepo(true, (cwd) => {
    execFileSync('node', [SETUP], { cwd, stdio: 'pipe' });
    execFileSync('node', [SETUP], { cwd, stdio: 'pipe' });
    const got = execFileSync('git', ['config', '--local', 'core.hooksPath'], { cwd })
      .toString().trim();
    assert.strictEqual(got, 'scripts/git-hooks');
  });
});

test('exits 0 with warning when not in a git repo (no CI break)', () => {
  withTempRepo(false, (cwd) => {
    let result;
    try {
      result = execFileSync('node', [SETUP], { cwd, stdio: 'pipe' });
    } catch (e) {
      assert.fail(`should not throw outside git repo, got exit ${e.status}`);
    }
    assert.ok(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/setup-git-hooks.test.js`
Expected: FAIL — `ENOENT` for SETUP path.

- [ ] **Step 3: Write the setup script**

Create `scripts/install-helpers/setup-git-hooks.js`:

```javascript
#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'pipe' });
} catch {
  console.warn('[setup-git-hooks] not a git repo; skipping hook setup');
  process.exit(0);
}

try {
  execFileSync('git', ['config', '--local', 'core.hooksPath', 'scripts/git-hooks'], {
    stdio: 'pipe',
  });
  console.log('[setup-git-hooks] enabled scripts/git-hooks (IR-024 commit-msg guard active)');
} catch (e) {
  console.warn('[setup-git-hooks] failed to set core.hooksPath:', e?.message ?? e);
  process.exit(0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/setup-git-hooks.test.js`
Expected: 3 pass, 0 fail.

---

### Task 3: package.json postinstall + 版號

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Read current package.json**

Run: `grep -A1 '"version"\|"scripts"' package.json | head -20`

- [ ] **Step 2: Update version and add postinstall**

Edit `package.json`:
- `"version": "1.17.57"` → `"version": "1.17.58"`
- 在 `"scripts"` 區塊加：`"postinstall": "node scripts/install-helpers/setup-git-hooks.js"`

- [ ] **Step 3: Verify postinstall works in current repo**

Run: `node scripts/install-helpers/setup-git-hooks.js`
Expected: stdout `[setup-git-hooks] enabled scripts/git-hooks (IR-024 commit-msg guard active)`

Run: `git config --local core.hooksPath`
Expected: `scripts/git-hooks`

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: all tests pass (including new ones).

---

### Task 4: 端到端手動驗證（IR-020 部署後實測精神）

- [ ] **Step 1: 驗證 reject 行為**

```bash
git commit --allow-empty -m "$(printf 'test: hook reject\n\nCo-Authored-By: foo <foo@bar>')" 2>&1 | tee /tmp/commit-result.log
echo "exit: $?"
```

Expected: exit 1, stderr 含 `IR-024 violation`，commit 沒進 git log。

驗證 commit 真的沒進 log:
```bash
git log -1 --pretty=%B | grep -c "Co-Authored-By" || echo "no co-authored: clean"
```

- [ ] **Step 2: 驗證 accept 行為**

```bash
git commit --allow-empty -m "test: hook accept clean message"
git log -1 --pretty=%B
```

Expected: commit 成功，log 顯示 `test: hook accept clean message`。

- [ ] **Step 3: 清理測試 commit**

```bash
git reset --hard HEAD~1
```

Expected: 工作區回到 step 1 之前的狀態。

---

### Task 5: 文件同步（IR-008 / IR-032）

**Files:**
- Modify: `README.md`
- Modify: `docs/README.zh-TW.md`
- Modify: `docs/README.ja.md`
- Modify: `CHANGELOG.md`
- Modify: `FILELIST.md`

- [ ] **Step 1: 找到 README 版號位置**

Run: `grep -n "1.17.57" README.md docs/README.zh-TW.md docs/README.ja.md`
記下行號 → 三檔同步改成 `1.17.58`。

- [ ] **Step 2: 更新三語系 README**

每份 README 在版號附近的 changelog 摘要區（如果有的話）加一行：

- `README.md`（zh，主要繁中版）：「v1.17.58: 新增 commit-msg git hook，本地端強制阻擋 Co-Authored-By trailer（IR-024 邏輯卡控）」
- `docs/README.zh-TW.md`：同上
- `docs/README.ja.md`：「v1.17.58: commit-msg git hook を追加、Co-Authored-By トレーラーをローカルでブロック (IR-024 ロジック強制)」

如果三份 README 不是這個格式，**直接打開檔案看當前 1.17.57 的描述風格、照樣寫一則 1.17.58**。

- [ ] **Step 3: CHANGELOG.md**

Run: `head -30 CHANGELOG.md` 看格式 → 在最頂端 1.17.57 之前插入：

```markdown
## v1.17.58 (2026-05-07)

### Added
- **commit-msg git hook**：本地端強制阻擋 commit message 含 `Co-Authored-By` trailer。`scripts/git-hooks/commit-msg` + postinstall 自動啟用 `core.hooksPath`。把 IR-024 從 dashboard 軟提醒升級為邏輯卡控（呼應 IR-027 「邏輯才有效」）。
- `scripts/install-helpers/setup-git-hooks.js`：postinstall 觸發，idempotent，git repo 外/失敗皆不中斷 npm install。

### Tests
- `tests/git-hook-co-authored-by.test.js`：7 case 涵蓋大小寫變體、縮排、誤殺防護。
- `tests/setup-git-hooks.test.js`：3 case 涵蓋正常 / idempotent / 非 git 環境。
```

- [ ] **Step 4: FILELIST.md**

Run: `head -30 FILELIST.md` 看格式 → 加新檔案登記：

```
scripts/git-hooks/commit-msg                    — IR-024 強卡 hook
scripts/install-helpers/setup-git-hooks.js      — postinstall 啟用 hooksPath
tests/git-hook-co-authored-by.test.js           — hook 偵測邏輯測試
tests/setup-git-hooks.test.js                   — setup script 測試
docs/superpowers/specs/2026-05-07-git-hook-co-authored-by-design.md
docs/superpowers/plans/2026-05-07-git-hook-co-authored-by.md
```

依 FILELIST.md 既有結構（按目錄分區）插到對應位置。

- [ ] **Step 5: 三語系一致性檢查**

Run: `grep "1.17.58" README.md docs/README.zh-TW.md docs/README.ja.md package.json CHANGELOG.md`
Expected: 5 個檔案都各有一筆。

---

### Task 6: 品管三步驟 + commit + PR

- [ ] **Step 1: verification-before-completion**

呼叫 superpowers:verification-before-completion skill。
跑一次完整測試：

```bash
npm test 2>&1 | tail -20
```

Expected: pass count 增加（原本 baseline + 10 新 case）。

- [ ] **Step 2: requesting-code-review**

呼叫 superpowers:requesting-code-review skill 對 working tree 做 review。
若有發現再修，無發現繼續。

- [ ] **Step 3: receiving-code-review**

若 step 2 有 review 回饋，呼叫 superpowers:receiving-code-review 嚴謹處理。

- [ ] **Step 4: 一個 commit + PR（IR-024 自我驗證）**

```bash
git status
git add scripts/git-hooks/commit-msg \
        scripts/install-helpers/setup-git-hooks.js \
        tests/git-hook-co-authored-by.test.js \
        tests/setup-git-hooks.test.js \
        package.json \
        README.md docs/README.zh-TW.md docs/README.ja.md \
        CHANGELOG.md FILELIST.md \
        docs/superpowers/specs/2026-05-07-git-hook-co-authored-by-design.md \
        docs/superpowers/plans/2026-05-07-git-hook-co-authored-by.md
git commit -m "$(cat <<'EOF'
feat(git-hook): IR-024 邏輯卡控 — commit-msg hook 阻擋 Co-Authored-By (v1.17.58)

把 IR-024 從 dashboard 軟提醒升級為 git commit-msg hook 強卡。
postinstall 自動設 core.hooksPath，dev 跑 npm install 即啟用。
case-insensitive trailer 偵測 + 誤殺防護（必須行首 + 冒號）。
EOF
)"
```

**注意**：這個 commit message **不能**含 `Co-Authored-By`（自我驗證 hook 生效）。

- [ ] **Step 5: 推到遠端 + 開 PR**

```bash
git push -u origin vin/busy-bose-a7cfa3
gh pr create --title "feat(git-hook): IR-024 邏輯卡控 — commit-msg hook 阻擋 Co-Authored-By (v1.17.58)" --body "$(cat <<'EOF'
## Summary
- 新增 `scripts/git-hooks/commit-msg`，本地端阻擋 Co-Authored-By trailer
- `setup-git-hooks.js` postinstall 自動啟用 `core.hooksPath`
- 把 IR-024 從軟提醒升級為邏輯卡控（呼應 IR-027 「邏輯才有效」）

## Test plan
- [ ] `npm test` 全綠（含 10 個新 case）
- [ ] 本機驗證 commit 含 Co-Authored-By → 被 reject
- [ ] 本機驗證 clean commit → 通過
- [ ] PR 自身的 commit message 不含 Co-Authored-By（自我驗證）

Spec: docs/superpowers/specs/2026-05-07-git-hook-co-authored-by-design.md
Plan: docs/superpowers/plans/2026-05-07-git-hook-co-authored-by.md
Backlog source: project_310 第 1 項
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Hook script + 偵測邏輯 → Task 1 ✓
- 啟用機制（postinstall）→ Task 2 + 3 ✓
- 7 個測試 case → Task 1 step 1 全列 ✓
- README / CHANGELOG / FILELIST / package.json → Task 3 + 5 ✓
- 三語系同步（IR-032）→ Task 5 step 2 ✓
- 版號同步（IR-031）→ Task 3 + 5 step 5 ✓
- 品管三步驟（IR-012）→ Task 6 step 1-3 ✓
- 端到端驗證（IR-020 精神）→ Task 4 ✓

**2. Placeholder scan:** 全部 step 都有 exact code / exact 檔案路徑 / expected output。Task 5 step 2 的「如果 README 不是這個格式 → 看當前 1.17.57 描述風格照樣寫」是 fallback 指令、不是 placeholder（避免 plan 寫死目前未確認的 README 格式）。

**3. Type consistency:** `core.hooksPath = scripts/git-hooks` 在 setup script、test、Task 4 驗證、CHANGELOG 一致；hook 路徑 `scripts/git-hooks/commit-msg` 在 spec / test / Task 4 一致。
