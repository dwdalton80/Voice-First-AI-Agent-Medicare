const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('[DB] Unexpected PostgreSQL error:', err.message);
    });
  }
  return pool;
}

// Graceful query — returns empty result if DB not configured
async function query(text, params) {
  const p = getPool();
  if (!p) {
    console.warn('[DB] No DATABASE_URL configured — skipping query:', text.substring(0, 60));
    return { rows: [], rowCount: 0 };
  }
  try {
    return await p.query(text, params);
  } catch (e) {
    console.error('[DB] Query error:', e.message, '|', text.substring(0, 80));
    return { rows: [], rowCount: 0 };
  }
}

module.exports = { query, getPool };
