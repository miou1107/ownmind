/**
 * ownmind_upload_standard could read any local file and publish it to the whole team, and the
 * server route behind it never ran the secret scan every other memory write runs. Security
 * review 2026-10-03, item 10.
 *
 * Sample keys are assembled at run time: this repository's own commit scan uses the same
 * detector, and a literal sample would block it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkStandardUpload } from '../src/utils/standard-upload-check.js';
import { checkStandardFile, MAX_BYTES } from '../mcp/lib/standard-file-guard.js';
import { tempDir } from './helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const GH_KEY = 'gh' + 'p_' + 'aB3'.repeat(12);

describe('server: batch-sync-standard scans every chunk', () => {
  const chunk = (title, content) => ({ title, content, level: 2, hash: 'a'.repeat(64) });

  it('refuses a key in a chunk body, and says which chunk', () => {
    const r = checkStandardUpload({ parent_title: 'Deploy', chunks: [chunk('Intro', 'hello'), chunk('Token', `use ${GH_KEY}`)] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
    assert.equal(r.body.chunk_index, 1);
    assert.equal(r.body.section, 2, 'sections are counted from 1');
    assert.equal(r.body.chunk_title, undefined, 'the title may be the secret itself');
    assert.equal(r.body.matched_text, undefined, 'the matched text goes back into a conversation');
    assert.match(r.body.detected_by, /github_pat/);
  });

  it('refuses a key in a heading or in the standard title', () => {
    assert.equal(checkStandardUpload({ parent_title: 'x', chunks: [chunk(GH_KEY, 'body')] }).ok, false);
    assert.equal(checkStandardUpload({ parent_title: `x ${GH_KEY}`, chunks: [] }).ok, false);
  });

  it('a standard ABOUT passwords is not a password', () => {
    const r = checkStandardUpload({
      parent_title: '密碼政策',
      chunks: [chunk('密碼長度', '密碼至少 12 碼，token 要每 90 天換一次，金鑰不得寫進程式碼。')],
    });
    assert.deepEqual(r, { ok: true });
  });

  it('a malformed chunk is a 400, not a crash', () => {
    const r = checkStandardUpload({ parent_title: 'x', chunks: [{ title: 'a' }] });
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it('the route runs it before the sync token and before any write', () => {
    const src = read('src', 'routes', 'memory.js');
    const start = src.indexOf("router.post('/batch-sync-standard'");
    const body = src.slice(start, src.indexOf('\nrouter.', start + 1) === -1 ? undefined : src.indexOf('\nrouter.', start + 1));
    const scan = body.indexOf('checkStandardUpload(');
    assert.ok(scan > 0, 'the route does not call checkStandardUpload');
    assert.ok(scan < body.indexOf('checkSyncToken('), 'scan must come before the sync token check');
    assert.ok(scan < body.indexOf('INSERT INTO'), 'scan must come before any write');
  });
});

describe('client: which files ownmind_upload_standard may read', () => {
  const tmp = tempDir('om-std-');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  const write = (rel, text = '# Title\n\nbody\n') => {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    return p;
  };

  it('a Markdown file in an ordinary folder is fine', () => {
    const p = write('docs/standard.md');
    const r = checkStandardFile(p, { home });
    assert.equal(r.ok, true, r.error);
    // .native, as the guard uses: on a Windows runner the temp folder is `RUNNER~1`, and the
    // guard expands short names on purpose (that is how `SSH~1` gets recognised as `.ssh`).
    assert.equal(r.realPath, fs.realpathSync.native(p));
  });

  it('refuses anything that is not Markdown: key files, configs, .env', () => {
    for (const rel of ['.ssh/id_rsa', '.claude.json', 'proj/.env', 'notes.txt']) {
      const r = checkStandardFile(write(rel), { home });
      assert.equal(r.ok, false, rel);
      assert.match(r.error, /Markdown/, rel);
    }
  });

  it('refuses a Markdown file inside a credentials folder', () => {
    const r = checkStandardFile(write('.ssh/notes.md'), { home });
    assert.equal(r.ok, false);
    assert.match(r.error, /holds credentials/);
    assert.equal(checkStandardFile(write('.aws/README.md'), { home }).ok, false);
  });

  it('refuses a relative path, a missing file, a folder, and an oversized file', () => {
    assert.equal(checkStandardFile('docs/standard.md', { home }).ok, false);
    assert.equal(checkStandardFile(path.join(home, 'nope.md'), { home }).ok, false);
    fs.mkdirSync(path.join(home, 'dir.md'), { recursive: true });
    assert.match(checkStandardFile(path.join(home, 'dir.md'), { home }).error, /regular file|EISDIR|EPERM|EACCES/);
    const big = write('big.md', 'x'.repeat(MAX_BYTES + 1));
    assert.match(checkStandardFile(big, { home }).error, /at most/);
  });

  it('a .md symlink pointing at a key file is judged by where it points', (t) => {
    const target = write('.ssh/id_ed25519');
    const link = path.join(home, 'innocent.md');
    try { fs.symlinkSync(target, link); } catch { t.skip('cannot create symlinks here'); return; }
    const r = checkStandardFile(link, { home });
    assert.equal(r.ok, false);
  });

  it('the tool checks the file and scans it before staging, and the session id is not Math.random', () => {
    const src = read('mcp', 'index.js');
    const start = src.indexOf('case "ownmind_upload_standard"');
    const body = src.slice(start, src.indexOf('case "ownmind_confirm_upload"'));
    const guard = body.indexOf('checkStandardFile(');
    assert.ok(guard > 0, 'the tool does not call checkStandardFile');
    assert.doesNotMatch(body, /readFileSync\(/, 'the guard reads the file itself, on the handle it checked');
    assert.match(body, /fileCheck\.content/);
    assert.ok(body.indexOf('checkStandardUpload(') < body.indexOf('pendingUploads.set('), 'scan before staging');
    assert.doesNotMatch(body, /Math\.random/);
  });
});

// ------------------------------------------------------------- review round, same day

describe('review: what the server scan still let through', () => {
  const chunk = (content, title = 'Setup') => ({ title, content, level: 2, hash: 'a'.repeat(64) });
  const refused = (content) => checkStandardUpload({ parent_title: 'Deploy', chunks: [chunk(content)] });
  const begin = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';
  const rsa = '-----BEGIN ' + 'RSA PRIVATE KEY-----';

  it('an SSH private key — the file this fix was written about — is refused', () => {
    for (const header of [begin, rsa]) {
      const r = refused(`Put this on the server:\n\n${header}\n${'b3BlbnNzaC1rZXktdjEAAAAA'.repeat(3)}\n`);
      assert.equal(r.ok, false, header);
      assert.match(r.body.detected_by, /private_key_block/);
    }
  });

  it('env-file lines with real-looking values, and passwords in connection URLs', () => {
    for (const text of [
      'DB_PASSWORD=Hunter2xyz' + '!987',
      'API_TOKEN=abcd1234' + 'efgh5678',
      'export AWS_SECRET_ACCESS_KEY="wJalrXUtnFEMI' + '7K7MDENG"',
      'postgres://admin:S3cr3tPass' + 'w0rd@db.internal:5432/app',
      'redis://:onlyPassw0rd' + '@cache:6379',
    ]) assert.equal(refused(text).ok, false, text);
  });

  it('placeholders a deployment standard is full of stay allowed', () => {
    for (const text of [
      'API_KEY=your-key-here',
      'DB_PASSWORD=<password>',
      'TOKEN=${TOKEN}',
      'SECRET=changeme123',
      'API_TOKEN=xxxxxxxx',
      'postgres://user:<password>@host/db',
      'mysql://root:${DB_PASSWORD}@db',
      'https://user:****@example.com',
      'DB_PASSWORD 至少 12 碼，每 90 天更換一次',
      'Set PASSWORD=1 to enable the prompt',
    ]) assert.deepEqual(refused(text), { ok: true }, text);
  });

  it('formats added to the shared detector are caught too', () => {
    for (const key of [
      'AI' + 'za' + 'Sy' + 'aB3'.repeat(11),
      'gl' + 'pat-' + 'aB3'.repeat(7),
      'xo' + 'xb-' + '1234-abcd'.repeat(2),
      'h' + 'f_' + 'aB3'.repeat(11),
    ]) assert.equal(refused(`key: ${key}`).ok, false, key);
  });

  it('hash and level are checked, since they are stored as sent', () => {
    const bad = (extra) => checkStandardUpload({ parent_title: 'x', chunks: [{ title: 't', content: 'c', ...extra }] });
    assert.equal(bad({ level: 'x' }).status, 400);
    assert.equal(bad({ level: 99 }).status, 400);
    assert.equal(bad({ hash: 'not-a-hash' }).status, 400);
    assert.equal(bad({ level: 3, hash: 'f'.repeat(64) }).ok, true);
  });
});

describe('review: what the file check still let through', () => {
  const tmp = tempDir('om-std2-');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });

  it('a hard link to a key file is refused — there is no link to resolve', (t) => {
    const target = path.join(home, '.ssh', 'id_rsa');
    fs.writeFileSync(target, 'not a real key');
    const link = path.join(home, 'notes.md');
    try { fs.linkSync(target, link); } catch { t.skip('cannot create hard links here'); return; }
    const r = checkStandardFile(link, { home });
    assert.equal(r.ok, false);
    assert.match(r.error, /hard link/);
  });

  it('a network path is refused', () => {
    assert.match(checkStandardFile('\\\\localhost\\c$\\x.md', { home }).error, /Network/);
    assert.match(checkStandardFile('//server/share/x.md', { home }).error, /Network/);
  });

  it('the content returned is the content checked', () => {
    const p = path.join(home, 'ok.md');
    fs.writeFileSync(p, '# Hello\n\nworld\n');
    const r = checkStandardFile(p, { home });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.content, '# Hello\n\nworld\n');
    assert.equal(r.size, Buffer.byteLength(r.content));
  });

  it('the refusal message names the section by number, never by its title', () => {
    const src = read('mcp', 'index.js');
    const start = src.indexOf('case "ownmind_upload_standard"');
    const body = src.slice(start, src.indexOf('case "ownmind_confirm_upload"'));
    assert.doesNotMatch(body, /chunk_title/);
    assert.match(body, /secretCheck\.body\.section/);
  });
});
