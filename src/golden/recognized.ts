/**
 * Ответ модели → документ той же формы, что и «правда» эталона (GoldenDoc).
 *
 * Чистая функция. Повторяет ДЕТЕРМИНИРОВАННУЮ часть конвейера, через которую
 * распознанная строка проходит до записи в invoice_items (порядок как в
 * fileWatcher.processFile / reprocessInvoice):
 *   1. sanitizeInvoiceVat      — строки «без НДС» при итоге «с НДС» → масштаб;
 *   2. sanitizeItemVatPerItem  — точечная починка строк, взятых из колонки «без НДС»;
 *   3. sanitizeItemArithmetic  — qty × price ≈ total (правило 3 CLAUDE.md);
 *   строки без названия пропускаются (конвейер их тоже не сохраняет).
 * Функции санитайзеров — настоящие, из src/parser/itemSanitizer, поэтому
 * регрессия в них тоже покажется в прогоне эталонов.
 *
 * Шапка: номер, дата и ИНН — как прочитала модель. Сумма и НДС доводятся тем
 * же правилом, что invoiceRepo.recalculateTotal: сумма документа, если она
 * есть и есть строки, иначе Σ строк; НДС — напечатанный, если он правдоподобен
 * для этой суммы (isStatedVatConsistent), иначе из ставок строк (deriveVatSum),
 * а если вывести не из чего — напечатанный как есть.
 *
 * НЕ применяется намеренно:
 *   - пересчёт единиц/упаковок — эталон сравнивает строки «как в накладной»;
 *   - выученные исправления OCR (ocr_correction_cards) — это данные компании,
 *     а не качество распознавания, и их apply() пишет last_used_at;
 *   - привязка поставщика по справочнику и сопоставление с 1С.
 */
import type { ParsedInvoiceData } from '../ocr/types';
import {
  sanitizeInvoiceVat,
  sanitizeItemVatPerItem,
  sanitizeItemArithmetic,
  deriveVatSum,
  isStatedVatConsistent,
} from '../parser/itemSanitizer';
import { toNumber, toText, type GoldenDoc, type GoldenLine } from './compare';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function recognizedFromParsed(parsed: ParsedInvoiceData): GoldenDoc {
  const items = Array.isArray(parsed.items) ? parsed.items.filter(it => it != null && typeof it === 'object') : [];
  const docTotal = toNumber(parsed.total_sum);
  const statedVat = toNumber(parsed.vat_sum);

  const vatSanity = sanitizeInvoiceVat(
    items.map(i => ({ quantity: i.quantity, unit: i.unit, price: i.price, total: i.total })),
    docTotal,
    statedVat,
  );
  const perItemVat = sanitizeItemVatPerItem(
    vatSanity.items.map((i, k) => ({
      quantity: i.quantity, unit: i.unit, price: i.price, total: i.total,
      vat_rate: items[k]?.vat_rate,
    })),
    docTotal,
  );

  const lines: GoldenLine[] = [];
  const rated: Array<{ total: number | null; vat_rate: number | null }> = [];
  items.forEach((orig, k) => {
    if (!orig.name) return;
    const sane = sanitizeItemArithmetic({
      quantity: orig.quantity,
      unit: orig.unit,
      price: perItemVat.items[k]?.price ?? orig.price,
      total: perItemVat.items[k]?.total ?? orig.total,
    }).item;
    const line: GoldenLine = {
      quantity: toNumber(sane.quantity),
      unit: toText(sane.unit),
      price: toNumber(sane.price),
      total: toNumber(sane.total),
    };
    lines.push(line);
    rated.push({ total: line.total, vat_rate: toNumber(orig.vat_rate) });
  });

  // invoiceRepo.recalculateTotal: итог документа, только если он есть И есть строки.
  const itemsTotal = lines.reduce((s, l) => s + (l.total ?? 0), 0);
  const totalSum = docTotal != null && docTotal > 0 && itemsTotal > 0 ? docTotal : round2(itemsTotal);
  const finalVat = isStatedVatConsistent(statedVat, totalSum) ? statedVat : deriveVatSum(rated);
  const vatSum = finalVat != null ? finalVat : statedVat;

  return {
    invoice_number: toText(parsed.invoice_number),
    invoice_date: toText(parsed.invoice_date),
    total_sum: totalSum,
    vat_sum: vatSum,
    supplier_inn: toText(parsed.supplier_inn),
    items: lines,
  };
}
