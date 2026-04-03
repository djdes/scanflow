import { ParsedInvoiceData, ParsedInvoiceItem, OcrResult } from '../ocr/types';
import { logger } from '../utils/logger';
import { parseTableFromWords } from './positionAwareParser';

const RUSSIAN_MONTHS: Record<string, string> = {
  'января': '01', 'февраля': '02', 'марта': '03', 'апреля': '04',
  'мая': '05', 'июня': '06', 'июля': '07', 'августа': '08',
  'сентября': '09', 'октября': '10', 'ноября': '11', 'декабря': '12',
  'янв': '01', 'фев': '02', 'мар': '03', 'апр': '04',
  'май': '05', 'июн': '06', 'июл': '07', 'авг': '08',
  'сен': '09', 'окт': '10', 'ноя': '11', 'дек': '12',
};

const DATE_PATTERNS = [
  // "от 22 января 2026 г." or "22 января 2026"
  /(?:от\s+)?(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/i,
  /(\d{2})[.\/-](\d{2})[.\/-](\d{4})/,    // DD.MM.YYYY
  /(\d{4})[.\/-](\d{2})[.\/-](\d{2})/,    // YYYY-MM-DD
];

const INVOICE_NUMBER_PATTERNS = [
  /номер\s+документа[^\n]*\n\s*(\S+)/i,                   // ТОРГ-12: Номер документа\n17-0048600
  /(?:счет|счёт|накладная|наклад)[\s\w]*№\s*(\d+)/i,      // Счет на оплату № 94
  /№\s*([A-Za-zА-Яа-я]{1,5}[\-]?\d[\d\-\/]*)/i,          // №ПН-00457
  /№\s+(\d+)/i,                                            // № 94
  /(?:ПН|ТН|УПД)[\s\-]*(\d+[\-\/]?\d*)/i,                 // ПН-00457 (no ТОРГ — it's a form name)
];

// Company name regex: ООО/ИП/etc + name, up to ", ИНН" or end of line
const COMPANY_PATTERN = /((?:ООО|ОАО|ЗАО|АО|ПАО|ИП)\s+.+?)(?:,\s*ИНН|$)/i;

const TOTAL_PATTERNS = [
  /(?:всего\s+к\s+оплате|итого\s+к\s+оплате)[:\s]*(\d[\d\s]*[.,]\d{2})/i,
  /(?:всего\s+наименований\s+\d+.*?на\s+сумму)\s+(\d[\d\s]*[.,]\d{2})/i,
  /(?:итого|всего)[:\s]*\n?\s*(\d[\d\s]*[.,]\d{2})/i,
  /(?:итого|всего)[:\s]*(\d[\d\s]+)\s*(?:руб|₽)?/i,
];

const UNIT_MAP: Record<string, string> = {
  'кг': 'кг', 'кг.': 'кг', 'килограмм': 'кг', 'килогр': 'кг',
  'шт': 'шт', 'шт.': 'шт', 'штук': 'шт', 'штука': 'шт',
  'л': 'л', 'л.': 'л', 'литр': 'л', 'литров': 'л',
  'уп': 'уп', 'уп.': 'уп', 'упак': 'уп', 'упаковка': 'уп', 'упаковок': 'уп',
  'пач': 'уп', 'пачка': 'уп', 'пачек': 'уп',
  'бут': 'шт', 'бутылка': 'шт', 'бутылок': 'шт',
  'банка': 'шт', 'банок': 'шт',
  'пакет': 'шт', 'пакетов': 'шт',
};

function parseNumber(str: string): number | undefined {
  if (!str) return undefined;
  const cleaned = str.replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  return isNaN(num) ? undefined : num;
}

function normalizeDate(match: RegExpMatchArray, patternIndex: number): string | undefined {
  try {
    if (patternIndex === 0) {
      // Russian month: "22 января 2026"
      const day = match[1].padStart(2, '0');
      const monthName = match[2].toLowerCase();
      const month = RUSSIAN_MONTHS[monthName] || '01';
      const year = match[3];
      return `${year}-${month}-${day}`;
    }
    if (match[0].match(/^\d{4}/)) {
      return `${match[1]}-${match[2]}-${match[3]}`;
    }
    const day = match[1];
    const month = match[2];
    const year = match[3];
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  } catch {
    return undefined;
  }
}

function extractDate(text: string): string | undefined {
  for (let i = 0; i < DATE_PATTERNS.length; i++) {
    const match = text.match(DATE_PATTERNS[i]);
    if (match) return normalizeDate(match, i);
  }
  return undefined;
}

function extractInvoiceNumber(text: string): string | undefined {
  for (const pattern of INVOICE_NUMBER_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return undefined;
}

function extractSupplier(text: string): string | undefined {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  const supplierLineIdx = lines.findIndex(l => /поставщик/i.test(l));
  const buyerLineIdx = lines.findIndex(l => /покупатель/i.test(l));

  function findCompany(line: string): string | undefined {
    const m = line.match(COMPANY_PATTERN);
    if (m) {
      let name = m[1].trim().replace(/[«»]/g, '"').replace(/\s+/g, ' ').replace(/[,;]\s*$/, '');
      return name.length > 2 ? name : undefined;
    }
    return undefined;
  }

  if (supplierLineIdx >= 0) {
    // Check if supplier info is on the same line as "Поставщик"
    const onLine = findCompany(lines[supplierLineIdx]);
    if (onLine) return onLine;

    // Search between Поставщик and Покупатель
    const betweenEnd = buyerLineIdx > supplierLineIdx ? buyerLineIdx : Math.min(supplierLineIdx + 10, lines.length);
    for (let i = supplierLineIdx + 1; i < betweenEnd; i++) {
      const found = findCompany(lines[i]);
      if (found) return found;
    }

    // Labels adjacent (column-by-column OCR) — first company after both labels = supplier
    const afterIdx = Math.max(supplierLineIdx, buyerLineIdx >= 0 ? buyerLineIdx : supplierLineIdx) + 1;
    for (let i = afterIdx; i < Math.min(afterIdx + 15, lines.length); i++) {
      const found = findCompany(lines[i]);
      if (found) return found;
    }
  }

  // Fallback: first company before "Покупатель"
  const endLine = buyerLineIdx >= 0 ? buyerLineIdx : lines.length;
  for (let i = 0; i < endLine; i++) {
    const found = findCompany(lines[i]);
    if (found) return found;
  }

  return undefined;
}

function extractTotal(text: string): number | undefined {
  for (const pattern of TOTAL_PATTERNS) {
    const match = text.match(pattern);
    if (match) return parseNumber(match[1]);
  }

  // Fallback for ТОРГ-12: look for "Сумма(руб)" then next large decimal number
  const lines = text.split('\n');
  const summaRubIdx = lines.findIndex(l => /сумма\s*\(?руб/i.test(l.trim()));
  if (summaRubIdx >= 0) {
    for (let i = summaRubIdx + 1; i < Math.min(summaRubIdx + 10, lines.length); i++) {
      const m = lines[i].trim().match(/^(\d[\d\s]*[.,]\d{2})$/);
      if (m) {
        const val = parseNumber(m[1]);
        if (val && val > 100) return val;
      }
    }
  }

  return undefined;
}

function extractUnit(text: string): string {
  const lower = text.toLowerCase().trim();
  for (const [key, value] of Object.entries(UNIT_MAP)) {
    if (lower.includes(key)) return value;
  }
  return 'шт';
}

function extractItems(text: string): ParsedInvoiceItem[] {
  const items: ParsedInvoiceItem[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // Strategy 1: Table-like rows — all data on one line
  // "1  Молоко 3.2% 1л  10  шт  89.90  899.00"
  const tableRowPattern = /^(?:\d+[.\)\s]+)?(.+?)\s+(\d+[.,]?\d*)\s*(кг|шт|л|уп|упак|пач|бут|банк|пакет)?\.?\s+(\d+[.,]?\d+)\s+(\d+[.,]?\d+)\s*$/i;
  const pipeRowPattern = /^(?:\d+[.\)\s]+)?(.+?)\s*[|│]\s*(\d+[.,]?\d*)\s*[|│]\s*(\w+\.?)\s*[|│]\s*(\d+[.,]?\d+)\s*[|│]\s*(\d+[.,]?\d+)/i;

  for (const line of lines) {
    if (/^(наименование|товар|номер|№|п\/п|ед\.?|цена|кол|сумма|итого|всего)/i.test(line)) continue;
    const match = line.match(pipeRowPattern) || line.match(tableRowPattern);
    if (match) {
      const name = match[1].trim();
      const quantity = parseNumber(match[2]);
      const unit = match[3] ? extractUnit(match[3]) : 'шт';
      const price = parseNumber(match[4]);
      const total = parseNumber(match[5]);
      if (name && name.length > 1 && (quantity || price)) {
        items.push({ name, quantity, unit, price, total });
      }
    }
  }

  if (items.length > 0) return items;

  // Strategy 2: Multi-line OCR table parsing
  // OCR from tables often splits columns into separate lines
  logger.debug('Strategy 2: multi-line table parsing');

  // Find table boundaries to avoid false positives from payment/bank sections
  const tableStartIdx = lines.findIndex(l =>
    /товар[ыа]?\s*\(?работ/i.test(l) ||
    /^наим\.?\s*$/i.test(l)               // ТОРГ-12: "Наим." column header
  );
  const tableEndIdx = lines.findIndex((l, idx) =>
    idx > (tableStartIdx >= 0 ? tableStartIdx + 1 : 0) &&
    /^(?:итого|всего\s+(?:наименований|по\s+накладной))/i.test(l)
  );

  const scanStart = tableStartIdx >= 0 ? tableStartIdx + 1 : 0;
  const scanEnd = tableEndIdx >= 0 ? tableEndIdx : lines.length;

  const productNames: Array<{ index: number; name: string }> = [];
  const qtyUnits: Array<{ index: number; qty: number; unit: string }> = [];
  const standaloneQtys: Array<{ index: number; qty: number }> = [];
  const prices: Array<{ index: number; value: number }> = [];

  // Table header keywords to skip (including ТОРГ-12 column headers)
  const skipKeywords = /^(кол|количеств|ед\.?$|цена|сумма|товар|работ|услуг|наименов|наим\.?$|итого|всего|без\s+налог|ставк|ндс|код$|номер|№|лист|набор|мест$|штук|принят|факт|руб|коп|учет|%$|адрес|грузо|основан|рейс|заказ|диспетч)/i;

  for (let i = scanStart; i < scanEnd; i++) {
    const line = lines[i];
    if (skipKeywords.test(line)) continue;

    // Product: "1 Мука (50кг)" or "40-057-11 2 Кальмар..." (with ТОРГ-12 code prefix)
    const productMatch = line.match(/^(?:\d{1,3}-\d{2,3}-\d{2}\s+)?(\d{1,3})\s+(?:\d{4,}\s+)?([А-ЯЁа-яё].{2,})/);
    if (productMatch) {
      let name = productMatch[2].trim().replace(/\s*[|│]\s*\d{4,}\s*$/, ''); // strip trailing article code
      if (name.replace(/[^А-ЯЁа-яё]/g, '').length > 1) {
        productNames.push({ index: i, name });
        continue;
      }
    }

    // Product name on separate line after standalone row number: "2\nСахар (50кг)"
    if (/^[А-ЯЁа-яё]/.test(line) && line.replace(/[^А-ЯЁа-яё]/g, '').length > 1) {
      const prevLine = i > 0 ? lines[i - 1].trim() : '';
      if (/^\d{1,3}$/.test(prevLine)) {
        const name = line.trim().replace(/\s*[|│]\s*\d{4,}\s*$/, '');
        productNames.push({ index: i, name });
        continue;
      }
    }

    // Quantity + unit: "2 шт" or "60 шт" or "5,000 кг" (max 4 integer digits to avoid article codes)
    const qtyMatch = line.match(/^(\d{1,4}(?:[.,]\d+)?)\s+(кг|шт|л|уп|упак|пач|бут)\.?\s*$/i);
    if (qtyMatch) {
      qtyUnits.push({
        index: i,
        qty: parseNumber(qtyMatch[1]) || 0,
        unit: extractUnit(qtyMatch[2]),
      });
      continue;
    }

    // Standalone quantity: just a number like "60" (max 4 digits to avoid article codes)
    if (/^\d{1,4}$/.test(line)) {
      const val = parseInt(line);
      if (val > 0 && val < 10000) {
        standaloneQtys.push({ index: i, qty: val });
        continue;
      }
    }

    // Price/total: "1 900,00" or "30,60"
    const priceMatch = line.match(/^(\d[\d\s]*[.,]\d{2})\s*$/);
    if (priceMatch) {
      const value = parseNumber(priceMatch[1]);
      if (value !== undefined) {
        prices.push({ index: i, value });
      }
    }
  }

  // Also collect prices from the summary section (after table end)
  if (tableEndIdx >= 0) {
    for (let i = tableEndIdx; i < Math.min(tableEndIdx + 20, lines.length); i++) {
      const priceMatch = lines[i].match(/^(\d[\d\s]*[.,]\d{2})\s*$/);
      if (priceMatch) {
        const value = parseNumber(priceMatch[1]);
        if (value !== undefined) {
          prices.push({ index: i, value });
        }
      }
    }
  }

  // Post-processing: detect standalone product names (no row number, common in ТОРГ-12)
  const productIndices = new Set(productNames.map(p => p.index));
  for (let i = scanStart; i < scanEnd; i++) {
    if (productIndices.has(i)) continue;
    const line = lines[i];
    if (skipKeywords.test(line)) continue;

    // Long Cyrillic line with multiple words — likely a standalone product name
    if (/^[А-ЯЁа-яё]/.test(line) && line.length > 15 &&
        /\s/.test(line) &&
        line.replace(/[^А-ЯЁа-яёA-Za-z]/g, '').length > 5) {
      const name = line.replace(/\s*[|│]\s*\d{4,}\s*$/, '').trim();
      if (name.replace(/[^А-ЯЁа-яё]/g, '').length > 3) {
        productNames.push({ index: i, name });
        productIndices.add(i);
      }
    }
  }

  // Sort products by line index (standalone products may have been added out of order)
  productNames.sort((a, b) => a.index - b.index);

  // Merge continuation lines: short Cyrillic text immediately after a product name
  const unitOnly = /^(кг|шт|л|уп|упак|пач|бут)\.?\s*$/i;
  for (const product of productNames) {
    const nextIdx = product.index + 1;
    if (nextIdx < scanEnd && !productIndices.has(nextIdx)) {
      const nextLine = lines[nextIdx].trim();
      if (/^[А-ЯЁа-яё]/.test(nextLine) && nextLine.length <= 20 &&
          !skipKeywords.test(nextLine) && !unitOnly.test(nextLine) &&
          nextLine.replace(/[^А-ЯЁа-яё]/g, '').length > 0) {
        product.name += ' ' + nextLine;
      }
    }
  }

  logger.debug('Multi-line parsing results', {
    products: productNames.length,
    qtyUnits: qtyUnits.length,
    standaloneQtys: standaloneQtys.length,
    prices: prices.length,
  });

  // Step 1: Build items — associate qty/unit by proximity
  for (let p = 0; p < productNames.length; p++) {
    const product = productNames[p];
    const item: ParsedInvoiceItem = { name: product.name };

    const nextProductIndex = p + 1 < productNames.length ? productNames[p + 1].index : scanEnd;

    // Try qty+unit first, then standalone qty
    const nearestQty = qtyUnits.find(q => q.index > product.index && q.index < nextProductIndex);
    if (nearestQty) {
      item.quantity = nearestQty.qty;
      item.unit = nearestQty.unit;
    } else {
      const nearestStandaloneQty = standaloneQtys.find(q => q.index > product.index && q.index < nextProductIndex);
      if (nearestStandaloneQty) {
        item.quantity = nearestStandaloneQty.qty;
        item.unit = 'шт';
      }
    }

    items.push(item);
  }

  // Step 2: Assign prices — detect if proximity or sequential assignment is needed
  if (productNames.length > 0 && prices.length > 0) {
    const firstProductIdx = productNames[0].index;
    const lastProductIdx = productNames[productNames.length - 1].index;

    // Check if any prices fall between first and last product (row-by-row OCR)
    const pricesBetweenProducts = productNames.length > 1
      ? prices.filter(pr => pr.index > firstProductIdx && pr.index < lastProductIdx)
      : prices.filter(pr => pr.index > firstProductIdx && pr.index < scanEnd);

    if (pricesBetweenProducts.length > 0) {
      // Row-by-row: assign prices by proximity to each product
      logger.debug('Prices interspersed with products — using proximity assignment');
      for (let p = 0; p < items.length; p++) {
        const product = productNames[p];
        const nextProductIndex = p + 1 < productNames.length ? productNames[p + 1].index : scanEnd;
        const relevantPrices = prices.filter(pr =>
          pr.index > product.index && pr.index < nextProductIndex
        );
        if (relevantPrices.length >= 2) {
          items[p].price = relevantPrices[0].value;
          items[p].total = relevantPrices[1].value;
        } else if (relevantPrices.length === 1) {
          items[p].price = relevantPrices[0].value;
        }
      }
    } else {
      // Column-by-column: all prices come after all products, split at "Итого" line
      logger.debug('Prices after all products — using sequential assignment');
      const pricesAfterProducts = prices.filter(pr => pr.index > lastProductIdx);
      const itogoLineIdx = lines.findIndex((l, idx) => idx > lastProductIdx && /^итого/i.test(l));

      if (itogoLineIdx >= 0) {
        const unitPrices = pricesAfterProducts.filter(pr => pr.index < itogoLineIdx);
        const postItogoPrices = pricesAfterProducts.filter(pr => pr.index > itogoLineIdx);
        for (let p = 0; p < items.length; p++) {
          if (p < unitPrices.length) items[p].price = unitPrices[p].value;
          if (p < postItogoPrices.length) items[p].total = postItogoPrices[p].value;
        }
      } else {
        if (pricesAfterProducts.length >= 2 * items.length) {
          for (let p = 0; p < items.length; p++) {
            items[p].price = pricesAfterProducts[p].value;
            items[p].total = pricesAfterProducts[items.length + p].value;
          }
        } else {
          for (let p = 0; p < items.length && p < pricesAfterProducts.length; p++) {
            items[p].total = pricesAfterProducts[p].value;
          }
        }
      }
    }

    // Cross-validate: compute/fix total from qty × price
    for (const item of items) {
      if (item.quantity && item.price) {
        const computed = Math.round(item.quantity * item.price * 100) / 100;
        if (!item.total || Math.abs(computed - item.total) > 1) {
          item.total = computed;
        }
      }
      if (item.quantity && item.total && !item.price) {
        item.price = Math.round((item.total / item.quantity) * 100) / 100;
      }
    }
  }

  if (items.length > 0) return items;

  // Strategy 3: Look for "qty x price = total" patterns
  const multiplyPattern = /(\d+[.,]?\d*)\s*(кг|шт|л|уп|упак)?\.?\s*[xх×*]\s*(\d+[.,]?\d+)\s*=?\s*(\d+[.,]?\d+)?/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const numMatch = line.match(multiplyPattern);
    if (numMatch) {
      const nameLine = i > 0 ? lines[i - 1] : '';
      const name = nameLine.replace(/^\d+[.\)\s]+/, '').trim() || line.split(/\d/)[0].trim();
      if (name && name.length > 1) {
        items.push({
          name,
          quantity: parseNumber(numMatch[1]),
          unit: numMatch[2] ? extractUnit(numMatch[2]) : 'шт',
          price: parseNumber(numMatch[3]),
          total: parseNumber(numMatch[4]),
        });
      }
    }
  }

  return items;
}

export function parseInvoiceText(ocrResult: OcrResult): ParsedInvoiceData {
  if (ocrResult.structured) {
    logger.info('Using structured data from OCR engine');
    return ocrResult.structured;
  }

  const text = ocrResult.text;
  logger.info('Parsing invoice from raw text', { textLength: text.length });

  // Try position-aware parser first if bounding boxes are available
  let items: ParsedInvoiceItem[] = [];
  if (ocrResult.words && ocrResult.words.length > 0) {
    logger.info('Trying position-aware parser (bounding boxes available)');
    items = parseTableFromWords(ocrResult.words);
    if (items.length > 0) {
      logger.info('Position-aware parser succeeded', { itemsCount: items.length });
    } else {
      logger.warn('Position-aware parser found no items, falling back to text-based parser');
    }
  }

  // Fallback to text-based parser if position-aware failed
  if (items.length === 0) {
    items = extractItems(text);
  }

  const data: ParsedInvoiceData = {
    invoice_number: extractInvoiceNumber(text),
    invoice_date: extractDate(text),
    supplier: extractSupplier(text),
    total_sum: extractTotal(text),
    items,
  };

  logger.info('Invoice parsed', {
    invoice_number: data.invoice_number,
    invoice_date: data.invoice_date,
    supplier: data.supplier,
    total_sum: data.total_sum,
    itemsCount: data.items.length,
  });

  if (data.total_sum && data.items.length > 0) {
    const itemsTotal = data.items.reduce((sum, item) => sum + (item.total || 0), 0);
    if (itemsTotal > 0 && Math.abs(itemsTotal - data.total_sum) > 1) {
      logger.warn('Invoice validation: items total does not match invoice total', {
        itemsTotal,
        invoiceTotal: data.total_sum,
        diff: Math.abs(itemsTotal - data.total_sum),
      });
    }
  }

  return data;
}
