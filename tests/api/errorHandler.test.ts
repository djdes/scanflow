import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import multer from 'multer';

vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ClientError, terminalErrorHandler } from '../../src/api/middleware/errorHandler';
import { logger } from '../../src/utils/logger';

// Маршруты как в server.ts: параметр пути и SPA-фолбэк /{*splat}. Роутер
// Express 5 раскодирует параметры сам и на мусоре бросает URIError.
function makeApp(): express.Express {
  const app = express();
  app.get('/api/items/:id', (req, res) => { res.json({ id: req.params.id }); });
  app.get('/boom', () => { throw new Error('kaput'); });
  app.get('/too-big', () => { throw new multer.MulterError('LIMIT_FILE_SIZE'); });
  app.post('/api/strict', multer({ fileFilter: (_req, _file, cb) => cb(new ClientError(415, 'Такой файл не подходит (.doc). Подходят фото, PDF и XML')) }).single('file'),
    (_req, res) => { res.sendStatus(202); });
  app.post('/api/upload', multer().single('file'), (_req, res) => { res.sendStatus(202); });
  app.get('/{*splat}', (_req, res) => { res.send('spa'); });
  app.use(terminalErrorHandler);
  return app;
}

describe('terminalErrorHandler (п.20)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('мусорный URL сканера → 400 и warn, без error-лога', async () => {
    const res = await request(makeApp()).get('/%c0%ae%c0%ae/%c0%ae%c0%ae/etc/passwd');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Bad request' });
    expect(logger.warn).toHaveBeenCalledWith('Bad request: undecodable URL', expect.objectContaining({
      error: expect.stringMatching(/Failed to decode param/),
    }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('битый параметр API-маршрута → тоже 400', async () => {
    const res = await request(makeApp()).get('/api/items/%E0%A4%A');
    expect(res.status).toBe(400);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('нормальный URL не задет', async () => {
    const res = await request(makeApp()).get('/api/items/%D0%B0%D0%B1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'аб' });
  });

  it('прочие ошибки — как раньше: 500 и error-лог', async () => {
    const res = await request(makeApp()).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Ошибка сервера. Попробуйте ещё раз' });
    expect(logger.error).toHaveBeenCalledWith('Unhandled request error', { error: 'kaput' });
  });

  it('multer: слишком большой файл — 413 и текст по-русски', async () => {
    const res = await request(makeApp()).get('/too-big');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Файл слишком большой', code: 'LIMIT_FILE_SIZE' });
  });

  it('неподходящий файл — ошибка клиента с текстом для человека, а не 500', async () => {
    const res = await request(makeApp()).post('/api/strict').attach('file', Buffer.from('doc'), 'Договор.doc');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Такой файл не подходит (.doc). Подходят фото, PDF и XML' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('Safari-style empty multipart body returns an actionable 400 instead of 500', async () => {
    const res = await request(makeApp()).post('/api/upload?key=secret-not-to-log')
      .set('Content-Type', 'multipart/form-data; boundary=----WebKitFormBoundaryTest')
      .set('User-Agent', 'Safari test')
      .send('');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'upload_incomplete', error: expect.stringContaining('Повторить') });
    expect(logger.warn).toHaveBeenCalledWith('Incomplete multipart upload', expect.objectContaining({
      path: '/api/upload', content_length: '0', user_agent: 'Safari test',
    }));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('truncated multipart without closing boundary is a client upload error', async () => {
    const body = '--boundary\r\nContent-Disposition: form-data; name="file"; filename="image.jpg"\r\nContent-Type: image/jpeg\r\n\r\npartial';
    const res = await request(makeApp()).post('/api/upload')
      .set('Content-Type', 'multipart/form-data; boundary=boundary').send(body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('upload_incomplete');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('valid multipart continues to accept the complete file', async () => {
    const res = await request(makeApp()).post('/api/upload').attach('file', Buffer.from('complete'), 'image.jpg');
    expect(res.status).toBe(202);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
