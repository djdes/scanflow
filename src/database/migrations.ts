import Database from 'better-sqlite3';
import { logger } from '../utils/logger';

export function runMigrations(db: Database.Database): void {
  logger.info('Running database migrations...');

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

  // === Migration v2: supplier banking details + analyzer config ===
  const hasInvoiceType = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('invoices') WHERE name = 'invoice_type'"
  ).get() as { cnt: number };

  if (hasInvoiceType.cnt === 0) {
    logger.info('Migration v2: Adding supplier detail columns to invoices...');
    db.exec(`
      ALTER TABLE invoices ADD COLUMN invoice_type TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_inn TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_bik TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_account TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_corr_account TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_address TEXT;
    `);
  }

  const hasAnalyzerConfig = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'analyzer_config'"
  ).get() as { cnt: number };

  if (hasAnalyzerConfig.cnt === 0) {
    logger.info('Migration v2: Creating analyzer_config table...');
    db.exec(`
      CREATE TABLE analyzer_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL DEFAULT 'hybrid',
        anthropic_api_key TEXT
      );
      INSERT INTO analyzer_config (id, mode, anthropic_api_key) VALUES (1, 'hybrid', null);
    `);
  }

  // === Migration v3: VAT (НДС) support ===
  const hasVatRate = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('invoice_items') WHERE name = 'vat_rate'"
  ).get() as { cnt: number };

  if (hasVatRate.cnt === 0) {
    logger.info('Migration v3: Adding VAT columns...');
    db.exec(`
      ALTER TABLE invoice_items ADD COLUMN vat_rate REAL;
      ALTER TABLE invoices ADD COLUMN vat_sum REAL;
    `);
  }

  // === Migration v4: Approval workflow for 1C ===
  // User explicitly clicks "Отправить в 1С" in the dashboard to mark an
  // invoice as ready for 1C pickup. /pending endpoint returns only approved.
  const hasApproved = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('invoices') WHERE name = 'approved_for_1c'"
  ).get() as { cnt: number };

  if (hasApproved.cnt === 0) {
    logger.info('Migration v4: Adding approved_for_1c column...');
    db.exec(`
      ALTER TABLE invoices ADD COLUMN approved_for_1c INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE invoices ADD COLUMN approved_at TEXT;
    `);
  }

  // === Migration v5: API request log (debug) ===
  // Records every hit to /api/* endpoints so we can verify whether 1C
  // actually reached the server when troubleshooting import issues.
  const hasApiRequestsLog = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'api_requests_log'"
  ).get() as { cnt: number };

  if (hasApiRequestsLog.cnt === 0) {
    logger.info('Migration v5: Creating api_requests_log table...');
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
  }

  logger.info('Database migrations completed');
}
