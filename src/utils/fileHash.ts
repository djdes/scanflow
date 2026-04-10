import { createHash } from 'crypto';
import { readFileSync } from 'fs';

/**
 * Calculate SHA-256 hash of a file's contents.
 * Used to detect duplicate uploads regardless of filename.
 */
export function sha256File(filePath: string): string {
  const buffer = readFileSync(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}
