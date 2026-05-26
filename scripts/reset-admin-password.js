#!/usr/bin/env node
/**
 * OwnMind emergency password recovery script — v1.19.9
 *
 * Corresponds to openspec/changes/v1.19.9-password-recovery/spec.md scenarios 9-12.
 *
 * Purpose: when a super_admin forgets their password and no other admin can help recover it,
 *          run this script on the server host to set the chosen super_admin's password_hash
 *          to NULL, then reset the password via the legacy /admin/setup + SETUP_TOKEN flow.
 *
 * Security: this script can only be run by someone with SSH access to the server (who already
 *           has the highest physical privilege). It doesn't lower the security level — it just
 *           reduces "needs to remember SQL syntax" to "runs a single command".
 *
 * Usage:
 *   node scripts/reset-admin-password.js
 *   (the script lists all super_admins and interactively asks which to reset)
 *
 * Environment variables:
 *   DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD — DB connection
 *
 * Exit codes:
 *   0 — success
 *   1 — DB connection failed / user cancelled / no super_admin found
 *
 * Design:
 *   - Interactive double confirmation (avoid accidental triggers).
 *   - Writes an audit log (action='cli_reset_password').
 *   - Auto-generates a random SETUP_TOKEN (32 hex chars) and prints it.
 *   - Only lists super_admin (not admin / user — avoid being used as a backdoor; those two
 *     roles should be recovered via the admin UI).
 */
import readline from 'readline';
import { randomBytes } from 'crypto';
import { query } from '../src/utils/db.js';

const HELP = `
OwnMind emergency password recovery script

Usage:
  node scripts/reset-admin-password.js

Description:
  Run this script on the server host to clear the chosen super_admin's password,
  then reset it via /admin/setup.

Required environment variables:
  DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD

Exit codes: 0 success, 1 failure or cancellation.
`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  console.log('=== OwnMind emergency password recovery v1.19.9 ===\n');

  // 1. List all super_admins.
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
    console.error(`❌ DB connection failed: ${err.message}`);
    console.error('Check DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD');
    process.exit(1);
  }

  if (admins.length === 0) {
    console.log('⚠️ No super_admin exists in this system.');
    console.log('If this is a fresh deployment, run the setup wizard (open /admin in a browser; auto-guided).');
    process.exit(1);
  }

  console.log(`Found ${admins.length} super_admin(s) in this system:\n`);
  admins.forEach((a, i) => {
    const lastUpdate = a.updated_at ? new Date(a.updated_at).toISOString().slice(0, 10) : 'never updated';
    console.log(`  [${i + 1}] ${a.email}  (name: ${a.name || '-'}, last updated: ${lastUpdate})`);
  });
  console.log();

  // 2. Interactive selection.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  const choice = (await ask('Enter the number to reset (or q to cancel): ')).trim();
  if (choice.toLowerCase() === 'q' || !choice) {
    console.log('Cancelled. No changes made.');
    rl.close();
    process.exit(1);
  }

  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= admins.length) {
    console.error('❌ Invalid number.');
    rl.close();
    process.exit(1);
  }

  const target = admins[idx];

  // 3. Double confirmation.
  console.log();
  console.log(`⚠️ About to clear ${target.email}'s password — they will then have to go through the SETUP_TOKEN flow to reset.`);
  const confirm = (await ask("Are you sure? Type 'yes' to confirm: ")).trim();
  rl.close();

  if (confirm !== 'yes') {
    console.log('Cancelled. No changes made.');
    process.exit(1);
  }

  // 4. Clear + generate SETUP_TOKEN + write audit log.
  const setupToken = randomBytes(16).toString('hex'); // 32 hex chars

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
          target.id, // self-audit (no other actor available; the CLI operator is recorded via `source`)
          'cli_reset_password',
          'user',
          target.id,
          JSON.stringify({ target_email: target.email, source: 'cli_script' }),
        ]
      );
    } catch (auditErr) {
      console.warn(`⚠️ audit log write failed (does not affect the rescue): ${auditErr.message}`);
    }
  } catch (err) {
    console.error(`❌ UPDATE failed: ${err.message}`);
    process.exit(1);
  }

  // 5. Print next-step instructions.
  console.log();
  console.log('✅ Password cleared. Next steps:\n');
  console.log('  1. Set the environment variable and restart the server:');
  console.log(`     export SETUP_TOKEN=${setupToken}`);
  console.log('     # then restart your server (e.g. docker compose restart or systemctl restart)');
  console.log();
  console.log('  2. Open /admin/setup in a browser (NOT /setup) and enter:');
  console.log(`     - email: ${target.email}`);
  console.log(`     - setup_token: ${setupToken}`);
  console.log('     - new password (at least 8 chars)');
  console.log();
  console.log('  3. After resetting, the SETUP_TOKEN env var can be removed; no server restart needed.');
  console.log();
  console.log('The audit log recorded this rescue operation (action=cli_reset_password).');
  process.exit(0);
}

main().catch((err) => {
  console.error(`❌ Unexpected error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
