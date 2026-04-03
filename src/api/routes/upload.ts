import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import { config } from '../../config';
import { FileWatcher } from '../../watcher/fileWatcher';
import { logger } from '../../utils/logger';

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
  logger.info('File uploaded via API', { fileName, originalName: req.file.originalname, forceEngine });

  // Prevent file watcher from also processing this file
  fileWatcher.markProcessing(filePath);

  try {
    const invoiceId = await fileWatcher.processFile(filePath, fileName, forceEngine);
    res.json({ message: 'Invoice processed', invoice_id: invoiceId });
  } catch (err) {
    res.status(500).json({ error: 'Processing failed', details: (err as Error).message });
  }
});

export default router;
