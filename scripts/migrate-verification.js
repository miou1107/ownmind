#!/usr/bin/env node

/**
 * 一次性遷移腳本：為現有 iron_rule 記憶自動匹配 verification template
 *
 * 冪等：已有 metadata.verification 的記憶會被跳過。
 *
 * 用法：node scripts/migrate-verification.js
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
  console.log('=== Iron Rule Verification 遷移開始 ===\n');

  // 抓所有 iron_rule 且沒有 metadata.verification 的記憶
  const result = await pool.query(
    `SELECT id, title, content, tags, metadata
     FROM memories
     WHERE type = 'iron_rule'
       AND status = 'active'
       AND (metadata IS NULL OR NOT (metadata ? 'verification'))`
  );

  const rules = result.rows;
  console.log(`找到 ${rules.length} 條需要遷移的 iron_rule\n`);

  let matched = 0;
  let skipped = 0;

  for (const rule of rules) {
    // 雙重冪等檢查（防止 SQL 條件未涵蓋的邊界情況）
    if (rule.metadata?.verification) {
      console.log(`  [跳過] #${rule.id} "${rule.title}" — 已有 verification`);
      skipped++;
      continue;
    }

    const templateId = matchTemplate({
      title: rule.title,
      content: rule.content,
      tags: rule.tags
    });

    if (!templateId) {
      console.log(`  [無匹配] #${rule.id} "${rule.title}"`);
      skipped++;
      continue;
    }

    const verification = RULE_TEMPLATES[templateId].verification;
    const updatedMetadata = { ...(rule.metadata || {}), verification };

    await pool.query(
      `UPDATE memories SET metadata = $1 WHERE id = $2`,
      [JSON.stringify(updatedMetadata), rule.id]
    );

    console.log(`  [已更新] #${rule.id} "${rule.title}" → ${templateId}`);
    matched++;
  }

  console.log(`\n=== 遷移完成 ===`);
  console.log(`  已更新: ${matched}`);
  console.log(`  跳過:   ${skipped}`);
  console.log(`  總計:   ${rules.length}`);

  await pool.end();
}

migrate().catch(err => {
  console.error('遷移失敗:', err);
  pool.end();
  process.exit(1);
});
