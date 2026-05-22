#!/usr/bin/env node
/**
 * OwnMind 緊急密碼救援腳本 — v1.19.9
 *
 * 對應 openspec/changes/v1.19.9-password-recovery/spec.md 場景 9-12。
 *
 * 用途：當 super_admin 忘記密碼且沒有其他 admin 可協助救援時、
 *      在伺服器主機上跑這個腳本、把指定 super_admin 的 password_hash 設 NULL、
 *      然後走舊 /admin/setup + SETUP_TOKEN 重新設密碼。
 *
 * 安全性：腳本只能在能 SSH 進伺服器（已有最高物理權限）的人手上跑、
 *        不會降低系統安全等級、只是把「需要記 SQL 語法」降為「跑一行指令」。
 *
 * 用法：
 *   node scripts/reset-admin-password.js
 *   （腳本會列出所有 super_admin、互動式問你選誰）
 *
 * 環境變數：
 *   DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD — DB 連線
 *
 * 退出碼：
 *   0 — 成功
 *   1 — DB 連線失敗 / 使用者取消 / 找不到 super_admin
 *
 * 設計：
 *   - 互動式雙重確認（避免誤觸發）
 *   - 寫 audit log（action='cli_reset_password'）
 *   - 自動產隨機 SETUP_TOKEN（32 字 hex）印給使用者
 *   - 只列 super_admin（不列 admin / user、避免被當成後門用、那兩個角色該走後台救援）
 */
import readline from 'readline';
import { randomBytes } from 'crypto';
import { query } from '../src/utils/db.js';

const HELP = `
OwnMind 緊急密碼救援腳本

用法：
  node scripts/reset-admin-password.js

說明：
  在伺服器主機上跑這個腳本、把指定 super_admin 的密碼清空、
  然後走 /admin/setup 重新設密碼。

需要環境變數：
  DB_HOST、DB_PORT、DB_NAME、DB_USER、DB_PASSWORD

退出碼：0 成功、1 失敗或取消。
`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  console.log('=== OwnMind 緊急密碼救援腳本 v1.19.9 ===\n');

  // 1. 列出所有 super_admin
  let admins;
  try {
    const result = await query(
      `SELECT id, email, name, created_at, updated_at
         FROM users
        WHERE role = 'super_admin'
        ORDER BY created_at ASC`
    );
    admins = result.rows;
  } catch (err) {
    console.error(`❌ DB 連線失敗：${err.message}`);
    console.error('請確認 DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD');
    process.exit(1);
  }

  if (admins.length === 0) {
    console.log('⚠️ 系統中沒有任何 super_admin。');
    console.log('如果這是新部署、請走 setup wizard（開瀏覽器到 /admin、自動引導）。');
    process.exit(1);
  }

  console.log(`系統中有 ${admins.length} 位 super_admin：\n`);
  admins.forEach((a, i) => {
    const lastUpdate = a.updated_at ? new Date(a.updated_at).toISOString().slice(0, 10) : '從未更新';
    console.log(`  [${i + 1}] ${a.email}  (name: ${a.name || '-'}, 最後更新: ${lastUpdate})`);
  });
  console.log();

  // 2. 互動式選擇
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  const choice = (await ask('請輸入要重設的編號（或輸入 q 取消）：')).trim();
  if (choice.toLowerCase() === 'q' || !choice) {
    console.log('已取消、未做任何變更。');
    rl.close();
    process.exit(1);
  }

  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= admins.length) {
    console.error('❌ 編號無效。');
    rl.close();
    process.exit(1);
  }

  const target = admins[idx];

  // 3. 雙重確認
  console.log();
  console.log(`⚠️ 即將清除 ${target.email} 的密碼、之後必須走 SETUP_TOKEN 流程重設。`);
  const confirm = (await ask("確定要繼續？輸入 'yes' 確認：")).trim();
  rl.close();

  if (confirm !== 'yes') {
    console.log('已取消、未做任何變更。');
    process.exit(1);
  }

  // 4. 執行清除 + 產 SETUP_TOKEN + 寫 audit log
  const setupToken = randomBytes(16).toString('hex'); // 32 字 hex

  try {
    await query(
      `UPDATE users
         SET password_hash = NULL,
             must_change_password = TRUE,
             updated_at = NOW()
       WHERE id = $1`,
      [target.id]
    );

    try {
      await query(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, details)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          target.id, // 自我審計（沒有其他 actor 可用、CLI 操作者由 source 註記）
          'cli_reset_password',
          'user',
          target.id,
          JSON.stringify({ target_email: target.email, source: 'cli_script' }),
        ]
      );
    } catch (auditErr) {
      console.warn(`⚠️ audit log 寫入失敗（不影響救援）：${auditErr.message}`);
    }
  } catch (err) {
    console.error(`❌ UPDATE 失敗：${err.message}`);
    process.exit(1);
  }

  // 5. 印出後續指引
  console.log();
  console.log('✅ 密碼已清除。後續步驟：\n');
  console.log('  1. 設環境變數並重啟 server：');
  console.log(`     export SETUP_TOKEN=${setupToken}`);
  console.log('     # 然後重啟你的 server（例如 docker compose restart 或 systemctl restart）');
  console.log();
  console.log('  2. 開瀏覽器到 /admin/setup（不是 /setup）、輸入：');
  console.log(`     - email: ${target.email}`);
  console.log(`     - setup_token: ${setupToken}`);
  console.log('     - 新密碼（至少 8 字）');
  console.log();
  console.log('  3. 重設完成後、SETUP_TOKEN 環境變數可以移除、server 不必重啟');
  console.log();
  console.log('audit log 已記錄這次救援操作（action=cli_reset_password）。');
  process.exit(0);
}

main().catch((err) => {
  console.error(`❌ 未預期錯誤：${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
