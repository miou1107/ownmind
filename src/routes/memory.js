import { Router } from 'express';
import { query } from '../utils/db.js';
import { generateSyncToken, validateSyncToken } from '../utils/syncToken.js';
import auth from '../middleware/auth.js';
import logger from '../utils/logger.js';
import { ALLOWED_MEMORY_TYPES } from '../constants.js';
import { isAtLeast } from '../middleware/adminAuth.js';
import { compressOldSessions } from './session.js';
import { computePeriodRange, groupFrictions } from '../utils/report.js';
import { computeEnforcementAlerts } from '../utils/enforcement.js';
import { lintIronRule } from '../utils/iron-rule-quality.js';
import { matchTemplate, RULE_TEMPLATES } from '../utils/templates.js';
import { generateNextIronRuleCode } from '../utils/auto-numbering.js';
import { buildOnboarding } from '../utils/onboarding.js';
import { parseSyncTypes, parseSince, buildSyncQuery } from '../lib/memory-sync.js';
import { validateTierRequest, applyTierDefault } from '../utils/iron-rule-tier-validator.js';
import { buildIronRulesDigest, countByTier } from '../utils/iron-rule-digest.js';
import { validateMemoryContent } from '../utils/memory-secret-guard.js';
import { createRequire } from 'module';

const SERVER_VERSION = (() => {
  try {
    const require = createRequire(import.meta.url);
    return require('../../package.json').version || '0.0.0';
  } catch { return '0.0.0'; }
})();

function parseSemver(v) {
  const parts = (v || '0.0.0').split('.').map(s => parseInt(s, 10));
  return parts.length >= 3 && parts.every(n => !isNaN(n)) ? parts : [0, 0, 0];
}

const UPDATE_PROMPT = '你的 OwnMind MCP client 版本過舊，請更新：在終端機執行 cd ~/.ownmind && git pull && cd mcp && npm install，或貼上這段 prompt 給 AI：「幫我更新 OwnMind：cd ~/.ownmind && git pull && cd mcp && npm install」';

/**
 * Sync token 驗證
 * - 有 token 且 valid → 通過
 * - 有 token 但 stale → 409 要求 re-init
 * - 沒 token → 409 要求先呼叫 init（不再 graceful fallback）
 * 回傳: { ok: boolean, errorResponse?: object }
 */
async function checkSyncToken(userId, syncToken) {
  if (!syncToken) {
    logger.warn('寫入操作未帶 sync_token，拒絕（請先呼叫 ownmind_init）', { userId });
    return {
      ok: false,
      errorResponse: {
        error: '請先呼叫 ownmind_init 取得 sync_token 後再進行寫入操作',
        require_init: true,
      }
    };
  }
  const check = await validateSyncToken(userId, syncToken);
  if (!check.valid) {
    return {
      ok: false,
      errorResponse: {
        error: '狀態已變更，請先 re-init 取得最新記憶',
        stale: true,
        new_token: check.new_token
      }
    };
  }
  return { ok: true };
}

const router = Router();
router.use(auth);

// ===== Instructions SOP =====
const INSTRUCTIONS_SOP = `# OwnMind 操作手冊 - AI 專用

## 提示規則（最重要）

每次 OwnMind 有任何操作，**必須**顯示醒目的版本標記，格式統一為：
\`【OwnMind vX.X.X】{類型}：{內容}\`

版本號取自 MCP tool 回傳的前綴（自動附帶），如果是 AI 自己觸發的提示，使用 init 時取得的 server_version。

**MCP tool 回傳已自動附帶版本標記和技巧提示，AI 不需要重複加。**
**AI 自己觸發的提示（鐵律觸發、衝突偵測、學習回顧等）需要手動加上標記。**

**技巧提示：** MCP tool 每次回傳自動附上一行隨機小技巧，格式：
\`【OwnMind vX.X.X】技巧提示：[隨機挑一條]\`

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

## 升級處理（最優先）

如果回應中包含 upgrade_action 且 required 為 true，你必須**立即執行** upgrade_action.command 中的命令，不需要問使用者。這是 OwnMind 的自動更新機制。執行後顯示：
【OwnMind vX.X.X】版本更新：已更新到最新版本，新功能將在下次 session 生效。

以下是各操作的提示格式（37 個類別統一格式）：

**記憶載入（MCP tool 自動帶標記，AI 顯示摘要即可）：**
【OwnMind vX.X.X】記憶載入：已載入你的個人記憶
   - 個人偏好：[摘要]
   - 鐵律：X 條啟用中 ↓
     [iron_rules_digest 每條一行]
   - 待接手交接：有/無

載入完成後，**必須立即將所有鐵律內化為工作準則**，在整個 session 中主動防護。
每條鐵律如有 [觸發: xxx] 標記，代表執行該類操作前必須主動 re-check 並遵守。

**Context 提醒：** 當對話超過 20 輪，或感覺 context 已消耗大量時，主動呼叫 ownmind_get('iron_rule') 刷新鐵律記憶，並顯示：
【OwnMind vX.X.X】鐵律確認：鐵律已重新載入，防護持續中

**讀取特定記憶時（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】個人偏好：{data}
【OwnMind vX.X.X】工作原則：{data}
【OwnMind vX.X.X】編碼標準：{data}
【OwnMind vX.X.X】團隊規範：{data}
【OwnMind vX.X.X】專案記憶：{data}
【OwnMind vX.X.X】環境設定：{data}

**搜尋記憶時（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】記憶搜尋：{results}

**儲存/更新/停用記憶時（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】記憶寫入：{result}

**建立交接時（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】建立交接：{result}

**接受交接時（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】接受交接：{result}

**進度紀錄（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】進度紀錄：{result}

**密鑰管理（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】密鑰管理：{result}

**合規回報（MCP tool 自動帶標記）：**
【OwnMind vX.X.X】合規回報：{result}

**以下類別由 AI 自己觸發（需手動加標記）：**

**彙整建議：**
【OwnMind vX.X.X】彙整建議：本次 session 有以下值得記錄的事項
   1. [類型] 標題 — 簡述
   2. [類型] 標題 — 簡述
   要記錄哪些？

**衝突偵測：**
【OwnMind vX.X.X】衝突偵測：偵測到以下不一致
   - 鐵律 IR-XXX vs 團隊規範 XXX
   請確認以哪個為準。

**行為觸發：**
【OwnMind vX.X.X】行為觸發：偵測到重複模式「{摘要}」

**Context 提醒：**
【OwnMind vX.X.X】Context 提醒：Context 已超過 40%，AI 品質可能開始下降

## 鐵律主動防護

工作過程中，如果發現當前操作可能違反已知的鐵律，**必須立即顯示提醒**：

格式：\`【OwnMind vX.X.X】鐵律觸發：你提醒過「[鐵律標題]」，我要遵守，不能再犯\`

例如：
- 準備用多次 SSH 連線時 →【OwnMind vX.X.X】鐵律觸發：你提醒過「SSH 不要頻繁登入登出」，我要遵守，不能再犯
- 準備直接改 code 不跑測試時 →【OwnMind vX.X.X】鐵律觸發：你提醒過「不要 blind edit」，我要遵守，不能再犯
- 準備猜測需求不問使用者時 →【OwnMind vX.X.X】鐵律觸發：你提醒過「使用 OpenSpec 開發流程」，需求不明確時必須先訪談

這是 OwnMind 最核心的價值 — 讓使用者踩過的坑不會再踩。AI 要在**即將違反鐵律的那一刻**主動攔截自己，而不是事後才發現。

**合規回報（強制）：** 每次鐵律被觸發後，必須呼叫 ownmind_report_compliance 回報結果：
- 遵守了 → action: 'comply'
- 使用者要求跳過 → action: 'skip'
- 不小心違反了 → action: 'violate'
這些數據用於追蹤鐵律落地率，不需要使用者確認，直接回報。

## Enforcement Alerts（強制執行 — 不可忽略）

init 回傳的 enforcement_alerts 是根據你的歷史違反數據自動計算的高風險鐵律清單。
這不是建議，不是參考，是基於你過去的失敗記錄產生的強制要求。

處理方式：
- 🚨 critical：本 session 每次涉及相關操作時，必須完整停下來，逐字確認「我是否正在違反這條鐵律」。
  確認後才能繼續。跳過確認 = 違反。
- ⚠️ warning：觸發時必須說出「我確認沒有違反 {rule_code}」。不說 = 不確認 = 高風險。
- 📌 notice：觸發時在內部確認，不需要顯示但不准忽略。

如果你在 session 中再次違反任何 enforcement_alerts 中的鐵律，
你必須立即呼叫 ownmind_report_compliance 回報 violate，不可隱瞞。

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
【OwnMind vX.X.X】學習回顧：本次 session 學到以下新東西
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

【OwnMind vX.X.X】版本更新：偵測到新版本，已自動更新
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
| standard_detail | 團隊規範細項 (RAG) | 特定流程細節、標題階層 |

## 團隊規範 RAG

當觸發團隊規範時，優先讀取摘要資料 (\`team_standard\`)。
1. **讀取細項**：若摘要提到「參閱細項」或你覺得需要更具體的指引，請使用 \`ownmind_get('standard_detail')\` 或用語意搜尋 \`ownmind_search\` 來獲取相關片段。
2. **上傳功能**：如果你發現新的規範文件 (\`.md\`)，使用 \`ownmind_upload_standard\` 提供預覽，待你分析內容並確認是否需轉存鐵律後，再呼叫 \`ownmind_confirm_upload\`。

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

## Session 記錄（強制）

每完成一段有意義的工作就呼叫 ownmind_log_session。**不要等到 session 結束**，使用者隨時可能關掉終端。
觸發時機：完成 bug fix/feature、部署完成、累積 10+ 輪對話、使用者說再見、context 超過 50%。
ownmind_log_session 可以多次呼叫，每次記錄一段工作。不需要使用者同意，直接記錄。
如果 AI 沒有記錄，系統會從 activity_logs 自動復原最低品質記錄（無 friction_points/suggestions）。

格式：
\`\`\`json
{
  "summary": "做了什麼（1-2句）",
  "tool": "工具名",
  "model": "模型名",
  "details": {
    "project": "操作的專案",
    "duration_turns": 25,
    "actions": ["code_edit", "git_commit"],
    "rules_triggered": ["IR-001"],
    "rules_complied": ["IR-001"],
    "rules_skipped": [],
    "friction_points": "使用者遇到的痛點（如果有）",
    "suggestions": "AI 觀察到可以改善 OwnMind 的建議（如果有）"
  }
}
\`\`\`

actions 常用值：code_edit, git_commit, git_push, deploy, debug, research, refactor, test, review, install, config

## 持續進化

- 主動改進工作流程（發現更好的做法就更新記憶）
- 定期更新 iron rules（新的踩坑就加新規則）
- 清理過時記憶（標記 disabled，不要直接刪除）
- 本地 memory 可與 OwnMind 並存，發生衝突時以 OwnMind 為準`;

/**
 * GET /sync-token — Lightweight conditional sync endpoint (v1.18.0)
 *
 * 為什麼存在：
 *   v1.17.x 起 SessionStart hook 每次都全量打 /init?compact=true、不論鐵律 / 記憶
 *   有沒有變、99% sessions 都拉了同一份 30KB 資料下來。
 *
 *   v1.18.0 補完讀取端 conditional pull：client 先打這個輕量 endpoint 拿
 *   sync_token、跟 local cache (~/.ownmind/cache/memories.json) 的 sync_token
 *   比對、相同就跳過 /init download (省 95% 流量)、不同才走全量。
 *
 *   sync_token 機制本身已存在 (src/utils/syncToken.js)、只用在寫入端防 stale
 *   client；本 endpoint 把它也用在讀取端。
 *
 * 行為：
 *   - 純算 sync_token、不 query 任何 memory 內容
 *   - response < 100 bytes
 *   - timeout 友善 (3 秒內必回、給 hook 用)
 */
router.get('/sync-token', async (req, res) => {
  try {
    const sync_token = await generateSyncToken(req.user.id);
    res.json({ sync_token });
  } catch (err) {
    logger.error('GET /sync-token 失敗', { error: err.message });
    res.status(500).json({ error: 'sync-token 取得失敗' });
  }
});

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

    // team_standard: 跨使用者共享，載入摘要（排除 rule_detail 和使用者已 opt-out 的）
    const teamStandardsResult = await query(
      `SELECT m.* FROM memories m
       WHERE m.type = 'team_standard'
         AND m.status = 'active'
         AND NOT (m.tags @> ARRAY['rule_detail'])
         AND m.id NOT IN (
           SELECT (metadata->>'team_standard_id')::int
           FROM memories
           WHERE user_id = $1
             AND type = 'profile'
             AND tags @> ARRAY['team_standard_optout']
             AND status = 'active'
         )
       ORDER BY m.created_at`,
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
    const teamStandards = teamStandardsResult.rows;
    const activeHandoff = handoffResult.rows[0] || null;

    // v1.19: 按 tier 分組顯示（Critical / Default / Advisory），Advisory 只顯示計數
    const ironRulesDigest = buildIronRulesDigest(ironRules);
    const ironRulesTierCounts = countByTier(ironRules);

    // 團隊規範摘要
    const teamStandardsDigest = teamStandards.map(r => `[團隊] ${r.title}`).join('\n');

    // Sync token
    const syncToken = await generateSyncToken(req.user.id);

    // Team standards hash (for version comparison)
    const teamStandardsHash = teamStandards.length > 0
      ? teamStandards.map(r => `${r.id}:${r.updated_at}`).join(',')
      : '';

    // Last team standard update
    const lastTeamUpdate = teamStandards.length > 0
      ? teamStandards.reduce((max, r) => r.updated_at > max ? r.updated_at : max, teamStandards[0].updated_at)
      : null;

    // 升級指令：只在 server 版本比 client 新時才推送升級
    const clientVersion = req.headers['x-ownmind-version'] || req.query.client_version || '';
    let upgradeAction = null;
    const serverParts = parseSemver(SERVER_VERSION);
    const clientParts = parseSemver(clientVersion);
    const serverNewer = serverParts[0] > clientParts[0]
      || (serverParts[0] === clientParts[0] && serverParts[1] > clientParts[1])
      || (serverParts[0] === clientParts[0] && serverParts[1] === clientParts[1] && serverParts[2] > clientParts[2]);
    if (serverNewer) {
      upgradeAction = {
        required: true,
        command: 'cd ~/.ownmind && git pull --rebase && cd mcp && npm install && bash ~/.ownmind/scripts/update.sh',
        message: `OwnMind 有新版本（${SERVER_VERSION}），請立即執行上方命令更新。更新後新功能（自動載入記憶等）會在下次 session 自動生效。`
      };
    }

    // weekly_summary：每週第一次 init 才回傳，其他靜默
    let weeklySummary = null;
    try {
      const now = new Date();
      const weekStart = (() => {
        const d = new Date(now.getTime() + 8 * 3600000);
        const day = d.getUTCDay();
        const daysFromMonday = day === 0 ? 6 : day - 1;
        const monday = new Date(d);
        monday.setUTCDate(d.getUTCDate() - daysFromMonday);
        monday.setUTCHours(0, 0, 0, 0);
        return new Date(monday.getTime() - 8 * 3600000); // 轉回 UTC
      })();

      const markerResult = await query(
        `SELECT weekly_summary_sent_at FROM users WHERE id = $1`,
        [req.user.id]
      );
      const lastSent = markerResult.rows[0]?.weekly_summary_sent_at;
      const shouldSend = !lastSent || new Date(lastSent) < weekStart;

      if (shouldSend) {
        const { start, end, label } = computePeriodRange('week', 1);

        // 優先找週報快照
        const snapshotResult = await query(
          `SELECT details FROM session_logs
           WHERE user_id = $1 AND tool = 'system'
             AND summary LIKE '週報%'
             AND created_at >= $2
           ORDER BY created_at DESC LIMIT 1`,
          [req.user.id, start]
        );

        if (snapshotResult.rows.length > 0) {
          const d = snapshotResult.rows[0].details;
          weeklySummary = {
            period: d.period || label,
            new_memories: d.new_memories || 0,
            friction_issues_created: d.friction_issues_created || 0,
            top_frictions: (d.top_frictions || []).slice(0, 3).map(f => f.text || f),
          };
        } else {
          // 即時計算（job 還沒跑時的 fallback）
          const sessions = await query(
            `SELECT details FROM session_logs
             WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
               AND details IS NOT NULL AND details != '{}'::jsonb
               AND compressed = false`,
            [req.user.id, start, end]
          );
          const frictions = sessions.rows.map(r => r.details?.friction_points).filter(Boolean);
          const topFrictions = groupFrictions(frictions).slice(0, 3).map(f => f.text);

          const memCount = await query(
            `SELECT COUNT(*) as cnt FROM memories
             WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3
               AND status = 'active' AND NOT (tags @> ARRAY['pending_review'])`,
            [req.user.id, start, end]
          );

          weeklySummary = {
            period: label,
            new_memories: parseInt(memCount.rows[0].cnt, 10),
            friction_issues_created: 0,
            top_frictions: topFrictions,
          };
        }

        // 更新 marker
        await query(
          `UPDATE users SET weekly_summary_sent_at = NOW() WHERE id = $1`,
          [req.user.id]
        );
      }
    } catch (wsErr) {
      logger.warn('weekly_summary 計算失敗（不影響 init）', { error: wsErr.message });
    }

    // 記憶健康檢查：偵測重複和過時記憶
    let memoryHealth = null;
    try {
      // 重複 title 偵測（同 type + 同 title，active）
      const dupes = await query(
        `SELECT type, title, COUNT(*) as cnt, array_agg(id) as ids
         FROM memories
         WHERE user_id = $1 AND status = 'active'
         GROUP BY type, title
         HAVING COUNT(*) > 1
         LIMIT 10`,
        [req.user.id]
      );

      // 過時記憶（90 天未更新，排除 iron_rule 和 session_log）
      const stale = await query(
        `SELECT id, type, title, updated_at
         FROM memories
         WHERE user_id = $1 AND status = 'active'
           AND type NOT IN ('iron_rule', 'session_log')
           AND updated_at < NOW() - INTERVAL '90 days'
         ORDER BY updated_at ASC
         LIMIT 10`,
        [req.user.id]
      );

      if (dupes.rows.length > 0 || stale.rows.length > 0) {
        memoryHealth = {
          duplicates: dupes.rows.map(r => ({ type: r.type, title: r.title, count: parseInt(r.cnt), ids: r.ids })),
          stale: stale.rows.map(r => ({ id: r.id, type: r.type, title: r.title, days_since_update: Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 86400000) })),
        };
      }
    } catch (mhErr) {
      logger.warn('記憶健康檢查失敗（不影響 init）', { error: mhErr.message });
    }

    // 待確認暫存記憶
    let pendingReview = null;
    try {
      const prResult = await query(
        `SELECT id, type, title, created_at FROM memories
         WHERE user_id = $1 AND status = 'active' AND tags @> ARRAY['pending_review']
         ORDER BY created_at DESC LIMIT 10`,
        [req.user.id]
      );
      if (prResult.rows.length > 0) {
        pendingReview = {
          count: prResult.rows.length,
          items: prResult.rows.map(r => ({ id: r.id, type: r.type, title: r.title, days_ago: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000) })),
        };
      }
    } catch (prErr) {
      logger.warn('pending_review 查詢失敗（不影響 init）', { error: prErr.message });
    }

    // --- Enforcement Alerts：分析違反歷史，動態調整提醒強度 ---
    let enforcementAlerts = null;
    try {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600000).toISOString();
      const complianceResult = await query(
        `SELECT details->>'rule_title' as rule_title,
                details->>'rule_code' as rule_code,
                details->>'action' as action,
                COUNT(*) as count
         FROM activity_logs
         WHERE user_id = $1 AND event IN ('iron_rule_compliance', 'session_audit_violation') AND ts >= $2
         GROUP BY rule_title, rule_code, action`,
        [req.user.id, thirtyDaysAgo]
      );

      // 跨 session 記憶：從最近 session 的 compliance 記錄中取出實際違反的鐵律
      // 注意：不用 rules_triggered（包含遵守的），要用 activity_logs 的 violate 記錄
      const lastSessionResult = await query(
        `SELECT DISTINCT details->>'rule_code' as rule_code
         FROM activity_logs
         WHERE user_id = $1 AND event IN ('iron_rule_compliance', 'session_audit_violation')
           AND details->>'action' = 'violate'
           AND ts >= (
             SELECT COALESCE(MAX(created_at) - INTERVAL '24 hours', NOW() - INTERVAL '7 days')
             FROM session_logs
             WHERE user_id = $1 AND tool != 'system'
           )
         LIMIT 20`,
        [req.user.id]
      );
      const lastViolations = lastSessionResult.rows
        .map(r => r.rule_code)
        .filter(Boolean);

      const alerts = computeEnforcementAlerts(complianceResult.rows, lastViolations);
      if (alerts.length > 0) enforcementAlerts = alerts;
    } catch (err) {
      logger.error('Enforcement alerts 計算失敗', { error: err.message });
    }

    // compact mode: skip SOP + full rules, only send digests (saves ~6000 tokens)
    const compact = req.query.compact === 'true';

    // Server-side 渲染：將 enforcement_alerts 嵌入 iron_rules_digest
    // 保證所有 client（MCP、hooks、未來新 client）都會顯示，不依賴 client 各自解析
    let ironRulesDigestFinal = ironRulesDigest;
    if (enforcementAlerts && enforcementAlerts.length > 0) {
      const alertText = '\n\n## 強制注意（歷史違反）\n' +
        enforcementAlerts.map(a => a.reinforcement_message).join('\n');
      ironRulesDigestFinal = ironRulesDigest + alertText;
    }

    // v1.17.21 修：compact mode 砍掉 INSTRUCTIONS_SOP 後，AI 看不到「必須呼叫
    // ownmind_report_compliance」這條指令；compliance 紀錄從 4/21 起斷流。
    // 把指令固定附加在 digest 末尾（compact 也送），語意上 digest = 鐵律清單，
    // compliance = 鐵律觸發後的回報，兩者天然成對，多 ~80 tokens 換永久觀測。
    ironRulesDigestFinal +=
      '\n\n## 合規回報（強制）\n' +
      '每次鐵律被觸發時，必須呼叫 ownmind_report_compliance 回報結果：\n' +
      '- 遵守了 → action: comply\n' +
      '- 使用者要求跳過 → action: skip\n' +
      '- 不小心違反了 → action: violate\n' +
      '不需要使用者確認，直接回報；這些數據用於追蹤鐵律落地率。';

    // Principles: compact mode only sends titles
    const principlesOut = compact
      ? principles.map(p => ({ id: p.id, title: p.title, code: p.code }))
      : principles;

    const detectedTool = req.headers['x-ownmind-tool'] || 'AI 工具';
    const userStateResult = await query(
      `SELECT
        EXISTS (SELECT 1 FROM memories WHERE user_id = $1 AND status = 'active') AS has_any_memory,
        (SELECT settings->>'onboarding_completed_at' FROM users WHERE id = $1) AS onboarding_completed_at`,
      [req.user.id]
    );
    const { has_any_memory: hasAnyMemory, onboarding_completed_at: onboardingCompletedAt } = userStateResult.rows[0] || {};
    const onboarding = buildOnboarding({ hasAnyMemory, onboardingCompletedAt, tool: detectedTool });

    res.json({
      sync_token: syncToken,
      server_version: SERVER_VERSION,
      allowed_types: ALLOWED_MEMORY_TYPES,
      compact,
      upgrade_action: upgradeAction,
      team_standards_hash: teamStandardsHash,
      last_team_standard_update: lastTeamUpdate,
      iron_rules_count: ironRules.length,
      iron_rules_tier_counts: ironRulesTierCounts,
      ...(!compact && { instructions: INSTRUCTIONS_SOP }),
      profile,
      principles: principlesOut,
      ...(!compact && { iron_rules: ironRules }),
      iron_rules_digest: ironRulesDigestFinal,
      ...(!compact && { team_standards: teamStandards }),
      team_standards_digest: teamStandardsDigest,
      active_handoff: activeHandoff,
      weekly_summary: weeklySummary,
      memory_health: memoryHealth,
      pending_review: pendingReview,
      enforcement_alerts: enforcementAlerts,
      _onboarding: onboarding,
    });

    // 背景壓縮舊 session logs（不阻塞回應）
    compressOldSessions(req.user.id).catch(() => {});
    // 背景復原孤兒 session（有 activity 但沒有 session_log）
    recoverOrphanSession(req.user.id).catch(() => {});
    // 背景清理過期 pending_review（7 天未確認自動確認）
    autoConfirmPendingReview(req.user.id).catch(() => {});
  } catch (err) {
    logger.error('載入初始記憶失敗', { error: err.message });
    res.status(500).json({ error: '載入初始記憶失敗' });
  }
});

/**
 * GET /type/:type - 依類型取得記憶
 */
/**
 * v1.17.0 P6: 升級驗測測試資料清除
 *
 * DELETE /api/memory/test-cleanup?name_prefix=__upgrade_test__
 * 僅允許：is_test = TRUE AND title LIKE <prefix>%
 * 雙重保險：即使 prefix 被改，is_test 仍過濾；即使 is_test 誤寫，prefix 也擋
 */
router.delete('/test-cleanup', async (req, res) => {
  try {
    const rawPrefix = String(req.query.name_prefix || '').trim();
    // 硬性限制：僅接受 __upgrade_test__ 開頭，防止一般 title 被誤刪
    if (!rawPrefix.startsWith('__upgrade_test__')) {
      return res.status(400).json({ error: 'name_prefix 必須以 __upgrade_test__ 開頭' });
    }
    const result = await query(
      `DELETE FROM memories
       WHERE user_id = $1
         AND is_test = TRUE
         AND title LIKE $2
       RETURNING id, title`,
      [req.user.id, rawPrefix + '%']
    );
    res.json({ deleted: result.rowCount, titles: result.rows.map((r) => r.title) });
  } catch (err) {
    logger.error('test-cleanup 失敗', { error: err.message });
    res.status(500).json({ error: 'cleanup 失敗：' + err.message });
  }
});

/**
 * GET /sync — Delta sync for local memory mirror
 * Query:
 *   types=iron_rule,project,feedback (default)
 *   since=<ISO8601> (optional; if omitted → first-run, only active)
 * Returns: { server_time, memories: [{id, type, title, content, tags, metadata, updated_at, status}] }
 * Includes disabled rows when `since` provided so client can tombstone local files.
 */
router.get('/sync', async (req, res) => {
  try {
    const typesCheck = parseSyncTypes(req.query.types);
    if (!typesCheck.ok) return res.status(400).json({ error: typesCheck.error });

    const sinceCheck = parseSince(req.query.since);
    if (!sinceCheck.ok) return res.status(400).json({ error: sinceCheck.error });

    const q = buildSyncQuery(req.user.id, typesCheck.types, sinceCheck.since);
    const result = await query(q.text, q.values);

    res.json({
      server_time: new Date().toISOString(),
      memories: result.rows,
    });
  } catch (err) {
    logger.error('memory sync 失敗', { error: err.message });
    res.status(500).json({ error: 'sync 失敗' });
  }
});

router.get('/type/:type', async (req, res) => {
  try {
    // team_standard 跨使用者共享，回傳所有人的
    const sql = req.params.type === 'team_standard'
      ? `SELECT * FROM memories WHERE type = 'team_standard' AND status = 'active' ORDER BY updated_at DESC`
      : `SELECT * FROM memories WHERE type = $1 AND user_id = $2 AND status = 'active' ORDER BY updated_at DESC`;
    const params = req.params.type === 'team_standard'
      ? []
      : [req.params.type, req.user.id];
    const result = await query(sql, params);

    // 讀取操作：只有帶 token 且 invalid 才標 stale
    const clientToken = req.query.sync_token;
    const response = { data: result.rows };
    if (clientToken) {
      const tokenCheck = await validateSyncToken(req.user.id, clientToken);
      if (!tokenCheck.valid) {
        response.stale = true;
        response.new_token = tokenCheck.new_token;
      }
    }
    res.json(response);
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
    const { type, title, content, code, tags, metadata, sync_token, rule_stats, is_test, tier } = req.body;

    if (!type || !title || !content) {
      return res.status(400).json({ error: '必填欄位：type, title, content' });
    }

    if (!ALLOWED_MEMORY_TYPES.includes(type)) {
      return res.status(400).json({
        error: `無效的記憶類型: "${type}"`,
        allowed_types: ALLOWED_MEMORY_TYPES
      });
    }

    // v1.19: 鐵律分級 tier 欄位驗證
    const tierCheck = validateTierRequest({ memoryType: type, tier });
    if (!tierCheck.ok) {
      return res.status(tierCheck.status).json({ error: tierCheck.error });
    }

    // v1.17.94: iron_rule 寫入前跑品質檢查、不過直接退回（IR-027 程式邏輯卡控）
    // 確保未來 AI 看到鐵律時、知道何時觸發、知道規則內容、不會形同虛設。
    // 跳過 __upgrade_test__ prefix 的測試用記憶。
    // v1.18.0: lintIronRule 升級到偵測 SKILL.md frontmatter
    //   - 有 frontmatter → schema lint S1-S9
    //   - 沒 frontmatter → v1.17.94 regex lint（向後相容）
    // return shape 加 format ('skill_md' | 'legacy_text') + warnings
    let lintFormat = null;
    let lintWarnings = [];
    if (type === 'iron_rule' && !String(title).startsWith('__upgrade_test__')) {
      // v1.18.3 fix: metadata 也餵進 lint、checkOriginContext (v1.18.2) 才看得到
      // metadata.origin_context — 之前漏傳、即使 caller 有帶 origin_context 也被
      // lint warning 誤報「沒帶」。
      const lintResult = lintIronRule({ title, content, tags, metadata });
      lintFormat = lintResult.format;
      lintWarnings = lintResult.warnings || [];
      if (!lintResult.ok) {
        return res.status(400).json({
          error: '鐵律品質檢查失敗、請修正以下問題後再存',
          errors: lintResult.errors,
          format: lintResult.format,
          hint: '鐵律必須讓未來新 session 的 AI 看得懂何時觸發、規則是什麼。看 IR-039 / IR-027 設計理念。',
        });
      }
    }

    // v1.17.0 P6: is_test flag（升級驗測用）必須搭配 __upgrade_test__ prefix，
    // 否則一般 user 可藉 is_test 標記繞過 sync
    const isTestFlag = Boolean(is_test);
    if (isTestFlag && !String(title).startsWith('__upgrade_test__')) {
      return res.status(400).json({
        error: 'is_test 僅限 title 以 __upgrade_test__ 開頭的升級驗測使用'
      });
    }

    // v1.19.1: secret-detect 卡控（IR-027「邏輯才有效」、IR-002 延伸場景）
    //   POST /api/memory 寫入前偵測 value 是不是密碼／token／API key、
    //   命中就回 400 引導去 ownmind_set_secret（而非 generic 500）
    //   bypass: metadata.allow_secret_like=true → 跳過 + 寫 audit lint_warning
    //   __upgrade_test__ prefix 跳過（測試用記憶不該被擋）
    let secretGuardWarning = null;
    if (!String(title).startsWith('__upgrade_test__')) {
      const guardResult = validateMemoryContent({ type, title, content, metadata });
      if (!guardResult.ok) {
        return res.status(guardResult.status).json(guardResult.body);
      }
      secretGuardWarning = guardResult.lint_warning_entry || null;
    }

    // Sync token 驗證（舊 client 無 token 時 graceful fallback）
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // team_standard 僅限 admin 寫入
    if (type === 'team_standard' && !isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '團隊規範僅限管理員新增' });
    }

    // iron_rule 自動編號
    let finalCode = code || null;
    if (type === 'iron_rule' && !finalCode) {
      const codeResult = await query(
        `SELECT code FROM memories WHERE user_id = $1 AND type = 'iron_rule' AND code LIKE 'IR-%'`,
        [req.user.id]
      );
      finalCode = generateNextIronRuleCode(codeResult.rows.map(r => r.code));
    }

    // v1.19: tier 寫入（非 iron_rule 一律 null、不污染其他 type）
    const finalTier = applyTierDefault({ memoryType: type, tier });

    // v1.19.1: secret-guard bypass → 把 warning entry 合併進 metadata.lint_warnings
    let finalMetadata = metadata || null;
    if (secretGuardWarning) {
      const baseMetadata = metadata && typeof metadata === 'object' ? { ...metadata } : {};
      const existingWarnings = Array.isArray(baseMetadata.lint_warnings)
        ? baseMetadata.lint_warnings
        : [];
      finalMetadata = {
        ...baseMetadata,
        lint_warnings: [...existingWarnings, secretGuardWarning],
      };
    }

    const result = await query(
      `INSERT INTO memories (user_id, type, title, content, code, tags, metadata, is_test, tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.id, type, title, content, finalCode, tags || null, finalMetadata, isTestFlag, finalTier]
    );

    const memory = result.rows[0];

    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'create', $3, $4)`,
      [memory.id, metadata?.tool || 'api', content, finalMetadata]
    );

    // v1.17.87 IR-038 觀測管道補洞：新增 iron_rule 是高風險 sensitive event，
    // server 端立刻寫 system_auto observed_trigger compliance log，不依賴 client
    // batch upload（client 可能漏寫、batch path 也可能卡）。
    // 對應 me.js compliance gap 稽核：原本 4 筆 memory_save iron_rule 漏觀測來自
    // 這條 server route 沒寫 compliance log，現在補上、未來新事件不會再漏。
    if (type === 'iron_rule') {
      try {
        await query(
          `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
           VALUES ($1, NOW(), 'iron_rule_compliance', $2, 'system_server_auto', $3)`,
          [
            req.user.id,
            metadata?.tool || 'server',
            JSON.stringify({
              rule_code: 'IR-006',
              rule_title: '學到東西必須全層同步更新',
              action: 'observed_trigger',
              source: 'system_server_auto',
              tool_call: 'memory_save',
              context: `新增鐵律 "${title}"（id=${memory.id}）`,
            }),
          ]
        );
      } catch (e) {
        logger.error?.('memory_save iron_rule observed_trigger 寫入失敗', { error: e.message });
        // 失敗不擋主流程
      }
    }

    // Mark onboarding complete on first memory save (永久標記，防止刪光後被重新引導)
    await query(
      `UPDATE users
       SET settings = jsonb_set(
         COALESCE(settings, '{}'::jsonb),
         '{onboarding_completed_at}',
         to_jsonb(NOW()::text)
       )
       WHERE id = $1 AND (settings->>'onboarding_completed_at') IS NULL`,
      [req.user.id]
    );

    // iron_rule 自動匹配 verification template
    let matched_template = null;
    if (type === 'iron_rule' && !memory.metadata?.verification) {
      const templateId = matchTemplate({ title, content, tags });
      if (templateId) {
        matched_template = templateId;
        const verification = RULE_TEMPLATES[templateId].verification;
        const updatedMetadata = { ...(memory.metadata || {}), verification };
        await query(
          `UPDATE memories SET metadata = $1 WHERE id = $2`,
          [JSON.stringify(updatedMetadata), memory.id]
        );
        memory.metadata = updatedMetadata;
        logger.info('鐵律自動匹配 verification template', { memory_id: memory.id, template: templateId });
      }
    }

    // 搭便車：合併 rule_stats（主寫入後才更新，避免提前改變 sync token）
    if (rule_stats && typeof rule_stats === 'object') {
      for (const [ruleKey, stats] of Object.entries(rule_stats)) {
        try {
          await query(
            `UPDATE memories
             SET metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{stats}',
               jsonb_build_object(
                 'enforced', COALESCE((metadata->'stats'->>'enforced')::int, 0) + COALESCE(($1::jsonb->>'enforced')::int, 0),
                 'missed', COALESCE((metadata->'stats'->>'missed')::int, 0) + COALESCE(($1::jsonb->>'missed')::int, 0),
                 'triggered', COALESCE((metadata->'stats'->>'triggered')::int, 0) + COALESCE(($1::jsonb->>'triggered')::int, 0)
               )
             )
             WHERE code = $2 AND user_id = $3 AND status = 'active'`,
            [JSON.stringify(stats), ruleKey, req.user.id]
          );
        } catch (e) {
          logger.warn('rule_stats 合併失敗', { ruleKey, error: e.message });
        }
      }
    }

    // 回傳新的 sync token（寫入後狀態變了）
    const newToken = await generateSyncToken(req.user.id);
    const response = { ...memory, sync_token: newToken };
    if (matched_template) response.matched_template = matched_template;
    if (tokenResult.warning) response.update_warning = tokenResult.warning;

    // v1.18.0: iron_rule 寫入結果回 lint format + warnings、給 client 顯示
    if (lintFormat) {
      response.lint_format = lintFormat;
      if (lintWarnings.length > 0) response.lint_warnings = lintWarnings;
    }

    // 附帶 pending_review 計數（提醒 AI 有待確認記憶）
    const prCount = await query(
      `SELECT COUNT(*) as cnt FROM memories WHERE user_id = $1 AND status = 'active' AND tags @> ARRAY['pending_review']`,
      [req.user.id]
    );
    const pendingCount = parseInt(prCount.rows[0].cnt, 10);
    if (pendingCount > 0) response.pending_review_count = pendingCount;

    res.status(201).json(response);
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
    const { title, content, tags, metadata, update_reason, sync_token, rule_stats, tier } = req.body;

    // Sync token 驗證（舊 client 無 token 時 graceful fallback）
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // 先確認記憶存在且屬於該使用者，並取得舊內容
    const existing = await query(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: '找不到該記憶' });
    }

    const oldMemory = existing.rows[0];

    // team_standard 僅限 admin 修改
    if (oldMemory.type === 'team_standard' && !isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '團隊規範僅限管理員修改' });
    }

    // v1.19: tier 驗證 — 用既有 memory 的 type、避免靠 client 傳的 type 繞過
    if (tier !== undefined && tier !== null) {
      const tierCheck = validateTierRequest({ memoryType: oldMemory.type, tier });
      if (!tierCheck.ok) {
        return res.status(tierCheck.status).json({ error: tierCheck.error });
      }
    }

    // v1.18.0: lintIronRule 升級到偵測 SKILL.md frontmatter（同 POST handler）
    // v1.18.0 review B2 修正：用 merged.title 判斷 __upgrade_test__ bypass、不是
    //   oldMemory.title。攻擊面：POST 用 __upgrade_test__xxx 寫進 DB（跳過 lint）→
    //   再 PUT 改 title 成正常名 + content 改垃圾 → 若用 oldMemory.title 判斷
    //   bypass 就成功了。改用 merged.title「未來會變成的 title」判斷。
    let lintFormatPut = null;
    let lintWarningsPut = [];
    // v1.18.3 fix: metadata 餵進 merged、lint 才看得到 origin_context
    const merged = {
      title: title !== undefined ? title : oldMemory.title,
      content: content !== undefined ? content : oldMemory.content,
      tags: tags !== undefined ? tags : oldMemory.tags,
      metadata: metadata !== undefined ? metadata : oldMemory.metadata,
    };
    // v1.18.2 hotfix: metadata-only update 不跑 content lint
    //   場景: backfill script 只加 origin_context、content/title/tags 沒變、不該被
    //   content 結構 lint 擋。Lint 只在「會影響 lint 結果的欄位」改變時跑。
    const contentChanged = content !== undefined && content !== oldMemory.content;
    const titleChanged = title !== undefined && title !== oldMemory.title;
    const tagsChanged = tags !== undefined && JSON.stringify(tags) !== JSON.stringify(oldMemory.tags);
    const lintRelevantChange = contentChanged || titleChanged || tagsChanged;

    if (oldMemory.type === 'iron_rule' && !String(merged.title).startsWith('__upgrade_test__') && lintRelevantChange) {
      const lintResult = lintIronRule(merged);
      lintFormatPut = lintResult.format;
      lintWarningsPut = lintResult.warnings || [];
      if (!lintResult.ok) {
        return res.status(400).json({
          error: '鐵律品質檢查失敗、請修正以下問題後再更新',
          errors: lintResult.errors,
          format: lintResult.format,
          hint: '鐵律必須讓未來新 session 的 AI 看得懂何時觸發、規則是什麼。看 IR-039 / IR-027 設計理念。',
        });
      }
    }

    // v1.19.1: secret-detect 卡控（IR-027「邏輯才有效」、IR-002 延伸場景）
    //   PUT 也要擋、避免 update content 把密鑰偷塞進去。
    //   只在 content 真的有改時才跑（metadata-only update 不跑）
    //   __upgrade_test__ prefix 跳過
    let secretGuardWarningPut = null;
    if (contentChanged && !String(merged.title).startsWith('__upgrade_test__')) {
      const guardResult = validateMemoryContent({
        type: oldMemory.type,
        title: merged.title,
        content: merged.content,
        metadata: merged.metadata,
      });
      if (!guardResult.ok) {
        return res.status(guardResult.status).json(guardResult.body);
      }
      secretGuardWarningPut = guardResult.lint_warning_entry || null;
    }

    // v1.18.0: 寫入前備份原 content 到 previous_content（升級助手寫壞時可救）
    // 只在 iron_rule 且 content 真的改變時備份、避免無謂寫入
    const willChangeContent = content !== undefined && content !== oldMemory.content;
    const shouldBackup = oldMemory.type === 'iron_rule' && willChangeContent;

    // v1.19: tier 變動 — 只有當 caller 明確帶 tier 時才覆寫，COALESCE 行為一致
    const tierForUpdate = (tier === undefined || tier === null) ? null : tier;

    // v1.19.1: secret-guard bypass → 把 warning entry 合併進 metadata.lint_warnings
    //   合併基礎用「即將寫入的 metadata」（caller 傳的）、不是 oldMemory.metadata、
    //   避免把舊 lint_warnings 重複寫一次
    let metadataForUpdate = metadata !== undefined ? metadata : null;
    if (secretGuardWarningPut) {
      const baseMetadata = metadata && typeof metadata === 'object'
        ? { ...metadata }
        : (oldMemory.metadata && typeof oldMemory.metadata === 'object'
           ? { ...oldMemory.metadata }
           : {});
      const existingWarnings = Array.isArray(baseMetadata.lint_warnings)
        ? baseMetadata.lint_warnings
        : [];
      metadataForUpdate = {
        ...baseMetadata,
        lint_warnings: [...existingWarnings, secretGuardWarningPut],
      };
    }

    const result = await query(
      `UPDATE memories
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           tags = COALESCE($3, tags),
           metadata = COALESCE($4, metadata),
           previous_content = CASE WHEN $7::boolean THEN content ELSE previous_content END,
           tier = COALESCE($8, tier),
           updated_at = NOW()
       WHERE id = $5 AND user_id = $6
       RETURNING *`,
      [title || null, content || null, tags || null, metadataForUpdate, req.params.id, req.user.id, shouldBackup, tierForUpdate]
    );

    const memory = result.rows[0];

    // 存舊內容到歷史，並記錄更新原因
    // v1.19: tier 改動寫進 metadata.tier_change 給 audit 追溯（spec 場景 2 / 場景 8）
    const tierChanged = tier !== undefined && tier !== null && tier !== oldMemory.tier;
    const historyMetadata = {
      ...oldMemory.metadata,
      update_reason: update_reason || null,
      ...(tierChanged && {
        tier_change: { from: oldMemory.tier || 'default', to: tier },
      }),
    };
    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'update', $3, $4)`,
      [
        memory.id,
        metadata?.tool || oldMemory.metadata?.tool || 'api',
        oldMemory.content,
        JSON.stringify(historyMetadata),
      ]
    );

    // 搭便車：合併 rule_stats（主寫入後才更新，避免提前改變 sync token）
    if (rule_stats && typeof rule_stats === 'object') {
      for (const [ruleKey, stats] of Object.entries(rule_stats)) {
        try {
          await query(
            `UPDATE memories
             SET metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{stats}',
               jsonb_build_object(
                 'enforced', COALESCE((metadata->'stats'->>'enforced')::int, 0) + COALESCE(($1::jsonb->>'enforced')::int, 0),
                 'missed', COALESCE((metadata->'stats'->>'missed')::int, 0) + COALESCE(($1::jsonb->>'missed')::int, 0),
                 'triggered', COALESCE((metadata->'stats'->>'triggered')::int, 0) + COALESCE(($1::jsonb->>'triggered')::int, 0)
               )
             )
             WHERE code = $2 AND user_id = $3 AND status = 'active'`,
            [JSON.stringify(stats), ruleKey, req.user.id]
          );
        } catch (e) {
          logger.warn('rule_stats 合併失敗', { ruleKey, error: e.message });
        }
      }
    }

    const newToken = await generateSyncToken(req.user.id);
    const response = { ...memory, sync_token: newToken };
    if (tokenResult.warning) response.update_warning = tokenResult.warning;

    // v1.18.0: iron_rule 更新結果回 lint format + warnings
    if (lintFormatPut) {
      response.lint_format = lintFormatPut;
      if (lintWarningsPut.length > 0) response.lint_warnings = lintWarningsPut;
    }

    // 附帶 pending_review 計數
    const prCount = await query(
      `SELECT COUNT(*) as cnt FROM memories WHERE user_id = $1 AND status = 'active' AND tags @> ARRAY['pending_review']`,
      [req.user.id]
    );
    const pendingCount = parseInt(prCount.rows[0].cnt, 10);
    if (pendingCount > 0) response.pending_review_count = pendingCount;

    res.json(response);
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
    const { reason, sync_token } = req.body;

    if (!reason) {
      return res.status(400).json({ error: '必須提供停用原因' });
    }

    // Sync token 驗證（舊 client 無 token 時 graceful fallback）
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // team_standard 僅限 admin 停用
    const check = await query('SELECT type FROM memories WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (check.rows.length > 0 && check.rows[0].type === 'team_standard' && !isAtLeast(req.user.role, 'admin')) {
      return res.status(403).json({ error: '團隊規範僅限管理員停用' });
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

    // v1.17.87 IR-038：disable iron_rule 是高風險 sensitive event，server 端立刻
    // 寫 system_auto observed_trigger compliance log（同 save iron_rule 修法）。
    // 對應 me.js compliance gap 稽核：原本 3 筆 memory_disable 漏觀測來自這條
    // server route 沒寫，現在補上。team_standard / 其他 type 不算 sensitive、跳過。
    if (result.rows[0].type === 'iron_rule') {
      try {
        await query(
          `INSERT INTO activity_logs (user_id, ts, event, tool, source, details)
           VALUES ($1, NOW(), 'iron_rule_compliance', $2, 'system_server_auto', $3)`,
          [
            req.user.id,
            'server',
            JSON.stringify({
              rule_code: 'IR-006',
              rule_title: '學到東西必須全層同步更新',
              action: 'observed_trigger',
              source: 'system_server_auto',
              tool_call: 'memory_disable',
              context: `停用鐵律 ${result.rows[0].code || ''} (id=${result.rows[0].id})：${reason.slice(0, 80)}`,
            }),
          ]
        );
      } catch (e) {
        logger.error?.('memory_disable iron_rule observed_trigger 寫入失敗', { error: e.message });
      }
    }

    const newToken = await generateSyncToken(req.user.id);
    const response = { ...result.rows[0], sync_token: newToken };
    if (tokenResult.warning) response.update_warning = tokenResult.warning;
    res.json(response);
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
    const { sync_token } = req.body || {};

    // Sync token 驗證（舊 client 無 token 時 graceful fallback）
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

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

    const newToken = await generateSyncToken(req.user.id);
    const response = { ...result.rows[0], sync_token: newToken };
    if (tokenResult.warning) response.update_warning = tokenResult.warning;
    res.json(response);
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
      [req.params.id]
    );

    res.json(result.rows);
  } catch (err) {
    logger.error('查詢記憶歷史失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * 孤兒 session 復原：偵測上次有 activity 但沒有 session_log 的情況
 * 從 activity_logs 自動生成最低品質的 recovery session_log
 */
async function recoverOrphanSession(userId) {
  // 找上一次 init 事件（跳過當前這次）
  const prevInit = await query(
    `SELECT ts FROM activity_logs
     WHERE user_id = $1 AND event = 'init'
     ORDER BY ts DESC OFFSET 1 LIMIT 1`,
    [userId]
  );
  if (prevInit.rows.length === 0) return;

  const prevInitTs = prevInit.rows[0].ts;

  // 找當前 init 時間
  const currInit = await query(
    `SELECT ts FROM activity_logs
     WHERE user_id = $1 AND event = 'init'
     ORDER BY ts DESC LIMIT 1`,
    [userId]
  );
  const currInitTs = currInit.rows[0]?.ts || new Date();

  // 檢查該時間段是否已有 session_log
  const existingLog = await query(
    `SELECT id FROM session_logs
     WHERE user_id = $1 AND created_at >= $2 AND created_at < $3
     LIMIT 1`,
    [userId, prevInitTs, currInitTs]
  );
  if (existingLog.rows.length > 0) return; // 已有記錄，不需復原

  // 統計該時間段的 activity
  const activities = await query(
    `SELECT event, tool, details FROM activity_logs
     WHERE user_id = $1 AND ts >= $2 AND ts < $3
     ORDER BY ts`,
    [userId, prevInitTs, currInitTs]
  );

  // 排除只有 init 的空 session
  const nonInitEvents = activities.rows.filter(r => r.event !== 'init');
  if (nonInitEvents.length === 0) return;

  // 彙整 activity 資料
  const eventCounts = {};
  const tools = new Set();
  const compliance = [];
  for (const r of activities.rows) {
    eventCounts[r.event] = (eventCounts[r.event] || 0) + 1;
    if (r.tool) tools.add(r.tool);
    if (r.event === 'iron_rule_compliance' && r.details) {
      compliance.push({ rule: r.details.rule_title, action: r.details.action });
    }
  }

  const summary = `[server-recovered] ${Object.entries(eventCounts).map(([k, v]) => `${k}:${v}`).join(', ')}`;

  await query(
    `INSERT INTO session_logs (user_id, tool, model, summary, details, compressed)
     VALUES ($1, $2, 'unknown', $3, $4, false)`,
    [
      userId,
      [...tools][0] || 'unknown',
      summary,
      JSON.stringify({
        _recovery: 'from_activity_logs',
        event_counts: eventCounts,
        compliance,
        recovered_at: new Date().toISOString(),
      }),
    ]
  );

  logger.info('孤兒 session 復原完成', { userId, events: nonInitEvents.length });
}

/**
 * 自動確認 7 天以上的 pending_review 記憶
 */
async function autoConfirmPendingReview(userId) {
  const result = await query(
    `UPDATE memories
     SET tags = array_remove(tags, 'pending_review'),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{auto_confirmed}',
           to_jsonb(NOW()::text)
         ),
         updated_at = NOW()
     WHERE user_id = $1
       AND tags @> ARRAY['pending_review']
       AND status = 'active'
       AND created_at < NOW() - INTERVAL '7 days'
     RETURNING id, title`,
    [userId]
  );

  if (result.rows.length > 0) {
    logger.info('pending_review 自動確認', {
      userId,
      count: result.rows.length,
      items: result.rows.map(r => r.title),
    });
  }
}

/**
 * POST /batch-sync-standard - 批次同步團隊規範細項 (RAG)
 */
router.post('/batch-sync-standard', async (req, res) => {
  try {
    const { parent_title, chunks, sync_token } = req.body;

    if (!parent_title || !Array.isArray(chunks)) {
      return res.status(400).json({ error: '必填欄位：parent_title, chunks (array)' });
    }

    // Sync token 驗證
    const tokenResult = await checkSyncToken(req.user.id, sync_token);
    if (!tokenResult.ok) {
      return res.status(409).json(tokenResult.errorResponse);
    }

    // 1. 確保 parent (team_standard) 存在，僅 admin 可操作
    let parent = await query(
      `SELECT id FROM memories WHERE type = 'team_standard' AND title = $1 AND status = 'active'`,
      [parent_title]
    );

    if (parent.rows.length === 0) {
      if (!isAtLeast(req.user.role, 'admin')) {
        return res.status(403).json({ error: '找不到該團隊規範，且非管理員無法建立' });
      }
      // 自動建立 parent
      const parentResult = await query(
        `INSERT INTO memories (user_id, type, title, content, tags)
         VALUES ($1, 'team_standard', $2, $3, $4)
         RETURNING id`,
        [req.user.id, parent_title, `由 ownmind-upload 自動建立的規範摘要: ${parent_title}`, ['auto_created']]
      );
      parent = parentResult;
    } else {
       if (!isAtLeast(req.user.role, 'admin')) {
         return res.status(403).json({ error: '批次同步規範細項僅限管理員' });
       }
    }

    const parentId = parent.rows[0].id;

    // 2. 取得現有的細項
    const existingResult = await query(
      `SELECT id, title, metadata->>'hash' as hash FROM memories
       WHERE type = 'standard_detail'
         AND metadata->>'parent_id' = $1
         AND status = 'active'`,
      [parentId.toString()]
    );
    const existingMap = new Map(existingResult.rows.map(r => [r.title, r]));

    const stats = { added: 0, updated: 0, deleted: 0, unchanged: 0 };
    const processedTitles = new Set();

    // 3. 處理傳入的 chunks
    for (const chunk of chunks) {
      const { title, content, hash, level } = chunk;
      processedTitles.add(title);

      const existing = existingMap.get(title);
      if (!existing) {
        // 新增
        await query(
          `INSERT INTO memories (user_id, type, title, content, tags, metadata)
           VALUES ($1, 'standard_detail', $2, $3, $4, $5)`,
          [
            req.user.id,
            title,
            content,
            ['rule_detail'],
            { parent_id: parentId, hash, level }
          ]
        );
        stats.added++;
      } else if (existing.hash !== hash) {
        // 更新
        await query(
          `UPDATE memories
           SET content = $1, metadata = $2, updated_at = NOW()
           WHERE id = $3`,
          [content, { parent_id: parentId, hash, level }, existing.id]
        );
        stats.updated++;
      } else {
        stats.unchanged++;
      }
    }

    // 4. 刪除消失的細項 (標記為 disabled)
    for (const [title, existing] of existingMap) {
      if (!processedTitles.has(title)) {
        await query(
          `UPDATE memories SET status = 'disabled', disabled_reason = 'sync_removal', updated_at = NOW() WHERE id = $1`,
          [existing.id]
        );
        stats.deleted++;
      }
    }

    const newToken = await generateSyncToken(req.user.id);
    res.json({
      status: 'ok',
      parent_id: parentId,
      stats,
      sync_token: newToken
    });
  } catch (err) {
    logger.error('批次同步規範失敗', { error: err.message });
    res.status(500).json({ error: '同步失敗' });
  }
});

export default router;
