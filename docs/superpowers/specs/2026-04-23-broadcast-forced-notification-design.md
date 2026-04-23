# Design: Broadcast 強制通知邏輯補強

**Date:** 2026-04-23
**Status:** Approved

---

## 問題

OwnMind 廣播通知系統技術交付鏈完整（DB → filter → SessionStart hook → system-reminder），但缺乏強制 AI 回應的機制。廣播對 AI 而言是被動資訊，AI 可以看到卻不主動提示使用者，導致重要通知（版本更新、安全警告）被靜默略過。

根源：`configs/CLAUDE.md` 沒有廣播處理規則，`render-session-context.js` 不區分廣播等級。

---

## 目標

- WARNING/ERROR 等級或 upgrade_reminder 類型的廣播，AI 必須在第一句回應中主動告知使用者
- INFO 等級廣播維持被動顯示（不強制）
- 雙重保障：程式邏輯 + 規則文件同時到位，符合 IR-027

---

## 設計

### 變更一：`hooks/lib/render-session-context.js`

**邏輯：** 在廣播渲染完成後，判斷列表中是否有強制廣播。若有，附加一段強制 instruction block。

**強制廣播判斷條件（任一成立）：**
- `bc.severity` 為 `'warning'` 或 `'error'`（不區分大小寫）
- `bc.type` 為 `'upgrade_reminder'`

**插入位置：** 廣播區塊最末行，緊接在最後一則廣播之後。

**插入內容：**
```
> **[SYSTEM] 強制行動要求：** 上方通知為強制等級（WARNING/ERROR 或版本更新）。你必須在本次回應的第一句主動告知使用者通知內容與可執行動作（升級 / 已收到 / 暫緩），不可略過、不可等使用者詢問。
```

**INFO 廣播：** 不插入任何 instruction block，行為不變。

---

### 變更二：`configs/CLAUDE.md`

新增廣播處理規則區塊，讓 AI 明確知道規範：

```markdown
## 廣播通知處理規則

當 context 中出現 `📢 OwnMind 系統通知` 時：

- **INFO 等級**：被動資訊，不強制主動提示
- **WARNING / ERROR 等級** 或 **版本更新通知（upgrade_reminder）**：強制等級，必須在第一句回應中主動告知使用者通知內容與可執行動作（升級 / 已收到 / 暫緩）

強制廣播出現時 context 中會有 `[SYSTEM] 強制行動要求` 標記，這是系統觸發的強制指令，不可忽略。
```

---

## 不在範圍內

- MCP post-tool-call injection（`mcp/index.js` renderBroadcasts）暫不修改，邏輯相同可後續跟進
- 廣播 snooze / dismiss 流程不變
- 廣播 DB schema 不變

---

## 測試驗證方式

1. 在 DB 新增一筆 severity=warning 的測試廣播
2. 重啟 Claude Code session
3. 確認第一句回應主動提到廣播內容
4. 確認 INFO 廣播不觸發強制提示
