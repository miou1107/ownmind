/**
 * What hooks/lib/redact.js has to catch before a reply leaves the machine (security review
 * 2026-10-03, item 9).
 *
 * The old rule knew `keyword=value` with nothing between keyword and separator, and `Bearer x`.
 * Every case below went to the server verbatim under it. Sample keys are assembled at run time:
 * this repository's own commit scan uses the same detector, and a literal sample would block it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, toReason } from '../hooks/lib/redact.js';
import { replyExcerpt } from '../hooks/lib/verdict-store.js';

const r = (n, c = 'aB3') => c.repeat(Math.ceil(n / c.length)).slice(0, n);
const KEYS = {
  github: 'gh' + 'p_' + r(36),
  githubFine: 'github' + '_pat_' + r(40, 'Ab1_'),
  openai: 's' + 'k-' + r(40),
  anthropic: 's' + 'k-ant-' + r(40),
  aws: 'AK' + 'IA' + r(16, 'QZ7'),
  jwt: 'ey' + 'J' + r(20) + '.ey' + 'J' + r(20) + '.' + r(20),
  gitlab: 'gl' + 'pat-' + r(20),
  slack: 'xo' + 'xb-' + r(24, '12a-'),
  google: 'AI' + 'za' + r(35),
};

function assertGone(out, secret, label) {
  assert.ok(!out.includes(secret), `${label}: the secret survived:\n${out}`);
  assert.match(out, /REDACTED/, `${label}: nothing was masked`);
}

for (const [name, key] of Object.entries(KEYS)) {
  test(`a bare ${name} key with no keyword in front of it is masked`, () => {
    assertGone(redact(`試試看這個 ${key} 能不能用`), key, name);
  });
}

test('JSON config: the closing quote between keyword and colon no longer hides the value', () => {
  const secret = 'Zx9-' + r(20);
  for (const text of [
    `{"api_key": "${secret}"}`,
    `{"OWNMIND_API_KEY":"${secret}"}`,
    `  "password" : "${secret}",`,
    `'client_secret': '${secret}'`,
  ]) assertGone(redact(text), secret, text);
});

test('a quoted value with spaces goes whole, not just its first word', () => {
  const out = redact('password: "correct horse battery staple"');
  for (const word of ['correct', 'horse', 'battery', 'staple']) assert.ok(!out.includes(word), out);
});

test('env, YAML and compound names', () => {
  const secret = 'Qw8' + r(17);
  for (const text of [
    `export OWNMIND_API_KEY=${secret}`,
    `AWS_SECRET_ACCESS_KEY=${secret}`,
    `db_password: ${secret}`,
    `access-key => ${secret}`,
  ]) assertGone(redact(text), secret, text);
});

test('CLI flags with a space', () => {
  const secret = 'Kp4' + r(17);
  assertGone(redact(`mysql --password ${secret} -h db`), secret, '--password');
  assertGone(redact(`tool --api-key ${secret}`), secret, '--api-key');
  assert.match(redact(`tool --api-key ${secret} -v`), / -v$/, 'the next flag survives');
});

test('Chinese labels, full-width colon included', () => {
  for (const text of ['密碼：hunter22', '金鑰: abcdef123456', '密鑰=abcdef123456']) {
    const out = redact(text);
    assert.match(out, /REDACTED/, text);
    assert.doesNotMatch(out, /hunter22|abcdef123456/, text);
  }
});

test('a password inside a URL; the user name and host stay', () => {
  const out = redact('git clone https://vin:S3cretPass99@git.example.com/repo.git');
  assert.ok(!out.includes('S3cretPass99'), out);
  assert.match(out, /https:\/\/vin:\[REDACTED\]@git\.example\.com\/repo\.git/);
  assert.equal(redact('http://localhost:8080/path'), 'http://localhost:8080/path', 'a port is not a password');
});

test('Authorization headers of any scheme', () => {
  const b64 = r(24, 'dX5=');
  assertGone(redact(`curl -H "Authorization: Basic ${b64}" x`), b64, 'Basic');
  assertGone(redact(`Authorization: Token ${b64}`), b64, 'Token');
  assertGone(redact(`header = "Authorization: Bearer ${b64}"`), b64, 'Bearer in a curl config');
});

test('a private key block, terminated or cut off', () => {
  const body = r(64, 'MIIEv') + '\n' + r(64, 'Qk9A');
  const begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
  const end = '-----END ' + 'RSA PRIVATE KEY-----';
  const out = redact(`before\n${begin}\n${body}\n${end}\nafter`);
  assert.ok(!out.includes('MIIEv'), out);
  assert.match(out, /^before\n\[REDACTED PRIVATE KEY\]\nafter$/);
  assert.ok(!redact(`${begin}\n${body}`).includes('Qk9A'), 'a block cut off mid-way still goes');
});

test("the caller's own key is masked wherever it appears, even as a bare UUID", () => {
  // OwnMind keys are randomUUID(): no prefix, no keyword, nothing else here would catch one.
  const key = '3f2a9c1e-7b4d-4e8a-9f61-' + '0c5d2b8a7e14';
  const out = redact(`我的設定是 ${key}，對嗎？`, { secrets: [key] });
  assertGone(out, key, 'own key');
  assert.equal(redact('id 3f2a9c1e', { secrets: ['', null, 'short'] }), 'id 3f2a9c1e', 'empty and short secrets are ignored');
  assert.equal(redact('a.b+c', { secrets: ['a.b+c-long'] }), 'a.b+c', 'a secret is matched literally, not as a pattern');
});

test('ordinary prose and code survive', () => {
  for (const text of [
    '我先看了 A 檔案，又看了 B 檔案，最後發現問題在第 42 行。',
    'The basic idea: a token bucket refills every second.',
    'Run `git log --oneline` and check commit 5f19a2169f798d7cde8c2ceb28be9fac38d58641.',
    'hope that this vlog will help',
    'author: Vin',
    'See https://github.com/miou1107/ownmind/blob/main/README.md',
  ]) assert.equal(redact(text), text, text);
});

test('the reason written to the failure log and the excerpt kept on disk are redacted', () => {
  assert.ok(!toReason(`boom ${KEYS.github}`).includes(KEYS.github));
  // The excerpt is redacted before the cut, so a key straddling the cut cannot leave a prefix
  // long enough to be useful but too short for any pattern to recognise.
  const text = 'x'.repeat(130) + ' ' + KEYS.openai;
  assert.ok(!replyExcerpt(text).includes(KEYS.openai.slice(0, 12)), replyExcerpt(text));
});

// ------------------------------------------------------------- review round, same day

test('escaped JSON, as logs and JSON.stringify output carry it', () => {
  const secret = 'Zq7' + r(20);
  for (const text of [
    `{\\"api_key\\": \\"${secret}\\"}`,
    `"body": "{\\"password\\":\\"${secret}\\"}"`,
  ]) assertGone(redact(text), secret, text);
});

test('Chinese without a colon, and with 為', () => {
  for (const text of ['密碼是 hunter22xyz', '密碼為：hunter22xyz', '金鑰是abcdef123456']) {
    const out = redact(text);
    assert.doesNotMatch(out, /hunter22xyz|abcdef123456/, text);
  }
});

test('a Chinese sentence about a key is not swallowed whole', () => {
  // The sentence a judge needs for a rule about checking the config after a key change.
  for (const text of [
    '金鑰：已經換好了，設定檔我也打開確認過，重啟後實測身分是 vin。',
    'Password: 鐵律說不能在回覆貼密碼，所以我沒有貼出來。',
    '密碼是什麼我不知道，要問你。',
  ]) assert.equal(redact(text), text, text);
  assert.equal(redact('金鑰：abc123456，設定檔我也確認過'), '金鑰：[REDACTED]，設定檔我也確認過');
});

test('curl -u, an empty URL user, cookies, headers, XML, webhooks and more formats', () => {
  const pw = 'Hunter22' + r(8);
  assertGone(redact(`curl -u admin:${pw} https://api`), pw, 'curl -u');
  assert.match(redact(`curl -u admin:${pw} https://api`), /-u admin:\[REDACTED\] https:\/\/api/);
  assertGone(redact(`redis://:${pw}@cache:6379`), pw, 'empty user');
  assertGone(redact(`Cookie: session=${pw}; theme=dark`), pw, 'Cookie');
  assertGone(redact(`Set-Cookie: sid=${pw}; HttpOnly`), pw, 'Set-Cookie');
  assertGone(redact(`-H "x-ownmind-key: ${pw}"`), pw, 'x-ownmind-key');
  assertGone(redact(`Authorization: Digest username="a", response="${pw}"`), pw, 'Digest');
  assertGone(redact(`Authorization: ${pw}`), pw, 'no scheme');
  assertGone(redact(`<password>${pw}</password>`), pw, 'XML');
  assert.equal(redact(`<ApiKey>${pw}</ApiKey>`), '<ApiKey>[REDACTED]</ApiKey>');
  const slack = 'https://hooks.slack.com/services/' + 'T0' + r(9) + '/B0' + r(9) + '/' + r(24);
  assertGone(redact(slack), slack.split('/services/')[1], 'Slack webhook');
  const hf = 'h' + 'f_' + r(34);
  assertGone(redact(`token ${hf}`), hf, 'Hugging Face');
  const sg = 'S' + 'G.' + r(22) + '.' + r(43);
  assertGone(redact(sg), sg, 'SendGrid');
});

test('ordinary English that only looked like a header survives', () => {
  for (const text of [
    'He was the bearer of bad news.',
    'Authorization: the server checks the role first.',
    'if (password === confirm) return;',
  ]) assert.equal(redact(text), text, text);
});

test('the excerpt kept on disk masks the caller\'s own key too', () => {
  const key = '3f2a9c1e-7b4d-4e8a-9f61-' + '0c5d2b8a7e14';
  assert.ok(!replyExcerpt(`key ${key}`, [key]).includes(key));
});

test('no pattern goes quadratic on long input', () => {
  // These run synchronously in the Stop hook. Measured before the fix, at 200KB: `a.` repeated
  // 18s (URL rule), `token` repeated 8.4s (keyword rule), base64 2.5s.
  const n = 200_000;
  for (const [name, unit] of Object.entries({
    dots: 'a.', dashes: 'a-', sk: 'sk-', slack: 'xoxb-a', token: 'token', flag: '--token',
    base64: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo+abc-def.', cjk: '密碼是', colon: 'a:', at: 'a@', quote: '"a', xml: '<password>', auth: 'Authorization: ',
    cookie: 'Cookie: ', url: 'https://a', curl: '-u a:', assign: 'password=',
  })) {
    const text = unit.repeat(Math.ceil(n / unit.length));
    const t0 = process.hrtime.bigint();
    redact(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${name}: ${Math.round(ms)}ms on ${n} characters`);
  }
});
