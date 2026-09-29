import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import multer from 'multer';

vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { terminalErrorHandler } from '../../src/api/middleware/errorHandler';
import { logger } from '../../src/utils/logger';

// Маршруты как в server.ts: параметр пути и SPA-фолбэк /{*splat}. Роутер
// Express 5 раскодирует параметры сам и на мусоре бросает URIError.
function makeApp(): express.Express {
  const app = express();
  app.get('/api/items/:id', (req, res) => { res.json({ id: req.params.id }); });
  app.get('/boom', () => { throw new Error('kaput'); });
  app.get('/too-big', () => { throw new multer.MulterError('LIMIT_FILE_SIZE'); });
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
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(logger.error).toHaveBeenCalledWith('Unhandled request error', { error: 'kaput' });
  });

  it('multer: слишком большой файл — 413', async () => {
    const res = await request(makeApp()).get('/too-big');
    expect(res.status).toBe(413);
  });
});
