// Where an invoice photo came from, recorded for the «История» tab.
//   'web'    — uploaded from the dashboard (POST /api/upload, no filename query)
//   'camera' — mobile camera page (POST /api/upload?filename=photo_<ts>_<id>.<ext>)
//   'inbox'  — dropped straight into data/inbox/ (watcher pickup, no HTTP request)
//   'telegram' / 'email' — authenticated inbound channel webhooks
export type UploadSource = 'web' | 'camera' | 'inbox' | 'telegram' | 'email';

// Same pattern the upload route's multer filename guard uses to accept the
// camera page's custom name (see src/api/routes/upload.ts).
const CAMERA_FILENAME_RE = /^photo_\d+_[\w-]+\.\w+$/;

/**
 * Infer the upload source from the optional `?filename=` query the client sent.
 * The mobile camera page sends a `photo_<ts>_<id>.<ext>` name; the dashboard
 * sends nothing. Inbox pickups never reach this code (no HTTP request).
 */
export function inferUploadSource(filenameQuery: string | undefined | null): UploadSource {
  if (filenameQuery && CAMERA_FILENAME_RE.test(filenameQuery)) return 'camera';
  return 'web';
}
