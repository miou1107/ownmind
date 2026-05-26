#!/usr/bin/env node
/**
 * OwnMind TTY Echo Hook (v1.17.71)
 *
 * 設計目的（Vin 三條規格）：
 *   1. 所有 OwnMind 動作（記憶讀寫、鐵律觸發、合規回報、廣播）都讓 user 看見
 *   2. 同次觸發多條 banner 合併成一個招牌區塊（不重複 prefix）
 *   3. 嚴禁被 AI 過濾或吃掉 — 不寫 stderr / stdout / additionalContext
 *
 * 為什麼這個 hook 存在：
 *   Claude Code 把 MCP tool result 摺疊成卡片、user 看不到；AI 也常吞掉不轉述。
 *   我們從 PostToolUse hook 攔截 tool result，挑出「【OwnMind vX.Y.Z】XXX：YYY」
 *   開頭的 banner，直接寫到 user terminal device，繞過 Claude Code hook output 系統。
 *
 * 主路徑（Mac/Linux）：開 /dev/tty 寫入
 * 主路徑（Windows）：開 \\.\CONOUT$ 寫入
 * Fallback：寫 ~/.ownmind/logs/banner-pending.jsonl，下次 SessionStart hook 補印。
 *
 * 永遠 exit 0，不擋 tool 流程。stdout / stderr 都不寫（避免被 AI 通道吃到）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 測試開關：
// OWNMIND_TTY_FORCE_FALLBACK=1 → 跳過 tty 主路徑，強制走 fallback
// OWNMIND_TTY_OVERRIDE=<path>  → tty 路徑用這個檔（測試時指向 fake tty）
const FORCE_FALLBACK = process.env.OWNMIND_TTY_FORCE_FALLBACK === '1';
const TTY_OVERRIDE = process.env.OWNMIND_TTY_OVERRIDE || '';

const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const PENDING_FILE = path.join(HOME, '.ownmind', 'logs', 'banner-pending.jsonl');

main();

async function main() {
  try {
    const input = await readStdin();
    const banners = extractBanners(input);
    if (banners.length === 0) {
      // 沒 banner 不污染任何東西
      process.exit(0);
      return;
    }
    const block = formatBlock(banners);
    if (!block) {
      process.exit(0);
      return;
    }
    const wrote = !FORCE_FALLBACK && writeToTty(block);
    if (!wrote) {
      writeFallback(block);
    }
  } catch {
    // 永遠 exit 0、永不 crash
  }
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) {
      // 沒人餵 stdin、不阻塞
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    // 安全網：1 秒沒收到任何資料就放棄
    setTimeout(() => resolve(buf), 1000).unref();
  });
}

/**
 * 從 hook input JSON 抽出所有「【OwnMind vX.Y.Z】XXX：YYY」 + 「📢 OwnMind ...」 banner。
 *
 * @param {string} rawJson  Claude Code hook stdin JSON
 * @returns {Array<{ kind: 'banner', version: string, eventLine: string } |
 *                 { kind: 'broadcast', text: string }>}
 */
function extractBanners(rawJson) {
  let parsed;
  try { parsed = JSON.parse(rawJson || '{}'); }
  catch { return []; }

  // Claude Code PostToolUse 實測會送兩種 tool_response 結構：
  //   (A) 直接 array：tool_response: [{type, text}, ...]   ← MCP tool 走這條
  //   (B) wrap 在 content：tool_response: { content: [...] }  ← 其他 tool / 舊版
  // v1.17.71 只處理 (B)，導致 prod MCP banner 抽不到。兩種都要支援。
  const tr = parsed.tool_response || parsed.toolResponse || {};
  let contentParts;
  if (Array.isArray(tr)) {
    contentParts = tr;
  } else if (Array.isArray(tr.content)) {
    contentParts = tr.content;
  } else {
    contentParts = [];
  }
  const fullText = contentParts
    .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
  if (!fullText) return [];

  const lines = fullText.split('\n');
  const banners = [];

  // 廣播 block：📢 OwnMind 系統通知 ... 直到 ---
  let broadcastBuf = null;
  for (const line of lines) {
    if (broadcastBuf) {
      broadcastBuf.push(line);
      if (line.trim() === '---') {
        banners.push({ kind: 'broadcast', text: broadcastBuf.join('\n') });
        broadcastBuf = null;
      }
      continue;
    }
    if (line.startsWith('📢 OwnMind')) {
      broadcastBuf = [line];
      continue;
    }
    // Match both legacy 【】 brand banner and new [] format (v1.22.0+).
    // Some product files still emit 【】 until their own i18n pass lands.
    const m = line.match(/^(?:【OwnMind\s+(v[\d.]+)】|\[OwnMind\s+(v[\d.]+)\]\s*)(.+?)\s*$/);
    if (m) {
      const version = m[1] || m[2];
      const eventLine = m[3];
      banners.push({ kind: 'banner', version, eventLine });
    }
  }
  // 廣播沒收尾的也算（防呆）
  if (broadcastBuf && broadcastBuf.length > 1) {
    banners.push({ kind: 'broadcast', text: broadcastBuf.join('\n') });
  }
  return banners;
}

/**
 * 把 banner 陣列合併成單一招牌區塊。
 *
 * 格式：
 *   📢 OwnMind 系統通知（如有）
 *   ...
 *   ---
 *
 *   【OwnMind v1.17.71】
 *     記憶搜尋
 *     技巧提示：你可以搜尋記憶
 */
function formatBlock(banners) {
  if (!Array.isArray(banners) || banners.length === 0) return null;

  const out = [];

  // 廣播區塊先出
  for (const b of banners) {
    if (b.kind === 'broadcast') {
      out.push(b.text);
      out.push('');
    }
  }

  // OwnMind banner 合併成「招牌 header + 縮排 list」
  const eventBanners = banners.filter((b) => b.kind === 'banner');
  if (eventBanners.length > 0) {
    const version = eventBanners[0].version || '';
    out.push(`[OwnMind ${version}]`);
    for (const b of eventBanners) {
      // 拿掉結尾單獨的 「：」（多行事件如「記憶搜尋：」結尾是冒號 + 換行）
      const cleaned = b.eventLine.replace(/：\s*$/, '');
      out.push(`  ${cleaned}`);
    }
  }
  if (out.length === 0) return null;
  return out.join('\n');
}

/**
 * 嘗試寫到 user terminal device。成功回 true、失敗回 false。
 * 絕不寫 stderr / stdout（會被 Claude Code 當 hook 通道處理 → AI 看到）。
 */
function writeToTty(block) {
  const ttyPath = TTY_OVERRIDE || (process.platform === 'win32' ? '\\\\.\\CONOUT$' : '/dev/tty');
  let fd = null;
  try {
    fd = fs.openSync(ttyPath, 'a');
    fs.writeSync(fd, '\n' + block + '\n');
    fs.closeSync(fd);
    return true;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return false;
  }
}

/**
 * Fallback：寫進 ~/.ownmind/logs/banner-pending.jsonl，下次 SessionStart 補印。
 * 每行 JSON 一個 record（JSON Lines 格式）。
 *
 * 嚴禁寫 stderr / stdout（規格 #3：不能被 AI 過濾）。
 */
// 防無限增長：banner-pending.jsonl 超過 1 MB 時 rotate 成 .old（覆蓋舊的）。
// 1 MB ≈ 10k records，遠超任何合理積壓量。
// 想像場景：non-tty long-running script 永遠跑不到下次 SessionStart 補印 → 檔案無限長。
const PENDING_FILE_MAX_BYTES = 1024 * 1024;

function writeFallback(block) {
  try {
    const dir = path.dirname(PENDING_FILE);
    fs.mkdirSync(dir, { recursive: true });
    try {
      const stat = fs.statSync(PENDING_FILE);
      if (stat.size > PENDING_FILE_MAX_BYTES) {
        try { fs.renameSync(PENDING_FILE, PENDING_FILE + '.old'); } catch { /* ignore */ }
      }
    } catch { /* file 不存在 → 不需要 rotate */ }
    const record = { ts: new Date().toISOString(), block };
    fs.appendFileSync(PENDING_FILE, JSON.stringify(record) + '\n');
  } catch {
    // 連 fallback 都失敗就放棄；絕不寫 stderr
  }
}
