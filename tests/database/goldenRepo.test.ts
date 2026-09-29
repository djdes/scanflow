import { describe, it, expect, vi, beforeEach } from 'vitest';

// БД не нужна: getDb подменён адаптером, который записывает SQL и параметры.
// Проверяем то, что нельзя сломать молча — фильтр по владельцу (правило 19)
// и разбор имён файлов для очистки фото.
const db = vi.hoisted(() => {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const next = { all: [] as unknown[], get: undefined as unknown };
  const adapter = {
    prepare: (sql: string) => ({
      all: async (...args: unknown[]) => { calls.push({ sql, args }); return next.all; },
      get: async (...args: unknown[]) => { calls.push({ sql, args }); return next.get; },
      run: async (...args: unknown[]) => { calls.push({ sql, args }); return { changes: 1, lastInsertRowid: 5 }; },
    }),
  };
  return { calls, next, adapter };
});
vi.mock('../../src/database/db', () => ({ getDb: () => db.adapter }));

import { goldenRepo } from '../../src/database/repositories/goldenRepo';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  db.calls.length = 0;
  db.next.all = [];
  db.next.get = undefined;
});

describe('goldenRepo', () => {
  it('listGoldenInvoiceIds: только golden=1 и только свои; лимит прижат к 50; порядок стабилен', async () => {
    db.next.all = [{ id: 3 }, { id: 8 }];
    expect(await goldenRepo.listGoldenInvoiceIds(7, { limit: 999 })).toEqual([3, 8]);
    const { sql, args } = db.calls[0];
    expect(squash(sql)).toBe('SELECT id FROM invoices WHERE golden = 1 AND owner_user_id = ? ORDER BY id LIMIT 50');
    expect(args).toEqual([7]);
  });

  it('listGoldenInvoiceIds: явный список id — дубли и мусор выкинуты, владелец всё равно в фильтре', async () => {
    await goldenRepo.listGoldenInvoiceIds(7, { limit: 10, invoiceIds: [3, 3, -1, 4.5, 4] });
    const { sql, args } = db.calls[0];
    expect(squash(sql)).toContain('WHERE golden = 1 AND owner_user_id = ? AND id IN (?,?)');
    expect(squash(sql)).toContain('LIMIT 10');
    expect(args).toEqual([7, 3, 4]);
  });

  it('listGoldenInvoiceIds: пустой явный список — ничего, без запроса', async () => {
    expect(await goldenRepo.listGoldenInvoiceIds(7, { limit: 10, invoiceIds: [] })).toEqual([]);
    expect(db.calls).toHaveLength(0);
  });

  it('setGolden: отметка не сдвигает дату первой отметки, снятие её обнуляет', async () => {
    await goldenRepo.setGolden(12, true);
    await goldenRepo.setGolden(12, false);
    expect(squash(db.calls[0].sql)).toBe('UPDATE invoices SET golden = 1, golden_at = COALESCE(golden_at, NOW()) WHERE id = ?');
    expect(squash(db.calls[1].sql)).toBe('UPDATE invoices SET golden = 0, golden_at = NULL WHERE id = ?');
    expect(db.calls[1].args).toEqual([12]);
  });

  it('listGoldenFileNames: все страницы многостраничной + имя из file_path, без дублей', async () => {
    db.next.all = [
      { file_name: 'p1.jpg, p2.jpg', file_path: '/srv/data/processed/p1.jpg' },
      { file_name: 'single.jpg', file_path: '/srv/data/inbox/single.jpg' },
      { file_name: null, file_path: null },
    ];
    const names = await goldenRepo.listGoldenFileNames();
    expect(names.sort()).toEqual(['p1.jpg', 'p2.jpg', 'single.jpg']);
    expect(squash(db.calls[0].sql)).toBe('SELECT file_name, file_path FROM invoices WHERE golden = 1');
  });

  it('listRuns / countGolden — фильтр по владельцу', async () => {
    await goldenRepo.listRuns(7);
    await goldenRepo.countGolden(7);
    expect(squash(db.calls[0].sql)).toContain('FROM golden_runs WHERE owner_user_id = ? ORDER BY id DESC LIMIT 20');
    expect(db.calls[0].args).toEqual([7]);
    expect(squash(db.calls[1].sql)).toContain('WHERE golden = 1 AND owner_user_id = ?');
  });

  it('createRun / finishRun / markInterrupted — JSON в MEDIUMTEXT, прогресс только у идущего', async () => {
    expect(await goldenRepo.createRun({ ownerUserId: 7, startedBy: 7, model: 'm', summary: { planned: 2 } })).toBe(5);
    expect(db.calls[0].args).toEqual([7, 7, 'm', '{"planned":2}']);
    await goldenRepo.saveProgress(5, { processed: 1 }, [{ invoice_id: 1 }]);
    expect(squash(db.calls[1].sql)).toContain("WHERE id = ? AND status = 'running'");
    await goldenRepo.finishRun(5, 'done', { ok: 1 }, []);
    expect(db.calls[2].args).toEqual(['done', '{"ok":1}', '[]', 5]);
    await goldenRepo.markInterrupted(5, { error: 'x' });
    expect(squash(db.calls[3].sql)).toContain("SET status = 'error', finished_at = NOW()");
    expect(squash(db.calls[3].sql)).toContain("AND status = 'running'");
  });
});
