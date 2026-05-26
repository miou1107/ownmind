#!/usr/bin/env node

/**
 * One-shot migration: auto-match a verification template to every existing iron_rule memory.
 *
 * Idempotent: rows that already have metadata.verification are skipped.
 *
 * Usage: node scripts/migrate-verification.js
 */

import pg from 'pg';
import { matchTemplate, RULE_TEMPLATES } from '../src/utils/templates.js';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ownmind',
  user: process.env.DB_USER || 'ownmind',
  password: process.env.DB_PASSWORD || ''
});

async function migrate() {
  console.log('=== Iron rule verification migration starting ===\n');

  // Pull every active iron_rule without metadata.verification.
  const result = await pool.query(
    `SELECT id, title, content, tags, metadata
     FROM memories
     WHERE type = 'iron_rule'
       AND status = 'active'
       AND (metadata IS NULL OR NOT (metadata ? 'verification'))`
  );

  const rules = result.rows;
  console.log(`Found ${rules.length} iron_rule(s) to migrate\n`);

  let matched = 0;
  let skipped = 0;

  for (const rule of rules) {
    // Belt-and-suspenders idempotency check (covers edge cases the SQL filter might miss).
    if (rule.metadata?.verification) {
      console.log(`  [skip] #${rule.id} "${rule.title}" — already has verification`);
      skipped++;
      continue;
    }

    const templateId = matchTemplate({
      title: rule.title,
      content: rule.content,
      tags: rule.tags
    });

    if (!templateId) {
      console.log(`  [no match] #${rule.id} "${rule.title}"`);
      skipped++;
      continue;
    }

    const verification = RULE_TEMPLATES[templateId].verification;
    const updatedMetadata = { ...(rule.metadata || {}), verification };

    await pool.query(
      `UPDATE memories SET metadata = $1 WHERE id = $2`,
      [JSON.stringify(updatedMetadata), rule.id]
    );

    console.log(`  [updated] #${rule.id} "${rule.title}" → ${templateId}`);
    matched++;
  }

  console.log(`\n=== Migration complete ===`);
  console.log(`  Updated: ${matched}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Total:   ${rules.length}`);

  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  pool.end();
  process.exit(1);
});
