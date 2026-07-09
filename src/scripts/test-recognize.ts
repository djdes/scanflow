/**
 * DEV-ХАРНЕСС для проверки качества распознавания на claude_api-пути
 * (structured outputs + adaptive thinking + серверная валидация + repair).
 * НЕ трогает БД накладных — только читает analyzer_config/catalog и гоняет OCR.
 *
 *   npx ts-node src/scripts/test-recognize.ts <photo1> [photo2 ...]
 *
 * КАЖДЫЙ путь распознаётся ОТДЕЛЬНО через recognizeWithClaudeApi — ровно как в
 * проде (watcher обрабатывает каждую загруженную фотку по-странично, а страницы
 * многостраничной накладной сшивает уже на уровне БД через analyzeMultiPageText).
 */
import '../config';
import { initDb, closeDb } from '../database/db';
import { OcrManager } from '../ocr/ocrManager';
import { validateParsedInvoice } from '../ocr/invoiceValidator';
import type { ParsedInvoiceData } from '../ocr/types';

function recap(d: ParsedInvoiceData): void {
  console.log('\n--- ПОЛЯ ШАПКИ ---');
  console.log(`  type=${d.invoice_type} № ${d.invoice_number} date=${d.invoice_date}`);
  console.log(`  supplier="${d.supplier}" INN=${d.supplier_inn} KPP=${d.supplier_kpp}`);
  if (d.supplier_bik || d.supplier_account || d.supplier_corr_account || d.supplier_address) {
    console.log(`  БИК=${d.supplier_bik} р/с=${d.supplier_account} к/с=${d.supplier_corr_account}`);
    console.log(`  адрес="${d.supplier_address}"`);
  }
  console.log(`  total_sum=${d.total_sum} vat_sum=${d.vat_sum}`);
  console.log(`\n--- ПОЗИЦИИ (${d.items?.length ?? 0}) ---`);
  for (const it of d.items ?? []) {
    const calc = (Number(it.quantity) || 0) * (Number(it.price) || 0);
    const ok = it.total != null && Math.abs(calc - Number(it.total)) / Math.max(Math.abs(Number(it.total)), 1) <= 0.01 ? 'ok' : '⚠';
    console.log(`  ${it.row_no ?? '?'}. "${it.name}" | qty=${it.quantity} ${it.unit} | price=${it.price} | total=${it.total} | vat=${it.vat_rate} | pack=${it.pack_size ?? '-'} | q*p=${calc.toFixed(2)} ${ok}`);
  }
  const sum = (d.items ?? []).reduce((a, it) => a + (Number(it.total) || 0), 0);
  console.log(`\n  Σ items.total = ${sum.toFixed(2)}  |  total_sum = ${d.total_sum}  |  Δ = ${(sum - Number(d.total_sum || 0)).toFixed(2)}`);
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2);
  if (!paths.length) { console.log('usage: test-recognize <photo1> [photo2 ...]'); process.exit(1); }

  await initDb();
  const ocr = new OcrManager();

  const pageTexts: string[] = [];
  for (let i = 0; i < paths.length; i++) {
    console.log(`\n############ СТРАНИЦА ${i + 1}/${paths.length}: ${paths[i]} ############`);
    const t0 = Date.now();
    const result = await ocr.recognizeWithClaudeApi(paths[i]);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`=== engine: ${result.engine}  (${dt}s) ===`);
    pageTexts.push(result.text);
    const d = result.structured;
    if (!d) {
      console.log('НЕТ structured результата. text:', (result.text || '').slice(0, 400));
      continue;
    }
    recap(d);
    const issues = validateParsedInvoice(d);
    console.log(`\n=== ВАЛИДАТОР: ${issues.length} issue(s) ===`);
    for (const iss of issues) console.log(`  [${iss.code}]${iss.rowNo != null ? ' row ' + iss.rowNo : ''}: ${iss.message}`);
  }

  // Многостраничная сшивка — ровно как reprocessInvoice/processFile: объединённый
  // текст страниц → analyzeMultiPageText → единый результат.
  if (pageTexts.length > 1) {
    console.log(`\n============ СШИВКА ${pageTexts.length} СТРАНИЦ (analyzeMultiPageText) ============`);
    const combined = pageTexts.join('\n\n--- СТРАНИЦА ---\n\n');
    const t0 = Date.now();
    const merged = await ocr.analyzeMultiPageText(combined, pageTexts.length);
    console.log(`=== engine: ${merged.engine}  (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
    if (merged.structured) {
      recap(merged.structured);
      const issues = validateParsedInvoice(merged.structured);
      console.log(`\n=== ВАЛИДАТОР (сшивка): ${issues.length} issue(s) ===`);
      for (const iss of issues) console.log(`  [${iss.code}]${iss.rowNo != null ? ' row ' + iss.rowNo : ''}: ${iss.message}`);
    } else {
      console.log('СШИВКА НЕ ДАЛА structured результата.');
    }
  }

  await ocr.terminate();
  await closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
