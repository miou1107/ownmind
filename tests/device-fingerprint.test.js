import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateDeviceFingerprint,
  _internals,
} from '../shared/device-fingerprint.js';

// ============================================================
// 正常情況：OS 機器 ID 抓得到 → 用它算
// ============================================================

test('正常情況：用 OS 機器 ID + 安裝路徑算指紋', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => 'os-machine-id-abc-123',
    installPath: '/usr/local/ownmind',
  });
  assert.equal(typeof fp.device_fingerprint, 'string');
  assert.equal(fp.device_fingerprint.length, 16);
  assert.equal(fp.fingerprint_source, 'os_machine_id');
});

test('同樣輸入算出同樣指紋（穩定性）', async () => {
  const opts = {
    machineIdProvider: async () => 'os-id-xyz',
    installPath: '/path/to/install',
  };
  const fp1 = await generateDeviceFingerprint(opts);
  const fp2 = await generateDeviceFingerprint(opts);
  const fp3 = await generateDeviceFingerprint(opts);
  assert.equal(fp1.device_fingerprint, fp2.device_fingerprint);
  assert.equal(fp2.device_fingerprint, fp3.device_fingerprint);
});

test('不同 OS 機器 ID 算出不同指紋', async () => {
  const fpA = await generateDeviceFingerprint({
    machineIdProvider: async () => 'machine-A',
    installPath: '/x',
  });
  const fpB = await generateDeviceFingerprint({
    machineIdProvider: async () => 'machine-B',
    installPath: '/x',
  });
  assert.notEqual(fpA.device_fingerprint, fpB.device_fingerprint);
});

test('同 OS ID + 不同安裝路徑 → 不同指紋', async () => {
  const fpA = await generateDeviceFingerprint({
    machineIdProvider: async () => 'same-id',
    installPath: '/path/A',
  });
  const fpB = await generateDeviceFingerprint({
    machineIdProvider: async () => 'same-id',
    installPath: '/path/B',
  });
  assert.notEqual(fpA.device_fingerprint, fpB.device_fingerprint);
});

// ============================================================
// Fallback：OS 機器 ID 抓不到 → 用主機名 + 安裝路徑
// ============================================================

test('OS ID 抓不到（拋例外）→ fallback 用 hostname + 安裝路徑', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => {
      throw new Error('no /etc/machine-id');
    },
    hostnameProvider: () => 'my-laptop',
    installPath: '/path',
  });
  assert.equal(typeof fp.device_fingerprint, 'string');
  assert.equal(fp.device_fingerprint.length, 16);
  assert.equal(fp.fingerprint_source, 'no_machine_id');
});

test('OS ID 抓到但回空字串 → 視同抓不到、走 fallback', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => '',
    hostnameProvider: () => 'host',
    installPath: '/p',
  });
  assert.equal(fp.fingerprint_source, 'no_machine_id');
});

test('Fallback 同樣輸入算出同樣指紋', async () => {
  const opts = {
    machineIdProvider: async () => null,
    hostnameProvider: () => 'host-x',
    installPath: '/p',
  };
  const fp1 = await generateDeviceFingerprint(opts);
  const fp2 = await generateDeviceFingerprint(opts);
  assert.equal(fp1.device_fingerprint, fp2.device_fingerprint);
});

// ============================================================
// SHA-256 hash 邏輯
// ============================================================

test('SHA-256 hash 取前 16 字、是 hex', async () => {
  const fp = await generateDeviceFingerprint({
    machineIdProvider: async () => 'test-id',
    installPath: '/x',
  });
  assert.match(fp.device_fingerprint, /^[0-9a-f]{16}$/);
});

// ============================================================
// 預設行為（不傳 options）也不崩潰
// ============================================================

test('不傳 options 也能跑（用真實 node-machine-id 或 fallback）', async () => {
  const fp = await generateDeviceFingerprint();
  assert.equal(typeof fp.device_fingerprint, 'string');
  assert.equal(fp.device_fingerprint.length, 16);
  assert.ok(
    ['os_machine_id', 'no_machine_id'].includes(fp.fingerprint_source),
    `fingerprint_source 應是合法值、實際 ${fp.fingerprint_source}`
  );
});
