import { createHash } from 'crypto';

/**
 * Split Markdown into chunks by heading hierarchy (H1, H2, H3).
 * Sub-headings inherit the parent heading path, e.g. "Parent > Sub > Detail".
 *
 * @param {string} content raw Markdown content
 * @param {number} maxDepth split depth, default 3
 * @returns {Array} list of chunk objects
 */
export function parseStandardMarkdown(content, maxDepth = 3) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  
  let currentPath = [];
  let currentSections = []; // buffers multiple section bodies under the same path (if any)
  let currentLines = [];

  function flush() {
    if (currentLines.length === 0 && currentPath.length === 0) return;
    
    const text = currentLines.join('\n').trim();
    if (text || currentPath.length > 0) {
      const title = currentPath.join(' > ');
      chunks.push({
        title,
        content: text,
        level: currentPath.length,
        hash: createHash('sha256').update(text).digest('hex'),
      });
    }
    currentLines = [];
  }

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const title = headerMatch[2].trim();

      if (level <= maxDepth) {
        // flush the current content first
        flush();

        // adjust path depth
        currentPath = currentPath.slice(0, level - 1);
        currentPath[level - 1] = title;
        continue;
      }
    }
    currentLines.push(line);
  }

  // handle the final section
  flush();

  return chunks;
}
