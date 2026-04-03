/**
 * Тест парсера: парсит текст или файл как накладную
 * Использование: npm run test:parse -- <path-to-text-file-or-image>
 * Или без аргументов — использует тестовый текст
 */
import '../config';
import fs from 'fs';
import path from 'path';
import { parseInvoiceText } from '../parser/invoiceParser';
import { OcrResult } from '../ocr/types';

const SAMPLE_TEXT = `
ПРИХОДНАЯ НАКЛАДНАЯ №ПН-00457 от 30.01.2026

Поставщик: ООО "Молочный край"
ИНН: 7712345678

№  Наименование             Кол-во  Ед.  Цена    Сумма
1  Молоко 3.2% 1л           10      шт   89.90   899.00
2  Сметана 20% 400г         5       шт   125.00  625.00
3  Творог 9% 200г           8       шт   95.50   764.00
4  Масло сливочное 82.5%    3       кг   850.00  2550.00
5  Кефир 1% 1л              12      шт   75.00   900.00

Итого: 5738.00
`;

async function main(): Promise<void> {
  let text = SAMPLE_TEXT;

  const arg = process.argv[2];
  if (arg) {
    const fullPath = path.resolve(arg);
    if (fs.existsSync(fullPath)) {
      text = fs.readFileSync(fullPath, 'utf-8');
      console.log(`Loaded text from: ${fullPath}\n`);
    } else {
      console.log(`File not found: ${fullPath}, using sample text\n`);
    }
  } else {
    console.log('Using sample invoice text (pass file path as argument to use your own)\n');
  }

  console.log('=== Input text ===');
  console.log(text.substring(0, 500));
  console.log('');

  const ocrResult: OcrResult = { text, engine: 'test' };
  const parsed = parseInvoiceText(ocrResult);

  console.log('=== Parsed result ===');
  console.log(JSON.stringify(parsed, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Invoice number: ${parsed.invoice_number || 'N/A'}`);
  console.log(`Date: ${parsed.invoice_date || 'N/A'}`);
  console.log(`Supplier: ${parsed.supplier || 'N/A'}`);
  console.log(`Total sum: ${parsed.total_sum || 'N/A'}`);
  console.log(`Items found: ${parsed.items.length}`);

  if (parsed.items.length > 0) {
    console.log('\nItems:');
    parsed.items.forEach((item, i) => {
      console.log(`  ${i + 1}. ${item.name} | ${item.quantity || '?'} ${item.unit || '?'} | ${item.price || '?'} | ${item.total || '?'}`);
    });
  }
}

main().catch(console.error);
