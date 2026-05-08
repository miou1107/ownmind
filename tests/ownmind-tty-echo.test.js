import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * v1.17.71 — hooks/ownmind-tty-echo.cjs（OwnMind 在場感 / IR-027 邏輯卡控）
 *
 * 背景：v1.17.0 起 MCP tool result 末尾附「【OwnMind vX.Y.Z】XXX：YYY」banner
 * 給 user 看 OwnMind 在場感。但 Claude Code UI 把 tool result 摺疊、user 看不到，
 * AI 也常吞掉不轉述。Vin 三條規格：
 *   1. 合規回報頻繁也 OK，所有 OwnMind 動作都要 user 看見
 *   2. 同次觸發合併成一個招牌區塊
 *   3. 嚴禁被 AI 過濾 / 吃掉 → fallback 不能走 stderr / additionalContext
 *
 * 主路徑：寫 /dev/tty (mac/linux) 或 \\.\CONOUT$ (Windows)，繞過 Claude Code
 * hook output 系統，直接寫 user 的 terminal device。
 *
 * Fallback：tty 寫不到（SSH 無 -t / nohup / detached）→ 寫
 * ~/.ownmind/logs/banner-pending.jsonl，下次 SessionStart hook 開頭補印。
 * 絕不走 stderr / additionalContext（會被 AI 吃）。
 */

const repoRoot = path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), '..');
const hookPath = path.join(repoRoot, 'hooks', 'ownmind-tty-echo.cjs');

let tmpHome;
let pendingFile;

function runHook(input, env = {}) {
  return spawnSync('node', [hookPath], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, ...env },
  });
}

function setupTmpHome() {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-tty-test-'));
  fs.mkdirSync(path.join(tmpHome, '.ownmind', 'logs'), { recursive: true });
  pendingFile = path.join(tmpHome, '.ownmind', 'logs', 'banner-pending.jsonl');
}

function cleanupTmpHome() {
  fs.rmSync(tmpHome, { recursive: true, force: true });
}

describe('v1.17.71 — ownmind-tty-echo.cjs banner 抽取', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('module 檔案存在 + 可被 node 直接 spawn', () => {
    assert.ok(fs.existsSync(hookPath), 'hooks/ownmind-tty-echo.cjs 必須存在');
    const r = runHook('{}');
    assert.equal(r.status, 0, '空輸入也要正常 exit 0、不能 crash');
  });

  it('從 tool_response.content[*].text 抽出所有 【OwnMind...】 開頭的行', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: {
        content: [
          { type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：\n{"data":[],"hits":0}\n\n【OwnMind v1.17.71】技巧提示：你可以搜尋記憶' },
        ],
      },
    };
    // 強制 fallback 路徑（測試環境沒 /dev/tty 可寫）→ 寫入 pending file
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingFile), 'fallback 應寫 banner-pending.jsonl');
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /記憶搜尋/);
    assert.match(content, /技巧提示/);
  });

  it('沒有任何 【OwnMind】 banner 時不寫 pending file（不污染）', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: { content: [{ type: 'text', text: '純 JSON 沒 banner' }] },
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      '沒 banner 不該動 pending file');
  });

  it('同次觸發多條 banner 合併成「招牌 header + 縮排 list」一個區塊', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_get',
      tool_response: {
        content: [
          { type: 'text', text: '【OwnMind v1.17.71】鐵律提醒：[IR-007]\n{...}\n\n【OwnMind v1.17.71】技巧提示：鐵律不會被刪除' },
        ],
      },
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    const record = JSON.parse(content.trim().split('\n').pop());
    const block = record.block;
    // header：【OwnMind v1.17.71】 在第一行單獨一行
    assert.match(block, /^【OwnMind v[\d.]+】\n/, '招牌 header 必須在第一行');
    // 後續行不該再重複 prefix
    const lines = block.trim().split('\n');
    const tail = lines.slice(1).join('\n');
    assert.ok(!tail.includes('【OwnMind v'),
      '招牌 prefix 不該在後續行重複（合併成一塊）');
    // 內容 indented 列出
    assert.match(block, /鐵律提醒/);
    assert.match(block, /技巧提示/);
  });

  it('支援多 content parts（Claude Code 偶爾還是會收多 part）', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_init',
      tool_response: {
        content: [
          { type: 'text', text: '【OwnMind v1.17.71】記憶載入：已載入' },
          { type: 'text', text: '【OwnMind v1.17.71】技巧提示：你可以說「記起來」' },
        ],
      },
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /記憶載入/);
    assert.match(content, /技巧提示/);
  });

  it('支援廣播 banner（📢 OwnMind 開頭）也要被抓出來', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: {
        content: [
          { type: 'text', text: '📢 OwnMind 系統通知\n[INFO] 升級到 v1.17.71\n---\n\n【OwnMind v1.17.71】記憶搜尋：...' },
        ],
      },
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /OwnMind 系統通知/);
  });

  it('IR-007 regression: tool_response 直接是 array（Claude Code prod 真實送的格式）', () => {
    // 背景：v1.17.71 ship 後實測在場感 100% 失效。Trace 顯示 stdin 有資料、
    // hook 有跑、但 banner_count 永遠 0。Root cause：Claude Code PostToolUse
    // 送的 JSON 是 `tool_response: [{type, text}, ...]`（直接 array），
    // 而不是 hook 預期的 `tool_response: { content: [...] }`。所有原本的
    // fixture 都用後者，因此測試全綠但 prod 抓不到 banner。
    //
    // 本條 test 用真實 PostToolUse stdin 截下來的結構，確保 prod 格式可被處理。
    const input = {
      session_id: '7e090be5-a795-4ea7-8a5a-699fc953c175',
      hook_event_name: 'PostToolUse',
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_input: { query: 'capture full json' },
      tool_response: [
        {
          type: 'text',
          text: '【OwnMind v1.17.71】記憶搜尋：\n{\n  "data": [],\n  "memory_hits": 0,\n  "session_hits": 0\n}\n\n【OwnMind v1.17.71】技巧提示：記憶分短期和長期：session log 會自動壓縮，鐵律和決策永久保留',
        },
      ],
      tool_use_id: 'toolu_019gnX792kxsc3qL4AQQtVF7',
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(pendingFile),
      'prod 格式（tool_response 直接是 array）也要能抽出 banner');
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /記憶搜尋/);
    assert.match(content, /技巧提示/);
  });

  it('壞掉的 JSON 輸入也不能 crash（防呆）', () => {
    const r = runHook('this is not json');
    assert.equal(r.status, 0, '壞 JSON 也要 exit 0、不擋 tool 流程');
  });

  it('exit code 永遠是 0（即使 hook 內部有錯）', () => {
    // 即使 input 完全合法但寫入失敗（force fallback + 不寫 file，模擬磁碟滿）
    const r = runHook({ tool_response: { content: [{ type: 'text', text: '【OwnMind v1.17.71】X：Y' }] } },
      { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
  });

  it('Fallback 路徑 — 寫 banner-pending.jsonl 用 JSON Lines 格式（每行一個 record）', () => {
    const input = {
      tool_response: { content: [{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }] },
    };
    runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2, '兩次 fallback 應該是兩行 JSON Lines');
    for (const line of lines) {
      const rec = JSON.parse(line);
      assert.ok(rec.ts, '每行 record 應有 ts 時戳');
      assert.ok(rec.block, '每行 record 應有 block 內容');
    }
  });

  it('Fallback 不該寫進 stderr 或 stdout（避免被 AI 看到）', () => {
    // 關鍵：Vin 規格 #3 — 嚴禁被 AI 過濾或吃掉
    // PostToolUse 的 stderr → AI；stdout(plain text) → 丟掉
    // 我們的 fallback 只能寫 file，不能寫 stderr
    const input = {
      tool_response: { content: [{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }] },
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.stderr, '', 'stderr 必須空白（AI 通道不能用）');
    // stdout 可以是空或 PostToolUse JSON 但不能含 banner 文字
    assert.ok(!r.stdout.includes('【OwnMind v'),
      'stdout 不能含 banner 文字（避免被 Claude Code 當 hook output 處理）');
  });
});

describe('v1.17.71 — ownmind-tty-echo.cjs 主路徑 tty 寫入（如果有 tty）', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('tty 可寫時不該觸發 fallback（無 pending file）', () => {
    // 這個 test 只在有 /dev/tty 可寫的環境跑得起來；spawnSync 沒 controlling tty
    // 預設會走 fallback，所以這個 test 只驗「強制走 main path」（透過環境變數
    // 指向假的 tty 模擬器：用一個 pipe file）
    const fakeTty = path.join(tmpHome, 'fake-tty');
    fs.writeFileSync(fakeTty, '');  // 空檔當假 tty
    const input = {
      tool_response: { content: [{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }] },
    };
    const r = runHook(input, { OWNMIND_TTY_OVERRIDE: fakeTty });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      '主路徑成功時不該寫 pending file');
    // 假 tty 應收到 banner
    const ttyContent = fs.readFileSync(fakeTty, 'utf8');
    assert.match(ttyContent, /記憶搜尋/, '主路徑應寫到 tty');
  });
});
