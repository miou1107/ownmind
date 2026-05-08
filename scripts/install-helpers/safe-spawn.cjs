// scripts/install-helpers/safe-spawn.cjs
//
// safeSpawn — execFile 的 Windows-friendly 包裝。
//
// 為什麼要這個 helper：
//   Node child_process.execFile 加 { shell: true } 在 Windows 會把命令包進 cmd.exe。
//   cmd.exe 看到 "powershell.exe -Command 'Get-X | Select-Object'" 會把 | 當成 cmd 自己的
//   pipe operator → 找 Select-Object 當外部命令 → 失敗。這是 v1.17.63 self-check.cjs
//   scheduler 永遠 false fail 的根因。
//
//   此外 Windows 上 spawn console subsystem binary（如 node.exe、powershell.exe）
//   預設會分配 console window — Task Scheduler 觸發時 = 跳視窗。windowsHide:true 防止此事。
//
// 預設值（可被 options override，但 shell:true 在 Windows 會 log warning）：
//   - shell: false       絕不過 shell
//   - windowsHide: true  絕不顯示 console window
//   - timeout: 5000ms
//
// 回傳：{ ok, stdout, stderr, code, error, stderr_tail }，不 throw。
// 失敗呼叫者拿 ok=false + 結構化錯誤判斷，不用 try/catch。

'use strict';

const { execFile } = require('child_process');
const os = require('os');

const HOME = os.homedir();
const DEFAULT_TIMEOUT_MS = 5000;
const STDERR_TAIL_BYTES = 500;

function sanitize(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.split(HOME).join('~');
}

function safeSpawn(file, args = [], options = {}) {
  // v1.17.66 review fix — 不能 log warning 了事（Task Scheduler 跑 stderr 沒人看，
  // Bug #2 這類隱性 regression 會再次溜過 review）。
  // 真要過 shell 的 caller 自己用 child_process.execFile，不要走 helper —
  // helper 的價值就在「閉合不安全 default」。
  if (options.shell === true && process.platform === 'win32') {
    throw new Error(
      `safeSpawn refuses shell:true on win32 — cmd.exe will eat PowerShell | pipes. ` +
      `Use child_process.execFile directly if you really need shell. file=${file}`
    );
  }

  const opts = {
    shell: false,
    windowsHide: true,
    timeout: DEFAULT_TIMEOUT_MS,
    ...options,
  };

  return new Promise((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => {
      const stdoutStr = String(stdout || '');
      const stderrStr = String(stderr || '');
      if (error) {
        resolve({
          ok: false,
          code: error.code,
          error: sanitize(error.message),
          stdout: sanitize(stdoutStr),
          stderr: sanitize(stderrStr),
          stderr_tail: sanitize(stderrStr).slice(-STDERR_TAIL_BYTES),
          killed: error.killed === true,
          signal: error.signal || null,
        });
      } else {
        resolve({
          ok: true,
          code: 0,
          stdout: sanitize(stdoutStr),
          stderr: sanitize(stderrStr),
        });
      }
    });
  });
}

module.exports = { safeSpawn };
