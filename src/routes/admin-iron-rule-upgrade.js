/**
 * admin-iron-rule-upgrade.js — 鐵律升級助手 API (v1.18.0)
 *
 * 對應 spec.md §3 + tasks.md §11
 *
 * 三個 endpoint：
 *   GET  /api/admin/iron-rules/upgrade-status
 *     → { total, skill_md_format, legacy_text, rules: [{id, code, title, format, tags}] }
 *   POST /api/admin/iron-rules/:id/suggest-skill-md
 *     → { suggested: '<SKILL.md content>', notes: [...] } (不寫 DB)
 *   PUT  /api/admin/iron-rules/:id/upgrade { content }
 *     → { ok, format, lint_warnings? }
 *     寫 DB + 備份 previous_content + 觸發 sync (sync 由既有 PUT /api/memory/:id 處理)
 *
 * 簡化策略：PUT 直接代理到既有 /api/memory/:id PUT、避免 duplicate logic
 *   - lintIronRule 卡品質 (rc1 已加)
 *   - previous_content 自動備份 (rc1 已加)
 *   - sync_token / 鐵律 sync 機制全相容
 */

import { Router } from 'express';
import { query } from '../utils/db.js';
import adminAuth from '../middleware/adminAuth.js';
import logger from '../utils/logger.js';
import { detectFrontmatter } from '../utils/iron-rule-frontmatter.js';
import { lintIronRule } from '../utils/iron-rule-quality.js';
import { suggestSkillMdFormat } from '../utils/iron-rule-suggest.js';
import { generateSyncToken, validateSyncToken } from '../utils/syncToken.js';
import { injectOriginSection } from '../utils/iron-rule-origin-context.js';

// audit log writer — 跟 src/routes/admin.js writeAuditLog 同 schema
async function writeAdminAudit(actorId, action, targetType, targetId, details) {
  try {
    await query(
      `INSERT INTO admin_audit_logs (actor_id, action, target_type, target_id, details, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [actorId, action, targetType, String(targetId), JSON.stringify(details || {})]
    );
  } catch (e) {
    logger.warn('admin audit log 寫入失敗、不擋主流程', { error: e.message, action, targetId });
  }
}

const router = Router();

router.use(adminAuth);

/**
 * GET /upgrade-status — 列出目前 user 所有 active iron_rule + format status
 *
 * Note: 用 req.user.id 過濾 (per-user)、admin 看自己的 user_id 鐵律
 *   v1.18.x 可加 ?user_id=N 給 super_admin 看別人
 */
router.get('/upgrade-status', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, code, title, content, tags
       FROM memories
       WHERE user_id = $1
         AND type = 'iron_rule'
         AND status = 'active'
       ORDER BY code NULLS LAST, created_at`,
      [req.user.id]
    );

    const rules = result.rows.map(r => {
      const fm = detectFrontmatter(String(r.content || ''));
      const isSkillMd = fm.has && !fm.parseError;
      return {
        id: r.id,
        code: r.code || `id-${r.id}`,
        title: r.title,
        format: isSkillMd ? 'skill_md' : 'legacy_text',
        tags: r.tags || [],
      };
    });

    const total = rules.length;
    const skillMd = rules.filter(r => r.format === 'skill_md').length;
    const legacy = total - skillMd;

    // v1.18.0-rc3 review B2 修正：回 sync_token 給 client、PUT upgrade 必須帶上做 stale check
    const sync_token = await generateSyncToken(req.user.id);

    res.json({
      total,
      skill_md_format: skillMd,
      legacy_text: legacy,
      rules,
      sync_token,
    });
  } catch (err) {
    logger.error('GET /upgrade-status 失敗', { error: err.message });
    res.status(500).json({ error: '查詢失敗' });
  }
});

/**
 * POST /:id/suggest-skill-md — 推 SKILL.md proposal、不寫 DB
 *
 * v1.18.0 用 template-based suggest (見 iron-rule-suggest.js)
 * 未來 OWNMIND_SUGGEST_API_KEY 設定就走 LLM (TODO v1.18.x)
 */
router.post('/:id/suggest-skill-md', async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id, 10);
    if (Number.isNaN(ruleId)) {
      return res.status(400).json({ error: 'invalid rule id' });
    }

    const result = await query(
      `SELECT id, code, title, content, tags
       FROM memories
       WHERE id = $1 AND user_id = $2 AND type = 'iron_rule' AND status = 'active'`,
      [ruleId, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: '找不到該鐵律' });
    }

    const rule = result.rows[0];
    const suggestion = suggestSkillMdFormat(rule);

    res.json({
      rule_id: rule.id,
      code: rule.code,
      title: rule.title,
      original_content: rule.content,
      proposed_content: suggestion.proposed_content,
      already_skill_md: suggestion.already_skill_md,
      notes: suggestion.notes,
      // v1.18.1: helper 內 round-trip lint self-check 結果、UI 可顯示 warning
      lint_ok: suggestion.lint_ok,
      lint_errors: suggestion.lint_errors || [],
      suggest_method: 'template',  // 未來 'llm' 路徑保留欄位
    });
  } catch (err) {
    logger.error('POST /:id/suggest-skill-md 失敗', { error: err.message, ruleId: req.params.id });
    res.status(500).json({ error: '產生建議失敗' });
  }
});

/**
 * PUT /:id/upgrade — 寫 DB + 備份 previous_content + 觸發 sync_token bump
 *
 * 流程：
 *   1. 跑 lintIronRule (rc1 schema lint)、不過 reject 400
 *   2. UPDATE memories SET content = $new, previous_content = content
 *   3. 寫 memory_history audit
 *   4. 回 { ok, format, lint_warnings? }
 *
 * 注意：sync_token 自動因 updated_at 變動而變、SessionStart 下次自動 refresh、
 * 本機 ~/.claude/skills/ownmind-iron-rules/ 自動更新（不需 endpoint 主動 trigger）
 */
router.put('/:id/upgrade', async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id, 10);
    if (Number.isNaN(ruleId)) {
      return res.status(400).json({ error: 'invalid rule id' });
    }

    const { content, sync_token, origin_event, user_quote } = req.body;
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content 必填' });
    }

    // v1.18.0-rc3 review B2 修正：sync_token 必填、防跨 tab race
    //   (admin 開 modal 時拿到 snapshot=A、背景 ownmind_save 改成 B、
    //    admin 點 confirm 升級 → previous_content 被覆寫成 A、B 永久遺失)
    if (!sync_token) {
      return res.status(400).json({
        error: 'sync_token 必填、請刷新列表後重試',
        hint: '從 GET /upgrade-status 拿 sync_token、PUT 帶上做 stale check',
      });
    }
    const tokenCheck = await validateSyncToken(req.user.id, sync_token);
    if (!tokenCheck.valid) {
      return res.status(409).json({
        error: '鐵律狀態已變動 (sync_token 不一致)、請重新載入後再升級',
        new_token: tokenCheck.new_token,
      });
    }

    // 1. 取舊 row 確認所有權
    const existing = await query(
      `SELECT id, type, title, content, tags
       FROM memories
       WHERE id = $1 AND user_id = $2 AND type = 'iron_rule' AND status = 'active'`,
      [ruleId, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: '找不到該鐵律' });
    }

    const oldRule = existing.rows[0];

    // 2. 跑 lint (rc1 schema lint)
    // v1.18.3 fix: metadata 也餵進 lint、checkOriginContext (v1.18.2) 才看得到
    // origin_context 不會誤報「沒帶」
    const lintResult = lintIronRule({
      title: oldRule.title,
      content,
      tags: oldRule.tags,
      metadata: oldRule.metadata,
    });
    if (!lintResult.ok) {
      return res.status(400).json({
        error: '升級內容沒過 lint、修正後再儲存',
        errors: lintResult.errors,
        format: lintResult.format,
      });
    }

    // v1.18.2: admin 補了 origin_event / user_quote → 寫進 metadata.origin_context
    // + 自動 inject「## 起源」段落到 body (從 metadata render)
    let finalContent = content;
    let updatedMetadata = oldRule.metadata || null;
    if (origin_event || user_quote) {
      const oc = {
        captured_at: new Date().toISOString(),
        confidence: 'user_direct',  // admin 手填、不是從 session 推、視為 user_direct
        event: origin_event || 'admin 升級助手手動補（無對話脈絡）',
      };
      if (user_quote) oc.user_quote = user_quote;
      finalContent = injectOriginSection(content, oc);
      updatedMetadata = { ...(updatedMetadata || {}), origin_context: oc };
    }

    // 3. UPDATE — 備份原 content 到 previous_content
    await query(
      `UPDATE memories
       SET content = $1,
           previous_content = $2,
           metadata = COALESCE($5, metadata),
           updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [finalContent, oldRule.content, ruleId, req.user.id, updatedMetadata ? JSON.stringify(updatedMetadata) : null]
    );

    // 4. memory_history audit
    await query(
      `INSERT INTO memory_history (memory_id, changed_by, change_type, content, metadata)
       VALUES ($1, $2, 'update', $3, $4)`,
      [
        ruleId,
        'admin-iron-rule-upgrade',
        oldRule.content,
        JSON.stringify({ source: 'iron_rule_upgrade_helper', upgrade_to: lintResult.format }),
      ]
    );

    // v1.18.0-rc3 review I2 修正：補 admin audit log、追「哪個 admin」改了「哪條鐵律」
    await writeAdminAudit(req.user.id, 'iron_rule_upgrade', 'memory', ruleId, {
      code: oldRule.code,
      title: oldRule.title,
      old_format: 'legacy_text',
      new_format: lintResult.format,
    });

    // 5. 回新 sync_token (給 client 知道狀態變了)
    const newSyncToken = await generateSyncToken(req.user.id);

    res.json({
      ok: true,
      rule_id: ruleId,
      format: lintResult.format,
      lint_warnings: lintResult.warnings || [],
      sync_token: newSyncToken,
    });
  } catch (err) {
    logger.error('PUT /:id/upgrade 失敗', { error: err.message, ruleId: req.params.id });
    res.status(500).json({ error: '升級失敗' });
  }
});

export default router;
