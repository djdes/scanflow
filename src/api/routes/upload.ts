import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { config } from '../../config';
import { FileWatcher } from '../../watcher/fileWatcher';
import { logger } from '../../utils/logger';
import { inferUploadSource } from '../../utils/uploadSource';
import { isXmlMimeType } from '../../xml';
import { enqueueRecognitionFile } from '../../services/recognitionQueue';

const router = Router();
let fileWatcher: FileWatcher;

export function setFileWatcher(fw: FileWatcher): void {
  fileWatcher = fw;
}

// .xml — электронные УПД/счёт-фактуры/ТОРГ-12 из ЭДО (формат ФНС, src/xml):
// разбираются без распознавания, дальше — тот же конвейер, что у фото.
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp', '.pdf', '.xml'];

/**
 * Расширение, под которым файл ляжет в inbox/ (оно же решает, как его
 * обрабатывать), или null — файл не принимается. Расширение — из имени; XML
 * без расширения (или с чужим) узнаём по MIME application/xml, text/xml.
 */
export function uploadExtension(originalName: string, mimeType?: string | null): string | null {
  const ext = path.extname(originalName || '').toLowerCase();
  if (ALLOWED_EXTENSIONS.includes(ext)) return ext;
  if (isXmlMimeType(mimeType)) return '.xml';
  return null;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.inboxDir);
  },
  filename: (req, file, cb) => {
    // Owner survives a crash between saving the photo and committing its queue receipt.
    // Never reuse a client filename: a retry must not overwrite an unprocessed photo.
    const ext = uploadExtension(file.originalname, file.mimetype) ?? path.extname(file.originalname);
    cb(null, `upload-${req.user!.id}-${Date.now()}-${randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (uploadExtension(file.originalname, file.mimetype)) {
      cb(null, true);
    } else {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`));
    }
  },
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB
  },
});

// POST /api/upload — upload JPEG manually
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  const filePath = req.file.path;
  const fileName = req.file.filename;
  const forceEngine = typeof req.query.engine === 'string' ? req.query.engine : undefined;
  const uploadSource = inferUploadSource(req.query.filename as string | undefined);
  const userAgent = ((req.headers['user-agent'] as string | undefined) ?? '').slice(0, 512) || null;
  logger.info('File uploaded via API', { fileName, originalName: req.file.originalname, forceEngine });

  // Prevent file watcher from also processing this file
  fileWatcher.markProcessing(filePath);

  try {
    const job = await enqueueRecognitionFile(filePath, fileName, forceEngine, {
      source: uploadSource, userAgent, ownerUserId: req.user?.id ?? null,
    }, req.file.originalname);
    res.status(202).json({ message: 'Фотография сохранена в постоянной очереди', job_id: job.id,
      file_name: job.file_name, invoice_id: job.invoice_id, queued: job.state !== 'completed' });
  } catch (error) {
    logger.error('Could not persist upload receipt', { fileName, error: (error as Error).message });
    res.status(503).json({ error: 'Не удалось подтвердить сохранение задания. Фото оставлено для повторной отправки' });
  } finally { fileWatcher.unmarkProcessing(filePath); }
});

export default router;
