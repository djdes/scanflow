import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

// БД-свободный тест почтового канала: репозитории замоканы, inbox/ — временный.
vi.mock('../../src/config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config')>();
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const inboxDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sf-inbound-xml-'));
  return { config: { ...real.config, inboxDir } };
});
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/database/db', () => ({
  getDb: () => { throw new Error('почтовый канал ходит в БД только через репозитории'); },
}));
vi.mock('../../src/database/repositories/inboundChannelRepo', () => ({
  inboundChannelRepo: { get: vi.fn(), claimTelegramUpdate: vi.fn() },
}));
vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: { getTelegramConfig: vi.fn() },
}));

import { inboundPublicRouter, setInboundFileWatcher, safeExtension } from '../../src/api/routes/inbound';
import { inboundChannelRepo } from '../../src/database/repositories/inboundChannelRepo';
import { config } from '../../src/config';

const TOKEN = 'inbound-secret';
const fw = { markProcessing: vi.fn(), processFile: vi.fn(async () => 1) };
setInboundFileWatcher(fw as never);

const XML = fs.readFileSync(path.join(__dirname, '..', 'xml', 'fixtures', 'upd_501_ip_utf8.xml'));

function app() {
  const a = express();
  a.use('/api/inbound/public', inboundPublicRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(inboundChannelRepo.get).mockResolvedValue({
    email_enabled: 1,
    email_secret_hash: createHash('sha256').update(TOKEN).digest('hex'),
  } as never);
});

describe('safeExtension', () => {
  it.each([
    ['ON_NSCHFDOPPR_1.xml', 'application/octet-stream', '.xml'],
    ['ON_NSCHFDOPPR_1.XML', undefined, '.xml'],
    ['attachment', 'application/xml', '.xml'],
    ['document.dat', 'text/xml', '.xml'],
    ['scan.pdf', 'application/pdf', '.pdf'],
    ['ON_NSCHFDOPPR_1.xml.sig', 'application/pkcs7-signature', null],
  ])('%s (%s) → %s', (name, mime, ext) => {
    expect(safeExtension(name, mime)).toBe(ext);
  });
});

describe('POST /api/inbound/public/email/:userId — XML-вложения', () => {
  it('XML принимается и уходит в processFile от имени владельца канала; подпись .sig — отказ', async () => {
    const res = await request(app()).post('/api/inbound/public/email/5')
      .set('X-Inbound-Token', TOKEN)
      .attach('files', XML, { filename: 'ON_NSCHFDOPPR_2BE_20260929.xml', contentType: 'application/xml' })
      .attach('files', Buffer.from('signature'), { filename: 'ON_NSCHFDOPPR_2BE_20260929.xml.sig', contentType: 'application/octet-stream' });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toHaveLength(1);
    expect(res.body.accepted[0]).toMatch(/^email-5-\d+-[0-9a-f]{8}\.xml$/);
    expect(res.body.rejected).toHaveLength(1);
    expect(res.body.rejected[0]).toContain('.xml.sig');

    const stored = path.join(config.inboxDir, res.body.accepted[0]);
    expect(fs.readFileSync(stored).equals(XML)).toBe(true);
    expect(fw.markProcessing).toHaveBeenCalledWith(stored);
    expect(fw.processFile).toHaveBeenCalledWith(stored, res.body.accepted[0], undefined, expect.objectContaining({
      source: 'email', ownerUserId: 5,
    }));
  });

  it('неверный токен — 404, файл не принимается', async () => {
    const res = await request(app()).post('/api/inbound/public/email/5')
      .set('X-Inbound-Token', 'wrong')
      .attach('files', XML, { filename: 'a.xml', contentType: 'application/xml' });
    expect(res.status).toBe(404);
    expect(fw.processFile).not.toHaveBeenCalled();
  });
});
