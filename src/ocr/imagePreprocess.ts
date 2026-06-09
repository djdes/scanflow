import sharp from 'sharp';
import fs from 'fs';
import { logger } from '../utils/logger';

/**
 * Pre-OCR image enhancement (Phase 1): make fine print survive the Claude image
 * API's internal downscaling (~1.15 MP). Conservative + non-destructive:
 *   1. trim uniform margins — ONLY if it removes a sensible amount and doesn't
 *      wreck the aspect ratio (guard against cropping into the document)
 *   2. normalise (contrast stretch) so faint/thin text gets crisper
 *   3. sharpen (edge contrast)
 *
 * NB: we deliberately do NOT auto-orient (.rotate()) — the current pipeline
 * serves raw pixels (already upright) and applying a misleading EXIF tag could
 * rotate an already-correct image sideways. Orientation stays exactly as today.
 *
 * NEVER throws and NEVER returns empty: on any sharp error, or if the trim guard
 * rejects, it falls back to the original bytes. Preprocessing must not break OCR.
 *
 * Returns the enhanced JPEG buffer (or the original bytes on failure).
 */
export async function preprocessInvoiceImage(input: Buffer | string): Promise<Buffer> {
  const original: Buffer = Buffer.isBuffer(input) ? input : await fs.promises.readFile(input);
  try {
    const meta = await sharp(original, { failOn: 'none' }).metadata();
    const w0 = meta.width ?? 0;
    const h0 = meta.height ?? 0;

    // Decide whether to use a trimmed (margin-cropped) version.
    let body = sharp(original, { failOn: 'none' });
    if (w0 > 0 && h0 > 0) {
      try {
        const t = await sharp(original, { failOn: 'none' })
          .trim({ threshold: 20 })
          .toBuffer({ resolveWithObject: true });
        const tw = t.info.width;
        const th = t.info.height;
        const areaRatio = (tw * th) / (w0 * h0);
        const arOrig = w0 / h0;
        const arTrim = tw / th;
        const aspectOk = Math.abs(arTrim / arOrig - 1) < 0.6;
        // Accept the trim only if it removed margins (area < ~99%) but kept the
        // bulk of the document (area >= 50%) and didn't distort the shape.
        if (areaRatio >= 0.5 && areaRatio < 0.99 && aspectOk) {
          body = sharp(t.data, { failOn: 'none' });
        }
      } catch {
        /* trim unsupported / failed — keep untrimmed body */
      }
    }

    const out = await body
      .normalise()
      .sharpen()
      .jpeg({ quality: 90 })
      .toBuffer();

    // Guard against a degenerate/empty result.
    if (!out || out.length < 1000) return original;
    return out;
  } catch (err) {
    logger.warn('preprocessInvoiceImage failed, using original image', { error: (err as Error).message });
    return original;
  }
}
