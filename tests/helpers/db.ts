import mysql from 'mysql2/promise';
import { runMigrations } from '../../src/database/migrations';
import { setPool } from '../../src/database/db';

/**
 * Test DB lifecycle. Tests share a dedicated MariaDB schema (env DB_NAME or
 * `scanflow_test`) on the same MariaDB instance the app uses. Before each
 * test, every table is TRUNCATED so the suite stays isolated. Migrations
 * run once per process.
 *
 * Run with `DB_NAME=scanflow_test` or set in `.env.test`. The schema must
 * already exist (created by a DBA) and the `scanflow` user must have full
 * privileges on it.
 *
 * NOTE: as of the SQLite→MariaDB migration, the per-test repository calls
 * are async — every existing test that calls `resetDb()` synchronously
 * needs to be rewritten to `await resetDb()` plus async repo calls. This
 * helper is async-first; tests must catch up.
 */

let pool: mysql.Pool | null = null;
let migrated = false;

export async function resetDb(): Promise<mysql.Pool> {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || '192.168.33.3',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'scanflow',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'scanflow_test',
      waitForConnections: true,
      connectionLimit: 5,
      charset: 'utf8mb4',
      dateStrings: true,
      multipleStatements: true,
      namedPlaceholders: true,
    });
    setPool(pool);
  }
  if (!migrated) {
    await runMigrations(pool);
    migrated = true;
  }

  // TRUNCATE all data tables in FK-safe order. migration_history is left
  // untouched so we don't re-run schema changes between tests.
  const tables = [
    'nomenclature_price_stats',
    'sber_payments',
    'invoice_items',
    'invoices',
    'mapping_supplier_usage',
    'nomenclature_mappings',
    'onec_nomenclature',
    'sber_tokens',
    'suppliers',
    'notification_events',
    'users',
    'webhook_config',
    'analyzer_config',
    'api_requests_log',
  ];
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) {
    await pool.query(`TRUNCATE TABLE \`${t}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  // Re-seed singleton config rows the app expects.
  await pool.query(
    `INSERT INTO analyzer_config (id, mode, anthropic_api_key) VALUES (1, 'hybrid', NULL)`
  );

  return pool;
}

export async function closeTestDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    migrated = false;
  }
}
