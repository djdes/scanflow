/**
 * One-shot data migration: read every row from a SQLite database file (the
 * legacy `data/database.sqlite` from the better-sqlite3 era) and insert it
 * into the MariaDB schema created by the new migrations runner.
 *
 * Run as:
 *   tsx src/scripts/migrate-sqlite-to-mysql.ts /path/to/old/database.sqlite
 *
 * Idempotent: uses INSERT IGNORE on PK to skip rows that already exist.
 * Safe to re-run if it fails halfway. Truncates `migration_history`-style
 * tables it manages itself; user data tables are append-only.
 *
 * Reads SQLite via the `sqlite3` Linux/Windows CLI (so we don't need to
 * keep `better-sqlite3` in package.json after this script's last use).
 * The CLI is bundled with most distros / available on Windows via scoop.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config';
import { initDb, getPool, closeDb } from '../database/db';
import { logger } from '../utils/logger';

interface TableSpec {
  name: string;
  // Columns to copy in this order. Must match between SQLite and MariaDB.
  columns: string[];
  // Optional: skip rows where this predicate returns true (e.g. sweep stale data).
  filter?: (row: Record<string, unknown>) => boolean;
  // Singleton/config tables that the new migrations runner pre-seeds. We must
  // OVERWRITE the seed values with the values from SQLite, not skip on PK
  // collision. Default false → INSERT IGNORE.
  overwrite?: boolean;
}

// Order matters: parents first (so FKs resolve), children second.
// `migration_history` is created and populated by the new runMigrations() —
// don't copy it.
const TABLES: TableSpec[] = [
  {
    name: 'users',
    columns: [
      'id', 'username', 'password_hash', 'api_key', 'role', 'created_at', 'last_login_at',
      'email', 'notify_mode', 'notify_events', 'telegram_chat_id', 'telegram_bot_token',
      'sber_purpose_template',
    ],
  },
  {
    name: 'webhook_config',
    columns: ['id', 'url', 'enabled', 'auth_token', 'auto_send_1c'],
  },
  {
    name: 'analyzer_config',
    columns: [
      'id', 'mode', 'anthropic_api_key', 'claude_model', 'llm_mapper_enabled',
      'auto_send_1c', 'auto_send_sber',
    ],
    overwrite: true,
  },
  {
    name: 'sber_tokens',
    columns: [
      'id', 'access_token', 'refresh_token', 'expires_at', 'account_number', 'org_name',
      'payer_inn', 'payer_kpp', 'payer_bank_bic', 'payer_bank_corr_account',
      'created_at', 'updated_at',
    ],
  },
  {
    name: 'suppliers',
    columns: [
      'inn', 'name', 'kpp', 'account', 'bank_bic', 'bank_corr_account', 'bank_name',
      'address', 'verified', 'source', 'notes', 'created_at', 'updated_at', 'last_used_at',
    ],
  },
  {
    name: 'onec_nomenclature',
    columns: [
      'guid', 'code', 'name', 'full_name', 'unit', 'parent_guid',
      'is_folder', 'is_weighted', 'synced_at',
    ],
  },
  {
    name: 'nomenclature_mappings',
    columns: [
      'id', 'scanned_name', 'mapped_name_1c', 'category', 'default_unit', 'approved',
      'created_at', 'onec_guid', 'times_seen', 'last_seen_supplier', 'last_seen_at',
      'pack_size', 'pack_unit',
    ],
  },
  {
    name: 'mapping_supplier_usage',
    columns: ['mapping_id', 'supplier', 'first_seen_at', 'last_seen_at', 'times_seen'],
  },
  {
    name: 'invoices',
    columns: [
      'id', 'file_name', 'file_path', 'invoice_number', 'invoice_date', 'supplier',
      'total_sum', 'raw_text', 'status', 'ocr_engine', 'error_message', 'created_at',
      'sent_at', 'invoice_type', 'supplier_inn', 'supplier_bik', 'supplier_account',
      'supplier_corr_account', 'supplier_address', 'vat_sum', 'approved_for_1c',
      'approved_at', 'file_hash', 'items_total_mismatch', 'telegram_message_id',
      'supplier_kpp', 'duplicate_of',
    ],
  },
  {
    name: 'invoice_items',
    columns: [
      'id', 'invoice_id', 'original_name', 'mapped_name', 'quantity', 'unit', 'price',
      'total', 'mapping_confidence', 'vat_rate', 'onec_guid',
    ],
  },
  {
    name: 'sber_payments',
    columns: [
      'id', 'invoice_id', 'external_id', 'status', 'payment_purpose', 'amount',
      'payer_account', 'payee_inn', 'request_payload', 'response_body',
      'sber_payment_number', 'error_message', 'created_at',
    ],
  },
  // notification_events: skip — empty in practice and ephemeral.
  // api_requests_log: skip — pure logging table.
];

interface SqliteRow {
  [key: string]: string | number | null;
}

function readSqliteTable(dbPath: string, table: string, columns: string[]): SqliteRow[] {
  // Use sqlite3 CLI in JSON mode. Works on Linux (apt sqlite3) and Windows
  // (scoop install sqlite). Quote each column name to handle reserved words.
  const colList = columns.map(c => `"${c}"`).join(', ');
  const sql = `.mode json
.headers on
SELECT ${colList} FROM "${table}";`;
  const result = spawnSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 256 });
  if (result.status !== 0) {
    throw new Error(`sqlite3 CLI failed for table ${table}: ${result.stderr}`);
  }
  const out = result.stdout.trim();
  if (!out) return [];
  // JSON mode emits each result row set as one JSON array (or empty string)
  return JSON.parse(out) as SqliteRow[];
}

async function migrateTable(spec: TableSpec, sqlitePath: string): Promise<{ name: string; total: number; inserted: number; skipped: number }> {
  logger.info(`[migrate] reading ${spec.name}...`);
  const rows = readSqliteTable(sqlitePath, spec.name, spec.columns);
  const total = rows.length;
  if (total === 0) {
    logger.info(`[migrate] ${spec.name} is empty, skipping`);
    return { name: spec.name, total: 0, inserted: 0, skipped: 0 };
  }

  // Build a single multi-row INSERT IGNORE for atomicity / speed.
  // Chunked into batches of 200 to avoid max_allowed_packet issues on
  // big rows (raw_text on invoices can be 5 KB+, items can also bloat).
  const pool = getPool();
  const colList = spec.columns.map(c => `\`${c}\``).join(', ');
  const placeholders = `(${spec.columns.map(() => '?').join(', ')})`;

  let inserted = 0;
  let skipped = 0;
  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).filter(r => !spec.filter || !spec.filter(r));
    if (batch.length === 0) continue;
    const values: unknown[] = [];
    for (const row of batch) {
      for (const col of spec.columns) {
        // Booleans in SQLite are 0/1 already; nulls passed through.
        values.push(row[col] ?? null);
      }
    }
    const placeholderSet = batch.map(() => placeholders).join(', ');
    const verb = spec.overwrite ? 'REPLACE INTO' : 'INSERT IGNORE INTO';
    const sql = `${verb} \`${spec.name}\` (${colList}) VALUES ${placeholderSet}`;
    const [result] = await pool.query(sql, values);
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
    inserted += affected;
    skipped += batch.length - affected;
  }

  logger.info(`[migrate] ${spec.name}: ${inserted} inserted, ${skipped} skipped, ${total} total`);
  return { name: spec.name, total, inserted, skipped };
}

async function main(): Promise<void> {
  const sqlitePath = process.argv[2];
  if (!sqlitePath) {
    console.error('Usage: tsx migrate-sqlite-to-mysql.ts /path/to/database.sqlite');
    process.exit(1);
  }
  if (!fs.existsSync(sqlitePath)) {
    console.error(`Source DB not found: ${sqlitePath}`);
    process.exit(1);
  }

  logger.info(`Migration starting`, {
    source: path.resolve(sqlitePath),
    target: `${config.dbHost}:${config.dbPort}/${config.dbName}`,
  });

  // Ensure schema is in place.
  await initDb();

  // Disable FK checks during bulk insert — `invoices` references itself
  // (duplicate_of) and `invoice_items` references `invoices`, so a strict FK
  // order isn't enough when some duplicate_of values point to invoices that
  // came earlier in the same table. Re-enabled at the end.
  const pool = getPool();
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');

  const summary: Array<{ name: string; total: number; inserted: number; skipped: number }> = [];
  try {
    for (const spec of TABLES) {
      const r = await migrateTable(spec, sqlitePath);
      summary.push(r);
    }
  } finally {
    await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  }

  // Bump AUTO_INCREMENT past the largest known id so future INSERTs don't
  // collide with ported rows. MariaDB normally infers this, but explicit is
  // safer when seeding from a non-AUTO_INCREMENT source.
  for (const t of ['users', 'invoices', 'invoice_items', 'nomenclature_mappings', 'sber_payments', 'webhook_config', 'api_requests_log']) {
    const [rows] = await pool.query(`SELECT MAX(id) AS max_id FROM \`${t}\``);
    const maxId = (rows as { max_id: number | null }[])[0].max_id ?? 0;
    if (maxId > 0) {
      await pool.query(`ALTER TABLE \`${t}\` AUTO_INCREMENT = ?`, [maxId + 1]);
    }
  }

  console.log('\n=== migration summary ===');
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(28)} ${s.inserted.toString().padStart(5)} inserted   ${s.skipped} skipped   (${s.total} total)`);
  }

  await closeDb();
  logger.info('Migration complete');
}

main().catch(err => {
  logger.error('Migration failed', { error: (err as Error).message, stack: (err as Error).stack });
  process.exit(1);
});
