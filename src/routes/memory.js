import { Router } from 'express';
import { query } from '../utils/db.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';

const router = Router();
router.use(auth);

// ===== Instructions SOP =====
const INSTRUCTIONS_SOP = `# OwnMind 操作手冊 - AI 專用

## 提示規則（最重要）

每次 OwnMind 有任何操作，**必須**顯示醒目的 🧠 品牌提示，讓使用者知道 OwnMind 在工作。
密鑰操作用 🔐。以下是各操作的提示格式：

**載入記憶時：**
🧠 OwnMind 已載入你的個人記憶：
   - 個人偏好：[摘要]
   - 鐵律：X 條啟用中
   - 專案：X 個專案 context
   - 待接手交接：有/無

**讀取特定記憶時：**
🧠 OwnMind 已調閱「XXX」記憶

**搜尋記憶時：**
🧠 OwnMind 搜尋「XXX」→ 找到 X 筆相關記憶

**儲存記憶時：**
🧠 OwnMind 已儲存 [類型]：[標題]

**更新記憶時：**
🧠 OwnMind 已更新「XXX」

**停用記憶時：**
🧠 OwnMind 已停用 [編號]（原因：XXX）

**建立交接時：**
🧠 OwnMind 交接已建立 → 目標：XXX
   - 狀態：...
   - 待完成：...
   - 注意：...

**接手交接時：**
🧠 OwnMind 交接接手 ← 來源：XXX
   - 狀態：...
   - 待完成：...
   確認接手嗎？

**彙整建議時：**
🧠 OwnMind 彙整建議（本次 session 有以下值得記錄的事項）：
   1. [類型] 標題 — 簡述
   2. [類型] 標題 — 簡述
   要記錄哪些？

**密鑰存取時：**
🔐 OwnMind 正在取得密鑰「XXX」...

## 何時該儲存記憶

遇到以下情境時，**必須立即儲存**：
1. 完成一個完整功能（feature complete）
2. 修復一個 bug（含根因分析）
3. 做出重要決策（架構、技術選型、取捨）
4. 發現或建立鐵律（iron rule）
5. 學到新的踩坑經驗
6. 使用者明確要求「記起來」「學起來」

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
         AND type IN ('profile', 'principle')
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
    const activeHandoff = handoffResult.rows[0] || null;

    res.json({
      instructions: INSTRUCTIONS_SOP,
      profile,
      principles,
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
    const { title, content, tags, metadata } = req.body;

    // 先確認記憶存在且屬於該使用者
    const existing = await query(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

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

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'update', $3, $4)`,
      [memory.id, metadata?.tool || 'api', memory.content, memory.metadata]
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

    // 取得歷史版本的內容
    const historyResult = await query(
      `SELECT * FROM memory_history
       WHERE id = $1 AND memory_id = $2 AND user_id = $3`,
      [history_id, req.params.id, req.user.id]
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
    const result = await query(
      `SELECT * FROM memory_history
       WHERE memory_id = $1 AND user_id = $2
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
