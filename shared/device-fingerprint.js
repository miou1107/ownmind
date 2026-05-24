/**
 * device-fingerprint — 算「來源機器指紋」（白話：給後台分辨「這筆回報是
 * 從哪台電腦送來的」用的穩定識別碼、不暴露主機名或 MAC）
 *
 * 對應 OpenSpec 提案 v1.19.14-bug-report-tool（規格 §2.6、§四、場景 28-32）。
 *
 * 為什麼用作業系統機器 ID 而不是主機名 + MAC：
 *   - 第四輪 Gemini 對抗審查指出 Docker / VPN / 虛擬機環境下主機名 + MAC 會
 *     頻繁變動：容器主機名是隨機 container ID、Tailscale / WireGuard 等
 *     虛擬網卡會塞進去打亂主網卡偵測
 *   - 作業系統機器 ID 由 OS 管理、跨重啟穩定：
 *     - macOS：IOPlatformUUID（系統永久 ID）
 *     - Linux：/etc/machine-id（首次開機設定、之後不變）
 *     - Windows：登錄檔 MachineGuid
 *
 * 設計重點：
 *   - 每次啟動即時算、不寫檔（不會被同步資料夾帶走）
 *   - 同機器同安裝路徑 → 必算同一個指紋
 *   - 不同機器（OS ID 不同）→ 必算不同指紋
 *   - 抓不到 OS ID 時 fallback 用主機名 + 安裝路徑、帶 fingerprint_source 標記
 *   - 純函式（吃 options 注入、好測試）
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * 預設的 OS 機器 ID 取得器：用 node-machine-id 套件
 * 抓不到回 null（不丟例外、讓 fallback 接管）
 */
async function defaultMachineIdProvider() {
  try {
    const machineIdModule = await import('node-machine-id');
    // 套件可能 export default、也可能直接 export 函式
    const fn = machineIdModule.machineId || machineIdModule.default?.machineId;
    if (typeof fn !== 'function') return null;
    const id = await fn();
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function defaultHostnameProvider() {
  try {
    return os.hostname();
  } catch {
    return 'unknown';
  }
}

/**
 * 算 SHA-256 雜湊、取前 16 字
 * @param {string} input
 * @returns {string}
 */
function sha256First16(input) {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * 算「來源機器指紋」
 *
 * @param {Object} [options]
 * @param {Function} [options.machineIdProvider] - async function 回 OS 機器 ID 字串、抓不到回 null/empty
 * @param {Function} [options.hostnameProvider] - sync function 回主機名（fallback 用）
 * @param {string} [options.installPath] - OwnMind 安裝路徑（預設用本檔目錄）
 * @returns {Promise<{ device_fingerprint: string, fingerprint_source: 'os_machine_id' | 'no_machine_id' }>}
 */
export async function generateDeviceFingerprint(options = {}) {
  const machineIdProvider = options.machineIdProvider || defaultMachineIdProvider;
  const hostnameProvider = options.hostnameProvider || defaultHostnameProvider;
  const installPath = options.installPath || __dirname;

  let osMachineId = null;
  try {
    osMachineId = await machineIdProvider();
  } catch {
    osMachineId = null;
  }

  if (typeof osMachineId === 'string' && osMachineId.length > 0) {
    return {
      device_fingerprint: sha256First16(`${osMachineId}|${installPath}`),
      fingerprint_source: 'os_machine_id',
    };
  }

  // Fallback：用主機名 + 安裝路徑
  const hostname = hostnameProvider();
  return {
    device_fingerprint: sha256First16(`hostname:${hostname}|${installPath}`),
    fingerprint_source: 'no_machine_id',
  };
}

// 給測試用的內部 export（不對外公開 API）
export const _internals = {
  sha256First16,
  defaultMachineIdProvider,
  defaultHostnameProvider,
};
