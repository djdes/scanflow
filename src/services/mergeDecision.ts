import { normalizeInvoiceNumber } from '../utils/invoiceNumber';

/**
 * Единая точка решения о склейке многостраничных накладных. Используется обоими
 * путями обработки (watcher и dispatcher), чтобы правило было ровно одно и копии
 * не разъехались.
 */

/**
 * Мердж ЗАПРЕЩЁН, если у ОБЕИХ накладных есть непустой номер и нормализованные
 * номера различаются — это заведомо разные документы.
 *
 * Номер сильнее любой эвристики продолжения (row_no / поставщик / время): в
 * инциденте 2026-07-22 накладные ООО «ОМЕГА ПРИНТ» №287 и №288 случайно подошли
 * под «продолжение по row_no», и combined re-analysis проглотил №288. Разные
 * номера теперь дают жёсткий стоп, какой бы эвристике мердж ни показался.
 *
 * Если хотя бы у одной стороны номера нет — не блокируем: это штатный случай
 * продолжения (номер только на первом листе), его досматривает эвристика row_no.
 */
export function mergeBlockedByNumber(
  a: { invoice_number: string | null | undefined },
  b: { invoice_number: string | null | undefined },
): boolean {
  const na = normalizeInvoiceNumber(a.invoice_number);
  const nb = normalizeInvoiceNumber(b.invoice_number);
  if (!na || !nb) return false;
  return na !== nb;
}

/** Допуск на копейку — цены/НДС в накладных округляются, точное равенство сумм невозможно. */
const SUM_EPSILON = 0.01;

/**
 * Пост-проверка unified-результата: слияние ПРОГЛОТИЛО данные, если объединённый
 * разбор содержит меньше позиций, чем было суммарно на склеиваемых страницах,
 * ИЛИ его сумма меньше максимальной из сумм отдельных страниц.
 *
 * Обоснование порога:
 *  - позиций: настоящая многостраничная даёт объединение всех строк, поэтому
 *    unified.itemCount >= Σ(страницы). Меньше — Claude потерял строку.
 *  - сумма: для настоящей многостраничной итог последней страницы (grand total)
 *    >= суммы любой отдельной страницы, поэтому unified.total >= max(страницы).
 *    Меньше — проглочен целый документ (как №288 = 9000 при unified 8900).
 *
 * true → откат склейки (обе накладные остаются раздельными).
 */
export function mergeLostData(
  pages: Array<{ itemCount: number; totalSum: number | null }>,
  unified: { itemCount: number; totalSum: number | null },
): boolean {
  const sumItems = pages.reduce((acc, p) => acc + p.itemCount, 0);
  if (unified.itemCount < sumItems) return true;

  const maxPageTotal = pages.reduce((acc, p) => Math.max(acc, p.totalSum ?? 0), 0);
  if ((unified.totalSum ?? 0) + SUM_EPSILON < maxPageTotal) return true;

  return false;
}
