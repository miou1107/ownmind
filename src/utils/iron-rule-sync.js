/**
 * iron-rule-sync.js — iron-rule -> local file system sync helpers (v1.18.0)
 *
 * Why it exists:
 *   v1.18.0 exports iron rules as one big skill to ~/.claude/skills/ownmind-iron-rules/
 *   so Claude Code can invoke them at the platform level, not just via a SessionStart list.
 *
 *   Cross-tool sync: Cursor/Codex/Antigravity etc. read their corresponding paths
 *   (reusing the existing install.sh:300 pattern).
 *
 * Design:
 *   - Pure builders (buildBigSkillMd / buildReferenceFile) — only assemble strings, zero IO
 *   - syncToFilesystem(rules, target, options) — writes files, fs can be injected (for tests)
 *   - only writes if the directory exists (reusing the install.sh:300 "append_upgrade_rule_if_exists" pattern)
 *
 * Same pattern as the existing OwnMind ownmind-memory big skill (zero cognitive load for the user).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectFrontmatter } from './iron-rule-frontmatter.js';

// Skill / rule paths across AI tools (reusing the directory list maintained in install.sh:300)
// path is user-home-relative; the handler joins HOME itself when writing
export const TOOL_TARGETS = {
  // Claude Code: full skill folder (primary path)
  claude: { kind: 'skill_folder', dir: '.claude/skills/ownmind-iron-rules', parentDir: '.claude/skills' },
  // Cursor / Antigravity / Windsurf: a single inline file (no skill concept; placed in the rules/ dir)
  cursor: { kind: 'inline_md', path: '.cursor/rules/ownmind-iron-rules.md', parentDir: '.cursor/rules' },
  antigravity: { kind: 'inline_md', path: '.antigravity/rules/ownmind-iron-rules.md', parentDir: '.antigravity/rules' },
  windsurf: { kind: 'inline_md', path: '.windsurf/rules/ownmind-iron-rules.md', parentDir: '.windsurf/rules' },
  // Codex / OpenCode / Gemini: append a marker-wrapped block to AGENTS.md / GEMINI.md
  codex: { kind: 'agents_md_block', path: '.codex/AGENTS.md', parentDir: '.codex' },
  opencode: { kind: 'agents_md_block', path: '.opencode/AGENTS.md', parentDir: '.opencode' },
  gemini: { kind: 'agents_md_block', path: '.gemini/GEMINI.md', parentDir: '.gemini' },
};

const BLOCK_MARKER_START = '<!-- ownmind-iron-rules:start -->';
const BLOCK_MARKER_END = '<!-- ownmind-iron-rules:end -->';

/**
 * Build a trigger-category index from the iron-rule list; returns Map<trigger, rule[]>
 */
function buildTriggerIndex(rules) {
  const index = new Map();
  for (const rule of rules) {
    const tags = Array.isArray(rule.tags) ? rule.tags : [];
    const triggers = tags
      .filter(t => typeof t === 'string' && t.startsWith('trigger:'))
      .map(t => t.slice('trigger:'.length));
    if (triggers.length === 0) {
      // rules without a trigger go to 'general'
      const list = index.get('general') || [];
      list.push(rule);
      index.set('general', list);
      continue;
    }
    for (const trig of triggers) {
      const list = index.get(trig) || [];
      list.push(rule);
      index.set(trig, list);
    }
  }
  return index;
}

function ruleSlug(rule) {
  // IR-XXX -> ir-xxx / use id when there is no code
  const code = rule.code || `id-${rule.id}`;
  return code.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function ruleReferenceRelativePath(rule) {
  // use a title slug for readability; the code prefix is sort-friendly
  const slug = ruleSlug(rule);
  const titleSlug = String(rule.title || '')
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return titleSlug ? `${slug}-${titleSlug}.md` : `${slug}.md`;
}

/**
 * Build the big SKILL.md content (frontmatter + index body)
 *
 * @param {Array<{id, code, title, content, tags, status}>} rules — active iron_rule list
 * @returns {string} full SKILL.md content (for ~/.claude/skills/ownmind-iron-rules/SKILL.md)
 */
export function buildBigSkillMd(rules) {
  const total = rules.length;
  const triggerIndex = buildTriggerIndex(rules);

  // pushy description — aligned with the standard SKILL.md style (spec.md §4.3)
  const description =
    `Use whenever you do ANY action covered by Vin's iron rules: code edits, ` +
    `git commits, deploys, debugging, doc updates, AI quality issues, secret handling. ` +
    `OwnMind has ${total} iron rules learned from real production incidents. ` +
    `ALWAYS consult this when about to commit, deploy, delete, edit code, or ` +
    `write any user-facing response. Read the index below; load detailed rules ` +
    `from references/ as needed.`;

  const lines = [];
  lines.push('---');
  lines.push('name: ownmind-iron-rules');
  lines.push('description: |');
  for (const line of description.match(/.{1,90}(\s|$)/g) || [description]) {
    lines.push(`  ${line.trim()}`);
  }
  lines.push('---');
  lines.push('');
  lines.push('# OwnMind Iron Rules');
  lines.push('');
  lines.push(`Vin 個人鐵律集合 — 從歷史踩坑學來的、必須嚴格遵守的工作規則（共 ${total} 條）。`);
  lines.push('');
  lines.push('## 觸發索引（按 trigger 分類）');
  lines.push('');

  // sort the trigger keys (makes the output deterministic and test-friendly)
  const sortedTriggers = [...triggerIndex.keys()].sort();
  for (const trig of sortedTriggers) {
    const rulesInTrig = triggerIndex.get(trig);
    lines.push(`### trigger: ${trig}`);
    lines.push('');
    for (const rule of rulesInTrig) {
      const code = rule.code || `id-${rule.id}`;
      const refPath = `references/${ruleReferenceRelativePath(rule)}`;
      lines.push(`- **${code}**: ${rule.title} → \`${refPath}\``);
    }
    lines.push('');
  }

  lines.push('## 如何使用');
  lines.push('');
  lines.push('當你要做某個 trigger 對應的動作時、查上方索引找到相關鐵律、讀 references/ 對應檔案拿到完整 do/dont 細節。');
  lines.push('');

  return lines.join('\n');
}

/**
 * Build a single rule reference file content
 *
 * already SKILL.md format -> return content as-is
 * legacy free-text -> auto-add a minimal frontmatter (auto-generated marker)
 */
export function buildReferenceFile(rule) {
  const content = String(rule.content || '');
  const fm = detectFrontmatter(content);

  if (fm.has && !fm.parseError) {
    // already valid SKILL.md, export as-is
    return content;
  }

  // legacy -> auto-wrap with frontmatter
  const code = rule.code || `id-${rule.id}`;
  const tags = Array.isArray(rule.tags) ? rule.tags : [];
  const triggers = tags
    .filter(t => typeof t === 'string' && t.startsWith('trigger:'))
    .map(t => t.slice('trigger:'.length))
    .join(', ') || 'general';

  const autoName = ruleSlug(rule);
  const autoDesc =
    `${code}: ${rule.title}. ` +
    `Triggers on: ${triggers}. ` +
    `(auto-generated frontmatter from legacy text rule — Vin can upgrade via /admin)`;

  const lines = [];
  lines.push('---');
  lines.push(`name: ${autoName}`);
  lines.push('description: |');
  for (const line of autoDesc.match(/.{1,90}(\s|$)/g) || [autoDesc]) {
    lines.push(`  ${line.trim()}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(`# ${code}: ${rule.title}`);
  lines.push('');
  lines.push(content);
  lines.push('');

  return lines.join('\n');
}

/**
 * Sync iron rules to a single tool target.
 *
 * @param {Array} rules - active iron_rule list
 * @param {keyof TOOL_TARGETS} targetKey - 'claude' / 'cursor' / 'codex' / ...
 * @param {Object} options
 * @param {string} [options.home] - HOME dir override (for tests)
 * @param {object} [options.fsModule] - fs module override (mock fs for tests)
 * @returns {{ written: boolean, reason?: string, files?: string[] }}
 *   - written: false if the parent dir does not exist (tool not installed, skip)
 *   - files: list of written file paths
 */
export function syncToFilesystem(rules, targetKey, options = {}) {
  const target = TOOL_TARGETS[targetKey];
  if (!target) return { written: false, reason: `unknown target: ${targetKey}` };

  const home = options.home || os.homedir();
  const fsMod = options.fsModule || fs;

  // only write if the parent dir exists (reusing the install.sh:300 pattern "install only if the dir exists, skip uninstalled ones")
  const parentAbs = path.join(home, target.parentDir);
  if (!fsMod.existsSync(parentAbs)) {
    return { written: false, reason: `parent dir not found: ${target.parentDir} (tool not installed)` };
  }

  const filesWritten = [];

  if (target.kind === 'skill_folder') {
    // Claude Code: ~/.claude/skills/ownmind-iron-rules/SKILL.md + references/*.md
    const skillDir = path.join(home, target.dir);
    const refDir = path.join(skillDir, 'references');
    fsMod.mkdirSync(refDir, { recursive: true });

    // write the big SKILL.md
    const bigSkillPath = path.join(skillDir, 'SKILL.md');
    atomicWriteFileSync(fsMod, bigSkillPath, buildBigSkillMd(rules));
    filesWritten.push(bigSkillPath);

    // clear old reference files (avoid leftovers from disabled iron rules)
    try {
      const existing = fsMod.readdirSync(refDir);
      for (const f of existing) {
        if (f.endsWith('.md')) {
          try { fsMod.unlinkSync(path.join(refDir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* refDir was just created, may have no files yet */ }

    // write each reference
    for (const rule of rules) {
      const refPath = path.join(refDir, ruleReferenceRelativePath(rule));
      atomicWriteFileSync(fsMod, refPath, buildReferenceFile(rule));
      filesWritten.push(refPath);
    }
  } else if (target.kind === 'inline_md') {
    // Cursor / Antigravity / Windsurf: one file, concatenating the big skill + all references
    const fileAbs = path.join(home, target.path);
    fsMod.mkdirSync(path.dirname(fileAbs), { recursive: true });
    const inlineLines = [];
    inlineLines.push(buildBigSkillMd(rules));
    inlineLines.push('');
    inlineLines.push('---');
    inlineLines.push('');
    inlineLines.push('# 各鐵律完整內容');
    for (const rule of rules) {
      inlineLines.push('');
      inlineLines.push(`## ${rule.code || rule.id}: ${rule.title}`);
      inlineLines.push('');
      inlineLines.push(buildReferenceFile(rule));
    }
    atomicWriteFileSync(fsMod, fileAbs, inlineLines.join('\n'));
    filesWritten.push(fileAbs);
  } else if (target.kind === 'agents_md_block') {
    // Codex / OpenCode / Gemini: append a marker-wrapped block to an existing AGENTS.md / GEMINI.md
    const fileAbs = path.join(home, target.path);
    let existing = '';
    try { existing = fsMod.readFileSync(fileAbs, 'utf8'); } catch { /* file does not exist; the later write will create it */ }

    // remove the old block (rewrite)
    const re = new RegExp(`${escapeRegExp(BLOCK_MARKER_START)}[\\s\\S]*?${escapeRegExp(BLOCK_MARKER_END)}\\n?`, 'g');
    const cleaned = existing.replace(re, '');

    const newBlock = [
      BLOCK_MARKER_START,
      '',
      '# OwnMind Iron Rules（自動同步、勿手改）',
      '',
      buildBigSkillMd(rules),
      '',
      BLOCK_MARKER_END,
    ].join('\n');

    atomicWriteFileSync(fsMod, fileAbs, cleaned + (cleaned.endsWith('\n') || cleaned === '' ? '' : '\n') + newBlock + '\n');
    filesWritten.push(fileAbs);
  }

  return { written: true, files: filesWritten };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Atomic file write: writeFileSync + rename
 * Avoids reading a half-written state during concurrent multi-window Claude Code SessionStart (review I1)
 */
function atomicWriteFileSync(fsMod, filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fsMod.writeFileSync(tmp, content);
    fsMod.renameSync(tmp, filePath);
  } catch (e) {
    // rollback: clean up tmp
    try { fsMod.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * Sync to all detected tools. Skip undetected tools silently.
 * @returns {Array<{target, written, reason?, files?}>}
 */
export function syncToAllTools(rules, options = {}) {
  const results = [];
  for (const targetKey of Object.keys(TOOL_TARGETS)) {
    const r = syncToFilesystem(rules, targetKey, options);
    results.push({ target: targetKey, ...r });
  }
  return results;
}
