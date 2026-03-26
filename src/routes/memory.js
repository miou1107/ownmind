import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(auth);

// ===== Instructions SOP =====
const INSTRUCTIONS_SOP = `# OwnMind 操作手冊 - AI 專用

## 提示規則（最重要）

每次 OwnMind 有任何操作，**必須**顯示醒目的【OwnMind】品牌標記，讓使用者知道 OwnMind 在工作。

**每次觸發時，在提示最後加上一行隨機小技巧：**
格式：\`【OwnMind 技巧】[隨機挑一條]\`

技巧庫（每次隨機挑一條，不要重複連續出現）：
- 你說「記起來」，我就會把重要經驗寫進記憶，跨平台永久保存
- 你說「新增鐵律」，我會記錄完整的踩坑背景，確保同樣的錯不再犯
- 你說「交接給 Codex」，我會整理好工作進度，讓另一個工具無縫接手
- 你說「我有哪些記憶」，我會列出你所有的偏好、鐵律和專案 context
- 你說「整理記憶」，我會回顧這次對話，找出值得保存的經驗
- 你可以問「你學到什麼」「今天有什麼新知識」，讓 AI 回顧並記下學習成果
- 不管你用 Claude、Cursor 還是 Codex，OwnMind 讓你的 AI 都共享同一份記憶
- 鐵律不會被刪除，只會被停用並記錄原因，方便日後回顧
- 每條鐵律都記錄了踩坑的背景，讓你（和 AI）知道為什麼有這條規則
- 你可以問「最近做了什麼」，我會從工作紀錄中幫你回顧
- OwnMind 會在你工作超過 2 小時或 context 超過 50% 時，主動提醒你整理記憶
- 交接時雙方都會看到摘要，確保沒有資訊遺漏
- 你的記憶可以隨時匯出成 markdown，資料永遠屬於你
- 你說「不要遵守這條」，我會先問你原因，然後停用但不刪除，留下完整紀錄
- 你可以搜尋記憶，例如「跟部署有關的鐵律」，我會用語意搜尋幫你找
- OwnMind 會自動記錄你使用的機器、工具和 AI 模型，方便追溯
- 換一台電腦？只要安裝 OwnMind，所有記憶立刻同步，不用重新教 AI
- 你可以問「ring 專案還有什麼沒做」，我會從專案記憶中回答
- 鐵律有編號（IR-001），方便你直接引用：「參考 IR-003」
- 每次交接都會記錄來源工具和模型，你可以追溯是哪個 AI 做的決策
- 你可以隨時問「這條鐵律是怎麼來的」，我會告訴你當初踩坑的完整背景
- OwnMind 支援密鑰管理，你的 API key 和密碼可以安全儲存，需要時才取用
- 你可以說「更新 ring 的進度」，我會幫你更新專案狀態和待辦事項
- 即使在線上 AI（claude.ai、ChatGPT）也能匯出記憶來使用
- 記憶分短期和長期：session log 會自動壓縮，鐵律和決策永久保留
- 你可以問「哪些鐵律被停用了」，回顧過去的決策變更
- OwnMind 會持續進化 — AI 會主動建議改進你的工作流程和規則
- 你說「這個專案做完了」，我會把它歸檔到作品集，記錄技術選型和心得

以下是各操作的提示格式：

**載入記憶時：**
【OwnMind】已載入你的個人記憶：
   - 個人偏好：[摘要]
   - 鐵律：X 條啟用中 ↓
     [iron_rules_digest 每條一行]
   - 待接手交接：有/無

載入完成後，**必須立即將所有鐵律內化為工作準則**，在整個 session 中主動防護。
每條鐵律如有 [觸發: xxx] 標記，代表執行該類操作前必須主動 re-check 並遵守。

**Context 提醒：** 當對話超過 20 輪，或感覺 context 已消耗大量時，主動呼叫 ownmind_get('iron_rule') 刷新鐵律記憶，並顯示：
【OwnMind】重新確認鐵律，防護持續中。

**讀取特定記憶時：**
【OwnMind】已調閱「XXX」記憶

**搜尋記憶時：**
【OwnMind】搜尋「XXX」→ 找到 X 筆相關記憶

**儲存記憶時：**
【OwnMind】已儲存 [類型]：[標題]

**更新記憶時：**
【OwnMind】已更新「XXX」
   舊版：[舊內容摘要]
   新版：[新內容摘要]
   原因：[update_reason]

**停用記憶時：**
【OwnMind】已停用 [編號]（原因：XXX）

**建立交接時：**
【OwnMind】交接已建立 → 目標：XXX
   - 狀態：...
   - 待完成：...
   - 注意：...

**接手交接時：**
【OwnMind】交接接手 ← 來源：XXX
   - 狀態：...
   - 待完成：...
   確認接手嗎？

**彙整建議時：**
【OwnMind】彙整建議（本次 session 有以下值得記錄的事項）：
   1. [類型] 標題 — 簡述
   2. [類型] 標題 — 簡述
   要記錄哪些？

**密鑰存取時：**
【OwnMind】正在取得密鑰「XXX」...

## 鐵律主動防護

工作過程中，如果發現當前操作可能違反已知的鐵律，**必須立即顯示提醒**：

格式：\`【OwnMind 觸發】你提醒過「[鐵律標題]」，我要遵守，不能再犯\`

例如：
- 準備用多次 SSH 連線時 →【OwnMind 觸發】你提醒過「SSH 不要頻繁登入登出」，我要遵守，不能再犯
- 準備直接改 code 不跑測試時 →【OwnMind 觸發】你提醒過「不要 blind edit」，我要遵守，不能再犯
- 準備猜測需求不問使用者時 →【OwnMind 觸發】你提醒過「使用 OpenSpec 開發流程」，需求不明確時必須先訪談

這是 OwnMind 最核心的價值 — 讓使用者踩過的坑不會再踩。AI 要在**即將違反鐵律的那一刻**主動攔截自己，而不是事後才發現。

## 何時該儲存記憶

遇到以下情境時，**必須立即儲存**：
1. 完成一個完整功能（feature complete）
2. 修復一個 bug（含根因分析）
3. 做出重要決策（架構、技術選型、取捨）
4. 發現或建立鐵律（iron rule）
5. 學到新的踩坑經驗
6. 使用者明確要求「記起來」「學起來」

## 「今天學到什麼」機制

當使用者問「你今天學到什麼」「這次學到什麼」「有什麼新發現」時，AI 要回顧整個對話，列出所有**還沒寫進 OwnMind 的**新知識和發現：

格式：
【OwnMind 學習回顧】本次 session 學到以下新東西：
   1. [鐵律] 標題 — 簡述原因
   2. [技術標準] 標題 — 簡述
   3. [專案] 標題 — 新發現或進展
   4. [個人偏好] 標題 — 觀察到的使用者偏好
   ...
   以上哪些要記下來？（輸入編號、「全部」、或「跳過」）

AI 要主動分類每個發現屬於什麼記憶類型，使用者確認後才寫入。
注意：只列出**還沒寫進 OwnMind 的**，已經記過的不要重複列。

## 自動更新檢查

每次 ownmind_init 載入記憶時，順便檢查 ~/.ownmind/ 是否為最新版本：
1. 執行 \`cd ~/.ownmind && git fetch 2>&1\` 檢查遠端
2. 執行 \`git log HEAD..origin/main --oneline\` 看有哪些新 commit
3. 如果有更新，執行 \`cd ~/.ownmind && git pull && cd mcp && npm install\`
4. 如果 skill 檔案有變更，同步更新到本地 skill 目錄
5. 顯示更新內容，格式如下：

【OwnMind 更新】偵測到新版本，已自動更新：
   - 新增鐵律主動防護功能
   - 小技巧庫擴充到 28 條
   - 修正交接摘要格式
  （根據 git log 的 commit message 摘要，用使用者看得懂的語言，不要列 commit hash）

如果沒有更新，不需要顯示任何訊息。

## 主動彙整觸發條件

以下情境觸發時，應主動整理並提出彙整建議（列出候選項讓使用者確認）：
1. 完成一個完整功能
2. 踩坑並解決了
3. 做出重要決策
4. 工作超過 2 小時沒彙整
5. Context 使用超過 50%
6. 使用者要開新對話或清空對話前

## 記憶類型與使用時機

| 類型 | 用途 | 範例 |
|------|------|------|
| profile | 使用者個人資料與偏好 | 身份、溝通偏好、工作風格 |
| principle | 核心原則與願景 | 持續進化、跨平台一致、自動化優先 |
| iron_rule | 鐵律（踩坑後訂下的不可違反規則）| SSH 不頻繁登入、commit 前跑測試 |
| coding_standard | 技術偏好與編碼標準 | coding style、工具鏈、開發流程 |
| project | 專案狀態與上下文 | 架構、環境、進度、待辦、更新紀錄 |
| portfolio | 作品集 | 做過的專案、技術選型、心得 |
| env | 開發環境資訊 | 機器、路徑、帳號、SSH config |

## 鐵律格式（Iron Rule）

每條鐵律必須包含完整的背景脈絡：
- **code**: 唯一識別碼（如 IR-001），新增時先查現有最大編號 +1
- **建立時間**: YYYY-MM-DD HH:mm
- **環境**: 機器 / 工具 / 模型
- **背景**: 為什麼會有這條規則（踩過什麼坑、發生什麼事）
- **規則**: 規則內容（明確、可執行）
- **適用範圍**: 全域 / 特定專案 / 特定語言

## Metadata 格式

每次寫入操作都應在 metadata 記錄：
- **machine**: 執行的機器名稱
- **tool**: 使用的工具（如 claude-code, cursor, codex）
- **model**: AI 模型（如 claude-opus-4-6, gpt-4o）
- **timestamp**: ISO 8601 格式時間戳

## 交接流程（Handoff）

**交接出去（發起方）：**
1. 建立 handoff，內容包含：狀態、待完成、注意事項、關鍵檔案
2. 顯示 🧠 交接摘要給使用者確認

**交接回來（接收方）：**
1. init 時發現 pending handoff → 顯示 🧠 交接摘要
2. 問使用者「確認接手嗎？」
3. 確認後 accept

## 停用規則流程

當使用者說「不要遵守這條鐵律」時：
1. **先問為什麼**：「這條鐵律是因為 [背景] 訂的，確定要停用嗎？還是調整適用範圍？」
2. **不要刪除**：將 status 改為 disabled
3. **記錄原因**：在停用原因中說明
4. 停用後仍可隨時重新啟用

## 持續進化

- 主動改進工作流程（發現更好的做法就更新記憶）
- 定期更新 iron rules（新的踩坑就加新規則）
- 清理過時記憶（標記 disabled，不要直接刪除）
- 本地 memory 可與 OwnMind 並存，發生衝突時以 OwnMind 為準`;

/**
 * GET /init - 載入初始記憶
 */
router.get('/init', async (req, res) => {
  try {
    const memoriesResult = await query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND type IN ('profile', 'principle', 'iron_rule')
         AND status = 'active'
       ORDER BY type, created_at`,
      [req.user.id]
    );

    const handoffResult = await query(
      `SELECT * FROM handoffs
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.user.id]
    );

    const memories = memoriesResult.rows;
    const profile = memories.find(m => m.type === 'profile') || null;
    const principles = memories.filter(m => m.type === 'principle');
    const ironRules = memories.filter(m => m.type === 'iron_rule');
    const activeHandoff = handoffResult.rows[0] || null;

    // 精簡摘要：每條鐵律一行，供 AI 快速內化
    const ironRulesDigest = ironRules.map(r => {
      const code = r.code || 'IR-?';
      const triggers = (r.tags || []).filter(t => t.startsWith('trigger:')).map(t => t.replace('trigger:', '')).join('/');
      return `${code}: ${r.title}${triggers ? ` [觸發: ${triggers}]` : ''}`;
    }).join('\n');

    res.json({
      instructions: INSTRUCTIONS_SOP,
      profile,
      principles,
      iron_rules: ironRules,
      iron_rules_digest: ironRulesDigest,
      active_handoff: activeHandoff
    });
  } catch (err) {
    logger.error('載入初始記憶失敗', { error: err.message });
    res.status(500).json({ error: '載入初始記憶失敗' });
  }
});

/**
 * GET /type/:type - 依類型取得記憶
 */
router.get('/type/:type', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM memories
       WHERE type = $1 AND user_id = $2 AND status = 'active'
       ORDER BY updated_at DESC`,
      [req.params.type, req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('依類型查詢記憶失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * GET /project/:name - 取得單一專案
 */
router.get('/project/:name', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM memories
       WHERE type = 'project'
         AND title ILIKE $1
         AND user_id = $2
         AND status = 'active'
       LIMIT 1`,
      [req.params.name, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該專案' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('查詢專案失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * GET /search?q= - 全文搜尋記憶
 */
router.get('/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) {
      return res.status(400).json({ error: '請提供搜尋關鍵字 q' });
    }

    const pattern = `%${q}%`;
    const result = await query(
      `SELECT * FROM memories
       WHERE user_id = $1
         AND status = 'active'
         AND (content ILIKE $2 OR title ILIKE $2)
       ORDER BY updated_at DESC`,
      [req.user.id, pattern]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('搜尋記憶失敗', { error: err.message });
    res.status(500).json({ error: '搜尋失敗' });
  }
});

/**
 * GET /:id - 取得單一記憶
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('查詢記憶失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * POST / - 建立記憶
 */
router.post('/', async (req, res) => {
  try {
    const { type, title, content, code, tags, metadata } = req.body;

    if (!type || !title || !content) {
      return res.status(400).json({ error: '必填欄位：type, title, content' });
    }

    const result = await query(
      `INSERT INTO memories (user_id, type, title, content, code, tags, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, type, title, content, code || null, tags || null, metadata || null]
    );

    const memory = result.rows[0];

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'create', $3, $4)`,
      [memory.id, metadata?.tool || 'api', content, metadata || null]
    );

    res.status(201).json(memory);
  } catch (err) {
    logger.error('建立記憶失敗', { error: err.message });
    res.status(500).json({ error: '建立記憶失敗' });
  }
});

/**
 * PUT /:id - 更新記憶
 */
router.put('/:id', async (req, res) => {
  try {
    const { title, content, tags, metadata, update_reason } = req.body;

    // 先確認記憶存在且屬於該使用者，並取得舊內容
    const existing = await query(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

    const oldMemory = existing.rows[0];

    const result = await query(
      `UPDATE memories
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           tags = COALESCE($3, tags),
           metadata = COALESCE($4, metadata),
           updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [title || null, content || null, tags || null, metadata || null, req.params.id, req.user.id]
    );

    const memory = result.rows[0];

    // 存舊內容到歷史，並記錄更新原因
    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'update', $3, $4)`,
      [
        memory.id,
        metadata?.tool || oldMemory.metadata?.tool || 'api',
        oldMemory.content,
        JSON.stringify({ ...oldMemory.metadata, update_reason: update_reason || null })
      ]
    );

    res.json(memory);
  } catch (err) {
    logger.error('更新記憶失敗', { error: err.message });
    res.status(500).json({ error: '更新記憶失敗' });
  }
});

/**
 * PUT /:id/disable - 停用記憶
 */
router.put('/:id/disable', async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: '必須提供停用原因' });
    }

    const result = await query(
      `UPDATE memories
       SET status = 'disabled',
           disabled_reason = $1,
           disabled_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [reason, req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'disable', $3, $4)`,
      [req.params.id, 'api', result.rows[0].content, JSON.stringify({ reason })]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('停用記憶失敗', { error: err.message });
    res.status(500).json({ error: '停用記憶失敗' });
  }
});

/**
 * PUT /:id/enable - 重新啟用記憶
 */
router.put('/:id/enable', async (req, res) => {
  try {
    const result = await query(
      `UPDATE memories
       SET status = 'active',
           disabled_reason = NULL,
           disabled_at = NULL,
           updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'enable', $3, NULL)`,
      [req.params.id, 'api', result.rows[0].content]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('啟用記憶失敗', { error: err.message });
    res.status(500).json({ error: '啟用記憶失敗' });
  }
});

/**
 * PUT /:id/revert - 還原到歷史版本
 */
router.put('/:id/revert', async (req, res) => {
  try {
    const { history_id } = req.body;

    if (!history_id) {
      return res.status(400).json({ error: '必須提供 history_id' });
    }

    // 先確認記憶屬於該使用者，再取得歷史版本
    const memCheck = await query(
      'SELECT id FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memCheck.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

    const historyResult = await query(
      `SELECT * FROM memory_history WHERE id = $1 AND memory_id = $2`,
      [history_id, req.params.id]
    );

    if (historyResult.rows.length === 0) {
      return res.status(404).json({ error: '找不到該歷史版本' });
    }

    const historyContent = historyResult.rows[0].content;

    // 更新記憶內容
    const result = await query(
      `UPDATE memories
       SET content = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING *`,
      [historyContent, req.params.id, req.user.id]
    );

    // 記錄還原操作
    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'revert', $3, $4)`,
      [req.params.id, 'api', historyContent, JSON.stringify({ reverted_from: history_id })]
    );

    res.json(result.rows[0]);
  } catch (err) {
    logger.error('還原記憶失敗', { error: err.message });
    res.status(500).json({ error: '還原記憶失敗' });
  }
});

/**
 * GET /:id/history - 取得記憶歷史
 */
router.get('/:id/history', async (req, res) => {
  try {
    // 先確認記憶屬於該使用者
    const memCheck = await query(
      'SELECT id FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );
    if (memCheck.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

    const result = await query(
      `SELECT * FROM memory_history
       WHERE memory_id = $1
       ORDER BY created_at DESC`,
      [req.params.id, req.user.id]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('查詢記憶歷史失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

export default router;
