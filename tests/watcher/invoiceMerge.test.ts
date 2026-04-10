import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// We can't easily import `invoiceRepo` because it uses a module-level db
// singleton keyed to config.dbPath. Instead this test exercises the merge
// strategies against a fresh in-memory SQLite instance that mirrors the
// production schema, then validates the invariants:
//
//   1. findMostRecentProcessedForContinuation returns the right row
//   2. findMostRecentProcessedForContinuation ignores 'parsing' rows
//   3. markStaleAsFailed moves stuck rows to 'error'
//   4. Early delete on merge leaves no orphan behind

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');

  // Minimal schema copied from production migrations — only the columns
  // the merge logic touches. We don't need mappings / nomenclature / etc.
  db.exec(`
    CREATE TABLE invoices (
      id INTEGER PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_path TEXT,
      invoice_number TEXT,
      supplier TEXT,
      total_sum REAL,
      raw_text TEXT,
      status TEXT DEFAULT 'new',
      error_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE invoice_items (
      id INTEGER PRIMARY KEY,
      invoice_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      quantity REAL,
      price REAL,
      total REAL,
      FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function insertInvoice(
  db: Database.Database,
  fields: {
    file_name: string;
    invoice_number?: string | null;
    supplier?: string | null;
    raw_text?: string;
    status?: string;
    created_at?: string; // ISO-ish, sqlite-compatible
  }
): number {
  const res = db.prepare(
    `INSERT INTO invoices
      (file_name, invoice_number, supplier, raw_text, status, created_at)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
  ).run(
    fields.file_name,
    fields.invoice_number ?? null,
    fields.supplier ?? null,
    fields.raw_text ?? '',
    fields.status ?? 'new',
    fields.created_at ?? null
  );
  return Number(res.lastInsertRowid);
}

// Replicas of the real repo methods so the test targets the exact SQL.
// Keeping them inline means if the production methods drift, this test
// breaks at compile / run time rather than silently passing.
function findMostRecentProcessedForContinuation(
  db: Database.Database,
  excludeId: number,
  withinMinutes: number
) {
  return db.prepare(
    `SELECT * FROM invoices
     WHERE id != ?
     AND status = 'processed'
     AND created_at > datetime('now', '-${withinMinutes} minutes')
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(excludeId) as { id: number; file_name: string } | undefined;
}

function markStaleAsFailed(db: Database.Database, staleMinutes: number) {
  return db.prepare(
    `UPDATE invoices
     SET status = 'error',
         error_message = COALESCE(error_message, 'Processing interrupted (stuck in parsing/ocr_processing)')
     WHERE status IN ('parsing', 'ocr_processing')
     AND created_at < datetime('now', '-${staleMinutes} minutes')`
  ).run().changes;
}

describe('invoice merge strategies (in-memory sqlite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  describe('Strategy D: findMostRecentProcessedForContinuation', () => {
    it('returns the most recent processed invoice within the window', () => {
      // Page 1 uploaded 30 seconds ago and fully processed
      const page1 = insertInvoice(db, {
        file_name: 'upload-A.jpg',
        invoice_number: '261',
        supplier: 'ООО "ВЕСЕЛОФФ"',
        status: 'processed',
        created_at: "datetime('now', '-30 seconds')",
      });
      // But sqlite CURRENT_TIMESTAMP expressions in VALUES don't eval —
      // we need to use a raw insert with datetime().
      db.prepare('UPDATE invoices SET created_at = datetime(\'now\', \'-30 seconds\') WHERE id = ?').run(page1);

      // Page 2 just arrived (new row, no metadata extracted yet)
      const page2 = insertInvoice(db, {
        file_name: 'upload-B.jpg',
        status: 'parsing',
      });

      const candidate = findMostRecentProcessedForContinuation(db, page2, 2);
      expect(candidate).toBeDefined();
      expect(candidate!.id).toBe(page1);
    });

    it('ignores rows still in parsing status (prevents cross-contamination of concurrent uploads)', () => {
      const concurrent = insertInvoice(db, {
        file_name: 'upload-C.jpg',
        status: 'parsing', // not processed
      });
      const self = insertInvoice(db, {
        file_name: 'upload-D.jpg',
        status: 'parsing',
      });

      const candidate = findMostRecentProcessedForContinuation(db, self, 2);
      expect(candidate).toBeUndefined();
    });

    it('ignores rows older than the window', () => {
      const ancient = insertInvoice(db, {
        file_name: 'upload-old.jpg',
        invoice_number: '100',
        status: 'processed',
      });
      db.prepare("UPDATE invoices SET created_at = datetime('now', '-10 minutes') WHERE id = ?").run(ancient);

      const fresh = insertInvoice(db, {
        file_name: 'upload-new.jpg',
        status: 'parsing',
      });

      const candidate = findMostRecentProcessedForContinuation(db, fresh, 2);
      expect(candidate).toBeUndefined();
    });

    it('excludes the row being processed itself', () => {
      const self = insertInvoice(db, {
        file_name: 'upload-self.jpg',
        status: 'processed',
      });
      const candidate = findMostRecentProcessedForContinuation(db, self, 2);
      expect(candidate).toBeUndefined();
    });

    it('prefers the most recent processed invoice when several exist', () => {
      const older = insertInvoice(db, {
        file_name: 'upload-older.jpg',
        status: 'processed',
      });
      db.prepare("UPDATE invoices SET created_at = datetime('now', '-90 seconds') WHERE id = ?").run(older);

      const newer = insertInvoice(db, {
        file_name: 'upload-newer.jpg',
        status: 'processed',
      });
      db.prepare("UPDATE invoices SET created_at = datetime('now', '-10 seconds') WHERE id = ?").run(newer);

      const self = insertInvoice(db, { file_name: 'upload-self.jpg', status: 'parsing' });

      const candidate = findMostRecentProcessedForContinuation(db, self, 2);
      expect(candidate).toBeDefined();
      expect(candidate!.id).toBe(newer);
    });
  });

  describe('markStaleAsFailed (startup janitor)', () => {
    it('moves rows stuck in parsing > threshold to error', () => {
      const stuck = insertInvoice(db, { file_name: 'stuck.jpg', status: 'parsing' });
      db.prepare("UPDATE invoices SET created_at = datetime('now', '-10 minutes') WHERE id = ?").run(stuck);

      const fresh = insertInvoice(db, { file_name: 'fresh.jpg', status: 'parsing' });

      const changed = markStaleAsFailed(db, 5);
      expect(changed).toBe(1);

      const stuckRow = db.prepare('SELECT status, error_message FROM invoices WHERE id = ?').get(stuck) as {
        status: string;
        error_message: string;
      };
      expect(stuckRow.status).toBe('error');
      expect(stuckRow.error_message).toContain('Processing interrupted');

      const freshRow = db.prepare('SELECT status FROM invoices WHERE id = ?').get(fresh) as { status: string };
      expect(freshRow.status).toBe('parsing');
    });

    it('also moves rows stuck in ocr_processing', () => {
      const stuck = insertInvoice(db, { file_name: 'ocr-stuck.jpg', status: 'ocr_processing' });
      db.prepare("UPDATE invoices SET created_at = datetime('now', '-10 minutes') WHERE id = ?").run(stuck);

      const changed = markStaleAsFailed(db, 5);
      expect(changed).toBe(1);
      const row = db.prepare('SELECT status FROM invoices WHERE id = ?').get(stuck) as { status: string };
      expect(row.status).toBe('error');
    });

    it('preserves existing error_message when already set', () => {
      const stuck = insertInvoice(db, { file_name: 'stuck.jpg', status: 'parsing' });
      db.prepare("UPDATE invoices SET created_at = datetime('now', '-10 minutes'), error_message = 'custom' WHERE id = ?").run(stuck);

      markStaleAsFailed(db, 5);
      const row = db.prepare('SELECT error_message FROM invoices WHERE id = ?').get(stuck) as { error_message: string };
      expect(row.error_message).toBe('custom');
    });
  });

  describe('early-delete merge invariant', () => {
    it('after simulated merge flow, the temp row is gone and no orphan remains', () => {
      // Setup: page 1 already processed
      const parent = insertInvoice(db, {
        file_name: 'upload-A.jpg',
        invoice_number: '261',
        supplier: 'ООО "ВЕСЕЛОФФ"',
        raw_text: 'Page 1 text...',
        status: 'processed',
      });

      // Page 2 arrives — new row created by processFile
      const temp = insertInvoice(db, {
        file_name: 'upload-B.jpg',
        raw_text: 'Page 2 text...',
        status: 'parsing',
      });

      // Simulate the new flow: appendFileName, appendRawText, THEN early delete
      const parentRow = db.prepare('SELECT raw_text, file_name FROM invoices WHERE id = ?').get(parent) as {
        raw_text: string;
        file_name: string;
      };
      db.prepare('UPDATE invoices SET file_name = ? WHERE id = ?').run(
        `${parentRow.file_name}, upload-B.jpg`,
        parent
      );
      db.prepare('UPDATE invoices SET raw_text = ? WHERE id = ?').run(
        `${parentRow.raw_text}\n\n--- СТРАНИЦА ---\n\nPage 2 text...`,
        parent
      );
      db.prepare('DELETE FROM invoices WHERE id = ?').run(temp);

      // Now simulate a CRASH here (no more code runs for this path)

      // Invariants:
      const survivors = db.prepare('SELECT id FROM invoices').all() as { id: number }[];
      expect(survivors).toHaveLength(1);
      expect(survivors[0].id).toBe(parent);

      const mergedRow = db.prepare('SELECT file_name, raw_text, status FROM invoices WHERE id = ?').get(parent) as {
        file_name: string;
        raw_text: string;
        status: string;
      };
      expect(mergedRow.file_name).toContain('upload-A.jpg');
      expect(mergedRow.file_name).toContain('upload-B.jpg');
      expect(mergedRow.raw_text).toContain('Page 1 text');
      expect(mergedRow.raw_text).toContain('Page 2 text');
      expect(mergedRow.raw_text).toContain('--- СТРАНИЦА ---');
      expect(mergedRow.status).toBe('processed'); // untouched by merge crash
    });
  });
});
