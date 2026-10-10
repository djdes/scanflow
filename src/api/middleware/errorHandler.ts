import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { logger } from '../../utils/logger';

/**
 * Мусорный URL: роутер Express 5 не смог раскодировать параметр пути
 * (сканеры шлют `/%c0%ae%c0%ae/…`) и бросил URIError «Failed to decode param».
 * Это ошибка клиента, а не сервера.
 */
function isUndecodableUrl(err: unknown): boolean {
  return err instanceof URIError || /Failed to decode param/i.test((err as Error)?.message ?? '');
}

function isIncompleteMultipart(err: unknown, req: Request): boolean {
  return /^multipart\/form-data\b/i.test(req.headers['content-type'] ?? '')
    && /^(Unexpected end of form|Unexpected end of file|Malformed part header|Multipart: Boundary not found)$/.test((err as Error)?.message ?? '');
}

/**
 * Terminal error handler (must be the LAST app.use). Without it, multer
 * rejections (file too large / unsupported type) and any other thrown error
 * fall through to Express's default HTML 500; map them to clean JSON instead.
 * headersSent guard preserves already-streaming responses (e.g. photo serving).
 */
export function terminalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: err.message });
    return;
  }
  if (isIncompleteMultipart(err, req)) {
    logger.warn('Incomplete multipart upload', {
      method: req.method,
      path: String(req.originalUrl ?? '').split('?')[0].slice(0, 200),
      error: (err as Error).message,
      content_length: req.headers['content-length'] ?? null,
      user_agent: String(req.headers['user-agent'] ?? '').slice(0, 256),
    });
    res.status(400).json({
      code: 'upload_incomplete',
      error: 'Файл не передан полностью. Нажмите «Повторить». Если ошибка повторяется, выберите фото заново.',
    });
    return;
  }
  if (isUndecodableUrl(err)) {
    // 400 и warn: error-лог (и письма по нему) — для сбоев сервера, а не для
    // чужих сканеров (п.20).
    logger.warn('Bad request: undecodable URL', {
      method: req.method,
      path: String(req.originalUrl ?? '').slice(0, 200),
      error: (err as Error).message,
    });
    res.status(400).json({ error: 'Bad request' });
    return;
  }
  if (err) {
    logger.error('Unhandled request error', { error: (err as Error).message });
    res.status(500).json({ error: 'Internal server error' });
    return;
  }
  next();
}
