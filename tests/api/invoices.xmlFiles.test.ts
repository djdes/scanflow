import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

// БД-свободный тест роутов файла накладной и защит от склейки для XML:
// invoiceRepo замокан, каталоги — временные, остальная БД недоступна.
vi.mock('../../src/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config')>();
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sf-xml-files-'));
  const mk = (name: string) => { const d = nodePath.join(root, name); nodeFs.mkdirSync(d); return d; };
  return { config: { ...real.config, inboxDir: mk('inbox'), processedDir: mk('processed'), failedDir: mk('failed') } };
});
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('эти роуты должны ходить в БД только через invoiceRepo'); },
}));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/database/repositories/invoiceRepo', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/database/repositories/invoiceRepo')>();
  return { ...real, invoiceRepo: { getById: vi.fn(), moveItemsToInvoice: vi.fn(), delete: vi.fn() } };
});

import invoicesRouter, { setFileWatcher } from '../../src/api/routes/invoices';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { config } from '../../src/config';

const repo = vi.mocked(invoiceRepo);
const fw = { addPageToInvoice: vi.fn() };
setFileWatcher(fw as never);

const XML_BYTES = fs.readFileSync(path.join(__dirname, '..', 'xml', 'fixtures', 'upd_503_ul_win1251.xml'));
const FILE_ID = 'ON_NSCHFDOPPR_2BM-5003012349-500301001-202409051210321234567_2BM-7701234560-770101001-201811261023548765432_20260928_1f0c5a2e-7b3d-4c61-9e2a-4a8d3b6c5e10';

const invoices: Record<number, Record<string, unknown>> = {
  1: { id: 1, owner_user_id: 2, file_name: 'upload-1.xml', ocr_engine: 'xml_upd', raw_text: JSON.stringify({ source: 'xml', file_id: FILE_ID }) },
  2: { id: 2, owner_user_id: 2, file_name: 'upload-2.jpg, upload-3.pdf, upload-gone.jpg', ocr_engine: 'claude_api', raw_text: '{}' },
  3: { id: 3, owner_user_id: 9, file_name: 'upload-9.jpg', ocr_engine: 'claude_api', raw_text: '{}' },
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { id: 2, username: 'u', role: 'user' } as never; next(); });
  a.use('/api/invoices', invoicesRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.getById.mockImplementation(async (id: number) => invoices[id] as never);
  fs.writeFileSync(path.join(config.processedDir, 'upload-1.xml'), XML_BYTES);
  fs.writeFileSync(path.join(config.processedDir, 'upload-2.jpg'), 'jpeg');
  fs.writeFileSync(path.join(config.failedDir, 'upload-3.pdf'), '%PDF');
});

describe('GET /api/invoices/:id/photos', () => {
  it('вид файла и наличие на диске', async () => {
    const res = await request(app()).get('/api/invoices/2/photos');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { filename: 'upload-2.jpg', url: '/api/invoices/2/photos/upload-2.jpg', kind: 'image', exists: true },
      { filename: 'upload-3.pdf', url: '/api/invoices/2/photos/upload-3.pdf', kind: 'pdf', exists: true },
      { filename: 'upload-gone.jpg', url: '/api/invoices/2/photos/upload-gone.jpg', kind: 'image', exists: false },
    ]);
  });

  it('XML-накладная', async () => {
    const res = await request(app()).get('/api/invoices/1/photos');
    expect(res.body.data).toEqual([{ filename: 'upload-1.xml', url: '/api/invoices/1/photos/upload-1.xml', kind: 'xml', exists: true }]);
  });
});

describe('GET /api/invoices/:id/photos/:filename', () => {
  it('исходный XML отдаётся только скачиванием, под именем из ЭДО, байты как есть', async () => {
    const res = await request(app()).get('/api/invoices/1/photos/upload-1.xml').buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${FILE_ID}.xml"`);
    expect(res.headers['content-type']).toMatch(/^application\/xml/);
    expect((res.body as Buffer).equals(XML_BYTES)).toBe(true);
  });

  it('фото и PDF — как раньше, без вложения; из failed/ тоже', async () => {
    const img = await request(app()).get('/api/invoices/2/photos/upload-2.jpg');
    expect(img.status).toBe(200);
    expect(img.headers['content-disposition']).toBeUndefined();
    const pdf = await request(app()).get('/api/invoices/2/photos/upload-3.pdf');
    expect(pdf.status).toBe(200);
  });

  it('файла нет на диске → 404; чужая накладная → 404', async () => {
    expect((await request(app()).get('/api/invoices/2/photos/upload-gone.jpg')).status).toBe(404);
    expect((await request(app()).get('/api/invoices/3/photos/upload-9.jpg')).status).toBe(404);
  });
});

describe('XML — цельный документ', () => {
  it('«дофоткать» к XML-накладной → 409, загруженные файлы убраны', async () => {
    const before = new Set(fs.readdirSync(config.processedDir));
    const res = await request(app()).post('/api/invoices/1/add-pages')
      .attach('files', Buffer.from('jpeg'), { filename: 'page2.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('XML');
    expect(fw.addPageToInvoice).not.toHaveBeenCalled();
    expect(new Set(fs.readdirSync(config.processedDir))).toEqual(before);
  });

  it('объединение с XML-накладной (в обе стороны) → 409, ничего не двигается', async () => {
    for (const url of ['/api/invoices/2/merge-into/1', '/api/invoices/1/merge-into/2']) {
      const res = await request(app()).post(url);
      expect(res.status).toBe(409);
    }
    expect(repo.moveItemsToInvoice).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });
});
