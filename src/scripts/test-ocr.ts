/**
 * Тест OCR: прогоняет изображение через все движки и сравнивает результаты
 * Использование: npm run test:ocr -- ./path/to/image.jpg
 */
import '../config'; // load .env
import path from 'path';
import { OcrManager } from '../ocr/ocrManager';
import { logger } from '../utils/logger';

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.log('Usage: npm run test:ocr -- <path-to-image.jpg>');
    console.log('Example: npm run test:ocr -- ./data/inbox/test.jpg');
    process.exit(1);
  }

  const fullPath = path.resolve(imagePath);
  console.log(`\n=== OCR Test: ${fullPath} ===\n`);

  const manager = new OcrManager();

  // Test all engines
  console.log('Running all OCR engines...\n');
  const results = await manager.recognizeAll(fullPath);

  for (const [engine, result] of Object.entries(results)) {
    console.log(`--- ${engine} ---`);
    if ('error' in result) {
      console.log(`  ERROR: ${result.error}`);
    } else {
      console.log(`  Text length: ${result.text.length}`);
      if (result.confidence) {
        console.log(`  Confidence: ${result.confidence.toFixed(1)}%`);
      }
      if (result.structured) {
        console.log(`  Structured data available: yes`);
        console.log(`  Items: ${result.structured.items?.length || 0}`);
      }
      console.log(`  Preview: ${result.text.substring(0, 300)}...`);
    }
    console.log('');
  }

  // Test chain (primary → fallback)
  console.log('--- Chain test (primary with fallback) ---');
  try {
    const chainResult = await manager.recognize(fullPath);
    console.log(`  Winner: ${chainResult.engine}`);
    console.log(`  Text length: ${chainResult.text.length}`);
  } catch (err) {
    console.log(`  All engines failed: ${(err as Error).message}`);
  }

  await manager.terminate();
}

main().catch(console.error);
