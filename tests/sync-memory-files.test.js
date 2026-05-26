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
  it('English lowercases and joins with underscore', () => {
    assert.equal(slugTitle('Hello World Test'), 'hello_world_test');
  });
  it('Chinese characters preserved', () => {
    assert.equal(slugTitle('OwnMind 專案'), 'ownmind_專案');
  });
  it('special characters stripped', () => {
    assert.equal(slugTitle('foo/bar: baz!'), 'foo_bar_baz');
  });
  it('overly long inputs are truncated', () => {
    const s = slugTitle('a'.repeat(100));
    assert.ok(s.length <= 60);
  });
  it('empty string fallback', () => {
    assert.equal(slugTitle(''), 'untitled');
    assert.equal(slugTitle('   '), 'untitled');
  });
});

describe('memoryFilename', () => {
  it('includes type + id + slug', () => {
    const f = memoryFilename({ id: 123, type: 'project', title: 'Hello World' });
    assert.equal(f, 'project_123_hello_world.md');
  });
  it('different type', () => {
    const f = memoryFilename({ id: 5, type: 'iron_rule', title: 'IR-001 規則' });
    assert.equal(f, 'iron_rule_5_ir-001_規則.md');
  });
});

describe('syncMemoryFiles - first run', () => {
  it('writes md files + MEMORY.md', () => {
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

  it('first run with a hand-written MEMORY.md → backs it up', () => {
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

  it('if MEMORY.md is already auto-synced → no duplicate backup', () => {
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
  it('disabled status deletes the corresponding md file', () => {
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

  it('disabled without a matching file does not crash', () => {
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
  it('sync failure → MEMORY.md gets a warning, existing files are not deleted', () => {
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

  it('in fail mode, if MEMORY.md is missing → emit one that contains only the warning', () => {
    syncMemoryFiles({ memoryDir: tmpDir, sync_failed: true });
    const memIdx = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8');
    assert.match(memIdx, /⚠️ last sync FAILED/);
  });

  it('repeated failures do not stack duplicate warnings', () => {
    syncMemoryFiles({ memoryDir: tmpDir, sync_failed: true });
    syncMemoryFiles({ memoryDir: tmpDir, sync_failed: true });
    const memIdx = fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8');
    const count = (memIdx.match(/⚠️ last sync FAILED/g) || []).length;
    assert.equal(count, 1);
  });
});

describe('yaml quoting — frontmatter safety', () => {
  it('title containing a single quote → quoted by doubling', () => {
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

  it('title containing a colon → still a valid YAML scalar', () => {
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

  it('non-numeric cloud_id → falls back to 0, no YAML injection', () => {
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
  it('groups output by type', () => {
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

  it('sync_failed → includes the warning', () => {
    const md = buildMemoryIndex([], '2026-04-24T10:00:00Z', true);
    assert.match(md, /⚠️ last sync FAILED/);
  });

  it('empty entries still emit the minimal structure', () => {
    const md = buildMemoryIndex([], '2026-04-24T10:00:00Z', false);
    assert.match(md, /# Memory Index/);
  });
});

describe('syncMemoryFiles - full re-sync after partial state', () => {
  it('second sync includes disabled entries → matching files disappear, new active entries retained', () => {
    // First run: two entries.
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

    // Second run: Alpha disabled, Beta updated.
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
