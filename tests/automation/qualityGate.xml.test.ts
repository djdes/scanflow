import { describe, it, expect, vi, beforeEach } from 'vitest';

// Строки накладной отдаёт подставная БД: storedAlignmentProblems — один SELECT
// (при двух строках история цен не запрашивается).
const db = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, queries: 0 }));
vi.mock('../../src/database/db', () => ({
  getDb: () => ({
    prepare: () => ({ all: async () => { db.queries++; return db.rows; } }),
  }),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { storedAlignmentProblems } from '../../src/automation/qualityGate';

// Две соседние строки с одним названием и разными числами: на фото это признак
// сдвига строк, в электронном документе — обычные две партии товара.
const twoBatches = (invoice: { ocr_engine: string | null; file_name: string }) => [
  { original_name: 'Молоко 3,2%', q: 10, u: 'шт', p: 88, t: 880, row_no: 1, owner_user_id: 1, ...invoice },
  { original_name: 'Молоко 3,2%', q: 5, u: 'шт', p: 90, t: 450, row_no: 2, owner_user_id: 1, ...invoice },
];

beforeEach(() => { db.queries = 0; });

describe('storedAlignmentProblems — XML', () => {
  it('фото: повтор названия у соседних строк — признак сдвига', async () => {
    db.rows = twoBatches({ ocr_engine: 'claude_api', file_name: 'upload-1.jpg' });
    expect((await storedAlignmentProblems(1)).join(' ')).toContain('одно название');
  });

  it('XML (по движку или по имени файла): проверка сдвига не делается', async () => {
    db.rows = twoBatches({ ocr_engine: 'xml_upd', file_name: 'upload-1.xml' });
    expect(await storedAlignmentProblems(1)).toEqual([]);
    db.rows = twoBatches({ ocr_engine: null, file_name: 'email-5-1-ab.xml' });
    expect(await storedAlignmentProblems(1)).toEqual([]);
    expect(db.queries).toBe(2);   // только чтение строк, без истории цен
  });
});
