/**
 * On a Mac or Linux machine `ps` shows every account the full command line of every process.
 * The shell scripts handed the API key to curl as `-H "Authorization: Bearer $KEY"`, to
 * `node -e` inside the program text, and to helper scripts as a plain argument, so anybody
 * logged in to the same machine could read it while the command ran. The session-start hook
 * does this at the start of every conversation.
 *
 * A process's environment and standard input are visible to its owner only, so the key now
 * travels there: `ownmind_curl_auth "$KEY" | curl -K -`, and environment variables for node.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const SCRIPTS = ['install.sh', 'hooks/ownmind-session-start.sh', 'scripts/check-sync.sh',
  'scripts/interactive-upgrade.sh', 'scripts/update.sh', 'scripts/verify-upgrade.sh'];

/** Code lines only: comments and the usage text may mention the forms below. */
const codeLines = (text) => text.split('\n')
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => !/^\s*#/.test(line) && !/^\s*echo /.test(line));

const KEY_VAR = String.raw`\$\{?(API_KEY|api_key)\}?`;
const FORBIDDEN = [
  { what: 'key in a curl -H argument', re: new RegExp(String.raw`Bearer ${KEY_VAR}`) },
  { what: 'key spliced into node program text', re: new RegExp(String.raw`'${KEY_VAR}'`) },
  { what: 'key passed as a --key argument', re: new RegExp(String.raw`--key "${KEY_VAR}"`) },
  { what: 'key passed as a plain argument to a helper', re: new RegExp(String.raw`(cli\.js"|install\.sh) [^\n]*"${KEY_VAR}"`) },
];

describe('no shell script puts the API key on a command line', () => {
  for (const rel of SCRIPTS) {
    it(rel, () => {
      const hits = [];
      for (const { line, n } of codeLines(read(rel))) {
        for (const { what, re } of FORBIDDEN) if (re.test(line)) hits.push(`${rel}:${n} ${what}: ${line.trim()}`);
      }
      assert.deepEqual(hits, []);
    });
  }

  it('every script that calls ownmind_curl_auth defines it', () => {
    for (const rel of SCRIPTS) {
      const text = read(rel);
      if (text.includes('ownmind_curl_auth "')) assert.match(text, /^ownmind_curl_auth\(\) \{/m, rel);
    }
  });
});

describe('helpers take the key from the environment', () => {
  it('register-mcp-cli --key-env reads the named variable and registers that key', async () => {
    const { tempDir } = await import('./helpers/temp-dir.js');
    const home = tempDir('ownmind-keyenv-');
    const KEY = '11111111-1111-4111-8111-111111111111';
    const r = spawnSync(process.execPath, [path.join(root, 'scripts/install-helpers/register-mcp-cli.cjs'),
      '--command', 'node', '--arg', 'x', '--url', 'https://example.invalid', '--key-env', 'OWNMIND_INSTALL_KEY',
      '--home', home], { encoding: 'utf8', env: { ...process.env, OWNMIND_INSTALL_KEY: KEY } });
    assert.match(r.stdout, /VERIFIED/, r.stdout + r.stderr);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    assert.equal(cfg.mcpServers.ownmind.env.OWNMIND_API_KEY, KEY);
  });

  it('install.sh takes the key from OWNMIND_INSTALL_KEY when the first argument is empty', () => {
    assert.match(read('install.sh'), /^API_KEY="\$\{1:-\$\{OWNMIND_INSTALL_KEY:-\}\}"$/m);
  });

  it('conditional-sync-cli reads OWNMIND_HOOK_KEY before falling back to the old argument', () => {
    assert.match(read('hooks/lib/conditional-sync-cli.js'), /process\.env\.OWNMIND_HOOK_KEY \|\| process\.argv\[3\]/);
  });
});

const bashWorks = spawnSync('bash', ['-s'], { input: 'command -v curl', encoding: 'utf8' }).status === 0;

describe('ownmind_curl_auth: what actually reaches the server', () => {
  let server;
  let port;
  const seen = [];
  before(async () => {
    server = http.createServer((req, res) => { seen.push(req.headers.authorization); res.end('ok'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => server.close());

  // The function as defined in install.sh, which runs before anything else is on disk.
  const fn = () => {
    const m = read('install.sh').match(/^ownmind_curl_auth\(\) \{[\s\S]*?^\}/m);
    assert.ok(m, 'install.sh defines ownmind_curl_auth');
    return m[0];
  };

  async function send(key) {
    const script = `${fn()}\nownmind_curl_auth "$K" | curl -K - -s -o /dev/null "http://127.0.0.1:${port}/"`;
    // The script on stdin, not as `-c` text: Windows' argument quoting eats backslashes.
    const child = spawn('bash', ['-s'], { env: { ...process.env, K: key } });
    child.stdin.end(script);
    await new Promise((r) => child.on('close', r));
    return seen.at(-1);
  }

  it('sends the key as the Authorization header', { skip: !bashWorks && 'bash with curl not available' }, async () => {
    assert.equal(await send('11111111-1111-4111-8111-111111111111'), 'Bearer 11111111-1111-4111-8111-111111111111');
  });

  it('a key with a quote or a backslash arrives unchanged', { skip: !bashWorks && 'bash with curl not available' }, async () => {
    assert.equal(await send('a"b\\c'), 'Bearer a"b\\c');
  });
});
