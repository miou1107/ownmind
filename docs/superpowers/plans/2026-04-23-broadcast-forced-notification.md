# Broadcast 強制通知邏輯補強 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 當 WARNING/ERROR 等級或 upgrade_reminder 類型廣播出現時，強制 AI 在第一句回應中主動告知使用者。

**Architecture:** 雙重保障 — `render-session-context.js` 動態注入強制 instruction block（程式邏輯），`configs/CLAUDE.md` 定義處理規則（AI 規範）。

**Tech Stack:** Node.js (ESM), node:test, 純字串操作，無新依賴。

---

### Task 1：新增失敗測試（強制廣播 instruction block）

**Files:**
- Modify: `tests/session-start-render.test.js`

- [ ] **Step 1：在現有 `describe('renderSessionContext — 廣播')` 區塊末尾加三個測試**

```js
// 在 tests/session-start-render.test.js 末行之前（第 99 行後）
// 加入以下三個 it() 到 describe('renderSessionContext — 廣播') 區塊內

  it('warning 等級廣播附加 SYSTEM 強制指令 block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '安全更新', body: '請盡快升級', severity: 'warning'
    }]);
    assert.match(out, /\[SYSTEM\] 強制行動要求/);
  });

  it('upgrade_reminder 類型廣播附加 SYSTEM 強制指令 block', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: 'OwnMind 有新版本', body: '請升級', severity: 'info', type: 'upgrade_reminder'
    }]);
    assert.match(out, /\[SYSTEM\] 強制行動要求/);
  });

  it('info 等級且非 upgrade_reminder 不附加強制指令', () => {
    const out = renderSessionContext({ server_version: '1.17.0' }, [{
      title: '一般公告', body: '系統維護', severity: 'info', type: 'announcement'
    }]);
    assert.doesNotMatch(out, /\[SYSTEM\] 強制行動要求/);
  });
```

- [ ] **Step 2：執行測試，確認三個新測試都失敗**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
node --test tests/session-start-render.test.js 2>&1 | grep -E "(FAIL|PASS|warning|upgrade|info)"
```

預期：三個新 case 顯示 `FAIL`，舊有 case 全部 `PASS`。

---

### Task 2：實作強制 instruction block（render-session-context.js）

**Files:**
- Modify: `hooks/lib/render-session-context.js`

- [ ] **Step 1：在廣播渲染區塊結尾（第 41 行後）新增強制廣播判斷**

在 `hooks/lib/render-session-context.js` 第 41 行（`}` 結束 `if (bcList.length > 0)` 之前），將廣播區塊改為：

```js
  // --- 新增：強制廣播判斷（在 bcList.length > 3 判斷之後，} 結束之前）---
  const renderedBcs = bcList.slice(0, 3);
  const hasForced = renderedBcs.some(bc =>
    ['warning', 'error'].includes(String(bc.severity || '').toLowerCase()) ||
    bc.type === 'upgrade_reminder'
  );
  if (hasForced) {
    lines.push('> **[SYSTEM] 強制行動要求：** 上方通知為強制等級（WARNING/ERROR 或版本更新）。你必須在本次回應的第一句主動告知使用者通知內容與可執行動作（升級 / 已收到 / 暫緩），不可略過、不可等使用者詢問。');
    lines.push('');
  }
```

完整修改後的廣播區塊（第 20–42 行）如下：

```js
  const bcList = Array.isArray(broadcasts) ? broadcasts : [];
  if (bcList.length > 0) {
    lines.push('## 📢 OwnMind 系統通知');
    for (const bc of bcList.slice(0, 3)) {
      const sev = String(bc.severity || 'info').toUpperCase();
      lines.push('> **[' + sev + '] ' + String(bc.title || '').replace(/\n/g, ' ') + '**');
      lines.push('> ' + String(bc.body || '').split('\n').slice(0, 5).join(' ').slice(0, 400));
      if (bc.cta_text) {
        const upgradeHint = bc.cta_action === 'upgrade_ownmind' ? '讓 AI 幫你升級' : '';
        lines.push('> 👉 可說「' + bc.cta_text + '」' + upgradeHint);
      }
      if (bc.allow_snooze) {
        const h = Number.isFinite(Number(bc.snooze_hours)) ? Number(bc.snooze_hours) : 24;
        lines.push('> （不想現在處理？可說「暫緩升級」延後 ' + h + ' 小時）');
      }
      lines.push('');
    }
    if (bcList.length > 3) {
      lines.push('（另有 ' + (bcList.length - 3) + ' 則廣播未顯示）');
      lines.push('');
    }
    const hasForced = bcList.slice(0, 3).some(bc =>
      ['warning', 'error'].includes(String(bc.severity || '').toLowerCase()) ||
      bc.type === 'upgrade_reminder'
    );
    if (hasForced) {
      lines.push('> **[SYSTEM] 強制行動要求：** 上方通知為強制等級（WARNING/ERROR 或版本更新）。你必須在本次回應的第一句主動告知使用者通知內容與可執行動作（升級 / 已收到 / 暫緩），不可略過、不可等使用者詢問。');
      lines.push('');
    }
  }
```

- [ ] **Step 2：執行測試，確認全部通過**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
node --test tests/session-start-render.test.js 2>&1 | tail -20
```

預期：所有 case 顯示 `PASS`，exit code 0。

- [ ] **Step 3：Commit**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
git add hooks/lib/render-session-context.js tests/session-start-render.test.js
git commit -m "feat: inject SYSTEM forced-action block for WARNING/ERROR/upgrade broadcasts"
```

---

### Task 3：更新 configs/CLAUDE.md

**Files:**
- Modify: `configs/CLAUDE.md`

- [ ] **Step 1：在 CLAUDE.md 末尾新增廣播處理規則區塊**

```markdown

## 廣播通知處理規則

當 context 中出現 `📢 OwnMind 系統通知` 時：

- **INFO 等級**：被動資訊，不強制主動提示
- **WARNING / ERROR 等級** 或 **版本更新通知（upgrade_reminder）**：強制等級，必須在第一句回應中主動告知使用者通知內容與可執行動作（升級 / 已收到 / 暫緩）

強制廣播出現時 context 中會有 `[SYSTEM] 強制行動要求` 標記，這是系統觸發的強制指令，不可忽略。
```

- [ ] **Step 2：Commit**

```bash
cd /Users/vincentkao/SourceCode/OwnMind
git add configs/CLAUDE.md
git commit -m "docs: add broadcast forced-notification handling rules to CLAUDE.md"
```
