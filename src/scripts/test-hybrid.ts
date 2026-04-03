/**
 * Тест гибридного OCR: Google Vision + Claude CLI Analyzer
 *
 * Usage: npm run test:hybrid -- ./path/to/invoice.jpg
 */

import 'dotenv/config';
import fs from 'fs';
import { OcrManager } from '../ocr/ocrManager';
import { analyzeTextWithClaude } from '../ocr/claudeTextAnalyzer';
import { logger } from '../utils/logger';

async function main() {
  const imagePath = process.argv[2];

  if (!imagePath || !fs.existsSync(imagePath)) {
    console.error('Usage: npm run test:hybrid -- ./path/to/invoice.jpg');
    console.error('  Provide a valid path to an invoice image.');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('Testing Hybrid OCR: Google Vision + Claude Analyzer');
  console.log('='.repeat(60));
  console.log(`Input: ${imagePath}`);
  console.log();

  const ocrManager = new OcrManager();

  try {
    // Step 1: Test raw OCR (Google Vision)
    console.log('--- Step 1: Google Vision OCR ---');
    const ocrResult = await ocrManager.recognize(imagePath);
    console.log(`Engine: ${ocrResult.engine}`);
    console.log(`Text length: ${ocrResult.text.length} chars`);
    console.log(`Words with bounding boxes: ${ocrResult.words?.length ?? 0}`);
    console.log();
    console.log('Raw OCR text (first 500 chars):');
    console.log(ocrResult.text.substring(0, 500));
    console.log();

    // Step 2: Test Claude Analyzer
    console.log('--- Step 2: Claude CLI Text Analyzer ---');
    const analyzerResult = await analyzeTextWithClaude(ocrResult.text);

    if (analyzerResult.success && analyzerResult.data) {
      console.log('Claude Analyzer: SUCCESS');
      console.log();
      console.log('Structured data:');
      console.log(JSON.stringify(analyzerResult.data, null, 2));
    } else {
      console.log('Claude Analyzer: FAILED');
      console.log(`Error: ${analyzerResult.error}`);
      if (analyzerResult.rawResponse) {
        console.log('Raw response:');
        console.log(analyzerResult.rawResponse.substring(0, 500));
      }
    }
    console.log();

    // Step 3: Test hybrid method
    console.log('--- Step 3: Hybrid OCR (combined) ---');
    const hybridResult = await ocrManager.recognizeHybrid(imagePath, true);
    console.log(`Engine: ${hybridResult.engine}`);
    console.log(`Has structured data: ${!!hybridResult.structured}`);

    if (hybridResult.structured) {
      console.log();
      console.log('Final structured data:');
      console.log(JSON.stringify(hybridResult.structured, null, 2));
    }

    console.log();
    console.log('='.repeat(60));
    console.log('Test completed!');
    console.log('='.repeat(60));

  } catch (err) {
    console.error('Test failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await ocrManager.terminate();
  }
}

main();
