import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { FileWatcher } from '../../watcher/fileWatcher';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { inboundChannelRepo } from '../../database/repositories/inboundChannelRepo';
import { userRepo } from '../../database/repositories/userRepo';

export const inboundPublicRouter = Router();
export const inboundConfigRouter = Router();

let fileWatcher: FileWatcher;
export function setInboundFileWatcher(value: FileWatcher): void { fileWatcher = value; }

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.pdf']);
const emailUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
});

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secretMatches(value: string, expectedHash: string | null): boolean {
  if (!value || !expectedHash) return false;
  const actual = Buffer.from(digest(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function safeExtension(originalName: string, mimeType?: string): string | null {
  let ext = path.extname(originalName || '').toLowerCase();
  if (!ext && mimeType) {
    const byMime: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
      'image/bmp': '.bmp', 'image/tiff': '.tiff',
      'application/pdf': '.pdf',
    };
    ext = byMime[mimeType] || '';
  }
  return ALLOWED_EXTENSIONS.has(ext) ? ext : null;
}

async function queueBuffer(
  buffer: Buffer,
  originalName: string,
  source: 'telegram' | 'email',
  ownerUserId: number,
  mimeType?: string,
): Promise<string> {
  if (!fileWatcher) throw new Error('FileWatcher not initialized');
  if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) throw new Error('Attachment size must be between 1 byte and 20 MB');
  const ext = safeExtension(originalName, mimeType);
  if (!ext) throw new Error('Only PDF, JPG, PNG, WEBP, BMP and TIFF attachments are supported');
  const fileName = `${source}-${ownerUserId}-${Date.now()}-${randomBytes(4).toString('hex')}${ext}`;
  const filePath = path.join(config.inboxDir, fileName);
  await fs.promises.mkdir(config.inboxDir, { recursive: true });
  await fs.promises.writeFile(filePath, buffer, { flag: 'wx' });
  fileWatcher.markProcessing(filePath);
  void fileWatcher.processFile(filePath, fileName, undefined, {
    source,
    userAgent: source === 'telegram' ? 'Telegram Bot API' : 'Email inbound webhook',
    ownerUserId,
  }).catch(error => logger.error('Inbound document processing failed', {
    source, ownerUserId, fileName, error: (error as Error).message,
  }));
  return fileName;
}

inboundConfigRouter.get('/status', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const [channel, telegram] = await Promise.all([
    inboundChannelRepo.get(userId),
    userRepo.getTelegramConfig(userId),
  ]);
  res.json({ data: {
    telegram_enabled: channel?.telegram_enabled === 1,
    telegram_ready: !!(telegram?.bot_token && telegram?.chat_id),
    email_enabled: channel?.email_enabled === 1,
  } });
});

inboundConfigRouter.post('/telegram/enable', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const telegram = await userRepo.getTelegramConfig(userId);
  if (!telegram?.bot_token || !telegram.chat_id) {
    return res.status(409).json({ error: 'Сначала сохраните токен бота и chat_id в профиле' });
  }
  const secret = randomBytes(24).toString('hex');
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://scanflow.ru').replace(/\/$/, '');
  const webhookUrl = `${baseUrl}/api/inbound/public/telegram/${userId}`;
  const response = await fetch(`https://api.telegram.org/bot${telegram.bot_token}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: webhookUrl, secret_token: secret, allowed_updates: ['message'] }),
  });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
  if (!response.ok || !result.ok) return res.status(502).json({ error: result.description || `Telegram HTTP ${response.status}` });
  await inboundChannelRepo.setTelegram(userId, true, digest(secret));
  res.json({ success: true });
});

inboundConfigRouter.post('/telegram/disable', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const telegram = await userRepo.getTelegramConfig(userId);
  if (telegram?.bot_token) {
    await fetch(`https://api.telegram.org/bot${telegram.bot_token}/deleteWebhook`, { method: 'POST' }).catch(() => null);
  }
  await inboundChannelRepo.setTelegram(userId, false, null);
  res.json({ success: true });
});

inboundConfigRouter.post('/email/enable', async (req: Request, res: Response) => {
  const userId = req.user!.id;
  const secret = randomBytes(32).toString('hex');
  await inboundChannelRepo.setEmail(userId, true, digest(secret));
  const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://scanflow.ru').replace(/\/$/, '');
  res.json({ data: {
    webhook_url: `${baseUrl}/api/inbound/public/email/${userId}`,
    webhook_token: secret,
    note: 'Токен показывается один раз. Передайте его сервису пересылки в заголовке X-Inbound-Token.',
  } });
});

inboundConfigRouter.post('/email/disable', async (req: Request, res: Response) => {
  await inboundChannelRepo.setEmail(req.user!.id, false, null);
  res.json({ success: true });
});

inboundPublicRouter.post('/email/:userId', emailUpload.any(), async (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId)) return res.status(404).json({ error: 'Not found' });
  const channel = await inboundChannelRepo.get(userId);
  const inboundToken = String(req.headers['x-inbound-token'] || '');
  if (channel?.email_enabled !== 1 || !secretMatches(inboundToken, channel.email_secret_hash)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (files.length === 0) return res.status(400).json({ error: 'No supported attachments' });
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const file of files) {
    try {
      accepted.push(await queueBuffer(file.buffer, file.originalname, 'email', userId, file.mimetype));
    } catch (error) {
      rejected.push(`${file.originalname}: ${(error as Error).message}`);
    }
  }
  res.status(accepted.length > 0 ? 202 : 400).json({ accepted, rejected });
});

inboundPublicRouter.post('/telegram/:userId', async (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId)) return res.status(404).json({ error: 'Not found' });
  const channel = await inboundChannelRepo.get(userId);
  const headerSecret = String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if (channel?.telegram_enabled !== 1
      || !secretMatches(headerSecret, channel.telegram_secret_hash)) {
    return res.status(404).json({ error: 'Not found' });
  }
  const updateId = Number(req.body?.update_id);
  if (Number.isInteger(updateId) && !(await inboundChannelRepo.claimTelegramUpdate(userId, updateId))) {
    return res.json({ ok: true, duplicate: true });
  }
  res.json({ ok: true });
  void (async () => {
    const telegram = await userRepo.getTelegramConfig(userId);
    if (!telegram?.bot_token || !telegram.chat_id) return;
    const message = req.body?.message;
    if (!message || String(message.chat?.id) !== String(telegram.chat_id)) return;
    let fileId: string | null = null;
    let fileName = 'telegram.jpg';
    let mimeType = 'image/jpeg';
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      fileId = message.photo[message.photo.length - 1]?.file_id || null;
    } else if (message.document?.file_id && (String(message.document.mime_type || '').startsWith('image/') || message.document.mime_type === 'application/pdf')) {
      fileId = message.document.file_id;
      fileName = message.document.file_name || fileName;
      mimeType = message.document.mime_type || mimeType;
    }
    if (!fileId) return;
    const infoResponse = await fetch(`https://api.telegram.org/bot${telegram.bot_token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const info = await infoResponse.json() as { ok?: boolean; result?: { file_path?: string } };
    if (!info.ok || !info.result?.file_path) throw new Error('Telegram getFile failed');
    const fileResponse = await fetch(`https://api.telegram.org/file/bot${telegram.bot_token}/${info.result.file_path}`);
    if (!fileResponse.ok) throw new Error(`Telegram download HTTP ${fileResponse.status}`);
    const buffer = Buffer.from(await fileResponse.arrayBuffer());
    await queueBuffer(buffer, fileName, 'telegram', userId, mimeType);
  })().catch(error => logger.error('Telegram inbound failed', { userId, error: (error as Error).message }));
});
