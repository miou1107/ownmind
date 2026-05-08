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

/**
 * v1.17.73 — 結構性 IR-007 拆雷（M-1）
 *
 * v1.17.71 → v1.17.72 踩到的雷：所有 19 條 fixture 都用 (B) shape
 *（tool_response: { content: [...] }），但 Claude Code prod MCP tool 真實
 * 送的是 (A) shape（tool_response: [...] 直接 array）。fixture 全部一致
 * 用錯誤 shape → 803/803 測試全綠但 prod 100% 抽不到 banner。典型「測試
 * 套不住 prod，因為 fixture 集體偽陽性」。
 *
 * 拆雷做法：把 fixture builder 抽成兩個 helper，多條測試混搭使用，
 * 不再「一抄錯就全錯」。新增 test 也明確標示用哪種 shape。
 *
 * 對應 prod：
 *   mcpToolResponse  → Claude Code MCP tool（mcp__ownmind__*） 真實 shape
 *   legacyToolResponse → 舊版 / 非 MCP tool 仍可能的 shape
 */
function mcpToolResponse(parts) {
  return parts;
}

function legacyToolResponse(parts) {
  return { content: parts };
}

describe('v1.17.71 — ownmind-tty-echo.cjs banner 抽取', () => {
  beforeEach(() => setupTmpHome());
  afterEach(() => cleanupTmpHome());

  it('module 檔案存在 + 可被 node 直接 spawn', () => {
    assert.ok(fs.existsSync(hookPath), 'hooks/ownmind-tty-echo.cjs 必須存在');
    const r = runHook('{}');
    assert.equal(r.status, 0, '空輸入也要正常 exit 0、不能 crash');
  });

  it('從 tool_response.content[*].text 抽出所有 【OwnMind...】 開頭的行（legacy shape）', () => {
    // 故意用 legacy {content: [...]} shape — 確保舊版 / 非 MCP tool 通道仍 work
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: legacyToolResponse([
        { type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：\n{"data":[],"hits":0}\n\n【OwnMind v1.17.71】技巧提示：你可以搜尋記憶' },
      ]),
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
      tool_response: mcpToolResponse([{ type: 'text', text: '純 JSON 沒 banner' }]),
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(pendingFile), false,
      '沒 banner 不該動 pending file');
  });

  it('同次觸發多條 banner 合併成「招牌 header + 縮排 list」一個區塊', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_get',
      tool_response: mcpToolResponse([
        { type: 'text', text: '【OwnMind v1.17.71】鐵律提醒：[IR-007]\n{...}\n\n【OwnMind v1.17.71】技巧提示：鐵律不會被刪除' },
      ]),
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

  it('支援多 content parts（legacy shape — 偶爾還是會收多 part）', () => {
    // 故意用 legacy {content: [...]} shape — 多 part 場景在 legacy 通道更常見
    const input = {
      tool_name: 'mcp__ownmind__ownmind_init',
      tool_response: legacyToolResponse([
        { type: 'text', text: '【OwnMind v1.17.71】記憶載入：已載入' },
        { type: 'text', text: '【OwnMind v1.17.71】技巧提示：你可以說「記起來」' },
      ]),
    };
    const r = runHook(input, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    const content = fs.readFileSync(pendingFile, 'utf8');
    assert.match(content, /記憶載入/);
    assert.match(content, /技巧提示/);
  });

  it('支援廣播 banner（📢 OwnMind 開頭）也要被抓出來', () => {
    const input = {
      tool_name: 'mcp__ownmind__ownmind_search',
      tool_response: mcpToolResponse([
        { type: 'text', text: '📢 OwnMind 系統通知\n[INFO] 升級到 v1.17.71\n---\n\n【OwnMind v1.17.71】記憶搜尋：...' },
      ]),
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

  // ─── 結構性合約測試（v1.17.73 引入單條 / v1.17.74 參數化 — IR-007 拆雷 ※深化）─────
  // 拆 v1.17.71 → v1.17.72 那種「fixture 集體用同一錯誤 shape」的雷。
  // 用相同 input 餵兩種 shape、比 extractBanners 結果必須一致（不論抽到 / 沒抽到）。
  //
  // v1.17.73 只覆蓋一句「kind + tip」雙 banner。reviewer 點到（v1.17.74+ m-1）：
  // broadcast / multi-part / 空 parts / 壞 parts 都沒測 — 那些路徑的 path-specific
  // bug 還是漏。v1.17.74 把 contract case 表化、跑同一邏輯、覆蓋 8 種變體。
  const contractCases = [
    {
      name: '單條 kind banner',
      parts: [{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }],
      expectBanner: true,
    },
    {
      name: '雙條 banner（kind + tip）',
      parts: [{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A\n\n【OwnMind v1.17.71】技巧提示：B' }],
      expectBanner: true,
    },
    {
      name: '廣播 banner（📢 OwnMind 系統通知）',
      parts: [{ type: 'text', text: '📢 OwnMind 系統通知\n[INFO] 升級到 v1.17.71\n---' }],
      expectBanner: true,
    },
    {
      name: '廣播 + 一般 banner 混合',
      parts: [{ type: 'text', text: '📢 OwnMind 系統通知\n升級到 v1.17.74\n---\n\n【OwnMind v1.17.71】記憶搜尋：A' }],
      expectBanner: true,
    },
    {
      name: 'banner 拆到多個 content parts',
      parts: [
        { type: 'text', text: '【OwnMind v1.17.71】鐵律提醒：[IR-007]' },
        { type: 'text', text: '【OwnMind v1.17.71】技巧提示：鐵律不會被刪除' },
      ],
      expectBanner: true,
    },
    {
      name: '空 parts array（無內容）',
      parts: [],
      expectBanner: false,
    },
    {
      name: '壞 part（type 有但 text 欄位缺）',
      parts: [{ type: 'text' }],
      expectBanner: false,
    },
    {
      name: '純文字沒 banner',
      parts: [{ type: 'text', text: 'No banner here, just plain data' }],
      expectBanner: false,
    },
  ];

  for (const c of contractCases) {
    it(`結構性合約 [${c.name}]：兩種 shape 行為必須一致`, () => {
      // (A) MCP shape
      runHook({ tool_response: mcpToolResponse(c.parts) }, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
      const aHasFile = fs.existsSync(pendingFile);
      const aBlock = aHasFile
        ? JSON.parse(fs.readFileSync(pendingFile, 'utf8').trim().split('\n').pop()).block
        : null;
      if (aHasFile) fs.unlinkSync(pendingFile);  // conditional cleanup（m-6）

      // (B) legacy shape
      runHook({ tool_response: legacyToolResponse(c.parts) }, { OWNMIND_TTY_FORCE_FALLBACK: '1' });
      const bHasFile = fs.existsSync(pendingFile);
      const bBlock = bHasFile
        ? JSON.parse(fs.readFileSync(pendingFile, 'utf8').trim().split('\n').pop()).block
        : null;

      // 兩種 shape 必須對「要不要寫 pending file」做一樣的決定
      assert.equal(aHasFile, bHasFile,
        `兩種 shape 必須一致決定 pending file 寫不寫（[${c.name}] mcp=${aHasFile} legacy=${bHasFile}）`);

      if (c.expectBanner) {
        assert.ok(aHasFile, `[${c.name}] 預期抽到 banner、應寫 pending file`);
        assert.equal(aBlock, bBlock,
          `[${c.name}] 兩種 shape 的 block 內容必須一致（path-specific bug 立刻被抓到）`);
        assert.ok(aBlock && aBlock.length > 0, `[${c.name}] block 不可為空`);
      } else {
        assert.equal(aHasFile, false, `[${c.name}] 不該抽到 banner、不該寫 pending file`);
      }
    });
  }

  it('壞掉的 JSON 輸入也不能 crash（防呆）', () => {
    const r = runHook('this is not json');
    assert.equal(r.status, 0, '壞 JSON 也要 exit 0、不擋 tool 流程');
  });

  it('exit code 永遠是 0（即使 hook 內部有錯）', () => {
    // 即使 input 完全合法但寫入失敗（force fallback + 不寫 file，模擬磁碟滿）
    const r = runHook({ tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】X：Y' }]) },
      { OWNMIND_TTY_FORCE_FALLBACK: '1' });
    assert.equal(r.status, 0);
  });

  it('Fallback 路徑 — 寫 banner-pending.jsonl 用 JSON Lines 格式（每行一個 record）', () => {
    const input = {
      tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }]),
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
      tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }]),
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
      tool_response: mcpToolResponse([{ type: 'text', text: '【OwnMind v1.17.71】記憶搜尋：A' }]),
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
