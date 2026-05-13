/**
 * iron-rule-sync.js — 鐵律 → 本地 file system sync helpers (v1.18.0)
 *
 * 為什麼存在：
 *   v1.18.0 把鐵律 export 成 1 big skill 到 ~/.claude/skills/ownmind-iron-rules/
 *   讓 Claude Code 平台級主動 invoke、不只靠 SessionStart 塞列表。
 *
 *   跨工具 sync：Cursor/Codex/Antigravity 等也讀對應路徑（沿用 install.sh:300 既有 pattern）。
 *
 * 設計：
 *   - Pure builders（buildBigSkillMd / buildReferenceFile）— 只組字串、零 IO
 *   - syncToFilesystem(rules, target, options) — 寫檔、可注入 fs（測試用）
 *   - 偵測目錄存在才寫（沿用 install.sh:300 「append_upgrade_rule_if_exists」pattern）
 *
 * 跟 OwnMind 既有 ownmind-memory big skill 同模式（user 認知負擔 0）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectFrontmatter } from './iron-rule-frontmatter.js';

// 跨 AI 工具的 skill / rule 路徑（沿用 install.sh:300 已維護的目錄列表）
// path 是 user-home-relative、handler 寫入時自己 join HOME
export const TOOL_TARGETS = {
  // Claude Code: 完整 skill folder（主路徑）
  claude: { kind: 'skill_folder', dir: '.claude/skills/ownmind-iron-rules', parentDir: '.claude/skills' },
  // Cursor / Antigravity / Windsurf: inline 單檔（沒 skill 概念、塞 rules/ 目錄）
  cursor: { kind: 'inline_md', path: '.cursor/rules/ownmind-iron-rules.md', parentDir: '.cursor/rules' },
  antigravity: { kind: 'inline_md', path: '.antigravity/rules/ownmind-iron-rules.md', parentDir: '.antigravity/rules' },
  windsurf: { kind: 'inline_md', path: '.windsurf/rules/ownmind-iron-rules.md', parentDir: '.windsurf/rules' },
  // Codex / OpenCode / Gemini: AGENTS.md / GEMINI.md append 含 marker 的 block
  codex: { kind: 'agents_md_block', path: '.codex/AGENTS.md', parentDir: '.codex' },
  opencode: { kind: 'agents_md_block', path: '.opencode/AGENTS.md', parentDir: '.opencode' },
  gemini: { kind: 'agents_md_block', path: '.gemini/GEMINI.md', parentDir: '.gemini' },
};

const BLOCK_MARKER_START = '<!-- ownmind-iron-rules:start -->';
const BLOCK_MARKER_END = '<!-- ownmind-iron-rules:end -->';

/**
 * 從鐵律 list 推 trigger 分類索引、回 Map<trigger, rule[]>
 */
function buildTriggerIndex(rules) {
  const index = new Map();
  for (const rule of rules) {
    const tags = Array.isArray(rule.tags) ? rule.tags : [];
    const triggers = tags
      .filter(t => typeof t === 'string' && t.startsWith('trigger:'))
      .map(t => t.slice('trigger:'.length));
    if (triggers.length === 0) {
      // 無 trigger 的鐵律歸 'general'
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
  // IR-002 → ir-002 / 無 code 用 id
  const code = rule.code || `id-${rule.id}`;
  return code.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function ruleReferenceRelativePath(rule) {
  // 用 title slug 加可讀性、code prefix 排序友善
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
 * @param {Array<{id, code, title, content, tags, status}>} rules — active iron_rule 列表
 * @returns {string} SKILL.md 完整內容（給 ~/.claude/skills/ownmind-iron-rules/SKILL.md 用）
 */
export function buildBigSkillMd(rules) {
  const total = rules.length;
  const triggerIndex = buildTriggerIndex(rules);

  // pushy description — 對齊 SKILL.md 標準寫法（spec.md §4.3）
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

  // 排序 trigger keys（讓輸出 deterministic、test 友善）
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
 * 已是 SKILL.md format → 原樣回 content
 * Legacy free-text → 自動補 minimal frontmatter（auto-generated 標記）
 */
export function buildReferenceFile(rule) {
  const content = String(rule.content || '');
  const fm = detectFrontmatter(content);

  if (fm.has && !fm.parseError) {
    // 已是合法 SKILL.md、原樣 export
    return content;
  }

  // Legacy → 自動包 frontmatter
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
 * @param {string} [options.home] - HOME dir override (測試用)
 * @param {object} [options.fsModule] - fs module override (測試用 mock fs)
 * @returns {{ written: boolean, reason?: string, files?: string[] }}
 *   - written: false if 父目錄不存在（沒裝該工具、skip）
 *   - files: 寫入的檔案 path 列表
 */
export function syncToFilesystem(rules, targetKey, options = {}) {
  const target = TOOL_TARGETS[targetKey];
  if (!target) return { written: false, reason: `unknown target: ${targetKey}` };

  const home = options.home || os.homedir();
  const fsMod = options.fsModule || fs;

  // 偵測父目錄存在才寫（沿用 install.sh:300 pattern「目錄存在才裝、跳過未裝的」）
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

    // 寫 big SKILL.md
    const bigSkillPath = path.join(skillDir, 'SKILL.md');
    atomicWriteFileSync(fsMod, bigSkillPath, buildBigSkillMd(rules));
    filesWritten.push(bigSkillPath);

    // 清掉舊的 reference files（避免 disabled 鐵律殘留）
    try {
      const existing = fsMod.readdirSync(refDir);
      for (const f of existing) {
        if (f.endsWith('.md')) {
          try { fsMod.unlinkSync(path.join(refDir, f)); } catch { /* ignore */ }
        }
      }
    } catch { /* refDir 剛建可能還沒檔 */ }

    // 寫每條 reference
    for (const rule of rules) {
      const refPath = path.join(refDir, ruleReferenceRelativePath(rule));
      atomicWriteFileSync(fsMod, refPath, buildReferenceFile(rule));
      filesWritten.push(refPath);
    }
  } else if (target.kind === 'inline_md') {
    // Cursor / Antigravity / Windsurf: 一個檔、把 big skill + 所有 reference 串起來
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
    // Codex / OpenCode / Gemini: append 含 marker 的 block 到既有 AGENTS.md / GEMINI.md
    const fileAbs = path.join(home, target.path);
    let existing = '';
    try { existing = fsMod.readFileSync(fileAbs, 'utf8'); } catch { /* 檔不存在、之後 write 會建 */ }

    // 移除舊 block（重新寫）
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
 * 避免 multi-window Claude Code 並發 SessionStart 時讀到半寫狀態 (review I1)
 */
function atomicWriteFileSync(fsMod, filePath, content) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fsMod.writeFileSync(tmp, content);
    fsMod.renameSync(tmp, filePath);
  } catch (e) {
    // rollback：tmp 清掉
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
