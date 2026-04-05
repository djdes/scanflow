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

  // === Migration v6: onec_nomenclature (1C catalog mirror) ===
  // Local copy of Справочник.Номенклатура from 1С. Primary key is the GUID
  // from the 1C reference (Ссылка.УникальныйИдентификатор). All mapping
  // decisions in the dashboard eventually resolve to one of these rows.
  const hasOnecNomenclature = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'onec_nomenclature'"
  ).get() as { cnt: number };

  if (hasOnecNomenclature.cnt === 0) {
    logger.info('Migration v6: Creating onec_nomenclature table...');
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
  }

  // === Migration v7: Extend mappings and invoice_items with onec_guid ===
  const hasMappingOnecGuid = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('nomenclature_mappings') WHERE name = 'onec_guid'"
  ).get() as { cnt: number };

  if (hasMappingOnecGuid.cnt === 0) {
    logger.info('Migration v7: Extending nomenclature_mappings...');
    db.exec(`
      ALTER TABLE nomenclature_mappings ADD COLUMN onec_guid TEXT;
      ALTER TABLE nomenclature_mappings ADD COLUMN times_seen INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_supplier TEXT;
      ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_at TEXT;

      CREATE INDEX IF NOT EXISTS idx_nomenclature_mappings_onec_guid
        ON nomenclature_mappings(onec_guid);
    `);
  }

  const hasInvoiceItemOnecGuid = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('invoice_items') WHERE name = 'onec_guid'"
  ).get() as { cnt: number };

  if (hasInvoiceItemOnecGuid.cnt === 0) {
    logger.info('Migration v7: Extending invoice_items with onec_guid...');
    db.exec(`ALTER TABLE invoice_items ADD COLUMN onec_guid TEXT;`);
  }

  // === Migration v8: mapping_supplier_usage (per-supplier stats m2m) ===
  const hasSupplierUsage = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type = 'table' AND name = 'mapping_supplier_usage'"
  ).get() as { cnt: number };

  if (hasSupplierUsage.cnt === 0) {
    logger.info('Migration v8: Creating mapping_supplier_usage table...');
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
  }

  logger.info('Database migrations completed');
}
