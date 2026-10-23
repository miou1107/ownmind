import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from './helpers/temp-dir.js';

/**
 * The installer's ASK:/FIX:/NEXT: lines (zero-touch-install, Tasks 10 and 12).
 *
 * install-messages.cjs turns a code into the line the AI relays to the colleague, in the
 * colleague's language. The shell and PowerShell scripts carry the English sentence as a
 * literal for the moment before any node exists on the machine; this file pins those
 * literals to hooks/locales/en.json so the two cannot drift.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const messages = require('../scripts/install-helpers/install-messages.cjs');
const cli = path.join(repoRoot, 'scripts', 'install-helpers', 'install-messages.cjs');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'hooks', 'locales', rel), 'utf8'));
const zh = read('zh.json');
const en = read('en.json');
const ja = read('ja.json');
const enOverride = read('en.override.json');
const jaOverride = read('ja.override.json');

const KEYS = [
  'install.ask.no_network',
  'install.ask.node_download',
  'install.ask.disk_full',
  'install.ask.unsupported_os',
  'install.next.verify_manual_terminal',
  'install.next.verify_manual_generic',
  'install.verify.session_title',
  'install.notify.loaded',
  'install.notify.not_loaded',
];

describe('install-messages dictionary entries', () => {
  it('every install.* key exists in zh, en and ja, and is pinned in both override files', () => {
    for (const key of KEYS) {
      for (const [name, dict] of [['zh', zh], ['en', en], ['ja', ja], ['en.override', enOverride], ['ja.override', jaOverride]]) {
        assert.equal(typeof dict[key], 'string', `${name}.json is missing ${key}`);
        assert.ok(dict[key].length > 0, `${name}.json has an empty ${key}`);
      }
      assert.equal(en[key], enOverride[key], `en.json and en.override.json disagree on ${key}`);
      assert.equal(ja[key], jaOverride[key], `ja.json and ja.override.json disagree on ${key}`);
    }
  });

  it('the Chinese source says it is pending the product owner approval', () => {
    assert.match(String(zh._comment_install), /pending/);
  });
});

describe('askLine / fixLine / nextLine', () => {
  it('askLine returns ASK:<code>:<sentence> in the requested language', () => {
    assert.equal(messages.askLine('no_network', 'zh'), `ASK:no_network:${zh['install.ask.no_network']}`);
    assert.equal(messages.askLine('no_network', 'en'), `ASK:no_network:${en['install.ask.no_network']}`);
    assert.equal(messages.askLine('disk_full', 'ja'), `ASK:disk_full:${ja['install.ask.disk_full']}`);
    assert.equal(messages.askLine('node_download', 'zh'), `ASK:node_download:${zh['install.ask.node_download']}`);
  });

  it('an unknown or missing locale falls back to English', () => {
    assert.equal(messages.askLine('disk_full', 'fr'), `ASK:disk_full:${en['install.ask.disk_full']}`);
    assert.equal(messages.askLine('disk_full'), `ASK:disk_full:${en['install.ask.disk_full']}`);
    assert.equal(messages.askLine('disk_full', null), `ASK:disk_full:${en['install.ask.disk_full']}`);
  });

  it('an unknown ASK code throws instead of printing a line the AI cannot act on', () => {
    assert.throws(() => messages.askLine('no_such_code', 'en'), /no_such_code/);
  });

  it('fixLine returns FIX:<code>:<command>', () => {
    assert.equal(messages.fixLine('clear_partial', 'rm -rf ~/.ownmind.partial'), 'FIX:clear_partial:rm -rf ~/.ownmind.partial');
  });

  it('nextLine returns NEXT:<kind> with an optional detail', () => {
    assert.equal(messages.nextLine('verify:new-session'), 'NEXT:verify:new-session');
    assert.equal(messages.nextLine('verify:manual', 'hello there'), 'NEXT:verify:manual:hello there');
  });

  it('a line break inside a sentence is collapsed so the ASK or NEXT line stays one line', () => {
    assert.equal(messages.flat('first\r\nsecond\nthird'), 'first second third');
    for (const key of KEYS) {
      for (const lang of ['zh', 'en', 'ja']) assert.doesNotMatch(messages.sentence(key, lang), /[\r\n]/);
    }
  });

  it('sentence returns one dictionary value, English when the language lacks it', () => {
    assert.equal(messages.sentence('install.verify.session_title', 'zh'), zh['install.verify.session_title']);
    assert.equal(messages.sentence('install.verify.session_title', 'xx'), en['install.verify.session_title']);
  });
});

describe('detectLocale', () => {
  it('OWNMIND_LOCALE_FORCE wins, then LC_ALL / LANG, and C or POSIX is ignored', () => {
    assert.equal(messages.detectLocale({ OWNMIND_LOCALE_FORCE: 'ja', LANG: 'zh_TW.UTF-8' }, { skipSystem: true }), 'ja');
    assert.equal(messages.detectLocale({ LANG: 'zh_TW.UTF-8' }, { skipSystem: true }), 'zh');
    assert.equal(messages.detectLocale({ LC_ALL: 'ja_JP.UTF-8', LANG: 'en_US.UTF-8' }, { skipSystem: true }), 'ja');
    assert.equal(messages.detectLocale({ LANG: 'en_US.UTF-8' }, { skipSystem: true }), 'en');
    assert.equal(messages.detectLocale({ LANG: 'C' }, { skipSystem: true }), 'en');
    assert.equal(messages.detectLocale({}, { skipSystem: true }), 'en');
  });

  it('an unusable force value is ignored', () => {
    assert.equal(messages.detectLocale({ OWNMIND_LOCALE_FORCE: 'fr', LANG: 'zh_TW.UTF-8' }, { skipSystem: true }), 'zh');
  });
});

describe('command line form', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });

  it('ask <code> --locale zh prints the Chinese ASK line', () => {
    const r = run(['ask', 'no_network', '--locale', 'zh']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `ASK:no_network:${zh['install.ask.no_network']}\n`);
  });

  it('ask without --locale follows OWNMIND_LOCALE_FORCE', () => {
    const r = run(['ask', 'disk_full'], { OWNMIND_LOCALE_FORCE: 'ja' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `ASK:disk_full:${ja['install.ask.disk_full']}\n`);
  });

  it('an unknown code exits non-zero with nothing on stdout, so the shell falls back to its literal', () => {
    const r = run(['ask', 'nope', '--locale', 'en']);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('say <key> prints the bare sentence', () => {
    const r = run(['say', 'install.next.verify_manual_terminal', '--locale', 'en']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${en['install.next.verify_manual_terminal']}\n`);
  });

  it('next <kind> [detail] and fix <code> <command> print their lines', () => {
    assert.equal(run(['next', 'verify:new-session']).stdout, 'NEXT:verify:new-session\n');
    assert.equal(run(['next', 'verify:manual', 'a b c']).stdout, 'NEXT:verify:manual:a b c\n');
    assert.equal(run(['fix', 'x', 'echo hi']).stdout, 'FIX:x:echo hi\n');
  });
});

describe('English literals in the installer scripts equal en.json byte for byte', () => {
  const SCRIPTS = [
    'scripts/bootstrap.sh',
    'scripts/bootstrap.ps1',
    'scripts/install-helpers/fetch-release.sh',
    'scripts/install-helpers/fetch-release.ps1',
    'scripts/install-helpers/ensure-node-runtime.sh',
    'scripts/install-helpers/ensure-node-runtime.ps1',
    'install.sh',
    'install.ps1',
  ];

  it('every ASK:<code>:<sentence> literal is the English sentence of install.ask.<code>', () => {
    let seen = 0;
    for (const rel of SCRIPTS) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      for (const m of text.matchAll(/ASK:([a-z_]+):([^"\n]+)"/g)) {
        const key = `install.ask.${m[1]}`;
        assert.ok(en[key], `${rel} emits ASK:${m[1]} but en.json has no ${key}`);
        assert.equal(m[2], en[key], `${rel}: the ASK:${m[1]} literal differs from en.json`);
        seen += 1;
      }
    }
    assert.ok(seen >= 8, `only ${seen} ASK literals found`);
  });

  it('the scripts carry the three ASK codes where they can happen', () => {
    const has = (rel, code) => fs.readFileSync(path.join(repoRoot, rel), 'utf8').includes(`ASK:${code}:`);
    for (const rel of ['scripts/bootstrap.sh', 'scripts/bootstrap.ps1', 'scripts/install-helpers/fetch-release.sh', 'scripts/install-helpers/fetch-release.ps1']) {
      assert.ok(has(rel, 'no_network'), `${rel} lacks ASK:no_network`);
      assert.ok(has(rel, 'disk_full'), `${rel} lacks ASK:disk_full`);
    }
    for (const rel of ['scripts/install-helpers/ensure-node-runtime.sh', 'scripts/install-helpers/ensure-node-runtime.ps1']) {
      assert.ok(has(rel, 'node_download'), `${rel} lacks ASK:node_download`);
      assert.ok(has(rel, 'disk_full'), `${rel} lacks ASK:disk_full`);
      assert.ok(has(rel, 'unsupported_os'), `${rel} lacks ASK:unsupported_os`);
    }
    assert.ok(has('install.sh', 'unsupported_os'), 'install.sh lacks ASK:unsupported_os');
  });

  it('the English sentence in the next-line fallback (install.sh and install.ps1) equals en.json', () => {
    for (const rel of ['install.sh', 'install.ps1']) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      assert.ok(text.includes(en['install.next.verify_manual_terminal']), `${rel} lacks the terminal sentence`);
      assert.ok(text.includes(en['install.next.verify_manual_generic']), `${rel} lacks the generic sentence`);
      assert.ok(text.includes(en['install.verify.session_title']), `${rel} lacks the verification session title`);
    }
  });
});

describe('FIX payloads are commands the AI can run as printed', () => {
  const ALL = [
    'scripts/bootstrap.sh', 'scripts/bootstrap.ps1', 'install.sh', 'install.ps1',
    'scripts/install-helpers/fetch-release.sh', 'scripts/install-helpers/fetch-release.ps1',
    'scripts/install-helpers/ensure-node-runtime.sh', 'scripts/install-helpers/ensure-node-runtime.ps1',
  ];

  it('no script still prints the placeholder "<same one-liner>"', () => {
    for (const rel of ALL) {
      assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, rel), 'utf8'), /<same one-liner/, `${rel} still has a placeholder instead of a command`);
    }
  });

  it('ownmind_retry_cmd prints the server install.sh pipe, with the key left as <KEY>', () => {
    const dir = tempDir('retry-cmd-');
    const script = path.join(dir, 'retry.sh');
    fs.writeFileSync(script, [
      `. "${path.join(repoRoot, 'scripts', 'install-helpers', 'fetch-release.sh')}"`,
      'OWNMIND_FIX_API="http://example.test/ownmind"',
      'ownmind_retry_cmd',
      'echo',
      'ownmind_retry_cmd "OWNMIND_SOURCE=github "',
      'echo',
      'unset OWNMIND_FIX_API',
      'ownmind_retry_cmd',
      '',
    ].join('\n'));
    const r = spawnSync('bash', [script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.split('\n').slice(0, 3), [
      'curl -fsSL http://example.test/ownmind/install.sh | bash -s -- <KEY> http://example.test/ownmind',
      'curl -fsSL http://example.test/ownmind/install.sh | OWNMIND_SOURCE=github bash -s -- <KEY> http://example.test/ownmind',
      'curl -fsSL <API_URL>/install.sh | bash -s -- <KEY> <API_URL>',
    ]);
  });
});

describe('Windows: a localized sentence is printed while the console is still UTF-8', () => {
  const PS = ['scripts/bootstrap.ps1', 'scripts/install-helpers/fetch-release.ps1', 'install.ps1'];

  /** The body of `function NAME { ... }`, found by matching braces. */
  function functionBody(text, name) {
    const at = text.indexOf(`function ${name} {`);
    assert.ok(at >= 0, `function ${name} not found`);
    let depth = 0;
    for (let i = text.indexOf('{', at); i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      if (text[i] === '}') { depth -= 1; if (depth === 0) return text.slice(at, i + 1); }
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  for (const rel of PS) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
    it(`${rel}: Write-Host sits between the switch to UTF-8 and the finally that restores the old code page`, () => {
      const body = functionBody(text, 'Write-OwnMindLocalized');
      const switched = body.indexOf('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
      const restored = body.indexOf('finally');
      const printedInside = body.indexOf('Write-Host $text');
      assert.ok(switched >= 0 && restored > switched, 'the UTF-8 switch and the finally must both exist');
      assert.ok(printedInside > switched && printedInside < restored, 'the sentence must be printed inside the UTF-8 scope');
      const literal = body.indexOf('Write-Host $text', restored);
      assert.ok(literal > restored, 'the English literal is printed when no sentence was printed');
      assert.match(body.slice(restored), /if \(-not \$text\)/, 'the English literal is the fallback only');
    });
    it(`${rel}: the language comes from the UI culture, not the regional format`, () => {
      assert.doesNotMatch(text, /Get-Culture/);
      assert.match(text, /\(Get-UICulture\)\.Name/);
    });
  }
});
