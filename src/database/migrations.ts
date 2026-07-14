import { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { logger } from '../utils/logger';

type Executor = Pool | PoolConnection;

/**
 * Each migration has:
 *   - version: monotonic integer. NEVER reorder or reuse numbers.
 *   - name:    short human-readable tag stored in migration_history.
 *   - detect:  returns true when the migration's changes are ALREADY present
 *              in the schema (lets us mark already-applied migrations on DBs
 *              that predate migration_history). May be null for migrations
 *              added after migration_history existed — they just run.
 *   - run:     performs the actual schema change. MySQL DDL is not
 *              transactional, so each ALTER/CREATE is idempotent (uses
 *              IF NOT EXISTS guards or the hasColumn/hasTable helpers).
 */
interface Migration {
  version: number;
  name: string;
  detect: ((exec: Executor) => Promise<boolean>) | null;
  run: (exec: Executor) => Promise<void>;
}

async function hasColumn(exec: Executor, table: string, column: string): Promise<boolean> {
  const [rows] = await exec.query<RowDataPacket[]>(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function hasTable(exec: Executor, table: string): Promise<boolean> {
  const [rows] = await exec.query<RowDataPacket[]>(
    `SELECT 1 FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table]
  );
  return rows.length > 0;
}

async function hasIndex(exec: Executor, table: string, index: string): Promise<boolean> {
  const [rows] = await exec.query<RowDataPacket[]>(
    `SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
       LIMIT 1`,
    [table, index]
  );
  return rows.length > 0;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    detect: (exec) => hasTable(exec, 'invoices'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS invoices (
          id              INT AUTO_INCREMENT PRIMARY KEY,
          file_name       VARCHAR(512) NOT NULL,
          file_path       VARCHAR(1024) NOT NULL,
          invoice_number  VARCHAR(255) NULL,
          invoice_date    VARCHAR(32) NULL,
          supplier        VARCHAR(512) NULL,
          total_sum       DOUBLE NULL,
          raw_text        MEDIUMTEXT NULL,
          status          VARCHAR(32) NOT NULL DEFAULT 'new',
          ocr_engine      VARCHAR(64) NULL,
          error_message   TEXT NULL,
          created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          sent_at         DATETIME NULL,
          INDEX idx_invoices_status (status),
          INDEX idx_invoices_created_at (created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await exec.query(`
        CREATE TABLE IF NOT EXISTS invoice_items (
          id                  INT AUTO_INCREMENT PRIMARY KEY,
          invoice_id          INT NOT NULL,
          original_name       VARCHAR(1024) NOT NULL,
          mapped_name         VARCHAR(1024) NULL,
          quantity            DOUBLE NULL,
          unit                VARCHAR(64) NULL,
          price               DOUBLE NULL,
          total               DOUBLE NULL,
          mapping_confidence  DOUBLE DEFAULT 0,
          INDEX idx_invoice_items_invoice_id (invoice_id),
          CONSTRAINT fk_invoice_items_invoice
            FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await exec.query(`
        CREATE TABLE IF NOT EXISTS nomenclature_mappings (
          id              INT AUTO_INCREMENT PRIMARY KEY,
          scanned_name    VARCHAR(512) NOT NULL UNIQUE,
          mapped_name_1c  VARCHAR(512) NOT NULL,
          category        VARCHAR(255) NULL,
          default_unit    VARCHAR(64) NULL,
          approved        TINYINT(1) NOT NULL DEFAULT 0,
          created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_mappings_scanned_name (scanned_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await exec.query(`
        CREATE TABLE IF NOT EXISTS webhook_config (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          url         VARCHAR(1024) NOT NULL,
          enabled     TINYINT(1) NOT NULL DEFAULT 0,
          auth_token  VARCHAR(255) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 2,
    name: 'supplier details + analyzer_config',
    detect: async (exec) => (await hasColumn(exec, 'invoices', 'invoice_type')) && (await hasTable(exec, 'analyzer_config')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'invoice_type'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN invoice_type VARCHAR(32) NULL`);
        await exec.query(`ALTER TABLE invoices ADD COLUMN supplier_inn VARCHAR(32) NULL`);
        await exec.query(`ALTER TABLE invoices ADD COLUMN supplier_bik VARCHAR(32) NULL`);
        await exec.query(`ALTER TABLE invoices ADD COLUMN supplier_account VARCHAR(64) NULL`);
        await exec.query(`ALTER TABLE invoices ADD COLUMN supplier_corr_account VARCHAR(64) NULL`);
        await exec.query(`ALTER TABLE invoices ADD COLUMN supplier_address VARCHAR(1024) NULL`);
      }
      if (!(await hasTable(exec, 'analyzer_config'))) {
        await exec.query(`
          CREATE TABLE analyzer_config (
            id                INT PRIMARY KEY,
            mode              VARCHAR(32) NOT NULL DEFAULT 'hybrid',
            anthropic_api_key TEXT NULL,
            CHECK (id = 1)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await exec.query(
          `INSERT INTO analyzer_config (id, mode, anthropic_api_key) VALUES (1, 'hybrid', NULL)`
        );
      }
    },
  },
  {
    version: 3,
    name: 'VAT columns',
    detect: (exec) => hasColumn(exec, 'invoice_items', 'vat_rate'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoice_items', 'vat_rate'))) {
        await exec.query(`ALTER TABLE invoice_items ADD COLUMN vat_rate DOUBLE NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'vat_sum'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN vat_sum DOUBLE NULL`);
      }
    },
  },
  {
    version: 4,
    name: 'approved_for_1c workflow',
    detect: (exec) => hasColumn(exec, 'invoices', 'approved_for_1c'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'approved_for_1c'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN approved_for_1c TINYINT(1) NOT NULL DEFAULT 0`);
      }
      if (!(await hasColumn(exec, 'invoices', 'approved_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN approved_at DATETIME NULL`);
      }
    },
  },
  {
    version: 5,
    name: 'api_requests_log',
    detect: (exec) => hasTable(exec, 'api_requests_log'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS api_requests_log (
          id          INT AUTO_INCREMENT PRIMARY KEY,
          timestamp   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          method      VARCHAR(10) NOT NULL,
          path        VARCHAR(1024) NOT NULL,
          remote_addr VARCHAR(64) NULL,
          user_agent  VARCHAR(512) NULL,
          status_code INT NULL,
          duration_ms INT NULL,
          INDEX idx_api_requests_log_timestamp (timestamp)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 6,
    name: 'onec_nomenclature catalog',
    detect: (exec) => hasTable(exec, 'onec_nomenclature'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS onec_nomenclature (
          guid         VARCHAR(64) PRIMARY KEY,
          code         VARCHAR(64) NULL,
          name         VARCHAR(512) NOT NULL,
          full_name    VARCHAR(1024) NULL,
          unit         VARCHAR(32) NULL,
          parent_guid  VARCHAR(64) NULL,
          is_folder    TINYINT(1) NOT NULL DEFAULT 0,
          is_weighted  TINYINT(1) NOT NULL DEFAULT 0,
          synced_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_onec_nomenclature_name (name),
          INDEX idx_onec_nomenclature_parent (parent_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 7,
    name: 'onec_guid on mappings + invoice_items',
    detect: async (exec) =>
      (await hasColumn(exec, 'nomenclature_mappings', 'onec_guid')) &&
      (await hasColumn(exec, 'invoice_items', 'onec_guid')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'nomenclature_mappings', 'onec_guid'))) {
        await exec.query(`ALTER TABLE nomenclature_mappings ADD COLUMN onec_guid VARCHAR(64) NULL`);
        await exec.query(`ALTER TABLE nomenclature_mappings ADD COLUMN times_seen INT NOT NULL DEFAULT 0`);
        await exec.query(`ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_supplier VARCHAR(512) NULL`);
        await exec.query(`ALTER TABLE nomenclature_mappings ADD COLUMN last_seen_at DATETIME NULL`);
        if (!(await hasIndex(exec, 'nomenclature_mappings', 'idx_nomenclature_mappings_onec_guid'))) {
          await exec.query(`CREATE INDEX idx_nomenclature_mappings_onec_guid ON nomenclature_mappings(onec_guid)`);
        }
      }
      if (!(await hasColumn(exec, 'invoice_items', 'onec_guid'))) {
        await exec.query(`ALTER TABLE invoice_items ADD COLUMN onec_guid VARCHAR(64) NULL`);
      }
    },
  },
  {
    version: 8,
    name: 'mapping_supplier_usage',
    detect: (exec) => hasTable(exec, 'mapping_supplier_usage'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS mapping_supplier_usage (
          mapping_id    INT NOT NULL,
          supplier      VARCHAR(512) NOT NULL,
          first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          times_seen    INT NOT NULL DEFAULT 1,
          PRIMARY KEY (mapping_id, supplier),
          INDEX idx_mapping_supplier_usage_supplier (supplier),
          CONSTRAINT fk_mapping_supplier_usage_mapping
            FOREIGN KEY (mapping_id) REFERENCES nomenclature_mappings(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 9,
    name: 'auto_send_1c flag',
    detect: (exec) => hasColumn(exec, 'webhook_config', 'auto_send_1c'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'webhook_config', 'auto_send_1c'))) {
        await exec.query(`ALTER TABLE webhook_config ADD COLUMN auto_send_1c TINYINT(1) NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 10,
    name: 'claude_model in analyzer_config',
    detect: (exec) => hasColumn(exec, 'analyzer_config', 'claude_model'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'analyzer_config', 'claude_model'))) {
        await exec.query(
          `ALTER TABLE analyzer_config ADD COLUMN claude_model VARCHAR(64) NOT NULL DEFAULT 'claude-sonnet-4-6'`
        );
      }
    },
  },
  {
    version: 11,
    name: 'fix stale dated model id',
    // Data-only migration: idempotent UPDATE.
    detect: async (exec) => {
      const [rows] = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM analyzer_config WHERE claude_model LIKE '%20250627%'`
      );
      return rows[0].cnt === 0;
    },
    run: async (exec) => {
      await exec.query(
        `UPDATE analyzer_config SET claude_model = 'claude-sonnet-4-6' WHERE claude_model LIKE '%20250627%'`
      );
    },
  },
  {
    version: 12,
    name: 'file_hash on invoices',
    detect: (exec) => hasColumn(exec, 'invoices', 'file_hash'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'file_hash'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN file_hash VARCHAR(64) NULL`);
        if (!(await hasIndex(exec, 'invoices', 'idx_invoices_file_hash'))) {
          await exec.query(`CREATE INDEX idx_invoices_file_hash ON invoices(file_hash)`);
        }
      }
    },
  },
  {
    version: 13,
    name: 'pack_size / pack_unit on nomenclature_mappings',
    detect: (exec) => hasColumn(exec, 'nomenclature_mappings', 'pack_size'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'nomenclature_mappings', 'pack_size'))) {
        await exec.query(`ALTER TABLE nomenclature_mappings ADD COLUMN pack_size DOUBLE NULL`);
        await exec.query(`ALTER TABLE nomenclature_mappings ADD COLUMN pack_unit VARCHAR(32) NULL`);
      }
    },
  },
  {
    version: 14,
    name: 'UNIQUE index on file_hash (atomic dedup)',
    // MySQL UNIQUE allows multiple NULLs, so a regular UNIQUE index has the
    // same semantic as SQLite's `WHERE file_hash IS NOT NULL` partial index:
    // two invoices with the same non-null hash collide; rows without a hash
    // don't.
    detect: (exec) => hasIndex(exec, 'invoices', 'idx_invoices_file_hash_unique'),
    run: async (exec) => {
      // Clean up duplicates first (cascade removes their items).
      await exec.query(`
        DELETE FROM invoices
         WHERE file_hash IS NOT NULL
           AND id NOT IN (
             SELECT min_id FROM (
               SELECT MIN(id) AS min_id FROM invoices WHERE file_hash IS NOT NULL GROUP BY file_hash
             ) AS keepers
           )
      `);
      if (await hasIndex(exec, 'invoices', 'idx_invoices_file_hash')) {
        await exec.query(`DROP INDEX idx_invoices_file_hash ON invoices`);
      }
      if (!(await hasIndex(exec, 'invoices', 'idx_invoices_file_hash_unique'))) {
        await exec.query(`CREATE UNIQUE INDEX idx_invoices_file_hash_unique ON invoices(file_hash)`);
      }
    },
  },
  {
    version: 15,
    name: 'items_total_mismatch flag on invoices',
    detect: (exec) => hasColumn(exec, 'invoices', 'items_total_mismatch'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'items_total_mismatch'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN items_total_mismatch TINYINT(1) NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 16,
    name: 'llm_mapper_enabled flag on analyzer_config',
    detect: (exec) => hasColumn(exec, 'analyzer_config', 'llm_mapper_enabled'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'analyzer_config', 'llm_mapper_enabled'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN llm_mapper_enabled TINYINT(1) NOT NULL DEFAULT 1`);
      }
    },
  },
  {
    version: 17,
    name: 'users table (per-account API keys)',
    detect: (exec) => hasTable(exec, 'users'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS users (
          id              INT AUTO_INCREMENT PRIMARY KEY,
          username        VARCHAR(255) NOT NULL UNIQUE,
          password_hash   VARCHAR(512) NOT NULL,
          api_key         VARCHAR(128) NOT NULL UNIQUE,
          role            VARCHAR(32) NOT NULL DEFAULT 'user',
          created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_login_at   DATETIME NULL,
          INDEX idx_users_api_key (api_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 18,
    name: 'user notification settings',
    detect: async (exec) =>
      (await hasColumn(exec, 'users', 'email')) && (await hasTable(exec, 'notification_events')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'users', 'email'))) {
        await exec.query(`ALTER TABLE users ADD COLUMN email VARCHAR(255) NULL`);
      }
      if (!(await hasColumn(exec, 'users', 'notify_mode'))) {
        await exec.query(`ALTER TABLE users ADD COLUMN notify_mode VARCHAR(32) NOT NULL DEFAULT 'digest_hourly'`);
      }
      if (!(await hasColumn(exec, 'users', 'notify_events'))) {
        const defaultEvents = JSON.stringify([
          'photo_uploaded',
          'invoice_recognized',
          'recognition_error',
          'suspicious_total',
          'elevated_prices',
          'invoice_edited',
          'approved_for_1c',
          'sent_to_1c',
        ]);
        // Vanilla MySQL forbids DEFAULT on TEXT/BLOB columns; MariaDB (≥10.2)
        // allows it. To work on both: add as NULL, backfill, then enforce NOT NULL.
        await exec.query(`ALTER TABLE users ADD COLUMN notify_events TEXT NULL`);
        await exec.query(
          `UPDATE users SET notify_events = ? WHERE notify_events IS NULL`,
          [defaultEvents],
        );
        await exec.query(`ALTER TABLE users MODIFY COLUMN notify_events TEXT NOT NULL`);
      }

      const mailTo = (process.env.MAIL_TO || '').trim();
      if (mailTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailTo)) {
        await exec.query('UPDATE users SET email = ? WHERE email IS NULL', [mailTo]);
      }

      if (!(await hasTable(exec, 'notification_events'))) {
        await exec.query(`
          CREATE TABLE notification_events (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            user_id      INT NOT NULL,
            event_type   VARCHAR(64) NOT NULL,
            payload_json TEXT NOT NULL,
            created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            sent_at      DATETIME NULL,
            INDEX idx_notif_pending (user_id, sent_at),
            CONSTRAINT fk_notif_events_user
              FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      }
    },
  },
  {
    version: 19,
    name: 'telegram notification fields',
    detect: async (exec) =>
      (await hasColumn(exec, 'users', 'telegram_chat_id')) &&
      (await hasColumn(exec, 'users', 'telegram_bot_token')) &&
      (await hasColumn(exec, 'invoices', 'telegram_message_id')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'users', 'telegram_chat_id'))) {
        await exec.query(`ALTER TABLE users ADD COLUMN telegram_chat_id VARCHAR(64) NULL`);
      }
      if (!(await hasColumn(exec, 'users', 'telegram_bot_token'))) {
        await exec.query(`ALTER TABLE users ADD COLUMN telegram_bot_token VARCHAR(255) NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'telegram_message_id'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN telegram_message_id BIGINT NULL`);
      }
    },
  },
  {
    version: 20,
    name: 'Sber Business payments',
    detect: async (exec) =>
      (await hasTable(exec, 'sber_tokens')) &&
      (await hasTable(exec, 'suppliers')) &&
      (await hasTable(exec, 'sber_payments')) &&
      (await hasColumn(exec, 'invoices', 'supplier_kpp')) &&
      (await hasColumn(exec, 'users', 'sber_purpose_template')),
    run: async (exec) => {
      if (!(await hasTable(exec, 'sber_tokens'))) {
        await exec.query(`
          CREATE TABLE sber_tokens (
            id                       INT PRIMARY KEY,
            access_token             TEXT NOT NULL,
            refresh_token            TEXT NOT NULL,
            expires_at               DATETIME NOT NULL,
            account_number           VARCHAR(64) NULL,
            org_name                 VARCHAR(512) NULL,
            payer_inn                VARCHAR(32) NULL,
            payer_kpp                VARCHAR(32) NULL,
            payer_bank_bic           VARCHAR(32) NULL,
            payer_bank_corr_account  VARCHAR(64) NULL,
            created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CHECK (id = 1)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      }
      if (!(await hasTable(exec, 'suppliers'))) {
        await exec.query(`
          CREATE TABLE suppliers (
            inn                VARCHAR(32) PRIMARY KEY,
            name               VARCHAR(512) NOT NULL,
            kpp                VARCHAR(32) NULL,
            account            VARCHAR(64) NULL,
            bank_bic           VARCHAR(32) NOT NULL,
            bank_corr_account  VARCHAR(64) NULL,
            bank_name          VARCHAR(512) NULL,
            address            VARCHAR(1024) NULL,
            verified           TINYINT(1) NOT NULL DEFAULT 0,
            source             VARCHAR(64) NULL,
            notes              TEXT NULL,
            created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_used_at       DATETIME NULL,
            INDEX idx_suppliers_name (name)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      }
      if (!(await hasTable(exec, 'sber_payments'))) {
        await exec.query(`
          CREATE TABLE sber_payments (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            invoice_id          INT NOT NULL UNIQUE,
            external_id         VARCHAR(64) NOT NULL UNIQUE,
            status              VARCHAR(32) NOT NULL,
            payment_purpose     VARCHAR(512) NOT NULL,
            amount              DOUBLE NOT NULL,
            payer_account       VARCHAR(64) NOT NULL,
            payee_inn           VARCHAR(32) NOT NULL,
            request_payload     TEXT NULL,
            response_body       TEXT NULL,
            sber_payment_number VARCHAR(64) NULL,
            error_message       TEXT NULL,
            created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_sber_payments_invoice_id (invoice_id),
            CONSTRAINT fk_sber_payments_invoice
              FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
      }
      if (!(await hasColumn(exec, 'invoices', 'supplier_kpp'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN supplier_kpp VARCHAR(32) NULL`);
      }
      if (!(await hasColumn(exec, 'users', 'sber_purpose_template'))) {
        await exec.query(`
          ALTER TABLE users ADD COLUMN sber_purpose_template VARCHAR(512)
            DEFAULT 'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}'
        `);
      }
    },
  },
  {
    version: 21,
    name: 'duplicate invoice detection',
    detect: (exec) => hasColumn(exec, 'invoices', 'duplicate_of'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'duplicate_of'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN duplicate_of INT NULL`);
        if (!(await hasIndex(exec, 'invoices', 'idx_invoices_duplicate_of'))) {
          await exec.query(`CREATE INDEX idx_invoices_duplicate_of ON invoices(duplicate_of)`);
        }
      }
    },
  },
  {
    version: 22,
    name: 'auto-send flags in analyzer_config',
    detect: async (exec) =>
      (await hasColumn(exec, 'analyzer_config', 'auto_send_1c')) &&
      (await hasColumn(exec, 'analyzer_config', 'auto_send_sber')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'analyzer_config', 'auto_send_1c'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN auto_send_1c TINYINT(1) NOT NULL DEFAULT 0`);
      }
      if (!(await hasColumn(exec, 'analyzer_config', 'auto_send_sber'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN auto_send_sber TINYINT(1) NOT NULL DEFAULT 0`);
      }
    },
  },
  {
    version: 23,
    name: 'magic-link token for email-only auth',
    detect: (exec) => hasColumn(exec, 'users', 'magic_token'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'users', 'magic_token'))) {
        await exec.query(`ALTER TABLE users ADD COLUMN magic_token VARCHAR(64) NULL`);
      }
      if (!(await hasColumn(exec, 'users', 'magic_token_expires_at'))) {
        await exec.query(`ALTER TABLE users ADD COLUMN magic_token_expires_at DATETIME NULL`);
      }
      if (!(await hasIndex(exec, 'users', 'idx_users_magic_token'))) {
        await exec.query(`CREATE INDEX idx_users_magic_token ON users(magic_token)`);
      }
    },
  },
  {
    version: 24,
    name: 'nomenclature_price_stats: median price per GUID',
    detect: (exec) => hasTable(exec, 'nomenclature_price_stats'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS nomenclature_price_stats (
          onec_guid    VARCHAR(64) NOT NULL PRIMARY KEY,
          median_price DOUBLE      NOT NULL,
          price_unit   VARCHAR(32) NOT NULL,
          samples      INT         NOT NULL,
          updated_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      const { backfillAllStats } = await import('../pricing/priceStats');
      await backfillAllStats();
    },
  },
  {
    version: 25,
    name: 'dispatcher mode: task_id + token + started_at on invoices',
    detect: (exec) => hasColumn(exec, 'invoices', 'dispatcher_task_id'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'dispatcher_task_id'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN dispatcher_task_id VARCHAR(64) NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'dispatcher_token'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN dispatcher_token CHAR(64) NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'dispatcher_started_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN dispatcher_started_at DATETIME NULL`);
      }
      if (!(await hasIndex(exec, 'invoices', 'idx_invoices_dispatcher_started'))) {
        await exec.query(
          `CREATE INDEX idx_invoices_dispatcher_started ON invoices (dispatcher_started_at)`,
        );
      }
    },
  },
  {
    version: 26,
    name: 'dispatcher mode: projectsflow_token on analyzer_config',
    detect: (exec) => hasColumn(exec, 'analyzer_config', 'projectsflow_token'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'analyzer_config', 'projectsflow_token'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN projectsflow_token VARCHAR(255) NULL`);
      }
    },
  },
  {
    version: 27,
    name: 'dispatcher mode: projectsflow_project_id on analyzer_config',
    detect: (exec) => hasColumn(exec, 'analyzer_config', 'projectsflow_project_id'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'analyzer_config', 'projectsflow_project_id'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN projectsflow_project_id VARCHAR(64) NULL`);
      }
    },
  },
  {
    version: 28,
    name: 'invoice_items.row_no — line sequence number for multi-page merge',
    detect: (exec) => hasColumn(exec, 'invoice_items', 'row_no'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoice_items', 'row_no'))) {
        await exec.query(`ALTER TABLE invoice_items ADD COLUMN row_no INT NULL`);
      }
    },
  },
  {
    version: 29,
    name: 'supplier_extract_jobs — async requisite recognition via dispatcher',
    detect: (exec) => hasTable(exec, 'supplier_extract_jobs'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS supplier_extract_jobs (
          id           INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
          token        CHAR(64)     NOT NULL,
          task_id      VARCHAR(64)  NULL,
          status       VARCHAR(20)  NOT NULL DEFAULT 'processing',
          file_name    VARCHAR(255) NOT NULL,
          file_path    TEXT         NOT NULL,
          content_type VARCHAR(64)  NOT NULL DEFAULT 'image/jpeg',
          result_json  TEXT         NULL,
          error        TEXT         NULL,
          created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 30,
    name: 'notify_events: opt-in elevated_prices for existing users',
    detect: async (exec) => {
      const [total] = await exec.query<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM users`);
      const [have]  = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS c FROM users WHERE notify_events LIKE '%"elevated_prices"%'`,
      );
      const t = Number(total[0]?.c ?? 0);
      const h = Number(have[0]?.c ?? 0);
      return t > 0 && t === h;
    },
    run: async (exec) => {
      const [users] = await exec.query<RowDataPacket[]>(`SELECT id, notify_events FROM users`);
      for (const u of users) {
        let events: unknown;
        try { events = JSON.parse(u.notify_events); } catch { events = []; }
        const arr: string[] = Array.isArray(events) ? events.filter((e): e is string => typeof e === 'string') : [];
        if (arr.includes('elevated_prices')) continue;
        arr.push('elevated_prices');
        await exec.query(`UPDATE users SET notify_events = ? WHERE id = ?`, [JSON.stringify(arr), u.id]);
      }
    },
  },
  {
    version: 31,
    name: 'history tab: recognized_at + upload_source + upload_user_agent on invoices',
    detect: async (exec) =>
      (await hasColumn(exec, 'invoices', 'recognized_at')) &&
      (await hasColumn(exec, 'invoices', 'upload_source')) &&
      (await hasColumn(exec, 'invoices', 'upload_user_agent')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'recognized_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN recognized_at DATETIME NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'upload_source'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN upload_source VARCHAR(32) NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'upload_user_agent'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN upload_user_agent VARCHAR(512) NULL`);
      }
    },
  },
  {
    version: 32,
    name: 'integration_events — activity log for 1C/Sber/webhook actions',
    detect: (exec) => hasTable(exec, 'integration_events'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS integration_events (
          id           INT AUTO_INCREMENT PRIMARY KEY,
          ts           DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
          integration  VARCHAR(16)   NOT NULL,
          event_type   VARCHAR(48)   NOT NULL,
          status       VARCHAR(8)    NOT NULL DEFAULT 'ok',
          invoice_id   INT           NULL,
          summary      VARCHAR(512)  NOT NULL,
          detail       TEXT          NULL,
          INDEX idx_integration_events_ts (ts),
          INDEX idx_integration_events_integration (integration)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 33,
    name: 'integration_sync_state — single-row flag: nomenclature needs export to 1C',
    detect: (exec) => hasTable(exec, 'integration_sync_state'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS integration_sync_state (
          id                              TINYINT      NOT NULL PRIMARY KEY,
          nomenclature_sync_requested_at  DATETIME     NULL,
          CONSTRAINT chk_sync_state_single CHECK (id = 1)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await exec.query(
        `INSERT IGNORE INTO integration_sync_state (id, nomenclature_sync_requested_at) VALUES (1, NULL)`
      );
    },
  },
  {
    version: 34,
    name: 'invoices.dispatcher_fetched_at — when the worker first claimed the photo (queue-aware timeout)',
    detect: (exec) => hasColumn(exec, 'invoices', 'dispatcher_fetched_at'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'dispatcher_fetched_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN dispatcher_fetched_at DATETIME NULL`);
      }
    },
  },
  {
    version: 35,
    name: 'analyzer_config.dadata_api_key — DaData key configurable from the Settings UI',
    detect: (exec) => hasColumn(exec, 'analyzer_config', 'dadata_api_key'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'analyzer_config', 'dadata_api_key'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN dadata_api_key VARCHAR(255) NULL`);
      }
    },
  },
  {
    version: 36,
    name: 'fix retired claude-opus-4-20250514 model id → sonnet-4-6',
    // Data-only, idempotent. The Settings dropdown used to offer the retired
    // Opus 4.0 snapshot (claude-opus-4-20250514), which now 404s from the
    // Anthropic API → OCR fails on every invoice. Rewrite it to the live default.
    detect: async (exec) => {
      const [rows] = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM analyzer_config WHERE claude_model LIKE '%opus-4-20250514%'`
      );
      return rows[0].cnt === 0;
    },
    run: async (exec) => {
      await exec.query(
        `UPDATE analyzer_config SET claude_model = 'claude-sonnet-4-6' WHERE claude_model LIKE '%opus-4-20250514%'`
      );
    },
  },
  {
    version: 37,
    name: 'invoices.onec_pulled_at — reservation window vs concurrent 1C double-pull duplicates',
    detect: (exec) => hasColumn(exec, 'invoices', 'onec_pulled_at'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'onec_pulled_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN onec_pulled_at DATETIME NULL`);
      }
    },
  },
  {
    version: 38,
    name: 'backfill vat_sum from per-item rates (multi-page desync + missed "в т.ч. НДС")',
    // Data-only, idempotent. vat_sum is a derived field (prices are VAT-included
    // by convention — see deriveVatSum / claudeApiAnalyzer). Older invoices have
    // a wrong/partial vat_sum: дофоткать bumped total_sum to the grand total but
    // left vat_sum at a page-1 subtotal, or Claude missed a dash "в т.ч. НДС".
    // Recompute it as Σ ROUND(total × rate/(100+rate), 2) — per-row rounding, same
    // as deriveVatSum — but ONLY for invoices where every priced line carries a
    // rate, and only when the stored value diverges by > 1 ₽.
    detect: async (exec) => {
      const [rows] = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt
           FROM invoices i
           JOIN (
             SELECT invoice_id,
                    SUM(ROUND(total * vat_rate / (100 + vat_rate), 2)) AS derived_vat,
                    COUNT(*) AS n_priced,
                    SUM(CASE WHEN vat_rate IS NULL THEN 1 ELSE 0 END) AS n_null_rate
               FROM invoice_items
              WHERE total > 0
              GROUP BY invoice_id
           ) x ON x.invoice_id = i.id
          WHERE x.n_priced > 0 AND x.n_null_rate = 0
            AND (i.vat_sum IS NULL OR ABS(i.vat_sum - x.derived_vat) > 1)`
      );
      return rows[0].cnt === 0;
    },
    run: async (exec) => {
      await exec.query(
        `UPDATE invoices i
           JOIN (
             SELECT invoice_id,
                    SUM(ROUND(total * vat_rate / (100 + vat_rate), 2)) AS derived_vat,
                    COUNT(*) AS n_priced,
                    SUM(CASE WHEN vat_rate IS NULL THEN 1 ELSE 0 END) AS n_null_rate
               FROM invoice_items
              WHERE total > 0
              GROUP BY invoice_id
           ) x ON x.invoice_id = i.id
            SET i.vat_sum = x.derived_vat
          WHERE x.n_priced > 0 AND x.n_null_rate = 0
            AND (i.vat_sum IS NULL OR ABS(i.vat_sum - x.derived_vat) > 1)`
      );
    },
  },
  {
    version: 39,
    name: 'invoice_items.name_overridden — user-set name that must be created in 1C',
    detect: (exec) => hasColumn(exec, 'invoice_items', 'name_overridden'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoice_items', 'name_overridden'))) {
        await exec.query(
          `ALTER TABLE invoice_items ADD COLUMN name_overridden TINYINT NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    version: 40,
    name: 'invoices.owner_user_id — per-tenant ownership (data isolation; scoping is flag-gated via DATA_SCOPING_ENABLED)',
    // Additive + idempotent. The column is harmless until DATA_SCOPING_ENABLED is
    // turned on (the scoping layer is the only reader). Backfill assigns all
    // existing invoices to the platform owner (lowest-id admin), so enabling
    // scoping never orphans historical data. See
    // docs/superpowers/specs/2026-06-24-multitenant-data-isolation-design.md
    detect: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'owner_user_id'))) return false;
      const [rows] = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM invoices WHERE owner_user_id IS NULL`
      );
      return rows[0].cnt === 0;
    },
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'owner_user_id'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN owner_user_id INT NULL`);
        await exec.query(`CREATE INDEX idx_invoices_owner_user_id ON invoices(owner_user_id)`);
      }
      // Idempotent backfill: only touches NULLs. If no admin exists yet, the
      // EXISTS guard skips every row (leaves NULL = system/owner-owned).
      await exec.query(
        `UPDATE invoices SET owner_user_id = (SELECT MIN(id) FROM users WHERE role='admin')
          WHERE owner_user_id IS NULL AND EXISTS (SELECT 1 FROM users WHERE role='admin')`
      );
    },
  },
  {
    version: 41,
    name: 'analyzer_config.claude_model — roll forward Sonnet 4.6 → Sonnet 5 (latest Sonnet)',
    // Data-only, idempotent. Switch installs still on the previous Sonnet default
    // to claude-sonnet-5. Only rows explicitly on claude-sonnet-4-6 are touched —
    // a manual Opus/Haiku choice is preserved. detect() is satisfied once no row
    // remains on 4-6, so re-runs are no-ops.
    detect: async (exec) => {
      const [rows] = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM analyzer_config WHERE claude_model = 'claude-sonnet-4-6'`
      );
      return rows[0].cnt === 0;
    },
    run: async (exec) => {
      await exec.query(
        `UPDATE analyzer_config SET claude_model = 'claude-sonnet-5' WHERE claude_model = 'claude-sonnet-4-6'`
      );
    },
  },
  {
    version: 42,
    name: 'invoices.recovery_attempts — bound the crash-recovery retry loop',
    // Startup recovery used to DELETE a stale invoice and drop its photo back
    // into inbox/ for the watcher to re-ingest. Deleting the row also erased the
    // file_hash that processFile's SHA-256 dedup checks, so a photo that
    // reliably crashed the process came back as a BRAND-NEW invoice — and a
    // fresh photo_uploaded notification — on every restart. That was the
    // 2026-07-14 storm: ~20 rounds of 3 invoices in 40 minutes.
    //
    // The row is no longer deleted, so this counter survives across restarts and
    // the retry loop can terminate. See src/watcher/crashRecovery.ts.
    detect: (exec) => hasColumn(exec, 'invoices', 'recovery_attempts'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'recovery_attempts'))) {
        await exec.query(
          `ALTER TABLE invoices ADD COLUMN recovery_attempts TINYINT NOT NULL DEFAULT 0`
        );
      }
    },
  },
  {
    version: 43,
    name: 'notification_sends — send log backing the notification rate limit',
    // The rate limiter's counter MUST live in the DB. During the 2026-07-14 storm
    // PM2 restarted the process every 90 seconds, so an in-memory counter would
    // have reset on every restart and never tripped. See notifications/rateLimit.ts.
    detect: (exec) => hasTable(exec, 'notification_sends'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS notification_sends (
          id         INT AUTO_INCREMENT PRIMARY KEY,
          event_type VARCHAR(64) NOT NULL,
          invoice_id INT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_notification_sends_created_at (created_at)
        )
      `);
    },
  },
  {
    version: 44,
    name: 'Sber-overdue alerts — invoices.sber_overdue_notified_at + backfill notify_events',
    // Additive + idempotent. Column marks that we already sent the "no Sber
    // payment in 14 days" alert (once-per-invoice cadence). Backfill adds the new
    // sber_payment_overdue event to existing users' notify_events so the alert is
    // on by default for them too (new users get it via ALL_EVENT_TYPES).
    // detect() requires BOTH the column AND the backfill so a partial failure
    // replays cleanly (invariant #16).
    detect: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'sber_overdue_notified_at'))) return false;
      const [rows] = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM users WHERE notify_events NOT LIKE '%sber_payment_overdue%'`
      );
      return rows[0].cnt === 0;
    },
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'sber_overdue_notified_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN sber_overdue_notified_at DATETIME NULL`);
      }
      // Backfill notify_events (TEXT holding a JSON array) in TS so we don't
      // depend on JSON functions and can guard against malformed rows.
      const [users] = await exec.query<RowDataPacket[]>(
        `SELECT id, notify_events FROM users WHERE notify_events NOT LIKE '%sber_payment_overdue%'`
      );
      for (const u of users) {
        let events: string[];
        try {
          events = JSON.parse((u.notify_events as string) || '[]');
          if (!Array.isArray(events)) events = [];
        } catch {
          events = [];
        }
        if (!events.includes('sber_payment_overdue')) events.push('sber_payment_overdue');
        await exec.query(`UPDATE users SET notify_events = ? WHERE id = ?`, [JSON.stringify(events), u.id]);
      }
    },
  },
];

export async function runMigrations(pool: Pool): Promise<void> {
  logger.info('Running database migrations...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS migration_history (
      version     INT PRIMARY KEY,
      name        VARCHAR(255) NOT NULL,
      applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      duration_ms INT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [appliedRows] = await pool.query<RowDataPacket[]>('SELECT version FROM migration_history');
  const applied = new Set(appliedRows.map((r) => r.version as number));

  for (const mig of MIGRATIONS) {
    if (applied.has(mig.version)) continue;

    if (mig.detect && (await mig.detect(pool))) {
      await pool.query(
        'INSERT IGNORE INTO migration_history (version, name, applied_at, duration_ms) VALUES (?, ?, NOW(), 0)',
        [mig.version, mig.name]
      );
      logger.info('Migration already present, backfilled history', { version: mig.version, name: mig.name });
      continue;
    }

    const t0 = Date.now();
    logger.info('Applying migration', { version: mig.version, name: mig.name });
    try {
      // MySQL DDL is NOT transactional — each ALTER/CREATE auto-commits.
      // Migrations themselves are written to be idempotent (IF NOT EXISTS,
      // hasColumn/hasTable guards) so a partial failure can be safely retried.
      await mig.run(pool);
      await pool.query(
        'INSERT INTO migration_history (version, name, applied_at, duration_ms) VALUES (?, ?, NOW(), ?)',
        [mig.version, mig.name, Date.now() - t0]
      );
      logger.info('Migration applied', { version: mig.version, name: mig.name, durationMs: Date.now() - t0 });
    } catch (err) {
      logger.error('Migration failed', {
        version: mig.version,
        name: mig.name,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  logger.info('Database migrations completed');
}
