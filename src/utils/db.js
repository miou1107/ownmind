import pg from 'pg';
import logger from './logger.js';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'ownmind',
  user: process.env.DB_USER || 'ownmind',
  password: process.env.DB_PASSWORD || ''
});

pool.on('error', (err) => {
  logger.error('資料庫連線池發生錯誤', { error: err.message });
});

/**
 * 執行 SQL 查詢
 * @param {string} text - SQL 語句
 * @param {Array} params - 參數
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.debug('執行查詢', { text, duration: `${duration}ms`, rows: result.rowCount });
  return result;
}

/**
 * v1.19.8 — 在一個 transaction 內跑多個查詢
 *
 * 用法：
 *   const result = await withTransaction(async (client) => {
 *     await client.query('SELECT pg_advisory_xact_lock(123)');
 *     await client.query('INSERT INTO ...');
 *     return { success: true };
 *   });
 *
 * 任何 throw 都會 ROLLBACK；正常 return 才 COMMIT。
 * 並發鎖 / 序列化動作（如 setup wizard 的單一寫入保證）必須走這條。
 *
 * @template T
 * @param {(client: pg.PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}

export default pool;
