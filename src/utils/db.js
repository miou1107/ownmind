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

export default pool;
