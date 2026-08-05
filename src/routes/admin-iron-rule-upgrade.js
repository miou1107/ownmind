/**
 * admin-iron-rule-upgrade.js — iron-rule upgrade-helper API (v1.18.0).
 *
 * Corresponds to spec.md §3 + tasks.md §11.
 *
 * Three endpoints:
 *   GET  /api/admin/iron-rules/upgrade-status
 *     → { total, skill_md_format, legacy_text, rules: [{id, code, title, format, tags}] }
 *   POST /api/admin/iron-rules/:id/suggest-skill-md
 *     → { suggested: '<SKILL.md content>', notes: [...] } (does not write DB)
 *   PUT  /api/admin/iron-rules/:id/upgrade { content }
 *     → { ok, format, lint_warnings? }
 *     writes DB + backs up previous_content + triggers sync (sync is
 *     handled by the existing PUT /api/memory/:id).
 *
 * Simplification: PUT delegates to the existing /api/memory/:id PUT to
 * avoid duplicating logic.
 *   - lintIronRule guards quality (added in rc1).
 *   - previous_content is auto-backed up (added in rc1).
 *   - sync_token / iron-rule sync mechanism is fully compatible.
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
import { writeAuditLog } from '../utils/audit-log.js';

// v1.26.60 kept this router deliberately, with no UI. The legacy console's 鐵律升級 tab
// was its only caller and went with the retirement, but the migration it reports on is
// far from done: measured on production 2026-08-05, 72 of 109 of one user's active iron
// rules are still legacy free text, and every other user's are. Deleting the only thing
// that can see an unfinished migration would have hidden it.

// v1.26.60: `writeAdminAudit` was here. It inserted into `admin_audit_logs`, a table no
// migration under db/ ever created — confirmed absent on production, where
// `to_regclass('public.admin_audit_logs')` returns null. So every one of those inserts
// had always thrown straight into its own catch and warned, since v1.18.0.
//
// Removed rather than fixed. Creating the table now would start collecting an audit
// trail nobody asked for, of a feature with no UI; the honest options were to write the
// rows somewhere real or to stop pretending, and the calls below were the pretence.
// The general-purpose writer that does work is src/utils/audit-log.js.

const router = Router();

router.use(adminAuth);

/**
 * GET /upgrade-status — list every active iron_rule of the current user
 * along with its format status.
 *
 * Note: filtered by req.user.id (per-user); admin sees their own user_id's
 * rules. v1.18.x could add ?user_id=N for super_admin to inspect others.
 */
router.get('/upgrade-status', async (req, res) => {
  try {
    const result = await query(
      `SELECT id, code, title, content, tags, tier
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
        // v1.19: iron-rule tier (admin UI display + edit).
        tier: r.tier || 'default',
      };
    });

    const total = rules.length;
    const skillMd = rules.filter(r => r.format === 'skill_md').length;
    const legacy = total - skillMd;

    // v1.18.0-rc3 review B2 fix: return sync_token to the client so PUT
    // upgrade must echo it back for stale checks.
    const sync_token = await generateSyncToken(req.user.id);

    res.json({
      total,
      skill_md_format: skillMd,
      legacy_text: legacy,
      rules,
      sync_token,
    });
  } catch (err) {
    logger.error('GET /upgrade-status failed', { error: err.message });
    res.status(500).json({ error: 'Query failed' });
  }
});

/**
 * POST /:id/suggest-skill-md — return a SKILL.md proposal; does not write DB.
 *
 * v1.18.0 uses template-based suggest (see iron-rule-suggest.js).
 * In the future, when OWNMIND_SUGGEST_API_KEY is set, route through LLM
 * (TODO v1.18.x).
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
      return res.status(404).json({ error: 'Iron rule not found' });
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
      // v1.18.1: the helper performs a round-trip lint self-check; expose
      // the result so the UI can show a warning.
      lint_ok: suggestion.lint_ok,
      lint_errors: suggestion.lint_errors || [],
      suggest_method: 'template',  // reserved field; future path 'llm'
    });
  } catch (err) {
    logger.error('POST /:id/suggest-skill-md failed', { error: err.message, ruleId: req.params.id });
    res.status(500).json({ error: 'Failed to produce suggestion' });
  }
});

/**
 * PUT /:id/upgrade — write DB + back up previous_content + bump sync_token.
 *
 * Pipeline:
 *   1. Run lintIronRule (rc1 schema lint); reject 400 on failure.
 *   2. UPDATE memories SET content = $new, previous_content = content.
 *   3. Write a memory_history audit row.
 *   4. Return { ok, format, lint_warnings? }.
 *
 * Note: sync_token automatically rolls forward via updated_at, so the next
 * SessionStart auto-refreshes ~/.claude/skills/ownmind-iron-rules/ on the
 * local machine (no need for the endpoint to trigger it directly).
 */
router.put('/:id/upgrade', async (req, res) => {
  try {
    const ruleId = parseInt(req.params.id, 10);
    if (Number.isNaN(ruleId)) {
      return res.status(400).json({ error: 'invalid rule id' });
    }

    const { content, sync_token, origin_event, user_quote } = req.body;
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    // v1.18.0-rc3 review B2 fix: sync_token is required, to guard against
    // cross-tab races (admin opens the modal at snapshot=A; a background
    // ownmind_save updates it to B; admin clicks confirm and would
    // overwrite previous_content with A — losing B permanently).
    if (!sync_token) {
      return res.status(400).json({
        error: 'sync_token is required; please refresh the list and retry',
        hint: 'Take sync_token from GET /upgrade-status and include it in PUT for the stale check',
      });
    }
    const tokenCheck = await validateSyncToken(req.user.id, sync_token);
    if (!tokenCheck.valid) {
      return res.status(409).json({
        error: 'Iron-rule state has changed (sync_token mismatch); please reload and retry',
        new_token: tokenCheck.new_token,
      });
    }

    // 1. Fetch the existing row and confirm ownership.
    const existing = await query(
      `SELECT id, type, title, content, tags
       FROM memories
       WHERE id = $1 AND user_id = $2 AND type = 'iron_rule' AND status = 'active'`,
      [ruleId, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Iron rule not found' });
    }

    const oldRule = existing.rows[0];

    // 2. Run lint (rc1 schema lint).
    // v1.18.3 fix: feed metadata into lint as well, so checkOriginContext
    // (v1.18.2) can see origin_context and won't falsely flag "missing".
    const lintResult = lintIronRule({
      title: oldRule.title,
      content,
      tags: oldRule.tags,
      metadata: oldRule.metadata,
    });
    if (!lintResult.ok) {
      return res.status(400).json({
        error: 'Upgrade content failed lint; fix and save again',
        errors: lintResult.errors,
        format: lintResult.format,
      });
    }

    // v1.18.2: admin supplied origin_event / user_quote → write into
    // metadata.origin_context, and auto-inject the "## 起源" section into
    // the body (rendered from metadata).
    let finalContent = content;
    let updatedMetadata = oldRule.metadata || null;
    if (origin_event || user_quote) {
      const oc = {
        captured_at: new Date().toISOString(),
        confidence: 'user_direct',  // admin filled it manually, not inferred from a session → user_direct
        event: origin_event || 'admin upgrade helper: manually backfilled (no conversation context)',
      };
      if (user_quote) oc.user_quote = user_quote;
      finalContent = injectOriginSection(content, oc);
      updatedMetadata = { ...(updatedMetadata || {}), origin_context: oc };
    }

    // 3. UPDATE — back up the previous content into previous_content.
    await query(
      `UPDATE memories
       SET content = $1,
           previous_content = $2,
           metadata = COALESCE($5, metadata),
           updated_at = NOW()
       WHERE id = $3 AND user_id = $4`,
      [finalContent, oldRule.content, ruleId, req.user.id, updatedMetadata ? JSON.stringify(updatedMetadata) : null]
    );

    // 4. memory_history audit.
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

    // v1.18.0-rc3 review I2 fix: write an admin audit log so we can trace
    // "which admin updated which iron rule".
    //
    // v1.26.60: retargeted from `admin_audit_logs` to `audit_logs`. The intent was right
    // and the destination was not — no migration ever created the other table, so this
    // trace has never once been written. Same shape, a table that exists.
    await writeAuditLog(req.user.id, 'iron_rule_upgrade', 'memory', ruleId, {
      code: oldRule.code,
      title: oldRule.title,
      old_format: 'legacy_text',
      new_format: lintResult.format,
    });

    // 5. Return a fresh sync_token so the client knows state changed.
    const newSyncToken = await generateSyncToken(req.user.id);

    res.json({
      ok: true,
      rule_id: ruleId,
      format: lintResult.format,
      lint_warnings: lintResult.warnings || [],
      sync_token: newSyncToken,
    });
  } catch (err) {
    logger.error('PUT /:id/upgrade failed', { error: err.message, ruleId: req.params.id });
    res.status(500).json({ error: 'Upgrade failed' });
  }
});

export default router;
