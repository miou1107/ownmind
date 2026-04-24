import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const {
  syncMemoryFiles,
  slugTitle,
  memoryFilename,
  buildMemoryIndex,
} = await import('../hooks/lib/sync-memory-files.js');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ownmind-sync-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('slugTitle', () => {
  it('英文變小寫加底線', () => {
    assert.equal(slugTitle('Hello World Test'), 'hello_world_test');
  });
  it('中文保留', () => {
    assert.equal(slugTitle('OwnMind 專案'), 'ownmind_專案');
  });
  it('特殊字元移除', () => {
    assert.equal(slugTitle('foo/bar: baz!'), 'foo_bar_baz');
  });
  it('超長截斷', () => {
    const s = slugTitle('a'.repeat(100));
    assert.ok(s.length <= 60);
  });
  it('空字串 fallback', () => {
    assert.equal(slugTitle(''), 'untitled');
    assert.equal(slugTitle('   '), 'untitled');
  });
});

describe('memoryFilename', () => {
  it('含 type + id + slug', () => {
    const f = memoryFilename({ id: 123, type: 'project', title: 'Hello World' });
    assert.equal(f, 'project_123_hello_world.md');
  });
  it('不同 type', () => {
    const f = memoryFilename({ id: 5, type: 'iron_rule', title: 'IR-001 規則' });
    assert.equal(f, 'iron_rule_5_ir-001_規則.md');
  });
});

describe('syncMemoryFiles - first run', () => {
  it('寫 md 檔 + MEMORY.md', () => {
    const data = {
      server_time: '2026-04-24T10:00:00Z',
      memories: [
        { id: 1, type: 'iron_rule', title: 'IR-001 test', content: 'body a', updated_at: '2026-04-20T00:00:00Z', status: 'active' },
        { id: 2, type: 'project', title: 'Project X', content: 'body b', updated_at: '2026-04-22T00:00:00Z', status: 'active' },
      ],
    };
    syncMemoryFiles({ memoryDir: tmpDir, data });

    const files = fs.readdirSync(tmpDir).sort();
    assert.ok(files.includes('MEMORY.md'));
    assert.ok(files.includes('iron_rule_1_ir-001_test.md'));
    assert.ok(files.includes('project_2_project_x.md'));

    const md = fs.readFileSync(path.join(tmpDir, 'iron_rule_1_ir-001_test.md'), 'utf8');
    assert.match(md, /^---\n/);
    assert.match(md, /type: 'iron_rule'/);
    assert.match(md, /cloud_id: 1/);
    assert.match(md, /updated_at: '2026-04-20/);
    assert.match(md, /body a/);

    const memIdx = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8');
    assert.match(memIdx, /<!-- ownmind-auto-synced at 2026-04-24T10:00:00Z -->/);
    assert.match(memIdx, /## Iron Rules/);
    assert.match(memIdx, /## Projects/);
    assert.match(memIdx, /iron_rule_1_ir-001_test\.md/);
    assert.match(memIdx, /updated 2026-04-20/);
  });

  it('首次若有手寫 MEMORY.md → 備份', () => {
    const existing = '# My hand-written notes\n- item 1\n';
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), existing);

    syncMemoryFiles({
      memoryDir: tmpDir,
      data: { server_time: '2026-04-24T10:00:00Z', memories: [] },
    });

    const files = fs.readdirSync(tmpDir);
    const backup = files.find((f) => f.startsWith('MEMORY.md.pre-sync-backup'));
    assert.ok(backup, `expected backup file, got ${JSON.stringify(files)}`);
    assert.equal(fs.readFileSync(path.join(tmpDir, backup), 'utf8'), existing);
  });

  it('若已是 auto-synced 的 MEMORY.md → 不重複備份', () => {
    const existing = '<!-- ownmind-auto-synced at 2026-04-23T00:00:00Z -->\n\n# Memory Index\n';
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), existing);

    syncMemoryFiles({
      memoryDir: tmpDir,
      data: { server_time: '2026-04-24T10:00:00Z', memories: [] },
    });

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('MEMORY.md.pre-sync-backup'));
    assert.equal(backups.length, 0);
  });
});

describe('syncMemoryFiles - tombstone', () => {
  it('disabled 狀態刪掉對應 md 檔', () => {
    const target = path.join(tmpDir, 'project_42_old.md');
    fs.writeFileSync(target, 'stale');

    syncMemoryFiles({
      memoryDir: tmpDir,
      data: {
        server_time: '2026-04-24T10:00:00Z',
        memories: [
          { id: 42, type: 'project', title: 'old', content: 'x', updated_at: '2026-04-01T00:00:00Z', status: 'disabled' },
        ],
      },
    });

    assert.equal(fs.existsSync(target), false);
  });

  it('disabled 但對應檔不存在也不爆', () => {
    assert.doesNotThrow(() => syncMemoryFiles({
      memoryDir: tmpDir,
      data: {
        server_time: '2026-04-24T10:00:00Z',
        memories: [{ id: 99, type: 'project', title: 'never', content: '', updated_at: '', status: 'disabled' }],
      },
    }));
  });
});

describe('syncMemoryFiles - fail mode', () => {
  it('sync 失敗 → MEMORY.md 有警告但不刪既有檔', () => {
    fs.writeFileSync(path.join(tmpDir, 'project_1_x.md'), 'keep me');
    fs.writeFileSync(
      path.join(tmpDir, 'MEMORY.md'),
      '<!-- ownmind-auto-synced at 2026-04-20T00:00:00Z -->\n\n# Memory Index\n'
    );

    syncMemoryFiles({ memoryDir: tmpDir, sync_failed: true });

    assert.equal(fs.existsSync(path.join(tmpDir, 'project_1_x.md')), true);
    const memIdx = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8');
    assert.match(memIdx, /⚠️ last sync FAILED/);
  });

  it('fail 模式下若 MEMORY.md 不存在 → 產出一份只含警告的', () => {
    syncMemoryFiles({ memoryDir: tmpDir, sync_failed: true });
    const memIdx = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8');
    assert.match(memIdx, /⚠️ last sync FAILED/);
  });

  it('連續 fail 不重複堆疊警告', () => {
    syncMemoryFiles({ memoryDir: tmpDir, sync_failed: true });
    syncMemoryFiles({ memoryDir: tmpDir, sync_failed: true });
    const memIdx = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8');
    const count = (memIdx.match(/⚠️ last sync FAILED/g) || []).length;
    assert.equal(count, 1);
  });
});

describe('yaml quoting — frontmatter safety', () => {
  it('title 含單引號 → 被 double', () => {
    syncMemoryFiles({
      memoryDir: tmpDir,
      data: {
        server_time: '2026-04-24T10:00:00Z',
        memories: [
          { id: 77, type: 'project', title: "Vin's project", content: 'x', updated_at: '2026-04-20T00:00:00Z', status: 'active' },
        ],
      },
    });
    const md = fs.readFileSync(path.join(tmpDir, "project_77_vin_s_project.md"), 'utf8');
    assert.match(md, /name: 'Vin''s project'/);
  });

  it('title 含冒號 → 仍是合法 YAML scalar', () => {
    syncMemoryFiles({
      memoryDir: tmpDir,
      data: {
        server_time: '2026-04-24T10:00:00Z',
        memories: [
          { id: 78, type: 'project', title: 'Foo: bar "baz"', content: 'x', updated_at: '2026-04-20T00:00:00Z', status: 'active' },
        ],
      },
    });
    const md = fs.readFileSync(path.join(tmpDir, 'project_78_foo_bar_baz.md'), 'utf8');
    assert.match(md, /name: 'Foo: bar "baz"'/);
  });

  it('cloud_id 非數字 → fallback 0，不會變 YAML 注入', () => {
    syncMemoryFiles({
      memoryDir: tmpDir,
      data: {
        server_time: '2026-04-24T10:00:00Z',
        memories: [
          { id: 'NaN-attack', type: 'project', title: 'x', content: 'x', updated_at: '2026-04-20T00:00:00Z', status: 'active' },
        ],
      },
    });
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith('project_'));
    // filename includes whatever id was, but cloud_id frontmatter should be 0
    const md = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    assert.match(md, /cloud_id: 0/);
  });
});

describe('buildMemoryIndex', () => {
  it('by type 分組輸出', () => {
    const entries = [
      { id: 1, type: 'iron_rule', title: 'A', updated_at: '2026-04-20T00:00:00Z', filename: 'iron_rule_1_a.md' },
      { id: 2, type: 'project', title: 'B', updated_at: '2026-04-22T00:00:00Z', filename: 'project_2_b.md' },
      { id: 3, type: 'feedback', title: 'C', updated_at: '2026-04-10T00:00:00Z', filename: 'feedback_3_c.md' },
    ];
    const md = buildMemoryIndex(entries, '2026-04-24T10:00:00Z', false);

    assert.match(md, /<!-- ownmind-auto-synced at 2026-04-24T10:00:00Z -->/);
    assert.doesNotMatch(md, /⚠️ last sync FAILED/);
    assert.match(md, /## Iron Rules\n- \[A\]\(iron_rule_1_a\.md\) — updated 2026-04-20/);
    assert.match(md, /## Projects\n- \[B\]\(project_2_b\.md\) — updated 2026-04-22/);
    assert.match(md, /## Feedback\n- \[C\]\(feedback_3_c\.md\) — updated 2026-04-10/);
  });

  it('sync_failed → 含警告', () => {
    const md = buildMemoryIndex([], '2026-04-24T10:00:00Z', true);
    assert.match(md, /⚠️ last sync FAILED/);
  });

  it('空 entries 也能輸出最小結構', () => {
    const md = buildMemoryIndex([], '2026-04-24T10:00:00Z', false);
    assert.match(md, /# Memory Index/);
  });
});

describe('syncMemoryFiles - full re-sync after partial state', () => {
  it('第二次 sync 含 disabled 項 → 對應檔消失，新 active 項保留', () => {
    // 第一次：2 項
    syncMemoryFiles({
      memoryDir: tmpDir,
      data: {
        server_time: '2026-04-20T10:00:00Z',
        memories: [
          { id: 10, type: 'project', title: 'Alpha', content: 'a1', updated_at: '2026-04-19T00:00:00Z', status: 'active' },
          { id: 11, type: 'project', title: 'Beta', content: 'b1', updated_at: '2026-04-20T00:00:00Z', status: 'active' },
        ],
      },
    });
    assert.equal(fs.existsSync(path.join(tmpDir, 'project_10_alpha.md')), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'project_11_beta.md')), true);

    // 第二次：Alpha disabled，Beta 更新
    syncMemoryFiles({
      memoryDir: tmpDir,
      data: {
        server_time: '2026-04-24T10:00:00Z',
        memories: [
          { id: 10, type: 'project', title: 'Alpha', content: 'a1', updated_at: '2026-04-19T00:00:00Z', status: 'disabled' },
          { id: 11, type: 'project', title: 'Beta', content: 'b2', updated_at: '2026-04-23T00:00:00Z', status: 'active' },
        ],
      },
    });
    assert.equal(fs.existsSync(path.join(tmpDir, 'project_10_alpha.md')), false);
    const beta = fs.readFileSync(path.join(tmpDir, 'project_11_beta.md'), 'utf8');
    assert.match(beta, /b2/);
  });
});
