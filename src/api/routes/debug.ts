import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../../database/db';
import { backupDatabase } from '../../utils/backup';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { snapshotRepo, headerRestorePatch, RESTORABLE_HEADER_FIELDS, type RestorableField, type SnapshotKind } from '../../database/repositories/snapshotRepo';
import { logEdit } from '../../database/repositories/editLogRepo';

const router = Router();

// POST /api/debug/restore-headers — массовый откат номера/даты/суммы/НДС из снимков.
// body: { kind: 'baseline' | 'recognized' (по умолчанию baseline), dry_run (по
// умолчанию true!), invoice_ids?: number[], fields?: [...] }. Строки не трогает.
// Рычаг отката пакета v2 — см. docs/runbooks/rollback-v2.md.
router.post('/restore-headers', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { kind?: string; dry_run?: unknown; invoice_ids?: unknown; fields?: unknown };
  const kind: SnapshotKind = body.kind === 'recognized' ? 'recognized' : 'baseline';
  const dryRun = body.dry_run !== false;
  const fields = Array.isArray(body.fields)
    ? RESTORABLE_HEADER_FIELDS.filter(f => (body.fields as unknown[]).includes(f))
    : [...RESTORABLE_HEADER_FIELDS];
  const ids = Array.isArray(body.invoice_ids)
    ? (body.invoice_ids as unknown[]).map(Number).filter(n => Number.isInteger(n) && n > 0)
    : null;
  const db = getDb();
  const invoices = ids && ids.length
    ? await db.prepare(`SELECT id, owner_user_id, invoice_number, invoice_date, total_sum, vat_sum FROM invoices WHERE id IN (${ids.map(() => '?').join(',')})`).all<Record<string, unknown>>(...ids)
    : await db.prepare('SELECT id, owner_user_id, invoice_number, invoice_date, total_sum, vat_sum FROM invoices').all<Record<string, unknown>>();
  const changes: Array<{ invoice_id: number; patch: Record<string, unknown>; before: Record<string, unknown> }> = [];
  for (const inv of invoices) {
    const snap = await snapshotRepo.latest(Number(inv.id), kind);
    if (!snap) continue;
    const patch = headerRestorePatch(inv as Partial<Record<RestorableField, string | number | null>>, snap, fields);
    if (!Object.keys(patch).length) continue;
    changes.push({ invoice_id: Number(inv.id), patch, before: Object.fromEntries(Object.keys(patch).map(k => [k, inv[k]])) });
    if (!dryRun) {
      await snapshotRepo.applyHeaderPatch(Number(inv.id), patch);
      for (const [field, value] of Object.entries(patch)) {
        await logEdit({
          ownerUserId: inv.owner_user_id == null ? null : Number(inv.owner_user_id), userId: req.user?.id ?? null,
          invoiceId: Number(inv.id), entity: 'invoice', field, oldValue: inv[field], newValue: value,
          context: { restored_from: kind, snapshot_id: snap.id, bulk: true },
        });
      }
    }
  }
  if (!dryRun) logger.warn('Bulk header restore applied', { kind, count: changes.length, by: req.user?.id });
  res.json({ data: { kind, dry_run: dryRun, checked: invoices.length, changed: changes.length, changes } });
});

// GET /api/debug/errors — last 10 invoices with status='error' (diagnostic)
router.get('/errors', async (_req: Request, res: Response) => {
  const db = getDb();
  const rows = await db.prepare(
    `SELECT id, file_name, error_message, created_at
     FROM invoices WHERE status = 'error'
     ORDER BY id DESC LIMIT 10`
  ).all();
  res.json({ data: rows });
});

// POST /api/debug/reprocess-errors — move failed files back to inbox for re-processing
router.post('/reprocess-errors', async (_req: Request, res: Response) => {
  const db = getDb();
  const rows = await db.prepare(
    `SELECT id, file_name FROM invoices WHERE status = 'error' ORDER BY id DESC LIMIT 10`
  ).all<{ id: number; file_name: string }>();

  const results: Array<{ id: number; file: string; status: string }> = [];
  for (const row of rows) {
    const fileName = path.basename(row.file_name);
    const failedPath = path.join(config.failedDir, fileName);
    const processedPath = path.join(config.processedDir, fileName);
    const inboxPath = path.join(config.inboxDir, fileName);

    let source: string | null = null;
    if (fs.existsSync(failedPath)) source = failedPath;
    else if (fs.existsSync(processedPath)) source = processedPath;

    if (!source) {
      results.push({ id: row.id, file: fileName, status: 'file_not_found' });
      continue;
    }

    try {
      await db.prepare('DELETE FROM invoice_items WHERE invoice_id = ?').run(row.id);
      await db.prepare('DELETE FROM invoices WHERE id = ?').run(row.id);
      fs.renameSync(source, inboxPath);
      results.push({ id: row.id, file: fileName, status: 'moved_to_inbox' });
    } catch (e) {
      results.push({ id: row.id, file: fileName, status: 'error: ' + (e as Error).message });
      logger.warn('reprocess-errors: failed to requeue', { id: row.id, error: (e as Error).message });
    }
  }
  res.json({ data: results });
});

// POST /api/debug/backup — trigger manual database backup
router.post('/backup', async (_req: Request, res: Response) => {
  const backupPath = await backupDatabase();
  if (backupPath) {
    res.json({ success: true, path: backupPath });
  } else {
    res.status(500).json({ success: false, error: 'Backup failed, check server logs' });
  }
});

// GET /api/debug/requests-log?limit=50&path_like=%invoices%
// Returns recent API request log entries (most recent first).
// Used for diagnosing connectivity issues with 1C and other clients.
router.get('/requests-log', async (req: Request, res: Response) => {
  // Sanitized + inlined below (mysql2 rejects placeholder ints in LIMIT on MySQL).
  const limit = Math.max(1, Math.min(parseInt(req.query.limit as string) || 50, 500));
  const pathLike = req.query.path_like as string | undefined;
  const sinceMinutes = req.query.since_minutes ? parseInt(req.query.since_minutes as string) : null;

  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (pathLike) {
    conditions.push('path LIKE ?');
    params.push(pathLike);
  }
  if (sinceMinutes !== null && !isNaN(sinceMinutes)) {
    conditions.push(`timestamp > (NOW() - INTERVAL ${sinceMinutes} MINUTE)`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = await db.prepare(
    `SELECT id, timestamp, method, path, remote_addr, user_agent, status_code, duration_ms
     FROM api_requests_log
     ${where}
     ORDER BY id DESC
     LIMIT ${limit}`
  ).all(...params);

  res.json({ data: rows, count: rows.length });
});

export default router;
