import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { config } from '../../config';
import { FileWatcher } from '../../watcher/fileWatcher';
import { logger } from '../../utils/logger';
import { inferUploadSource } from '../../utils/uploadSource';

const router = Router();
let fileWatcher: FileWatcher;

export function setFileWatcher(fw: FileWatcher): void {
  fileWatcher = fw;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.inboxDir);
  },
  filename: (req, file, cb) => {
    // Allow custom filename via query param (used by mobile camera page for multi-page merge)
    const customName = req.query.filename as string | undefined;
    if (customName && /^photo_\d+_[\w-]+\.\w+$/.test(customName)) {
      cb(null, customName);
    } else {
      const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      const ext = path.extname(file.originalname);
      cb(null, `upload-${uniqueSuffix}${ext}`);
    }
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
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
  const forceEngine = req.query.engine as string | undefined;
  const uploadSource = inferUploadSource(req.query.filename as string | undefined);
  const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;
  logger.info('File uploaded via API', { fileName, originalName: req.file.originalname, forceEngine });

  // Prevent file watcher from also processing this file
  fileWatcher.markProcessing(filePath);

  // Fire-and-forget: client gets a fast 202 with the file_name and polls
  // GET /api/invoices?file_name=X until the invoice row appears (watcher
  // INSERTs it within 1-2s of starting). Synchronous await on processFile
  // would block for OCR+Claude+possible multi-page merge (60s+), causing
  // nginx upstream timeout → 502 на клиенте при загрузке нескольких подряд.
  void (async () => {
    try {
      await fileWatcher.processFile(filePath, fileName, forceEngine, {
        source: uploadSource,
        userAgent,
      });
    } catch (err) {
      logger.error('Background processFile failed', {
        fileName, error: (err as Error).message,
      });
    }
  })();

  res.status(202).json({
    message: 'Invoice queued for processing',
    file_name: fileName,
  });
});

export default router;
