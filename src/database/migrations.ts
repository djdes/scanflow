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
  {
    version: 45,
    name: 'operations suite — autopilot, approvals, inbound channels and supplier mappings',
    // A single additive release. detect() requires every column and table so a
    // partial MySQL DDL failure replays the guarded statements on the next boot.
    detect: async (exec) =>
      (await hasColumn(exec, 'analyzer_config', 'auto_require_all_mapped')) &&
      (await hasColumn(exec, 'analyzer_config', 'auto_block_total_mismatch')) &&
      (await hasColumn(exec, 'analyzer_config', 'auto_min_mapping_confidence')) &&
      (await hasColumn(exec, 'analyzer_config', 'auto_max_total')) &&
      (await hasColumn(exec, 'analyzer_config', 'auto_require_verified_supplier')) &&
      (await hasColumn(exec, 'analyzer_config', 'payment_approval_threshold')) &&
      (await hasColumn(exec, 'invoices', 'duplicate_score')) &&
      (await hasColumn(exec, 'invoices', 'duplicate_reasons')) &&
      (await hasColumn(exec, 'suppliers', 'payment_terms_days')) &&
      (await hasTable(exec, 'approval_requests')) &&
      (await hasTable(exec, 'inbound_channels')) &&
      (await hasTable(exec, 'supplier_nomenclature_mappings')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'analyzer_config', 'auto_require_all_mapped'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN auto_require_all_mapped TINYINT(1) NOT NULL DEFAULT 1`);
      }
      if (!(await hasColumn(exec, 'analyzer_config', 'auto_block_total_mismatch'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN auto_block_total_mismatch TINYINT(1) NOT NULL DEFAULT 1`);
      }
      if (!(await hasColumn(exec, 'analyzer_config', 'auto_min_mapping_confidence'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN auto_min_mapping_confidence DOUBLE NOT NULL DEFAULT 0.80`);
      }
      if (!(await hasColumn(exec, 'analyzer_config', 'auto_max_total'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN auto_max_total DOUBLE NULL`);
      }
      if (!(await hasColumn(exec, 'analyzer_config', 'auto_require_verified_supplier'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN auto_require_verified_supplier TINYINT(1) NOT NULL DEFAULT 1`);
      }
      if (!(await hasColumn(exec, 'analyzer_config', 'payment_approval_threshold'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN payment_approval_threshold DOUBLE NULL DEFAULT 50000`);
      }

      if (!(await hasColumn(exec, 'invoices', 'duplicate_score'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN duplicate_score DOUBLE NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'duplicate_reasons'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN duplicate_reasons TEXT NULL`);
      }

      if (!(await hasColumn(exec, 'suppliers', 'payment_terms_days'))) {
        await exec.query(`ALTER TABLE suppliers ADD COLUMN payment_terms_days INT NOT NULL DEFAULT 7`);
      }

      await exec.query(`
        CREATE TABLE IF NOT EXISTS approval_requests (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          invoice_id    INT NOT NULL,
          action        VARCHAR(16) NOT NULL,
          status        VARCHAR(16) NOT NULL DEFAULT 'pending',
          requested_by  INT NULL,
          decided_by    INT NULL,
          request_note  TEXT NULL,
          decision_note TEXT NULL,
          execution_error TEXT NULL,
          created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          decided_at    DATETIME NULL,
          INDEX idx_approval_status_created (status, created_at),
          INDEX idx_approval_invoice (invoice_id),
          CONSTRAINT fk_approval_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS inbound_channels (
          user_id                 INT PRIMARY KEY,
          telegram_enabled        TINYINT(1) NOT NULL DEFAULT 0,
          telegram_secret_hash    CHAR(64) NULL,
          email_enabled           TINYINT(1) NOT NULL DEFAULT 0,
          email_secret_hash       CHAR(64) NULL,
          telegram_last_update_id BIGINT NULL,
          updated_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          CONSTRAINT fk_inbound_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS supplier_nomenclature_mappings (
          id             INT AUTO_INCREMENT PRIMARY KEY,
          supplier_key   VARCHAR(64) NOT NULL,
          scanned_hash   CHAR(64) NOT NULL,
          scanned_name   VARCHAR(512) NOT NULL,
          mapped_name_1c VARCHAR(512) NOT NULL,
          onec_guid      VARCHAR(64) NOT NULL,
          times_seen     INT NOT NULL DEFAULT 1,
          created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_supplier_scan (supplier_key, scanned_hash),
          INDEX idx_supplier_mapping_guid (onec_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 46,
    name: 'business control and secure 1C onboarding',
    // Additive and replay-safe. Every ALTER is guarded because MySQL DDL is
    // implicitly committed and a deploy can stop between statements.
    detect: async (exec) =>
      (await hasColumn(exec, 'invoices', 'payment_due_date')) &&
      (await hasColumn(exec, 'invoices', 'payment_priority')) &&
      (await hasColumn(exec, 'invoices', 'payment_hold_reason')) &&
      (await hasColumn(exec, 'invoices', 'onec_status')) &&
      (await hasColumn(exec, 'invoices', 'onec_document_ref')) &&
      (await hasColumn(exec, 'invoices', 'onec_error')) &&
      (await hasColumn(exec, 'invoices', 'onec_updated_at')) &&
      (await hasColumn(exec, 'approval_requests', 'batch_id')) &&
      (await hasColumn(exec, 'suppliers', 'verification_source')) &&
      (await hasColumn(exec, 'suppliers', 'verified_at')) &&
      (await hasColumn(exec, 'suppliers', 'verification_fingerprint')) &&
      (await hasColumn(exec, 'suppliers', 'verification_risk')) &&
      (await hasColumn(exec, 'analyzer_config', 'payment_cash_balance')) &&
      (await hasTable(exec, 'bank_statement_entries')) &&
      (await hasTable(exec, 'ocr_corrections')) &&
      (await hasTable(exec, 'onec_connections')) &&
      (await hasTable(exec, 'approval_delegates')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'payment_due_date'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN payment_due_date DATE NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'payment_priority'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN payment_priority VARCHAR(16) NOT NULL DEFAULT 'normal'`);
      }
      if (!(await hasColumn(exec, 'invoices', 'payment_hold_reason'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN payment_hold_reason VARCHAR(512) NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'onec_status'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN onec_status VARCHAR(24) NOT NULL DEFAULT 'not_sent'`);
      }
      if (!(await hasColumn(exec, 'invoices', 'onec_document_ref'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN onec_document_ref VARCHAR(255) NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'onec_error'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN onec_error TEXT NULL`);
      }
      if (!(await hasColumn(exec, 'invoices', 'onec_updated_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN onec_updated_at DATETIME NULL`);
      }
      if (!(await hasColumn(exec, 'approval_requests', 'batch_id'))) {
        await exec.query(`ALTER TABLE approval_requests ADD COLUMN batch_id CHAR(36) NULL`);
        if (!(await hasIndex(exec, 'approval_requests', 'idx_approval_batch'))) {
          await exec.query(`CREATE INDEX idx_approval_batch ON approval_requests(batch_id)`);
        }
      }
      for (const [column, ddl] of [
        ['verification_source', 'VARCHAR(32) NULL'],
        ['verified_at', 'DATETIME NULL'],
        ['verification_fingerprint', 'CHAR(64) NULL'],
        ['verification_risk', 'TEXT NULL'],
      ] as const) {
        if (!(await hasColumn(exec, 'suppliers', column))) {
          await exec.query(`ALTER TABLE suppliers ADD COLUMN ${column} ${ddl}`);
        }
      }
      if (!(await hasColumn(exec, 'analyzer_config', 'payment_cash_balance'))) {
        await exec.query(`ALTER TABLE analyzer_config ADD COLUMN payment_cash_balance DOUBLE NULL`);
      }

      await exec.query(`
        CREATE TABLE IF NOT EXISTS bank_statement_entries (
          id                    INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id         INT NULL,
          operation_date        DATE NOT NULL,
          amount                DOUBLE NOT NULL,
          direction             VARCHAR(8) NOT NULL,
          counterparty          VARCHAR(512) NULL,
          counterparty_inn      VARCHAR(32) NULL,
          account               VARCHAR(64) NULL,
          purpose               TEXT NULL,
          external_id           VARCHAR(128) NULL,
          operation_hash        CHAR(64) NOT NULL,
          matched_invoice_id    INT NULL,
          match_score           DOUBLE NULL,
          match_reason          VARCHAR(512) NULL,
          imported_by           INT NULL,
          created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_bank_entry_owner_hash (owner_user_id, operation_hash),
          INDEX idx_bank_entry_invoice (matched_invoice_id),
          INDEX idx_bank_entry_date (operation_date),
          CONSTRAINT fk_bank_entry_invoice FOREIGN KEY (matched_invoice_id) REFERENCES invoices(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS ocr_corrections (
          id               INT AUTO_INCREMENT PRIMARY KEY,
          supplier_key     VARCHAR(128) NOT NULL,
          field_name       VARCHAR(64) NOT NULL,
          original_hash    CHAR(64) NOT NULL,
          original_value   VARCHAR(1024) NOT NULL,
          corrected_value  VARCHAR(1024) NOT NULL,
          times_seen       INT NOT NULL DEFAULT 1,
          created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          last_used_at     DATETIME NULL,
          UNIQUE KEY uq_ocr_correction (supplier_key, field_name, original_hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS onec_connections (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id INT NOT NULL,
          name          VARCHAR(128) NOT NULL,
          token_hash    CHAR(64) NOT NULL UNIQUE,
          token_prefix  VARCHAR(12) NOT NULL,
          active        TINYINT(1) NOT NULL DEFAULT 1,
          last_used_at  DATETIME NULL,
          last_ip       VARCHAR(64) NULL,
          created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revoked_at    DATETIME NULL,
          INDEX idx_onec_connection_owner (owner_user_id, active),
          CONSTRAINT fk_onec_connection_user FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS approval_delegates (
          id                INT AUTO_INCREMENT PRIMARY KEY,
          delegator_user_id INT NOT NULL,
          delegate_user_id  INT NOT NULL,
          max_amount        DOUBLE NULL,
          valid_until       DATE NULL,
          active            TINYINT(1) NOT NULL DEFAULT 1,
          created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          revoked_at        DATETIME NULL,
          INDEX idx_approval_delegate_active (delegate_user_id, active, valid_until),
          CONSTRAINT fk_approval_delegator FOREIGN KEY (delegator_user_id) REFERENCES users(id) ON DELETE CASCADE,
          CONSTRAINT fk_approval_delegate FOREIGN KEY (delegate_user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    version: 47,
    name: 'supplier_extract_jobs.owner_user_id — владелец задачи извлечения реквизитов',
    // Аддитивно и идемпотентно: только nullable-колонка + индекс, ключи не трогаем.
    // Бэкфилл не нужен — задачи одноразовые и живут минуты; строка без владельца
    // просто не породит уведомление (см. notifySupplierExtractError).
    detect: async (exec) => hasColumn(exec, 'supplier_extract_jobs', 'owner_user_id'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'supplier_extract_jobs', 'owner_user_id'))) {
        await exec.query(`ALTER TABLE supplier_extract_jobs ADD COLUMN owner_user_id INT NULL`);
        await exec.query(
          `CREATE INDEX idx_supplier_extract_jobs_owner ON supplier_extract_jobs(owner_user_id)`
        );
      }
    },
  },
  {
    version: 48,
    name: 'supplier_cards — пер-тенантный справочник поставщиков (без DROP)',
    // СТРОГО АДДИТИВНАЯ миграция: только CREATE TABLE + копирование строк.
    // Никаких DROP и никаких ALTER существующих таблиц.
    //
    // Почему новая таблица, а не перестройка `suppliers`: там PRIMARY KEY (inn),
    // то есть один ИНН физически может существовать лишь в одном экземпляре, и
    // две компании не могут держать свои реквизиты одного поставщика. Убрать это
    // ограничение можно только сняв первичный ключ — а DROP запрещён. Поэтому
    // заводим новую таблицу нужной формы, а старая `suppliers` остаётся нетронутой.
    //
    // Побочная выгода: откат = вернуть код. Данные в `suppliers` при этом целы,
    // терять нечего даже при полном провале выкатки.
    detect: async (exec) => hasTable(exec, 'supplier_cards'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS supplier_cards (
          id                       INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id            INT NULL,
          inn                      VARCHAR(32) NOT NULL,
          name                     VARCHAR(512) NOT NULL,
          kpp                      VARCHAR(32) NULL,
          account                  VARCHAR(64) NULL,
          bank_bic                 VARCHAR(32) NOT NULL,
          bank_corr_account        VARCHAR(64) NULL,
          bank_name                VARCHAR(512) NULL,
          address                  VARCHAR(1024) NULL,
          verified                 TINYINT(1) NOT NULL DEFAULT 0,
          source                   VARCHAR(64) NULL,
          notes                    TEXT NULL,
          created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_used_at             DATETIME NULL,
          payment_terms_days       INT NOT NULL DEFAULT 7,
          verification_source      VARCHAR(32) NULL,
          verified_at              DATETIME NULL,
          verification_fingerprint CHAR(64) NULL,
          verification_risk        TEXT NULL,
          UNIQUE KEY uq_supplier_cards_owner_inn (owner_user_id, inn),
          INDEX idx_supplier_cards_name (name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Переносим существующий справочник админской компании. Владельца
      // проставляем конкретным id, а не NULL: MySQL не схлопывает NULL в UNIQUE,
      // поэтому строки с NULL потеряли бы защиту от дублей.
      //
      // ON DUPLICATE KEY делает копирование идемпотентным: повторный прогон
      // (в т.ч. после обрыва деплоя) не создаёт дублей и ничего не перетирает.
      if (await hasTable(exec, 'suppliers')) {
        await exec.query(`
          INSERT INTO supplier_cards
            (owner_user_id, inn, name, kpp, account, bank_bic, bank_corr_account,
             bank_name, address, verified, source, notes, created_at, updated_at,
             last_used_at, payment_terms_days, verification_source, verified_at,
             verification_fingerprint, verification_risk)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 s.inn, s.name, s.kpp, s.account, s.bank_bic, s.bank_corr_account,
                 s.bank_name, s.address, s.verified, s.source, s.notes,
                 s.created_at, s.updated_at, s.last_used_at, s.payment_terms_days,
                 s.verification_source, s.verified_at,
                 s.verification_fingerprint, s.verification_risk
            FROM suppliers s
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE supplier_cards.id = supplier_cards.id
        `);
      }
    },
  },
  {
    version: 49,
    name: 'sber_connections — подключение к Сберу на компанию (без DROP)',
    // Строго аддитивно. sber_tokens имеет CHECK (id = 1), то есть физически
    // допускает одно подключение на всю установку; снять это можно только через
    // DROP, что запрещено. Поэтому новая таблица, а старая остаётся нетронутой.
    detect: async (exec) => hasTable(exec, 'sber_connections'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS sber_connections (
          id                       INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id            INT NOT NULL,
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
          UNIQUE KEY uq_sber_connections_owner (owner_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Переносим единственное существующее подключение админской компании.
      // ON DUPLICATE KEY делает повторный прогон no-op: токены не перетираются,
      // если после копирования успел пройти refresh.
      if (await hasTable(exec, 'sber_tokens')) {
        await exec.query(`
          INSERT INTO sber_connections
            (owner_user_id, access_token, refresh_token, expires_at, account_number,
             org_name, payer_inn, payer_kpp, payer_bank_bic, payer_bank_corr_account,
             created_at, updated_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 t.access_token, t.refresh_token, t.expires_at, t.account_number,
                 t.org_name, t.payer_inn, t.payer_kpp, t.payer_bank_bic,
                 t.payer_bank_corr_account, t.created_at, t.updated_at
            FROM sber_tokens t
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE sber_connections.id = sber_connections.id
        `);
      }
    },
  },
  {
    version: 50,
    name: 'бэкфилл invoices.owner_user_id для накладных из inbox/',
    // Накладные, подхваченные watcher-ом из папки inbox/, создавались без
    // владельца: у файла на диске нет пользовательского контекста. Пока данные
    // были общими, это ни на что не влияло. После разделения по компаниям такая
    // накладная перестала работать — справочник поставщиков не подставлялся,
    // отправка в Сбер отклонялась с «не указан владелец».
    //
    // Папка inbox/ на сервере принадлежит оператору платформы, поэтому «ничьи»
    // накладные достаются админской компании — ровно как сделала миграция 40 для
    // легаси-строк. Только UPDATE, ничего не создаётся и не удаляется.
    detect: async (exec) => {
      const [rows] = await exec.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS cnt FROM invoices WHERE owner_user_id IS NULL`
      );
      return Number(rows[0].cnt) === 0;
    },
    run: async (exec) => {
      await exec.query(
        `UPDATE invoices
            SET owner_user_id = (SELECT MIN(id) FROM users WHERE role = 'admin')
          WHERE owner_user_id IS NULL
            AND EXISTS (SELECT 1 FROM users WHERE role = 'admin')`
      );
    },
  },
  {
    version: 51,
    name: 'onec_nomenclature_cards + nomenclature_price_stat_cards — каталог 1С на компанию (без DROP)',
    // Строго аддитивно. У onec_nomenclature первичный ключ — guid, у
    // nomenclature_price_stats — onec_guid, то есть обе физически допускают одну
    // строку на ключ и два каталога 1С в них не помещаются. Снять это можно
    // только через DROP, что запрещено, поэтому заводим двойники, а старые
    // таблицы остаются нетронутыми (откат = вернуть код).
    detect: async (exec) =>
      (await hasTable(exec, 'onec_nomenclature_cards')) &&
      (await hasTable(exec, 'nomenclature_price_stat_cards')),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS onec_nomenclature_cards (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id INT NOT NULL,
          guid          VARCHAR(64) NOT NULL,
          code          VARCHAR(64) NULL,
          name          VARCHAR(512) NOT NULL,
          full_name     VARCHAR(1024) NULL,
          unit          VARCHAR(32) NULL,
          parent_guid   VARCHAR(64) NULL,
          is_folder     TINYINT(1) NOT NULL DEFAULT 0,
          is_weighted   TINYINT(1) NOT NULL DEFAULT 0,
          synced_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_onec_cards_owner_guid (owner_user_id, guid),
          INDEX idx_onec_cards_name (name),
          INDEX idx_onec_cards_parent (owner_user_id, parent_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS nomenclature_price_stat_cards (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id INT NOT NULL,
          onec_guid     VARCHAR(64) NOT NULL,
          median_price  DOUBLE NOT NULL,
          price_unit    VARCHAR(32) NOT NULL,
          samples       INT NOT NULL,
          updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_price_stat_cards_owner_guid (owner_user_id, onec_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      if (await hasTable(exec, 'onec_nomenclature')) {
        await exec.query(`
          INSERT INTO onec_nomenclature_cards
            (owner_user_id, guid, code, name, full_name, unit, parent_guid, is_folder, is_weighted, synced_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 n.guid, n.code, n.name, n.full_name, n.unit,
                 n.parent_guid, n.is_folder, n.is_weighted, n.synced_at
            FROM onec_nomenclature n
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE onec_nomenclature_cards.id = onec_nomenclature_cards.id
        `);
      }

      if (await hasTable(exec, 'nomenclature_price_stats')) {
        await exec.query(`
          INSERT INTO nomenclature_price_stat_cards
            (owner_user_id, onec_guid, median_price, price_unit, samples, updated_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 p.onec_guid, p.median_price, p.price_unit, p.samples, p.updated_at
            FROM nomenclature_price_stats p
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE nomenclature_price_stat_cards.id = nomenclature_price_stat_cards.id
        `);
      }
    },
  },
  {
    version: 52,
    name: 'nomenclature_mapping_cards и спутники — сопоставления на компанию (без DROP)',
    // scanned_name в nomenclature_mappings уникален ГЛОБАЛЬНО, поэтому две
    // компании не могут выучить разные сопоставления для одного и того же текста
    // из скана. Снять уникальность можно только через DROP INDEX — запрещено.
    detect: async (exec) =>
      (await hasTable(exec, 'nomenclature_mapping_cards')) &&
      (await hasTable(exec, 'mapping_supplier_usage_cards')) &&
      (await hasTable(exec, 'supplier_nomenclature_mapping_cards')),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS nomenclature_mapping_cards (
          id                 INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id      INT NOT NULL,
          scanned_name       VARCHAR(512) NOT NULL,
          mapped_name_1c     VARCHAR(512) NOT NULL,
          category           VARCHAR(255) NULL,
          default_unit       VARCHAR(64) NULL,
          approved           TINYINT(1) NOT NULL DEFAULT 0,
          onec_guid          VARCHAR(64) NULL,
          times_seen         INT NOT NULL DEFAULT 0,
          last_seen_supplier VARCHAR(512) NULL,
          last_seen_at       DATETIME NULL,
          pack_size          DOUBLE NULL,
          pack_unit          VARCHAR(32) NULL,
          created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_mapping_cards_owner_scanned (owner_user_id, scanned_name),
          INDEX idx_mapping_cards_guid (onec_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS mapping_supplier_usage_cards (
          mapping_card_id INT NOT NULL,
          supplier        VARCHAR(512) NOT NULL,
          first_seen_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_seen_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          times_seen      INT NOT NULL DEFAULT 1,
          PRIMARY KEY (mapping_card_id, supplier),
          INDEX idx_usage_cards_supplier (supplier),
          CONSTRAINT fk_usage_cards_mapping
            FOREIGN KEY (mapping_card_id) REFERENCES nomenclature_mapping_cards(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS supplier_nomenclature_mapping_cards (
          id             INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id  INT NOT NULL,
          supplier_key   VARCHAR(64) NOT NULL,
          scanned_hash   CHAR(64) NOT NULL,
          scanned_name   VARCHAR(512) NOT NULL,
          mapped_name_1c VARCHAR(512) NOT NULL,
          onec_guid      VARCHAR(64) NOT NULL,
          times_seen     INT NOT NULL DEFAULT 1,
          created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_supplier_scan_cards (owner_user_id, supplier_key, scanned_hash),
          INDEX idx_supplier_mapping_cards_guid (onec_guid)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      if (await hasTable(exec, 'nomenclature_mappings')) {
        await exec.query(`
          INSERT INTO nomenclature_mapping_cards
            (owner_user_id, scanned_name, mapped_name_1c, category, default_unit, approved,
             onec_guid, times_seen, last_seen_supplier, last_seen_at, pack_size, pack_unit, created_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 m.scanned_name, m.mapped_name_1c, m.category, m.default_unit, m.approved,
                 m.onec_guid, m.times_seen, m.last_seen_supplier, m.last_seen_at,
                 m.pack_size, m.pack_unit, m.created_at
            FROM nomenclature_mappings m
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE nomenclature_mapping_cards.id = nomenclature_mapping_cards.id
        `);
      }

      // Связь переносим по естественному ключу (scanned_name): id в новой
      // таблице свои, старые mapping_id к ней не применимы.
      if (await hasTable(exec, 'mapping_supplier_usage')) {
        await exec.query(`
          INSERT INTO mapping_supplier_usage_cards
            (mapping_card_id, supplier, first_seen_at, last_seen_at, times_seen)
          SELECT c.id, u.supplier, u.first_seen_at, u.last_seen_at, u.times_seen
            FROM mapping_supplier_usage u
            JOIN nomenclature_mappings m ON m.id = u.mapping_id
            JOIN nomenclature_mapping_cards c
              ON c.scanned_name = m.scanned_name
             AND c.owner_user_id = (SELECT MIN(id) FROM users WHERE role = 'admin')
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE mapping_supplier_usage_cards.times_seen = mapping_supplier_usage_cards.times_seen
        `);
      }

      if (await hasTable(exec, 'supplier_nomenclature_mappings')) {
        await exec.query(`
          INSERT INTO supplier_nomenclature_mapping_cards
            (owner_user_id, supplier_key, scanned_hash, scanned_name, mapped_name_1c,
             onec_guid, times_seen, created_at, updated_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 s.supplier_key, s.scanned_hash, s.scanned_name, s.mapped_name_1c,
                 s.onec_guid, s.times_seen, s.created_at, s.updated_at
            FROM supplier_nomenclature_mappings s
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE supplier_nomenclature_mapping_cards.id = supplier_nomenclature_mapping_cards.id
        `);
      }
    },
  },
  {
    version: 53,
    name: 'ocr_correction_cards — выученные исправления OCR на компанию (без DROP)',
    // Строго аддитивно: только CREATE TABLE + копирование строк.
    //
    // В ocr_corrections уникальный ключ (supplier_key, field_name, original_hash)
    // ГЛОБАЛЬНЫЙ, владельца в таблице нет вовсе. Поэтому исправление, выученное
    // одной компанией, подставлялось в сканы всех остальных: и утечка (по
    // corrected_value видны чужие контрагенты, их счета и адреса), и порча данных
    // (чужой БИК/КПП молча переписывал распознанный). Плюс две компании физически
    // не могли выучить разные исправления одного и того же значения.
    //
    // Расширить ключ владельцем можно только через DROP INDEX — запрещено.
    // Поэтому двойник нужной формы, а старая ocr_corrections остаётся нетронутой:
    // откат = вернуть код, данные при этом целы.
    detect: async (exec) => hasTable(exec, 'ocr_correction_cards'),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS ocr_correction_cards (
          id               INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id    INT NOT NULL,
          supplier_key     VARCHAR(128) NOT NULL,
          field_name       VARCHAR(64) NOT NULL,
          original_hash    CHAR(64) NOT NULL,
          original_value   VARCHAR(1024) NOT NULL,
          corrected_value  VARCHAR(1024) NOT NULL,
          times_seen       INT NOT NULL DEFAULT 1,
          created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          last_used_at     DATETIME NULL,
          UNIQUE KEY uq_ocr_correction_cards (owner_user_id, supplier_key, field_name, original_hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Всё, что было выучено до разделения, достаётся админской компании —
      // ровно как в миграциях 48/49/51/52. owner_user_id проставляем конкретным
      // id, а не NULL: MySQL не схлопывает NULL в UNIQUE, и строки с NULL
      // потеряли бы защиту от дублей.
      //
      // ON DUPLICATE KEY делает копирование идемпотентным: повторный прогон
      // (в т.ч. после обрыва деплоя) не создаёт дублей и ничего не перетирает —
      // times_seen/corrected_value, накопленные уже в новой таблице, целы.
      if (await hasTable(exec, 'ocr_corrections')) {
        await exec.query(`
          INSERT INTO ocr_correction_cards
            (owner_user_id, supplier_key, field_name, original_hash, original_value,
             corrected_value, times_seen, created_at, updated_at, last_used_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 c.supplier_key, c.field_name, c.original_hash, c.original_value,
                 c.corrected_value, c.times_seen, c.created_at, c.updated_at, c.last_used_at
            FROM ocr_corrections c
           WHERE EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE ocr_correction_cards.id = ocr_correction_cards.id
        `);
      }
    },
  },
  {
    version: 54,
    name: 'integration_sync_state_cards + webhook_config_cards — состояние обмена и вебхук на компанию (без DROP)',
    // Строго аддитивно, как миграции 48/49/51/52: только CREATE TABLE и
    // INSERT … SELECT … ON DUPLICATE KEY. Ни DROP, ни ALTER существующих таблиц,
    // поэтому откат = вернуть код, а старые таблицы остаются целыми.
    //
    // Почему двойники, а не доработка существующих:
    //   * integration_sync_state держит CONSTRAINT chk_sync_state_single CHECK (id = 1),
    //     то есть физически одна строка на всю установку. Снять CHECK можно только
    //     через ALTER … DROP CONSTRAINT — запрещено. А флаг «каталог 1С нужно
    //     выгрузить заново» общим быть не может: новая позиция у одной компании
    //     поднимала бы выгрузку в базе 1С другой.
    //   * webhook_config формально AUTO_INCREMENT, но весь код работает через
    //     WHERE id = 1, то есть это тоже синглтон. Две компании, настроившие
    //     вебхук, перетирали бы друг другу URL и токен авторизации.
    detect: async (exec) =>
      (await hasTable(exec, 'integration_sync_state_cards')) &&
      (await hasTable(exec, 'webhook_config_cards')),
    run: async (exec) => {
      await exec.query(`
        CREATE TABLE IF NOT EXISTS integration_sync_state_cards (
          id                              INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id                   INT NOT NULL,
          nomenclature_sync_requested_at  DATETIME NULL,
          UNIQUE KEY uq_sync_state_cards_owner (owner_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      await exec.query(`
        CREATE TABLE IF NOT EXISTS webhook_config_cards (
          id            INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id INT NOT NULL,
          url           VARCHAR(1024) NOT NULL,
          enabled       TINYINT(1) NOT NULL DEFAULT 0,
          auth_token    VARCHAR(255) NULL,
          auto_send_1c  TINYINT(1) NOT NULL DEFAULT 0,
          UNIQUE KEY uq_webhook_config_cards_owner (owner_user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      // Единственную существующую строку каждой таблицы отдаём админской
      // компании — ровно как миграции 48/49/51/52. ON DUPLICATE KEY делает
      // повторный прогон (в т.ч. после обрыва деплоя) no-op: ничего не
      // дублируется и ничего не перетирается уже настроенным.
      if (await hasTable(exec, 'integration_sync_state')) {
        await exec.query(`
          INSERT INTO integration_sync_state_cards
            (owner_user_id, nomenclature_sync_requested_at)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 s.nomenclature_sync_requested_at
            FROM integration_sync_state s
           WHERE s.id = 1
             AND EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE integration_sync_state_cards.id = integration_sync_state_cards.id
        `);
      }

      if (await hasTable(exec, 'webhook_config')) {
        await exec.query(`
          INSERT INTO webhook_config_cards
            (owner_user_id, url, enabled, auth_token, auto_send_1c)
          SELECT (SELECT MIN(id) FROM users WHERE role = 'admin'),
                 w.url, w.enabled, w.auth_token, w.auto_send_1c
            FROM webhook_config w
           WHERE w.id = 1
             AND EXISTS (SELECT 1 FROM users WHERE role = 'admin')
          ON DUPLICATE KEY UPDATE webhook_config_cards.id = webhook_config_cards.id
        `);
      }
    },
  },
  {
    version: 55,
    name: 'invoices.read_at + paid_externally — прочтение и «оплачено вне сервиса»',
    // Аддитивно: две новые колонки в invoices через hasColumn-guard + ADD COLUMN
    // (идиом миграций 2/4/28), без DROP и без ALTER существующих колонок. Повторный
    // прогон — no-op. Бэкфилл read_at существующим строкам ставится РОВНО один раз
    // (внутри guard добавления колонки), чтобы весь бэклог стартовал прочитанным, а
    // новые непрочитанные накладные при случайном переигрывании не были затёрты.
    detect: async (exec) =>
      (await hasColumn(exec, 'invoices', 'read_at')) &&
      (await hasColumn(exec, 'invoices', 'paid_externally')),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'invoices', 'read_at'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN read_at DATETIME NULL`);
        await exec.query(
          `UPDATE invoices SET read_at = COALESCE(recognized_at, created_at) WHERE read_at IS NULL`,
        );
      }
      if (!(await hasColumn(exec, 'invoices', 'paid_externally'))) {
        await exec.query(`ALTER TABLE invoices ADD COLUMN paid_externally TINYINT(1) NOT NULL DEFAULT 0`);
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
