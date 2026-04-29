import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

/**
 * Each migration has:
 *   - version: monotonic integer. NEVER reorder or reuse numbers.
 *   - name:    short human-readable tag stored in migration_history.
 *   - detect:  returns true when the migration's changes are ALREADY present
 *              in the schema (lets us mark already-applied migrations on DBs
 *              that predate migration_history). May be null for migrations
 *              added after migration_history existed — they just run.
 *   - run:     performs the actual schema change. Called inside a transaction.
 */
interface Migration {
  version: number;
  name: string;
  detect: ((db: Database.Database) => boolean) | null;
  run: (db: Database.Database) => void;
}

const hasColumn = (db: Database.Database, table: string, column: string): boolean => {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM pragma_table_info(?) WHERE name = ?`
  ).get(table, column) as { cnt: number };
  return row.cnt > 0;
};

const hasTable = (db: Database.Database, table: string): boolean => {
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = ?`
  ).get(table) as { cnt: number };
  return row.cnt > 0;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    detect: (db) => hasTable(db, 'invoices'),
    run: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          invoice_number TEXT,
          invoice_date TEXT,
          supplier TEXT,
          total_sum REAL,
          raw_text TEXT,
          status TEXT NOT NULL DEFAULT 'new',
          ocr_engine TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          sent_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
        CREATE INDEX IF NOT EXISTS idx_invoices_created_at ON invoices(created_at);

        CREATE TABLE IF NOT EXISTS invoice_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          invoice_id INTEGER NOT NULL,
          original_name TEXT NOT NULL,
          mapped_name TEXT,
          quantity REAL,
          unit TEXT,
          price REAL,
          total REAL,
          mapping_confidence REAL DEFAULT 0,
          FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id);

        CREATE TABLE IF NOT EXISTS nomenclature_mappings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scanned_name TEXT NOT NULL UNIQUE,
          mapped_name_1c TEXT NOT NULL,
          category TEXT,
          default_unit TEXT,
          approved INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_mappings_scanned_name ON nomenclature_mappings(scanned_name);

        CREATE TABLE IF NOT EXISTS webhook_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          auth_token TEXT
        );
      `);
    },
  },
  {
    version: 2,
    name: 'supplier details + analyzer_config',
    detect: (db) => hasColumn(db, 'invoices', 'invoice_type') && hasTable(db, 'analyzer_config'),
    run: (db) => {
      if (!hasColumn(db, 'invoices', 'invoice_type')) {
        db.exec(`
          ALTER TABLE invoices ADD COLUMN invoice_type TEXT;
          ALTER TABLE invoices ADD COLUMN supplier_inn TEXT;
          ALTER TABLE invoices ADD COLUMN supplier_bik TEXT;
          ALTER TABLE invoices ADD COLUMN supplier_account TEXT;
          ALTER TABLE invoices ADD COLUMN supplier_corr_account TEXT;
          ALTER TABLE invoices ADD COLUMN supplier_address TEXT;
        `);
      }
      if (!hasTable(db, 'analyzer_config')) {
        db.exec(`
          CREATE TABLE analyzer_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            mode TEXT NOT NULL DEFAULT 'hybrid',
            anthropic_api_key TEXT
          );
          INSERT INTO analyzer_config (id, mode, anthropic_api_key) VALUES (1, 'hybrid', null);
        `);
      }
    },
  },
  {
    version: 3,
    name: 'VAT columns',
    detect: (db) => hasColumn(db, 'invoice_items', 'vat_rate'),
    run: (db) => {
      db.exec(`
        ALTER TABLE invoice_items ADD COLUMN vat_rate REAL;
        ALTER TABLE invoices ADD COLUMN vat_sum REAL;
      `);
    },
  },
  {
    version: 4,
    name: 'approved_for_1c workflow',
    detect: (db) => hasColumn(db, 'invoices', 'approved_for_1c'),
    run: (db) => {
      db.exec(`
        ALTER TABLE invoices ADD COLUMN approved_for_1c INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE invoices ADD COLUMN approved_at TEXT;
      `);
    },
  },
  {
    version: 5,
    name: 'api_requests_log',
    detect: (db) => hasTable(db, 'api_requests_log'),
    run: (db) => {
      db.exec(`
        CREATE TABLE api_requests_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL DEFAULT (datetime('now')),
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          remote_addr TEXT,
          user_agent TEXT,
          status_code INTEGER,
          duration_ms INTEGER
        );
        CREATE INDEX idx_api_requests_log_timestamp ON api_requests_log(timestamp);
      `);
    },
  },
  {
    version: 6,
    name: 'onec_nomenclature catalog',
    detect: (db) => hasTable(db, 'onec_nomenclature'),
    run: (db) => {
      db.exec(`
        CREATE TABLE onec_nomenclature (
          guid        TEXT PRIMARY KEY,
          code        TEXT,
          name        TEXT NOT NULL,
          full_name   TEXT,
          unit        TEXT,
          parent_guid TEXT,
          is_folder   INTEGER NOT NULL DEFAULT 0,
          is_weighted INTEGER NOT NULL DEFAULT 0,
          synced_at   TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_onec_nomenclature_name ON onec_nomenclature(name COLLATE NOCASE);
        CREATE INDEX idx_onec_nomenclature_parent ON onec_nomenclature(parent_guid);
      `);
    },
  },
  {
    version: 7,
    name: 'onec_guid on mappings + invoice_items',
    detect: (db) => hasColumn(db, 'nomenclature_mappings', 'onec_guid') && hasColumn(db, 'invoice_items', 'onec_guid'),
    run: (db) => {
      if (!hasColumn(db, 'nomenclature_mappings', 'onec_guid')) {
        db.exec(`
          ALTER TABLE nomenclature_mappings ADD COLUMN onec_guid TEXT;
          ALTER TABLE nomenclature_mappings ADD COLUMN times_seen INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_supplier TEXT;
          ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_at TEXT;
          CREATE INDEX IF NOT EXISTS idx_nomenclature_mappings_onec_guid
            ON nomenclature_mappings(onec_guid);
        `);
      }
      if (!hasColumn(db, 'invoice_items', 'onec_guid')) {
        db.exec(`ALTER TABLE invoice_items ADD COLUMN onec_guid TEXT;`);
      }
    },
  },
  {
    version: 8,
    name: 'mapping_supplier_usage',
    detect: (db) => hasTable(db, 'mapping_supplier_usage'),
    run: (db) => {
      db.exec(`
        CREATE TABLE mapping_supplier_usage (
          mapping_id    INTEGER NOT NULL,
          supplier      TEXT NOT NULL,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
          times_seen    INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (mapping_id, supplier),
          FOREIGN KEY (mapping_id) REFERENCES nomenclature_mappings(id) ON DELETE CASCADE
        );
        CREATE INDEX idx_mapping_supplier_usage_supplier ON mapping_supplier_usage(supplier);
      `);
    },
  },
  {
    version: 9,
    name: 'auto_send_1c flag',
    detect: (db) => hasColumn(db, 'webhook_config', 'auto_send_1c'),
    run: (db) => {
      db.exec(`ALTER TABLE webhook_config ADD COLUMN auto_send_1c INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    version: 10,
    name: 'claude_model in analyzer_config',
    detect: (db) => hasColumn(db, 'analyzer_config', 'claude_model'),
    run: (db) => {
      db.exec(`ALTER TABLE analyzer_config ADD COLUMN claude_model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6';`);
    },
  },
  {
    version: 11,
    name: 'fix stale dated model id',
    // Data-only migration: can be detected only by absence of affected rows.
    // If any row still uses the old dated id, re-running is safe (idempotent UPDATE).
    detect: (db) => {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM analyzer_config WHERE claude_model LIKE '%20250627%'`
      ).get() as { cnt: number };
      return row.cnt === 0;
    },
    run: (db) => {
      db.exec(`UPDATE analyzer_config SET claude_model = 'claude-sonnet-4-6' WHERE claude_model LIKE '%20250627%';`);
    },
  },
  {
    version: 12,
    name: 'file_hash on invoices',
    detect: (db) => hasColumn(db, 'invoices', 'file_hash'),
    run: (db) => {
      db.exec(`
        ALTER TABLE invoices ADD COLUMN file_hash TEXT;
        CREATE INDEX IF NOT EXISTS idx_invoices_file_hash ON invoices(file_hash);
      `);
    },
  },
  {
    version: 13,
    name: 'pack_size / pack_unit on nomenclature_mappings',
    detect: (db) => hasColumn(db, 'nomenclature_mappings', 'pack_size'),
    run: (db) => {
      db.exec(`
        ALTER TABLE nomenclature_mappings ADD COLUMN pack_size REAL;
        ALTER TABLE nomenclature_mappings ADD COLUMN pack_unit TEXT;
      `);
    },
  },
  {
    version: 14,
    name: 'UNIQUE partial index on file_hash (atomic dedup)',
    // Replaces the old non-unique idx_invoices_file_hash with a partial UNIQUE
    // index (only when file_hash IS NOT NULL). This makes INSERT race-safe:
    // two concurrent uploads of the same content will no longer both create
    // invoice rows — the second one gets a SQLITE_CONSTRAINT_UNIQUE error
    // and the caller falls back to the existing row.
    detect: (db) => {
      const row = db.prepare(
        `SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'index' AND name = 'idx_invoices_file_hash_unique'`
      ).get() as { cnt: number };
      return row.cnt > 0;
    },
    run: (db) => {
      // First clean up ANY duplicates that slipped in before the constraint.
      // Keep the lowest id, delete the rest (cascade removes their items).
      db.exec(`
        DELETE FROM invoices
        WHERE file_hash IS NOT NULL
          AND id NOT IN (
            SELECT MIN(id) FROM invoices
            WHERE file_hash IS NOT NULL
            GROUP BY file_hash
          );
        DROP INDEX IF EXISTS idx_invoices_file_hash;
        CREATE UNIQUE INDEX idx_invoices_file_hash_unique
          ON invoices(file_hash) WHERE file_hash IS NOT NULL;
      `);
    },
  },
  {
    version: 15,
    name: 'items_total_mismatch flag on invoices',
    detect: (db) => hasColumn(db, 'invoices', 'items_total_mismatch'),
    run: (db) => {
      // Populated by invoiceRepo.recalculateTotal: 1 when sum(items.total)
      // diverges from invoices.total_sum by > 1% (with a 1 ruble floor).
      // UI surfaces this as a warning badge so a human can review before
      // the invoice goes to 1С.
      db.exec(`ALTER TABLE invoices ADD COLUMN items_total_mismatch INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    version: 16,
    name: 'llm_mapper_enabled flag on analyzer_config',
    detect: (db) => hasColumn(db, 'analyzer_config', 'llm_mapper_enabled'),
    run: (db) => {
      // When on, the Claude OCR prompt receives the 1C catalog and is asked
      // to return onec_guid per item. The watcher trusts those GUIDs when
      // they exist in onec_nomenclature, skipping fuzzy matching for that
      // line. Enabled by default — pure upside on correctness, no extra API
      // calls (it piggybacks on the existing OCR request).
      db.exec(`ALTER TABLE analyzer_config ADD COLUMN llm_mapper_enabled INTEGER NOT NULL DEFAULT 1;`);
    },
  },
  {
    version: 17,
    name: 'users table (per-account API keys)',
    detect: (db) => hasTable(db, 'users'),
    run: (db) => {
      db.exec(`
        CREATE TABLE users (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
          password_hash   TEXT NOT NULL,
          api_key         TEXT NOT NULL UNIQUE,
          role            TEXT NOT NULL DEFAULT 'user',
          created_at      TEXT NOT NULL DEFAULT (datetime('now')),
          last_login_at   TEXT
        );
        CREATE INDEX idx_users_api_key ON users(api_key);
      `);
    },
  },
  {
    version: 18,
    name: 'user notification settings',
    detect: (db) => hasColumn(db, 'users', 'email') && hasTable(db, 'notification_events'),
    run: (db) => {
      const defaultEvents = JSON.stringify([
        'photo_uploaded',
        'invoice_recognized',
        'recognition_error',
        'suspicious_total',
        'invoice_edited',
        'approved_for_1c',
        'sent_to_1c',
      ]);

      if (!hasColumn(db, 'users', 'email')) {
        db.exec(`ALTER TABLE users ADD COLUMN email TEXT;`);
      }
      if (!hasColumn(db, 'users', 'notify_mode')) {
        db.exec(`ALTER TABLE users ADD COLUMN notify_mode TEXT NOT NULL DEFAULT 'digest_hourly';`);
      }
      if (!hasColumn(db, 'users', 'notify_events')) {
        db.exec(`ALTER TABLE users ADD COLUMN notify_events TEXT NOT NULL DEFAULT '${defaultEvents.replace(/'/g, "''")}';`);
      }

      // One-shot: pre-fill email from MAIL_TO env for existing users.
      // After migration, user can change via profile UI.
      const mailTo = (process.env.MAIL_TO || '').trim();
      if (mailTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailTo)) {
        db.prepare('UPDATE users SET email = ? WHERE email IS NULL').run(mailTo);
      }

      if (!hasTable(db, 'notification_events')) {
        db.exec(`
          CREATE TABLE notification_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL REFERENCES users(id),
            event_type   TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            created_at   TEXT NOT NULL DEFAULT (datetime('now')),
            sent_at      TEXT
          );
          CREATE INDEX idx_notif_pending ON notification_events(user_id, sent_at);
        `);
      }
    },
  },
];

export function runMigrations(db: Database.Database): void {
  logger.info('Running database migrations...');

  // Bootstrap the history table itself. Always idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS migration_history (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER
    );
  `);

  const appliedRows = db.prepare('SELECT version FROM migration_history').all() as { version: number }[];
  const applied = new Set<number>(appliedRows.map(r => r.version));

  const insertHistory = db.prepare(
    'INSERT OR IGNORE INTO migration_history (version, name, applied_at, duration_ms) VALUES (?, ?, datetime(\'now\'), ?)'
  );

  for (const mig of MIGRATIONS) {
    if (applied.has(mig.version)) continue;

    // Backfill case: the DB predates migration_history but already has the
    // changes from this migration. Record it without running.
    if (mig.detect && mig.detect(db)) {
      insertHistory.run(mig.version, mig.name, 0);
      logger.info('Migration already present, backfilled history', { version: mig.version, name: mig.name });
      continue;
    }

    const t0 = Date.now();
    logger.info('Applying migration', { version: mig.version, name: mig.name });
    const tx = db.transaction(() => {
      mig.run(db);
      insertHistory.run(mig.version, mig.name, Date.now() - t0);
    });
    try {
      tx();
      logger.info('Migration applied', { version: mig.version, name: mig.name, durationMs: Date.now() - t0 });
    } catch (err) {
      logger.error('Migration failed — transaction rolled back', {
        version: mig.version,
        name: mig.name,
        error: (err as Error).message,
      });
      throw err; // fail-fast: do not continue with a partially-migrated schema
    }
  }

  logger.info('Database migrations completed');
}
