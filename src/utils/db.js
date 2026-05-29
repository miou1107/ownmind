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
  logger.error('Database connection pool error', { error: err.message });
});

/**
 * Run a SQL query
 * @param {string} text - the SQL statement
 * @param {Array} params - parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  logger.debug('Query executed', { text, duration: `${duration}ms`, rows: result.rowCount });
  return result;
}

/**
 * v1.19.8 — run multiple queries inside a single transaction
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('SELECT pg_advisory_xact_lock(123)');
 *     await client.query('INSERT INTO ...');
 *     return { success: true };
 *   });
 *
 * Any throw triggers ROLLBACK; only a normal return COMMITs.
 * Concurrency locks / serialized actions (e.g. the setup wizard's single-write
 * guarantee) must go through this.
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
