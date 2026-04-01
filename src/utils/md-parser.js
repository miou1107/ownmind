import { createHash } from 'crypto';

/**
 * 將 Markdown 按標題階層 (H1, H2, H3) 切分為 Chunk
 * 子標題會繼承父標題路徑，例如 "Parent > Sub > Detail"
 * 
 * @param {string} content Markdown 原始內容
 * @param {number} maxDepth 切分深度，預設 3
 * @returns {Array} 切分後的物件清單
 */
export function parseStandardMarkdown(content, maxDepth = 3) {
  const lines = content.split(/\r?\n/);
  const chunks = [];
  
  let currentPath = [];
  let currentSections = []; // 用於暫存同一個路徑下的多個區塊內容（如果有）
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
        // 先把目前的內容存進去
        flush();

        // 調整路徑深度
        currentPath = currentPath.slice(0, level - 1);
        currentPath[level - 1] = title;
        continue;
      }
    }
    currentLines.push(line);
  }

  // 處理最後一個區塊
  flush();

  return chunks;
}
