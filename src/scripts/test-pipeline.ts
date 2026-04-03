/**
 * Тест полного пайплайна: JPEG → OCR → парсинг → маппинг → JSON
 * Использование: npm run test:pipeline -- ./path/to/image.jpg
 *
 * Env: OCR_FORCE_ENGINE=tesseract для тестирования конкретного движка
 */
import '../config';
import path from 'path';
import { getDb } from '../database/db';
import { OcrManager } from '../ocr/ocrManager';
import { parseInvoiceText } from '../parser/invoiceParser';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.log('Usage: npm run test:pipeline -- <path-to-image.jpg>');
    console.log('Example: npm run test:pipeline -- ./data/inbox/test.jpg');
    console.log('');
    console.log('Force specific OCR engine:');
    console.log('  OCR_FORCE_ENGINE=tesseract npm run test:pipeline -- ./test.jpg');
    console.log('  OCR_FORCE_ENGINE=claude_cli npm run test:pipeline -- ./test.jpg');
    console.log('  OCR_FORCE_ENGINE=google_vision npm run test:pipeline -- ./test.jpg');
    process.exit(1);
  }

  const fullPath = path.resolve(imagePath);
  console.log(`\n=== Full Pipeline Test ===`);
  console.log(`Image: ${fullPath}`);
  console.log(`OCR engine: ${process.env.OCR_FORCE_ENGINE || 'auto (chain)'}\n`);

  // Init
  getDb();
  const ocrManager = new OcrManager();
  const mapper = new NomenclatureMapper();

  // Step 1: OCR
  console.log('[1/3] OCR recognition...');
  const ocrResult = await ocrManager.recognize(fullPath);
  console.log(`  Engine used: ${ocrResult.engine}`);
  console.log(`  Text length: ${ocrResult.text.length}`);
  console.log(`  Text preview: ${ocrResult.text.substring(0, 200)}...\n`);

  // Step 2: Parse
  console.log('[2/3] Parsing invoice...');
  const parsed = parseInvoiceText(ocrResult);
  console.log(`  Invoice #: ${parsed.invoice_number || 'N/A'}`);
  console.log(`  Date: ${parsed.invoice_date || 'N/A'}`);
  console.log(`  Supplier: ${parsed.supplier || 'N/A'}`);
  console.log(`  Total: ${parsed.total_sum || 'N/A'}`);
  console.log(`  Items: ${parsed.items.length}\n`);

  // Step 3: Mapping
  console.log('[3/3] Mapping nomenclature...');
  const mappedItems = parsed.items.map(item => {
    const mapping = mapper.map(item.name);
    return {
      original_name: item.name,
      mapped_name: mapping.mapped_name,
      confidence: mapping.confidence,
      source: mapping.source,
      quantity: item.quantity,
      unit: item.unit,
      price: item.price,
      total: item.total,
    };
  });

  // Final JSON
  const result = {
    invoice_number: parsed.invoice_number,
    invoice_date: parsed.invoice_date,
    supplier: parsed.supplier,
    total_sum: parsed.total_sum,
    ocr_engine: ocrResult.engine,
    items: mappedItems,
  };

  console.log('\n=== Final JSON (ready for 1C) ===');
  console.log(JSON.stringify(result, null, 2));

  await ocrManager.terminate();
}

main().catch(console.error);
