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
  // SAFETY GUARD — DO NOT REMOVE.
  // On 2026-05-26 this helper truncated prod MariaDB because dotenv (loaded
  // transitively via src/database/db.ts → src/config.ts) populated
  // process.env.DB_NAME='scanflow' before the `||` fallback could fire.
  // resetDb() unconditionally TRUNCATEs every data table — if we ever point
  // at prod again it wipes the business. Two hard checks below stop that.
  const dbHost = process.env.DB_HOST || '';
  const dbName = process.env.DB_NAME || '';
  if (dbHost !== '127.0.0.1' && dbHost !== 'localhost') {
    throw new Error(
      `tests/helpers/db.ts: refusing to operate against DB_HOST="${dbHost}" — ` +
      `tests must point at 127.0.0.1 or localhost ONLY (incident 2026-05-26).`,
    );
  }
  if (!dbName.includes('test')) {
    throw new Error(
      `tests/helpers/db.ts: refusing to operate against DB_NAME="${dbName}" — ` +
      `schema name must contain "test" (incident 2026-05-26).`,
    );
  }

  if (!pool) {
    pool = mysql.createPool({
      host: dbHost,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'scanflow',
      password: process.env.DB_PASSWORD || '',
      database: dbName,
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
    // Дочерние раньше родительских: mapping_supplier_usage_cards ссылается на
    // nomenclature_mapping_cards внешним ключом.
    'mapping_supplier_usage_cards',
    'supplier_nomenclature_mapping_cards',
    'nomenclature_mapping_cards',
    'nomenclature_price_stat_cards',
    'onec_nomenclature_cards',
    'ocr_correction_cards',
    'ocr_corrections',
    'nomenclature_price_stats',
    'sber_payments',
    'invoice_items',
    'invoices',
    'mapping_supplier_usage',
    'nomenclature_mappings',
    'onec_nomenclature',
    'sber_tokens',
    'sber_connections',
    'suppliers',
    'supplier_cards',
    'supplier_extract_jobs',
    'notification_events',
    // Журнал отправок, на котором стоит часовой лимит уведомлений. Без очистки
    // счётчик копится между прогонами, пересекает NOTIFY_HOURLY_CAP и глушит
    // рассылку навсегда — тесты уведомлений начинают падать «на ровном месте».
    'notification_sends',
    'users',
    'webhook_config',
    'webhook_config_cards',
    'analyzer_config',
    'integration_sync_state',
    'integration_sync_state_cards',
    'api_requests_log',
  ];
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of tables) {
    await pool.query(`TRUNCATE TABLE \`${t}\``);
  }
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');

  // Re-seed singleton config rows the app expects. analyzer_config is still a
  // real platform-wide singleton, so its row has to come back.
  //
  // integration_sync_state больше не пересевается: с миграции 54 приложение
  // читает пер-тенантный integration_sync_state_cards, где строка появляется
  // upsert-ом при первом markNomenclatureSyncRequested(owner). Синглтон-строка
  // старой таблицы теперь не значит ничего, а её посев маскировал бы забытый
  // переезд вызывающего на новую таблицу.
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
