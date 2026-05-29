/**
 * iron-rule-frontmatter.js — iron-rule SKILL.md frontmatter detection + parsing (v1.18.0)
 *
 * Why it exists:
 *   v1.18.0 upgraded iron rules from free-text to the Anthropic SKILL.md format
 *   (frontmatter name + description + body), which needs a detection + parser base first.
 *
 * Design:
 *   - Detection: content starts with `---\n` and a later `\n---\n` is found -> treat as SKILL.md
 *   - No frontmatter -> treat as plain text, run v1.17.94 regex lint (backward compatible)
 *   - YAML parse failure -> treat as invalid SKILL.md (lint will reject)
 *
 * Pure function, cross-platform, zero side effects.
 */

import yaml from 'js-yaml';

/**
 * Detect + parse the SKILL.md frontmatter of an iron-rule content.
 *
 * Accepted format:
 *   ---\n
 *   <yaml>\n
 *   ---\n
 *   <markdown body...>
 *
 * @param {string} content the iron rule's content field
 * @returns {{ has: boolean, frontmatter?: object, body?: string, parseError?: string }}
 *   - has: whether a complete frontmatter was detected (both opening + closing markers present)
 *   - frontmatter: the parsed object (when YAML parse succeeds)
 *   - body: the plain markdown after the marker
 *   - parseError: the YAML parse error message (when has=true but parsing failed)
 */
export function detectFrontmatter(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return { has: false };
  }

  // Strictly require a `---\n` start (no leading whitespace, to avoid false positives)
  if (!content.startsWith('---\n')) {
    return { has: false };
  }

  // Find the closing marker `\n---\n` (do not accept `---` at EOF without a trailing newline, to avoid edge cases)
  const closeIdx = content.indexOf('\n---\n', 4);
  if (closeIdx === -1) {
    // opening marker present but no closing one -> not a valid frontmatter
    return { has: false };
  }

  const yamlText = content.slice(4, closeIdx);
  // The closing marker `\n---\n` is usually followed by a blank line (standard
  // SKILL.md style) -> strip the body's leading newlines, matching gray-matter /
  // Jekyll behaviour
  const body = content.slice(closeIdx + 5).replace(/^\n+/, '');

  let frontmatter;
  try {
    frontmatter = yaml.load(yamlText, {
      // safe mode: do not allow executing arbitrary JS (prevents yaml exploits)
      schema: yaml.JSON_SCHEMA,
    });
  } catch (e) {
    return {
      has: true,
      parseError: `YAML parse failed: ${e.message || String(e)}`,
      body,
    };
  }

  // The parse result must be an object (not null / array / scalar)
  if (frontmatter === null || frontmatter === undefined) {
    return {
      has: true,
      parseError: 'frontmatter cannot be empty',
      body,
    };
  }
  if (typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    return {
      has: true,
      parseError: 'frontmatter must be a key-value object',
      body,
    };
  }

  return { has: true, frontmatter, body };
}
