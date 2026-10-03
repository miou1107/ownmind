#!/usr/bin/env node
'use strict';
// swap-api-key.cjs — give this machine a new OwnMind API key, everywhere it keeps one.
//
// A key can now be replaced (POST /api/me/rotate-key, or an admin replacing a member's).
// The old key dies on the server at once, and every tool on every machine that held it —
// Claude Code, Cursor, Windsurf, OpenCode, Gemini CLI, Codex — goes dark until it holds the
// new one. This rewrites them all, reads each file back, and then asks the server who the
// new key belongs to: an installer saying "done" is not evidence (IR-001).
//
//   node swap-api-key.cjs --rotate   replace this account's key, then update this machine
//   node swap-api-key.cjs --set      this machine only; the new key is read from stdin
//                                    (or OWNMIND_NEW_API_KEY), never from the command line,
//                                    where other users of the machine could read it
//
// Only values equal to the old key are replaced, so a second account configured somewhere
// on the machine keeps its own. The key is never printed in full.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { sourcesFor, load, tomlLines, writeAtomic } = require('./migrate-api-url.cjs');
const { resolveCredentials } = require('./resolve-credentials.cjs');

const KEY_VAR = 'OWNMIND_API_KEY';
const TOML_KEY = /(\bOWNMIND_API_KEY\s*=\s*)(["'])([^"'\r\n]*)\2/g;

const mask = (k) => (k ? `${String(k).slice(0, 4)}…${String(k).slice(-4)}` : '(none)');

/** Every object anywhere in a parsed JSON config that carries a key. */
function collectKeyHolders(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (!Array.isArray(node) && typeof node[KEY_VAR] === 'string') out.push(node);
  for (const child of Object.values(node)) collectKeyHolders(child, out);
  return out;
}

function keysIn(source, loaded) {
  if (source.format === 'toml') {
    return tomlLines(loaded.text).filter((l) => l.live)
      .flatMap((l) => [...l.line.matchAll(TOML_KEY)].map((m) => m[3]));
  }
  return collectKeyHolders(loaded.parsed).map((h) => h[KEY_VAR]);
}

/**
 * Replace `oldKey` with `newKey` in every config on this machine, then read each changed file
 * back and confirm the old key is gone.
 *
 * @returns {{ changed: number, files: Array<{path, tool, changed, verified?, error?}> }}
 */
function swapKey(oldKey, newKey, opts = {}) {
  const home = opts.home || os.homedir();
  const sources = opts.sources || sourcesFor(home, { useEnv: !opts.home });
  const report = { changed: 0, files: [] };
  if (!oldKey || !newKey || oldKey === newKey) return report;

  for (const source of sources) {
    const loaded = load(source);
    if (!loaded) continue;
    if (loaded.error) {
      // Unreadable is only a failure when the old key is in it: a broken settings file of
      // some other tool must not fail a change that touched every file holding the key.
      const holdsOldKey = typeof loaded.text === 'string' && loaded.text.includes(oldKey);
      report.files.push(holdsOldKey
        ? { path: source.file, tool: source.tool, changed: 0, error: `holds the old key but could not be parsed: ${loaded.error}` }
        : { path: source.file, tool: source.tool, changed: 0, warning: loaded.error });
      continue;
    }

    let changed = 0;
    let output;
    if (source.format === 'toml') {
      output = tomlLines(loaded.text).map(({ line, live }) => (!live ? line
        : line.replace(TOML_KEY, (whole, lead, quote, value) => {
          if (value !== oldKey) return whole;
          changed += 1;
          return `${lead}${quote}${newKey}${quote}`;
        }))).join('');
    } else {
      for (const holder of collectKeyHolders(loaded.parsed)) {
        if (holder[KEY_VAR] === oldKey) {
          holder[KEY_VAR] = newKey;
          changed += 1;
        }
      }
      output = JSON.stringify(loaded.parsed, null, 2) + '\n';
    }
    if (changed === 0) continue;

    const entry = { path: source.file, tool: source.tool, changed };
    try {
      writeAtomic(source.file, output);
      const back = load(source);
      const keys = back && !back.error ? keysIn(source, back) : null;
      if (!keys) entry.error = 'the file could not be read back after writing';
      else if (keys.includes(oldKey)) entry.error = 'read back after writing, it still holds the old key';
      else if (!keys.includes(newKey)) entry.error = 'read back after writing, the new key is not in it';
      else entry.verified = true;
    } catch (err) {
      entry.changed = 0;
      entry.error = err.message;
    }
    report.files.push(entry);
    if (!entry.error) report.changed += changed;
  }
  return report;
}

/** Ask the server whose key this is. @returns {Promise<{ok, status, id?}>} */
async function whoIs(apiUrl, key, fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${String(apiUrl).replace(/\/+$/, '')}/api/me/profile`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, status: res.status, id: data && data.id };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

async function rotateOnServer(apiUrl, key, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${String(apiUrl).replace(/\/+$/, '')}/api/me/rotate-key`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try { data = await res.json(); } catch { /* reported below */ }
  if (!res.ok || !data || typeof data.api_key !== 'string') {
    throw new Error(`the server did not issue a new key (HTTP ${res.status}${data && data.error ? `: ${data.error}` : ''})`);
  }
  return { id: data.id, key: data.api_key };
}

/**
 * The whole change on this machine, with the server as the judge of whether it worked.
 *
 * @param {object} opts
 * @param {'rotate'|'set'} opts.mode
 * @param {string} [opts.newKey]  required for 'set'
 * @returns {Promise<{ ok: boolean, steps: string[], files: object[], recoveryFile?: string }>}
 */
async function changeKey(opts) {
  const home = opts.home || os.homedir();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const creds = opts.credentials || resolveCredentials({ home });
  const steps = [];
  const fail = (msg, extra = {}) => ({ ok: false, steps: [...steps, msg], files: [], ...extra });

  if (!creds.apiUrl || !creds.apiKey) return fail('找不到這台電腦目前的 OwnMind 網址或金鑰，沒辦法換。');
  const oldKey = creds.apiKey;

  let newKey;
  let expectedId;
  let recoveryFile;
  if (opts.mode === 'rotate') {
    // A key that lives only in an environment variable is one this tool cannot rewrite.
    // Rotating would kill it and leave the machine dark, so refuse before touching anything.
    if (creds.source && creds.source.key === 'env') {
      return fail('這台電腦的金鑰只存在環境變數 OWNMIND_API_KEY 裡，小工具改不到。請到後台換金鑰，自己改好環境變數，再用 --set 確認。');
    }
    const before = await whoIs(creds.apiUrl, oldKey, fetchImpl);
    if (!before.ok) return fail(`目前的金鑰已經不能用（HTTP ${before.status}），請改用 --set 貼上新金鑰。`);

    // The new key will exist nowhere but in this process until the configs hold it, so make
    // sure there is somewhere to keep it before asking for it.
    recoveryFile = path.join(home, '.ownmind', 'new-api-key.txt');
    try {
      fs.mkdirSync(path.dirname(recoveryFile), { recursive: true });
      fs.writeFileSync(recoveryFile, '', { mode: 0o600 });
    } catch (err) {
      return fail(`沒辦法在 ${recoveryFile} 先準備好保存新金鑰的地方（${err.message}），沒有換金鑰。`);
    }

    let issued;
    try {
      issued = await rotateOnServer(creds.apiUrl, oldKey, fetchImpl);
    } catch (err) {
      fs.rmSync(recoveryFile, { force: true });
      // A timeout or a dropped answer can come after the server already switched keys. Ask
      // with the old key: if it no longer works, the switch happened and the new key went
      // to nobody, and saying "nothing changed" would send the user the wrong way.
      const still = await whoIs(creds.apiUrl, oldKey, fetchImpl);
      if (still.status === 401) {
        return fail(`伺服器沒有回應成功（${err.message}），但舊金鑰已經失效，代表金鑰可能已經換了。請登入後台取得新金鑰，再用 --set 換上。`);
      }
      return fail(`伺服器沒有換金鑰，什麼都沒改：${err.message}`);
    }
    newKey = issued.key;
    expectedId = issued.id;
    steps.push(`伺服器已發新金鑰 ${mask(newKey)}，舊金鑰 ${mask(oldKey)} 已失效。`);
    // From here the old key is dead. Keep the new one until every config is confirmed.
    try {
      fs.writeFileSync(recoveryFile, newKey + '\n', { mode: 0o600 });
    } catch (err) {
      // The last resort: losing the only copy is worse than showing it on the user's own
      // terminal once.
      steps.push(`新金鑰存不進 ${recoveryFile}（${err.message}）。只顯示這一次，請自己記下：${newKey}`);
      recoveryFile = undefined;
    }
  } else {
    newKey = String(opts.newKey || '').trim();
    if (!newKey) return fail('沒有收到新金鑰。');
    const probe = await whoIs(creds.apiUrl, newKey, fetchImpl);
    if (!probe.ok) return fail(`伺服器不認得這把新金鑰（HTTP ${probe.status}），什麼都沒改。`);
    expectedId = probe.id;
  }

  const result = swapKey(oldKey, newKey, { home, sources: opts.sources });
  for (const f of result.files) {
    if (f.error) steps.push(`✗ ${f.tool}：${f.path} 沒有改成功：${f.error}`);
    else if (f.warning) steps.push(`！ ${f.tool}：${f.path} 讀不懂，裡面沒有舊金鑰，略過（${f.warning}）`);
    else steps.push(`✓ ${f.tool}：${f.path}（${f.changed} 處，已讀回確認）`);
  }
  // Nothing rewritten means nothing on this machine holds the new key — after a rotation
  // that is a machine about to go dark, not a success.
  const nothingChanged = result.changed === 0;
  if (nothingChanged) steps.push('✗ 這台電腦的設定檔裡找不到舊金鑰，沒有任何地方換上新金鑰。');

  const after = await whoIs(creds.apiUrl, newKey, fetchImpl);
  const identityOk = after.ok && (expectedId === undefined || after.id === expectedId);
  steps.push(identityOk
    ? `✓ 用新金鑰問伺服器：是同一個帳號（編號 ${after.id}）。`
    : `✗ 用新金鑰問伺服器沒有得到同一個帳號（HTTP ${after.status}）。`);

  const ok = identityOk && !nothingChanged && result.files.every((f) => !f.error);
  if (ok && recoveryFile) {
    fs.rmSync(recoveryFile, { force: true });
    recoveryFile = undefined;
  }
  if (ok) steps.push('完成。請把 Claude Code 等 AI 工具完全關掉再打開，新金鑰才會生效。');
  else if (recoveryFile) steps.push(`有地方沒改好。新金鑰先存在 ${recoveryFile}，修好後再刪掉。`);
  return { ok, steps, files: result.files, recoveryFile };
}

module.exports = { swapKey, changeKey, whoIs, collectKeyHolders, mask };

if (require.main === module) {
  const mode = process.argv.includes('--rotate') ? 'rotate' : process.argv.includes('--set') ? 'set' : null;
  if (!mode) {
    console.error('用法：node swap-api-key.cjs --rotate   或   node swap-api-key.cjs --set  （新金鑰從標準輸入給）');
    process.exit(2);
  }
  const readStdin = () => new Promise((resolve) => {
    if (process.env.OWNMIND_NEW_API_KEY) return resolve(process.env.OWNMIND_NEW_API_KEY);
    if (process.stdin.isTTY) process.stderr.write('貼上新的 OwnMind 金鑰，按 Enter：');
    let buf = '';
    process.stdin.setEncoding('utf8');
    // Up to the first line break, or the end of input — a key piped in two chunks arrives whole.
    process.stdin.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) { process.stdin.pause(); resolve(buf.split('\n')[0]); }
    });
    process.stdin.on('end', () => resolve(buf));
  });
  (async () => {
    const newKey = mode === 'set' ? await readStdin() : undefined;
    const r = await changeKey({ mode, newKey });
    for (const s of r.steps) console.log(`[ownmind] ${s}`);
    process.exit(r.ok ? 0 : 1);
  })().catch((err) => {
    console.error(`[ownmind] 換金鑰時出錯：${err && err.message}`);
    process.exit(1);
  });
}
