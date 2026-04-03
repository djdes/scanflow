import '../config';
import { OcrManager } from '../ocr/ocrManager';

(async () => {
  const mgr = new OcrManager();
  const res = await mgr.recognize(process.argv[2] || './data/inbox/photo_2026-01-30_09-16-55.jpg');
  process.stdout.write('=FULLTEXT=\n');
  process.stdout.write(res.text);
  process.stdout.write('\n=END=\n');
  await mgr.terminate();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
