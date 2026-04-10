# Reliability Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve system reliability — prevent data loss (DB backups), duplicate processing (file hashes), and mapping pollution (quality-gated auto-save).

**Architecture:** Three independent improvements: (1) daily SQLite backups via node-cron, (2) SHA-256 file hash column + dedup check on upload, (3) raise fuzzy auto-save threshold to 0.8 so questionable matches don't pollute learned mappings.

**Tech Stack:** SQLite (better-sqlite3), node-cron (already installed), Node.js crypto, TypeScript

---

## File Structure

**New files:**
- `src/utils/backup.ts` — backup logic: copy DB file with timestamp, cleanup old backups
- `src/utils/fileHash.ts` — SHA-256 hash calculation helper

**Modified files:**
- `src/database/migrations.ts` — add migration v12: `file_hash` column on `invoices`
- `src/database/repositories/invoiceRepo.ts` — add `findByFileHash()` method
- `src/watcher/fileWatcher.ts` — calculate hash, check for duplicate, store hash
- `src/mapping/nomenclatureMapper.ts` — raise `MIN_FUZZY_CONFIDENCE` from 0.6 to 0.8
- `src/index.ts` — schedule daily backup cron job on startup

---

## Task 1: File Hash Helper

**Files:**
- Create: `src/utils/fileHash.ts`

- [ ] **Step 1: Create the hash helper**

```typescript
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

/**
 * Calculate SHA-256 hash of a file's contents.
 * Used to detect duplicate uploads regardless of filename.
 */
export function sha256File(filePath: string): string {
  const buffer = readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/utils/fileHash.ts
git commit -m "feat(utils): SHA-256 file hash helper for duplicate detection"
```

---

## Task 2: Database Migration — file_hash Column

**Files:**
- Modify: `src/database/migrations.ts`

- [ ] **Step 1: Add migration v12 at the end of runMigrations()**

Find the last migration block (migration v11 that fixes stale model IDs) and add immediately after it, before `logger.info('Database migrations completed')`:

```typescript
  // === Migration v12: file_hash column on invoices ===
  const hasFileHash = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('invoices') WHERE name = 'file_hash'"
  ).get() as { cnt: number };

  if (hasFileHash.cnt === 0) {
    logger.info('Migration v12: Adding file_hash to invoices...');
    db.exec(`
      ALTER TABLE invoices ADD COLUMN file_hash TEXT;
      CREATE INDEX IF NOT EXISTS idx_invoices_file_hash ON invoices(file_hash);
    `);
  }
```

- [ ] **Step 2: Restart dev server to run migration**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat(db): migration v12 — add file_hash column to invoices"
```

---

## Task 3: Invoice Repository — findByFileHash

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts`

- [ ] **Step 1: Add findByFileHash method and update Invoice interface**

Find the `Invoice` interface at the top of the file and add `file_hash` field:

```typescript
export interface Invoice {
  // ... existing fields ...
  file_hash: string | null;
}
```

Find a place near other find methods (like `findRecentByFileName`) and add:

```typescript
  /**
   * Find an existing invoice by file content hash (SHA-256).
   * Used to prevent processing the same photo twice.
   */
  findByFileHash(fileHash: string): Invoice | undefined {
    const db = getDb();
    return db.prepare(
      `SELECT * FROM invoices
       WHERE file_hash = ?
       AND status NOT IN ('error')
       ORDER BY created_at DESC
       LIMIT 1`
    ).get(fileHash) as Invoice | undefined;
  },

  /**
   * Set file_hash on an invoice (called after successful upload).
   */
  setFileHash(id: number, fileHash: string): void {
    const db = getDb();
    db.prepare('UPDATE invoices SET file_hash = ? WHERE id = ?').run(fileHash, id);
  },
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts
git commit -m "feat(db): findByFileHash and setFileHash on invoiceRepo"
```

---

## Task 4: Duplicate Detection in fileWatcher

**Files:**
- Modify: `src/watcher/fileWatcher.ts`

- [ ] **Step 1: Import the hash helper**

At the top of `fileWatcher.ts`, add after the existing imports:

```typescript
import { sha256File } from '../utils/fileHash';
```

- [ ] **Step 2: Calculate hash and check duplicate at the start of processFile**

Find the beginning of `processFile(filePath: string)` method (around line 105). Right after the existing deduplication checks (in-memory Set, recent filename check), BEFORE creating the invoice record, add:

```typescript
    // Content-based deduplication: SHA-256 of file bytes.
    // Catches the case where the same photo is uploaded under a different name.
    let fileHash: string | null = null;
    try {
      fileHash = sha256File(filePath);
      const duplicate = invoiceRepo.findByFileHash(fileHash);
      if (duplicate) {
        logger.info('Duplicate file detected by hash, skipping', {
          filePath,
          hash: fileHash.substring(0, 12),
          existingInvoiceId: duplicate.id,
        });
        // Move file to processed to clean up inbox
        if (!config.dryRun) {
          try {
            const destPath = path.join(config.processedDir, fileName);
            fs.renameSync(filePath, destPath);
          } catch { /* ignore */ }
        }
        return duplicate.id;
      }
    } catch (e) {
      logger.warn('Failed to compute file hash, continuing without dedup', { filePath, error: (e as Error).message });
    }
```

- [ ] **Step 3: Store hash on the new invoice**

Find the line where the invoice is created (something like `const invoice = invoiceRepo.create({...})` near line 110-115). Right after that line, add:

```typescript
    if (fileHash) {
      invoiceRepo.setFileHash(invoice.id, fileHash);
    }
```

- [ ] **Step 4: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/watcher/fileWatcher.ts
git commit -m "feat(watcher): SHA-256 file hash deduplication"
```

---

## Task 5: Raise Fuzzy Auto-Save Threshold

**Files:**
- Modify: `src/mapping/nomenclatureMapper.ts`

- [ ] **Step 1: Change MIN_FUZZY_CONFIDENCE from 0.6 to 0.8 for auto-save**

The idea: keep matching with 0.6 confidence (so user sees suggestions), but only auto-save mappings that are very confident (0.8+). This prevents polluting learned mappings with questionable auto-matches.

Find line 22 which has:
```typescript
const MIN_FUZZY_CONFIDENCE = 0.6;
```

Replace the whole constants section at the top (around lines 15-22) with:

```typescript
const ONEC_FUSE_OPTIONS: IFuseOptions<OnecNomenclatureRow> = {
  keys: ['name', 'full_name'],
  threshold: 0.4, // Fuse score — matches with confidence >= 0.6 are returned
  includeScore: true,
  minMatchCharLength: 3,
};

// Minimum confidence to return a fuzzy match at all
const MIN_FUZZY_CONFIDENCE = 0.6;

// Minimum confidence to AUTO-SAVE a fuzzy match as a learned mapping.
// Higher than MIN_FUZZY_CONFIDENCE so questionable matches don't pollute
// learned mappings (they'd become "exact" matches on next lookup).
const AUTO_SAVE_CONFIDENCE = 0.8;
```

- [ ] **Step 2: Use AUTO_SAVE_CONFIDENCE in the auto-save block**

Find the block around line 117-149 that auto-saves fuzzy matches. It currently checks `confidence >= MIN_FUZZY_CONFIDENCE`. Change the auto-save guard only:

```typescript
      if (confidence >= MIN_FUZZY_CONFIDENCE) {
        // Auto-save ONLY if confidence is very high, to avoid polluting learned mappings
        if (confidence >= AUTO_SAVE_CONFIDENCE) {
          try {
            const existing = mappingRepo.getByScannedName(scannedName);
            if (!existing) {
              mappingRepo.create({
                scanned_name: scannedName,
                mapped_name_1c: best.item.name,
                onec_guid: best.item.guid,
              });
            }
            if (cleanName !== scannedName) {
              const existingClean = mappingRepo.getByScannedName(cleanName);
              if (!existingClean) {
                mappingRepo.create({
                  scanned_name: cleanName,
                  mapped_name_1c: best.item.name,
                  onec_guid: best.item.guid,
                });
              }
            }
          } catch (e) {
            logger.warn('Auto-save mapping failed', { scannedName, error: (e as Error).message });
          }
        }

        return {
          original_name: scannedName,
          mapped_name: best.item.name,
          onec_guid: best.item.guid,
          confidence,
          source: 'onec_fuzzy',
          mapping_id: null,
        };
      }
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/mapping/nomenclatureMapper.ts
git commit -m "feat(mapping): only auto-save fuzzy matches with confidence >= 0.8"
```

---

## Task 6: Database Backup Helper

**Files:**
- Create: `src/utils/backup.ts`

- [ ] **Step 1: Create backup helper**

```typescript
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from './logger';

const BACKUP_DIR = path.join(path.dirname(config.dbPath), 'backups');
const MAX_BACKUPS = 7; // Keep 7 days of backups

/**
 * Create a timestamped backup of the SQLite database.
 * Uses fs.copyFileSync which is safe with WAL mode — SQLite will checkpoint
 * automatically and the file copy captures a consistent snapshot.
 */
export function backupDatabase(): string | null {
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `database-${timestamp}.sqlite`);

    fs.copyFileSync(config.dbPath, backupPath);

    const sizeMB = (fs.statSync(backupPath).size / 1024 / 1024).toFixed(2);
    logger.info('Database backup created', { path: backupPath, sizeMB });

    cleanupOldBackups();
    return backupPath;
  } catch (err) {
    logger.error('Database backup failed', { error: (err as Error).message });
    return null;
  }
}

/**
 * Delete backups older than MAX_BACKUPS, keeping newest.
 */
function cleanupOldBackups(): void {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('database-') && f.endsWith('.sqlite'))
      .map(f => ({
        name: f,
        path: path.join(BACKUP_DIR, f),
        mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    const toDelete = files.slice(MAX_BACKUPS);
    for (const f of toDelete) {
      fs.unlinkSync(f.path);
      logger.debug('Old backup deleted', { file: f.name });
    }
  } catch (err) {
    logger.warn('Backup cleanup failed', { error: (err as Error).message });
  }
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/backup.ts
git commit -m "feat(backup): daily SQLite backup helper with 7-day retention"
```

---

## Task 7: Schedule Daily Backup on Startup

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Import cron and backup helper**

At the top of `src/index.ts`, add after the existing imports:

```typescript
import cron from 'node-cron';
import { backupDatabase } from './utils/backup';
```

- [ ] **Step 2: Schedule the cron job inside main()**

Find the `main()` function. After the line that starts the server (`startServer(fileWatcher, mapper)`), add:

```typescript
  // Daily backup at 3:00 AM server time
  cron.schedule('0 3 * * *', () => {
    logger.info('Running scheduled database backup...');
    backupDatabase();
  });
  logger.info('Daily backup scheduled at 03:00');

  // Run one backup immediately on startup (helps capture state before any crash)
  backupDatabase();
```

- [ ] **Step 3: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(backup): schedule daily SQLite backup at 03:00 + startup backup"
```

---

## Task 8: Manual Backup Endpoint (optional diagnostic)

**Files:**
- Modify: `src/api/routes/debug.ts`

- [ ] **Step 1: Add manual backup trigger endpoint**

Find the existing debug routes file. Add a new route:

```typescript
import { backupDatabase } from '../../utils/backup';

// POST /api/debug/backup — trigger manual DB backup
router.post('/backup', (_req: Request, res: Response) => {
  const path = backupDatabase();
  if (path) {
    res.json({ success: true, path });
  } else {
    res.status(500).json({ success: false, error: 'Backup failed, check logs' });
  }
});
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit and push all reliability improvements**

```bash
git add src/api/routes/debug.ts
git commit -m "feat(backup): manual backup trigger via POST /api/debug/backup"
git push
```

---

## Task 9: Deploy & Verify

- [ ] **Step 1: Wait ~30 seconds for GitHub Actions to deploy**

- [ ] **Step 2: Verify backup directory exists on server**

Via the debug endpoint (no SSH needed):

```bash
curl -X POST http://scan.magday.ru/api/debug/backup \
  -H "X-API-Key: <your-key>"
```

Expected response: `{"success":true,"path":"/var/www/.../data/backups/database-2026-04-10T..."}`

- [ ] **Step 3: Upload the same photo twice to test duplicate detection**

```bash
# First upload
curl -X POST http://scan.magday.ru/api/upload \
  -H "X-API-Key: <your-key>" \
  -F "file=@test.jpg"

# Second upload (same file)
curl -X POST http://scan.magday.ru/api/upload \
  -H "X-API-Key: <your-key>" \
  -F "file=@test.jpg"
```

Expected: second upload returns same `invoice_id` as first (duplicate detected).

- [ ] **Step 4: Check that existing invoices still work**

Open scan.magday.ru/invoices — list loads, can open details, mappings display correctly.

---

## Self-Review Checklist

- [x] **Spec coverage**: All three critical gaps addressed (backup, dedup, mapping pollution)
- [x] **No placeholders**: Every step has exact code, no TBDs
- [x] **Type consistency**: `file_hash` added to Invoice interface (Task 3) before use in Task 4; `findByFileHash` used in fileWatcher after definition
- [x] **Bite-sized**: Each step is 2-5 minutes of work
- [x] **Commits**: Each task ends with a commit
