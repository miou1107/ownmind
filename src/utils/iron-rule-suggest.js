/**
 * iron-rule-suggest.js — iron-rule SKILL.md upgrade suggestion generator (v1.18.0)
 *
 * Why it exists:
 *   The v1.18.0 upgrade-assistant Web UI converts the 35 legacy iron rules into
 *   SKILL.md format one by one.
 *   Each conversion flow: admin clicks [Suggest] -> server pushes a SKILL.md
 *   proposal -> diff view -> admin review -> [Confirm] writes to the DB.
 *
 *   v1.18.0 does not call an LLM API (avoids a new dependency + key management +
 *   complex LLM failure paths); it uses template-based mechanical assembly. Reasons:
 *     1. AI proposals often drift, Vin edits them anyway, template-based is enough
 *     2. adding an LLM in v1.18.x is easy (the interface is fixed)
 *     3. 35 rules x 1 min review = 35 min, doable without an LLM
 *
 *   Future option to switch to an LLM: detect the OWNMIND_SUGGEST_API_KEY env;
 *   if present go LLM, otherwise use the template.
 *
 * Pure function — pure string transformation, easy to test.
 */

import crypto from 'node:crypto';
import { detectFrontmatter } from './iron-rule-frontmatter.js';
import { lintIronRule } from './iron-rule-quality.js';

/**
 * Turn a legacy iron_rule into a SKILL.md proposal
 *
 * Logic:
 *   - already SKILL.md -> return as-is (note "already upgraded, no change needed")
 *   - legacy -> mechanically assemble frontmatter + body from title + content + tags
 *     - name = ir-XXX-{slug(title)} (kebab-case)
 *     - description = pushy three sentences: purpose + trigger point + consequence
 *     - body = add structured sections (why it exists / do / don't / if violated) extracted from content
 *
 * @param {Object} rule { id, code, title, content, tags }
 * @returns {{ already_skill_md: boolean, proposed_content: string, notes: string[] }}
 */
export function suggestSkillMdFormat(rule) {
  const content = String(rule?.content || '').trim();
  const title = String(rule?.title || '').trim();
  const code = rule?.code || `id-${rule?.id || 'unknown'}`;
  const tags = Array.isArray(rule?.tags) ? rule.tags : [];

  // already SKILL.md
  const fm = detectFrontmatter(content);
  if (fm.has && !fm.parseError) {
    return {
      already_skill_md: true,
      proposed_content: content,
      notes: ['Already in SKILL.md format, no upgrade needed'],
    };
  }

  const triggers = tags
    .filter(t => typeof t === 'string' && t.startsWith('trigger:'))
    .map(t => t.slice('trigger:'.length));

  const notes = [];

  // 1. name — use code (normalize first)
  const name = normalizeName(code, title);

  // 2. description — pushy three parts
  const description = buildDescription({ code, title, triggers });

  // 3. body — split the existing content into structured sections (keep the original text as much as possible)
  const body = buildBody({ code, title, content });

  // assemble frontmatter + body
  const proposed = [
    '---',
    `name: ${name}`,
    'description: |',
    ...description.split('\n').map(l => `  ${l}`),
    '---',
    '',
    body,
  ].join('\n');

  notes.push('Template-based suggestion: description uses the pushy three-sentence style; body is structured from the original content');
  notes.push('LLM suggest is not enabled (OWNMIND_SUGGEST_API_KEY not set); the template result may need admin fine-tuning');
  if (triggers.length === 0) {
    notes.push('The original iron rule has no trigger:xxx tag; description uses a general trigger — strongly recommend adding a trigger tag');
  }

  // v1.18.1 A: round-trip lint self-check — the helper validates its own output against lint
  // Previously (rc3) it did not; the upgrade assistant only got rejected by the server on click, a fixture/prod mismatch
  // Now the helper runs lint itself and, if it fails, adds a warning to notes for the admin
  const lintCheck = lintIronRule({
    title: rule.title,
    content: proposed,
    tags: rule.tags,
  });
  if (!lintCheck.ok) {
    notes.push(`⚠️ Template proposal did not pass lint (will be rejected by the server): ${lintCheck.errors.join(' / ')}`);
    notes.push('Admin must fix it manually before saving; do not just click confirm');
  }
  if (lintCheck.warnings && lintCheck.warnings.length > 0) {
    for (const w of lintCheck.warnings) notes.push(`Hint: ${w}`);
  }

  return {
    already_skill_md: false,
    proposed_content: proposed,
    notes,
    lint_ok: lintCheck.ok,
    lint_errors: lintCheck.errors,
  };
}

/**
 * Combine an IR-XXX code and title into a kebab-case ASCII name
 *   IR-XXX + 不要 commit .env → ir-xxx-cmt-a1b2c3
 *   id-339 + 修報表... → id-339-rpt-d4e5f6
 *
 * v1.18.0-rc3 review I4 fix: previously used a Chinese title slug, dangerous for
 *   cross-platform fs (macOS NFC/NFD normalize mismatch, Linux cross-platform git path breaks)
 *   -> changed to ASCII only: keep the leading ASCII words of the title (up to 6 chars) + a 6-char title hash
 */
function normalizeName(code, title) {
  const codeLower = code.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Grab the ASCII words in the title (commit / env / build etc.) for human recognition
  const asciiHint = (title.toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter(w => w.length >= 3)
    .slice(0, 2)
    .join('-')
    .slice(0, 12);

  // 6-char hash keeps the collision probability low enough and stays deterministic
  const hash = crypto.createHash('sha1').update(title).digest('hex').slice(0, 6);

  if (asciiHint) {
    return `${codeLower}-${asciiHint}-${hash}`;
  }
  return `${codeLower}-${hash}`;
}

/**
 * Build a pushy description (~100-200 chars)
 * Three-part form: use when ... required because ... triggers on ...
 */
function buildDescription({ code, title, triggers }) {
  const triggerStr = triggers.length > 0 ? triggers.join(', ') : 'general';
  const lines = [];
  lines.push(`Use this rule whenever you do work that may touch: ${triggerStr}.`);
  lines.push(`${code}「${title}」是你從歷史踩坑學來的硬規定、必須嚴格遵守。`);
  lines.push(`Triggers on: ${triggerStr}. ALWAYS consult body do/dont before action.`);
  return lines.join('\n');
}

/**
 * Build the body: keep the original content + a markdown comment hint (no placeholder sections)
 *
 * v1.18.0-rc3 review I1 fix: the body previously held a 「（從原內容拆出該做事項）」
 *   placeholder section that passed lint S6/S7, and admins shipped it without filling
 *   it in -> 35 placeholders got written to the DB
 *   -> changed to keep only the original content + an HTML comment hint, letting the
 *   admin decide whether to structure it
 *   a markdown comment `<!-- -->` is not rendered and does not count as a placeholder
 */
function buildBody({ code, title, content }) {
  const lines = [];
  lines.push(`# ${code}: ${title}`);
  lines.push('');
  lines.push('<!--');
  lines.push('  💡 升級提示：建議拆成「為什麼存在 / 該做 / 不該做 / 萬一犯了」結構化段落、AI 看得更清楚');
  lines.push('  保留原內容也可、lint 只要求 body 含「該做」「不該做」「規則」「必須」等關鍵字之一');
  lines.push('-->');
  lines.push('');
  lines.push(content);
  return lines.join('\n');
}
