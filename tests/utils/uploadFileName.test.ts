import express from 'express';
import multer from 'multer';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MULTIPART_UTF8, repairUploadFileName } from '../../src/utils/uploadFileName';

const asLatin1 = (name: string) => Buffer.from(name, 'utf8').toString('latin1');

describe('repairUploadFileName', () => {
  it('turns a UTF-8 name read as latin1 back into Cyrillic', () => {
    const broken = asLatin1('Счёт 617 от 23.11.2026.pdf');
    expect(broken).not.toContain('Счёт');
    expect(repairUploadFileName(broken)).toBe('Счёт 617 от 23.11.2026.pdf');
  });

  it('leaves correct names alone', () => {
    expect(repairUploadFileName('Счёт 617.pdf')).toBe('Счёт 617.pdf');
    expect(repairUploadFileName('IMG_0042.jpg')).toBe('IMG_0042.jpg');
    // Настоящий latin1 — не UTF-8 в байтах, чинить нечего.
    expect(repairUploadFileName('café.jpg')).toBe('café.jpg');
    expect(repairUploadFileName('')).toBe('');
    expect(repairUploadFileName(null)).toBe('');
  });
});

describe('multipart file names', () => {
  it('reads a raw UTF-8 filename from the form as UTF-8', async () => {
    const app = express();
    app.post('/', multer({ ...MULTIPART_UTF8, storage: multer.memoryStorage() }).single('file'),
      (req, res) => { res.json({ name: req.file?.originalname }); });
    const res = await request(app).post('/').attach('file', Buffer.from('%PDF-1.4'), 'Счёт 617 от 23.11.2026.pdf');
    expect(res.body.name).toBe('Счёт 617 от 23.11.2026.pdf');
  });
});
