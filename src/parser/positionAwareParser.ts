import { OcrWord } from '../ocr/types';
import { ParsedInvoiceItem } from '../ocr/types';
import { logger } from '../utils/logger';

/**
 * Position-aware table parser for invoice images.
 *
 * Handles two OCR patterns:
 * 1. Row-by-row: words in each table row have similar Y coordinates
 * 2. Column-by-column: words in each column have similar Y (Google Vision on certain layouts)
 *
 * Detection: if grouping by Y yields very few rows relative to word count,
 * switch to column-by-column parsing.
 */

// Patterns to identify skip sections (matched against combined text)
const SKIP_SECTION_PATTERNS = [
  /образец.*заполнения/i,
  /платеж.*поручени/i,
  /банк.*получател/i,
  /назначение.*платеж/i,
  /р\/с\s*поставщик/i,
  /уведомление.*оплат/i,
  /товар.*отпускается/i,
  /гарантируется.*наличие/i,
  /доверенност.*паспорт/i,
];

// Skip individual words (table headers, metadata)
// Note: \w doesn't match Cyrillic, so use .* for suffix matching
const SKIP_WORDS = /^(№|No|п\/п|кол[\.\-]?во|кол$|количеств.*|ед\.?$|ед\.\s*изм.*|цена|сумма|наименован.*|наим\.?$|всего|ндс|ставк.*|код$|номер|артикул|примечан.*|работ|услуг)$/i;

// Product row number pattern
const ROW_NUMBER_PATTERN = /^(\d{1,2})$/;

// Number patterns
const QTY_UNIT_PATTERN = /^(\d{1,4}(?:[.,]\d+)?)\s*(кг|шт|л|уп|упак|пач|бут)\.?$/i;
const STANDALONE_QTY_PATTERN = /^\d{1,4}(?:[.,]\d+)?$/;
const PRICE_PATTERN = /^(\d{1,3}(?:\s?\d{3})*[.,]\d{2})$/;
const UNIT_PATTERN = /^(кг|шт|л|уп|упак|пач|бут)\.?$/i;

// Skip these as product names
// Note: \w doesn't match Cyrillic, so use .* for suffix matching
const NAME_BLACKLIST = /^(товары?|работы?|услуги?|итого|всего|банк|инн|кпп|бик|получател.*|поставщик.*|покупател.*|образец|платеж.*|поручени.*|назначение|оплат.*|уведомлен.*|наименован.*|количеств.*|кол[\.\-]?во|\d+)$/i;

// Garbage text patterns (disclaimer text that shouldn't be products)
const GARBAGE_TEXT_PATTERNS = [
  /гарантируется/i,
  /указанного.*счете/i,
  /импортный.*товар/i,
  /фиксируется.*дату/i,
  /к\s*оплате.*рубл/i,
  /тысяч[иа]?\s+(пятьсот|шестьсот|семьсот)/i,
  /копе[йе]к[иа]?/i,
];

// Product code pattern (e.g., ПОС32469, Пос51366)
const PRODUCT_CODE_PATTERN = /^(ПОС|Пос|пос)\d{5}/i;

interface Column {
  x: number;
  xMax: number;
  words: OcrWord[];
}

/**
 * Main entry point for position-aware parsing
 */
export function parseTableFromWords(words: OcrWord[]): ParsedInvoiceItem[] {
  if (!words || words.length === 0) {
    return [];
  }

  // 1. Find table boundaries
  const tableBounds = findTableBoundaries(words);
  if (!tableBounds) {
    logger.debug('Position parser: table boundaries not found');
    return [];
  }

  const { startY, endY } = tableBounds;
  logger.debug('Position parser: table Y boundaries', { startY, endY });

  // 2. Filter words within table bounds
  let tableWords = words.filter(w => w.y >= startY && w.y <= endY);
  logger.debug('Position parser: table words', { count: tableWords.length });

  if (tableWords.length === 0) {
    return [];
  }

  // 3. Check for skip sections and remove them
  tableWords = filterSkipSections(tableWords);
  logger.debug('Position parser: after skip filter', { count: tableWords.length });

  // 4. Detect parsing mode: row-by-row or column-by-column
  // Column mode: when OCR reads column-by-column, there are VERY few distinct Y positions
  // (e.g., 2-5 rows for 100+ words). Row mode: normal reading with many rows.
  const rowCount = countDistinctYPositions(tableWords);
  const wordsPerRow = tableWords.length / Math.max(rowCount, 1);
  // Column mode only if average words per row is very high (>20) AND very few rows
  const isColumnMode = rowCount <= 5 && wordsPerRow > 20;

  logger.debug('Position parser: mode detection', {
    rowCount,
    wordCount: tableWords.length,
    wordsPerRow: wordsPerRow.toFixed(1),
    mode: isColumnMode ? 'column-by-column' : 'row-by-row'
  });

  // 5. Parse based on detected mode
  let items: ParsedInvoiceItem[];
  if (isColumnMode) {
    items = parseColumnByColumn(tableWords);
  } else {
    items = parseRowByRow(tableWords);
  }

  logger.debug('Position parser: final items', { count: items.length });
  return items;
}

/**
 * Find table start and end Y coordinates
 */
function findTableBoundaries(words: OcrWord[]): { startY: number; endY: number } | null {
  const sortedByY = [...words].sort((a, b) => a.y - b.y);

  // Find "Товар" or similar header
  let startIdx = -1;
  for (let i = 0; i < sortedByY.length; i++) {
    const text = sortedByY[i].text.toLowerCase();
    if (text.includes('товар') || text === 'наименование' || text === 'наим.') {
      startIdx = i;
      break;
    }
  }

  if (startIdx < 0) {
    // Fallback: look for first row number "1" followed by Cyrillic text
    for (let i = 0; i < sortedByY.length - 1; i++) {
      if (sortedByY[i].text === '1' && /^[А-ЯЁ]/i.test(sortedByY[i + 1]?.text || '')) {
        startIdx = i;
        break;
      }
    }
  }

  if (startIdx < 0) return null;

  // Find "Итого" or "Всего"
  let endIdx = sortedByY.length;
  for (let i = startIdx + 1; i < sortedByY.length; i++) {
    const text = sortedByY[i].text.toLowerCase();
    if (text === 'итого' || text === 'всего' || text.startsWith('итого:') || text.startsWith('всего:')) {
      endIdx = i;
      break;
    }
  }

  const startY = sortedByY[startIdx].y;
  // Use endY - 1 to exclude the "Итого" row itself from the table
  const endY = endIdx < sortedByY.length ? sortedByY[endIdx].y - 1 : sortedByY[sortedByY.length - 1].y + 100;

  return { startY, endY };
}

/**
 * Filter out skip sections based on combined text
 */
function filterSkipSections(words: OcrWord[]): OcrWord[] {
  // Combine text within small Y ranges to check for skip patterns
  const yTolerance = 15;
  const textByY: Map<number, { y: number; text: string; words: OcrWord[] }> = new Map();

  for (const word of words) {
    let foundGroup = false;
    for (const [key, group] of textByY.entries()) {
      if (Math.abs(word.y - group.y) < yTolerance) {
        group.text += ' ' + word.text;
        group.words.push(word);
        foundGroup = true;
        break;
      }
    }
    if (!foundGroup) {
      textByY.set(word.y, { y: word.y, text: word.text, words: [word] });
    }
  }

  // Find Y ranges to skip
  const skipYRanges: Array<{ minY: number; maxY: number }> = [];
  for (const group of textByY.values()) {
    for (const pattern of SKIP_SECTION_PATTERNS) {
      if (pattern.test(group.text)) {
        skipYRanges.push({
          minY: group.y - 20,
          maxY: group.y + 300,
        });
        break;
      }
    }
  }

  // Filter words
  if (skipYRanges.length === 0) return words;

  return words.filter(w => {
    for (const range of skipYRanges) {
      if (w.y >= range.minY && w.y <= range.maxY) return false;
    }
    return true;
  });
}

/**
 * Count distinct Y positions to detect parsing mode
 */
function countDistinctYPositions(words: OcrWord[]): number {
  const yTolerance = 8;
  const distinctY: number[] = [];

  for (const word of words) {
    let found = false;
    for (const y of distinctY) {
      if (Math.abs(word.y - y) < yTolerance) {
        found = true;
        break;
      }
    }
    if (!found) distinctY.push(word.y);
  }

  return distinctY.length;
}

/**
 * Parse table in column-by-column mode
 *
 * In this mode, Google Vision reads each column separately:
 * - Column 1: row numbers (1, 2, 3...)
 * - Column 2: product names
 * - Column 3: quantities (possibly with units)
 * - Column 4: prices
 * - Column 5: totals
 */
function parseColumnByColumn(words: OcrWord[]): ParsedInvoiceItem[] {
  // 1. Group words into columns by X position
  const columns = groupIntoColumns(words);
  logger.debug('Position parser (column mode): columns detected', { count: columns.length });

  if (columns.length < 2) {
    return [];
  }

  // 2. Identify column types
  const colTypes = identifyColumnTypes(columns);
  logger.debug('Position parser (column mode): column types', { types: colTypes });

  // 3. Find the product names column (usually the second column, first with Cyrillic text)
  let namesColIdx = -1;
  for (let i = 0; i < colTypes.length; i++) {
    if (colTypes[i] === 'names') {
      namesColIdx = i;
      break;
    }
  }

  if (namesColIdx < 0) {
    logger.debug('Position parser (column mode): no names column found');
    return [];
  }

  // 4. Sort names column by Y to get product order
  const namesCol = columns[namesColIdx];
  namesCol.words.sort((a, b) => a.y - b.y);

  // 5. Build items by matching Y positions across columns
  const items: ParsedInvoiceItem[] = [];

  for (const nameWord of namesCol.words) {
    const name = nameWord.text.trim();

    // Skip garbage
    if (!name || name.length < 2 || NAME_BLACKLIST.test(name) || SKIP_WORDS.test(name)) {
      continue;
    }
    if (!/[А-ЯЁа-яё]/.test(name)) continue;

    const item: ParsedInvoiceItem = {
      name,
      quantity: undefined,
      unit: undefined,
      price: undefined,
      total: undefined,
    };

    // Find corresponding values in other columns by closest Y
    for (let i = 0; i < columns.length; i++) {
      if (i === namesColIdx) continue;

      const colType = colTypes[i];
      if (colType === 'rownum') continue;

      const closestWord = findClosestByY(columns[i].words, nameWord.y);
      if (!closestWord || Math.abs(closestWord.y - nameWord.y) > 30) continue;

      const text = closestWord.text.trim();

      if (colType === 'qty' || colType === 'qtyunit') {
        const qtyMatch = text.match(QTY_UNIT_PATTERN);
        if (qtyMatch) {
          item.quantity = parseFloat(qtyMatch[1].replace(',', '.'));
          item.unit = normalizeUnit(qtyMatch[2]);
        } else if (STANDALONE_QTY_PATTERN.test(text)) {
          const qty = parseFloat(text.replace(',', '.'));
          if (qty > 0 && qty < 10000 && !item.quantity) {
            item.quantity = qty;
          }
        } else if (UNIT_PATTERN.test(text) && !item.unit) {
          item.unit = normalizeUnit(text);
        }
      } else if (colType === 'price') {
        const priceMatch = text.match(PRICE_PATTERN);
        if (priceMatch) {
          item.price = parseFloat(priceMatch[1].replace(/\s/g, '').replace(',', '.'));
        }
      } else if (colType === 'total') {
        const totalMatch = text.match(PRICE_PATTERN);
        if (totalMatch) {
          item.total = parseFloat(totalMatch[1].replace(/\s/g, '').replace(',', '.'));
        }
      }
    }

    // Cross-validation
    if (item.quantity && item.price && !item.total) {
      item.total = Math.round(item.quantity * item.price * 100) / 100;
    }
    if (item.quantity && item.total && !item.price) {
      item.price = Math.round((item.total / item.quantity) * 100) / 100;
    }

    items.push(item);
  }

  return items;
}

/**
 * Group words into columns by X position
 */
function groupIntoColumns(words: OcrWord[]): Column[] {
  const colGap = 25; // Minimum gap between columns
  const columns: Column[] = [];

  // Sort by X
  const sorted = [...words].sort((a, b) => a.x - b.x);

  for (const word of sorted) {
    let foundCol: Column | null = null;
    for (const col of columns) {
      if (word.x >= col.x - 10 && word.x <= col.xMax + colGap) {
        foundCol = col;
        break;
      }
    }

    if (foundCol) {
      foundCol.words.push(word);
      foundCol.xMax = Math.max(foundCol.xMax, word.x + word.width);
    } else {
      columns.push({
        x: word.x,
        xMax: word.x + word.width,
        words: [word],
      });
    }
  }

  // Sort columns by X
  columns.sort((a, b) => a.x - b.x);

  return columns;
}

/**
 * Identify column types based on content
 */
function identifyColumnTypes(columns: Column[]): string[] {
  const types: string[] = [];

  for (const col of columns) {
    let hasRowNumbers = 0;
    let hasNames = 0;
    let hasQtyUnit = 0;
    let hasPrices = 0;

    for (const word of col.words) {
      const text = word.text.trim();
      if (ROW_NUMBER_PATTERN.test(text) && parseInt(text, 10) <= 50) hasRowNumbers++;
      if (/^[А-ЯЁа-яё]/.test(text) && text.length >= 3) hasNames++;
      if (QTY_UNIT_PATTERN.test(text) || UNIT_PATTERN.test(text)) hasQtyUnit++;
      if (PRICE_PATTERN.test(text)) hasPrices++;
    }

    // Determine column type by majority content
    const maxCount = Math.max(hasRowNumbers, hasNames, hasQtyUnit, hasPrices);
    if (maxCount === 0) {
      types.push('unknown');
    } else if (hasNames === maxCount && hasNames > 0) {
      types.push('names');
    } else if (hasRowNumbers === maxCount && hasRowNumbers > 0) {
      types.push('rownum');
    } else if (hasQtyUnit === maxCount && hasQtyUnit > 0) {
      types.push('qtyunit');
    } else if (hasPrices === maxCount && hasPrices > 0) {
      // Distinguish between price and total by column position
      // Earlier columns tend to be prices, later columns totals
      types.push(types.filter(t => t === 'price' || t === 'total').length === 0 ? 'price' : 'total');
    } else {
      types.push('unknown');
    }
  }

  return types;
}

/**
 * Find word with closest Y coordinate
 */
function findClosestByY(words: OcrWord[], targetY: number): OcrWord | null {
  if (words.length === 0) return null;

  let closest = words[0];
  let minDist = Math.abs(closest.y - targetY);

  for (const word of words) {
    const dist = Math.abs(word.y - targetY);
    if (dist < minDist) {
      minDist = dist;
      closest = word;
    }
  }

  return closest;
}

/**
 * Parse table in row-by-row mode (standard case)
 *
 * Handles cases where quantities/prices appear on separate rows below product names.
 */
function parseRowByRow(words: OcrWord[]): ParsedInvoiceItem[] {
  const rowTolerance = 12;

  // Group words into rows
  const rows: { y: number; words: OcrWord[] }[] = [];
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);

  for (const word of sorted) {
    let foundRow = rows.find(r => Math.abs(word.y - r.y) < rowTolerance);
    if (foundRow) {
      foundRow.words.push(word);
    } else {
      rows.push({ y: word.y, words: [word] });
    }
  }

  // Sort rows by Y and words within rows by X
  rows.sort((a, b) => a.y - b.y);
  for (const row of rows) {
    row.words.sort((a, b) => a.x - b.x);
  }

  // Detect numeric column boundary
  // Exclude header/skip words from maxNameX to avoid inflating the boundary
  let minNumericX = Infinity;
  let maxNameX = 0;

  for (const row of rows) {
    for (const word of row.words) {
      // Only use price patterns (with decimals) for boundary detection,
      // not QTY_UNIT because "1л" in product names would skew the boundary
      if (PRICE_PATTERN.test(word.text)) {
        minNumericX = Math.min(minNumericX, word.x);
      } else if (/^[А-ЯЁа-яё]/.test(word.text) && word.text.length > 2
        && !SKIP_WORDS.test(word.text) && !NAME_BLACKLIST.test(word.text)
        && !UNIT_PATTERN.test(word.text)) {
        maxNameX = Math.max(maxNameX, word.x + word.width);
      }
    }
  }

  // Also consider standalone qty patterns when detecting minNumericX
  // Look for columns of small numbers (1-4 digits) that are clearly right of product names
  for (const row of rows) {
    for (const word of row.words) {
      if (STANDALONE_QTY_PATTERN.test(word.text) && word.x > maxNameX + 50) {
        minNumericX = Math.min(minNumericX, word.x);
      }
    }
  }

  const numericBoundary = minNumericX < Infinity ? (maxNameX + minNumericX) / 2 : Infinity;

  // First pass: scan all rows to detect if product codes exist (e.g., ПОС32469)
  // If product codes exist, use continuation logic; otherwise treat each row as separate product
  let hasProductCodes = false;

  interface ParsedRowData {
    name: string;
    rowIndex: number;
    numericValues: { x: number; text: string }[];
  }

  // Pre-scan to detect product code presence
  for (const row of rows) {
    const rowText = row.words.map(w => w.text).join(' ');
    if (PRODUCT_CODE_PATTERN.test(rowText)) {
      hasProductCodes = true;
      break;
    }
  }

  logger.debug('Position parser: product code detection', { hasProductCodes });

  const parsedRows: ParsedRowData[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const nameWords: string[] = [];
    const numericValues: { x: number; text: string }[] = [];

    for (const word of row.words) {
      const text = word.text.trim();
      if (!text || SKIP_WORDS.test(text)) continue;

      // Skip row numbers at the start
      if (ROW_NUMBER_PATTERN.test(text) && nameWords.length === 0) continue;

      if (word.x < numericBoundary) {
        if (!NAME_BLACKLIST.test(text)) {
          nameWords.push(text);
        }
      } else {
        numericValues.push({ x: word.x, text });
      }
    }

    const name = nameWords.join(' ').trim();

    // Skip garbage text (disclaimer, totals in words, etc.)
    const isGarbage = GARBAGE_TEXT_PATTERNS.some(p => p.test(name));
    if (isGarbage) continue;

    if (name && name.length >= 2 && /[А-ЯЁа-яё]/.test(name)) {
      // Check if this starts with a product code (new product indicator)
      const startsWithProductCode = PRODUCT_CODE_PATTERN.test(name);

      // Use continuation logic ONLY if invoice has product codes
      // Otherwise, each row with Cyrillic text is a new product
      if (hasProductCodes) {
        // Product code mode: merge continuation lines
        if (startsWithProductCode || parsedRows.length === 0) {
          parsedRows.push({ name, rowIndex: i, numericValues });
        } else {
          // Continuation of previous product (append name and numerics)
          const lastProduct = parsedRows[parsedRows.length - 1];
          lastProduct.name += ' ' + name;
          lastProduct.numericValues.push(...numericValues);
        }
      } else {
        // No product codes: each row is a separate product (original behavior)
        parsedRows.push({ name, rowIndex: i, numericValues });
      }
    } else if (numericValues.length > 0 && parsedRows.length > 0) {
      // This is a numeric-only row - attach to previous product
      const lastProduct = parsedRows[parsedRows.length - 1];
      lastProduct.numericValues.push(...numericValues);
    }
  }

  // Second pass: convert to items with numeric data
  const items: ParsedInvoiceItem[] = [];

  for (const pRow of parsedRows) {
    const item: ParsedInvoiceItem = {
      name: pRow.name,
      quantity: undefined,
      unit: undefined,
      price: undefined,
      total: undefined,
    };

    // Sort numeric values by X position
    pRow.numericValues.sort((a, b) => a.x - b.x);

    // Pre-process: combine split prices like ["2", "484,00"] → ["2 484,00"]
    const combinedValues = combineMultiPartPrices(pRow.numericValues);

    const numbers: number[] = [];

    for (const { text } of combinedValues) {
      // Quantity + unit combined: "10,8 кг"
      const qtyMatch = text.match(QTY_UNIT_PATTERN);
      if (qtyMatch) {
        if (!item.quantity) {
          item.quantity = parseFloat(qtyMatch[1].replace(',', '.'));
          item.unit = normalizeUnit(qtyMatch[2]);
        }
        continue;
      }

      // Standalone unit: "кг"
      if (UNIT_PATTERN.test(text)) {
        if (!item.unit) {
          item.unit = normalizeUnit(text);
        }
        continue;
      }

      // Price with decimals: "230,00" or "2 484,00"
      const priceMatch = text.match(PRICE_PATTERN);
      if (priceMatch) {
        numbers.push(parseFloat(priceMatch[1].replace(/\s/g, '').replace(',', '.')));
        continue;
      }

      // Standalone number (could be quantity)
      if (STANDALONE_QTY_PATTERN.test(text)) {
        const val = parseFloat(text.replace(',', '.'));
        if (val > 0 && val < 10000 && !item.quantity) {
          item.quantity = val;
        }
      }
    }

    // Assign price/total from collected numbers
    if (numbers.length >= 2) {
      item.price = numbers[numbers.length - 2];
      item.total = numbers[numbers.length - 1];
    } else if (numbers.length === 1) {
      item.total = numbers[0];
    }

    // Cross-validation
    if (item.quantity && item.price && !item.total) {
      item.total = Math.round(item.quantity * item.price * 100) / 100;
    }
    if (item.quantity && item.total && !item.price) {
      item.price = Math.round((item.total / item.quantity) * 100) / 100;
    }

    items.push(item);
  }

  return items;
}

/**
 * Combine multi-part prices that OCR splits into separate words.
 * Example: ["2", "484,00"] → ["2 484,00"]
 *
 * Pattern: single digit (1-9) followed by 3-digit number with decimals
 */
function combineMultiPartPrices(values: { x: number; text: string }[]): { x: number; text: string }[] {
  if (values.length < 2) return values;

  const result: { x: number; text: string }[] = [];
  let i = 0;

  while (i < values.length) {
    const current = values[i];
    const next = values[i + 1];

    // Check if current is 1-2 digits and next is a 3-digit price (e.g., "2 484,00" or "12 420,00")
    if (next && /^[1-9]\d?$/.test(current.text) && /^\d{3}[.,]\d{2}$/.test(next.text)) {
      // Check X proximity - they should be close (within ~40 pixels)
      if (next.x - current.x < 50) {
        // Combine them
        result.push({
          x: current.x,
          text: current.text + ' ' + next.text,
        });
        i += 2;
        continue;
      }
    }

    result.push(current);
    i++;
  }

  return result;
}

function normalizeUnit(unit: string): string {
  const lower = unit.toLowerCase().trim().replace('.', '');
  const map: Record<string, string> = {
    'кг': 'кг', 'килограмм': 'кг', 'килогр': 'кг',
    'шт': 'шт', 'штук': 'шт', 'штука': 'шт',
    'л': 'л', 'литр': 'л', 'литров': 'л',
    'уп': 'уп', 'упак': 'уп', 'упаковка': 'уп',
    'пач': 'уп', 'пачка': 'уп',
    'бут': 'шт', 'бутылка': 'шт',
  };
  return map[lower] || 'шт';
}
