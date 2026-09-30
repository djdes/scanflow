import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';

// БД-свободный тест загрузки: inbox/ — временный каталог, FileWatcher — заглушка
// (processFile проверяется по вызову, сам конвейер — в tests/watcher/xmlInvoice).
vi.mock('../../src/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config')>();
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const inboxDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sf-upload-xml-'));
  return { config: { ...real.config, inboxDir } };
});
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));

import uploadRouter, { setFileWatcher, uploadExtension } from '../../src/api/routes/upload';
import { config } from '../../src/config';

const fw = { markProcessing: vi.fn(), processFile: vi.fn(async () => 1) };
setFileWatcher(fw as never);

const XML = fs.readFileSync(path.join(__dirname, '..', 'xml', 'fixtures', 'upd_503_ul_win1251.xml'));

function app() {
  const a = express();
  a.use((req, _res, next) => { req.user = { id: 7, username: 'u', role: 'user' } as never; next(); });
  a.use('/api/upload', uploadRouter);
  a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: err.message });
  });
  return a;
}

beforeEach(() => { vi.clearAllMocks(); });

describe('uploadExtension', () => {
  it.each([
    ['ON_NSCHFDOPPR_1.xml', 'application/xml', '.xml'],
    ['ON_NSCHFDOPPR_1.XML', 'application/octet-stream', '.xml'],
    ['document', 'text/xml', '.xml'],
    ['document.bin', 'application/xml; charset=windows-1251', '.xml'],
    ['photo.JPG', 'image/jpeg', '.jpg'],
    ['scan.pdf', 'application/pdf', '.pdf'],
    ['virus.exe', 'application/octet-stream', null],
    ['notes.txt', 'text/plain', null],
  ])('%s (%s) → %s', (name, mime, ext) => {
    expect(uploadExtension(name, mime)).toBe(ext);
  });
});

describe('POST /api/upload — XML из ЭДО', () => {
  it('принимает .xml: файл ложится в inbox/ с расширением .xml, дальше processFile с владельцем', async () => {
    const res = await request(app()).post('/api/upload')
      .attach('file', XML, { filename: 'ON_NSCHFDOPPR_2BM_20260928.XML', contentType: 'application/octet-stream' });
    expect(res.status).toBe(202);
    const stored = res.body.file_name as string;
    expect(stored).toMatch(/^upload-\d+-\d+\.xml$/);
    const storedPath = path.join(config.inboxDir, stored);
    expect(fs.readFileSync(storedPath).equals(XML)).toBe(true);   // байты как есть: windows-1251 не перекодируется
    expect(fw.markProcessing).toHaveBeenCalledWith(storedPath);     // правило 6
    await vi.waitFor(() => expect(fw.processFile).toHaveBeenCalledTimes(1));
    expect(fw.processFile).toHaveBeenCalledWith(storedPath, stored, undefined, expect.objectContaining({
      source: 'web', ownerUserId: 7,
    }));
  });

  it('XML без расширения узнаётся по MIME text/xml', async () => {
    const res = await request(app()).post('/api/upload')
      .attach('file', XML, { filename: 'document', contentType: 'text/xml' });
    expect(res.status).toBe(202);
    expect(res.body.file_name).toMatch(/\.xml$/);
  });

  it('неподдерживаемый формат — отказ, processFile не зовётся', async () => {
    const res = await request(app()).post('/api/upload')
      .attach('file', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Unsupported file type: .txt');
    expect(fw.processFile).not.toHaveBeenCalled();
  });
});
