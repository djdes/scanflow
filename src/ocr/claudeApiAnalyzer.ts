import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { ParsedInvoiceData } from './types';
import { logger } from '../utils/logger';
import { config } from '../config';

export interface ApiAnalyzerResult {
  success: boolean;
  data?: ParsedInvoiceData;
  rawText?: string;
  error?: string;
}

/**
 * Minimal catalog row shape we feed to Claude for LLM-based mapping.
 * We pass an INDEX (1-based line number in the catalog block) instead of the
 * full GUID so the model doesn't have to echo 36-char strings back — it just
 * returns `catalog_idx: 42`, we resolve to guid on the server.
 */
export interface CatalogEntry {
  guid: string;
  name: string;
  unit?: string | null;
}

// 90s per Claude API request. Single-image accounting scans can legitimately
// take 30-60s on Opus; 90s gives us headroom before failing over to retry.
const CLAUDE_API_TIMEOUT_MS = 90_000;

// Total retries = 2 (3 attempts). Backoff: 1s, 2s. Total worst-case wall time
// ~ 90 + 1 + 90 + 2 + 90 = 273s per invoice if Claude is consistently slow.
const CLAUDE_API_MAX_RETRIES = 2;

/**
 * Wrap a Claude API call with retry + exponential backoff.
 * - Retries on 5xx and 429 (rate limit)
 * - Does NOT retry on 4xx auth/bad-request errors (they're not transient)
 * - Each attempt gets its own timeout signal
 */
async function withRetry<T>(fn: (signal: AbortSignal) => Promise<T>, label: string): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= CLAUDE_API_MAX_RETRIES; attempt++) {
    try {
      const signal = AbortSignal.timeout(CLAUDE_API_TIMEOUT_MS);
      return await fn(signal);
    } catch (e) {
      lastError = e as Error;
      const status = (e as { status?: number }).status;
      // Don't retry on 4xx except 429 — those are client errors
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw e;
      }
      if (attempt < CLAUDE_API_MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        logger.warn(`${label}: attempt ${attempt + 1} failed, retrying in ${backoffMs}ms`, {
          error: (e as Error).message,
          status,
        });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
  throw lastError ?? new Error(`${label}: unknown failure`);
}

/**
 * Build the prompt. When `catalog` is provided, Claude is asked to map each
 * item to a catalog_idx (1-based line number in the catalog block). Without
 * catalog, we skip that section entirely — backwards-compatible with
 * LLM-mapper-off mode.
 */
function buildPrompt(catalog?: CatalogEntry[]): string {
  let catalogBlock = '';
  if (catalog && catalog.length > 0) {
    // Format: "[idx] name (unit)" — compact, keeps token count under control.
    // 670 items at ~60 chars/line ≈ 40 KB, ~12k tokens. Well within Sonnet's
    // context window and cheaper than per-line fuzzy+API calls.
    const lines = catalog.map((c, i) => {
      const unit = c.unit ? ` (${c.unit})` : '';
      return `[${i + 1}] ${c.name}${unit}`;
    }).join('\n');
    catalogBlock = `

================================================================
СПРАВОЧНИК НОМЕНКЛАТУРЫ 1С (${catalog.length} позиций)
================================================================

Ниже пронумерованный список товаров из справочника 1С. Для КАЖДОЙ позиции накладной
найди соответствующий товар в этом списке и укажи его номер в поле "catalog_idx".

ПРАВИЛА СОПОСТАВЛЕНИЯ:
  • Сопоставляй по смыслу, а не по буквальному совпадению. OCR может искажать
    имя ("Помилка Сетан Семам" — пытайся понять, что это было изначально).
  • Производителя/бренд/артикул можно игнорировать — в справочнике хранится
    обобщённое название товара.
  • Размер/объём учитывай ВНИМАТЕЛЬНО: "Молоко 1л" и "Молоко 2л" — это РАЗНЫЕ
    позиции справочника.
  • Если ПОДХОДЯЩЕЙ позиции в справочнике нет — верни catalog_idx: null. НЕ
    подставляй "похоже" — лучше пусто, чем неверное сопоставление.

СПИСОК:
${lines}`;
  }

  return `Ты эксперт по русским товарным накладным. Проанализируй изображение и верни ТОЛЬКО валидный JSON (без markdown, без комментариев, без пояснений).

================================================================
СТРУКТУРА НАКЛАДНОЙ (ТОРГ-12, УПД, счёт-фактура, счёт на оплату)
================================================================

1) ШАПКА (верх страницы, до таблицы товаров):
   • "Счёт-фактура №", "УПД №", "Накладная №", "Счёт №" → invoice_number
     (обычно короткий: "261", "1/153468", "17-0048600")
   • "от DD месяца YYYY г." → invoice_date (YYYY-MM-DD)
   • "Продавец"/"Поставщик"/"Грузоотправитель" → supplier
     (ищи форму "ООО/АО/ИП ..."). Покупателя (обычно ООО "БФС") игнорируй.
   • "ИНН/КПП продавца", "ИНН поставщика" → supplier_inn (первые 10 или 12 цифр до "/")
   • Для "счёт на оплату": ищи также БИК банка, р/сч, к/сч, адрес поставщика.

2) ТАБЛИЦА ТОВАРОВ. Структура колонок для ТОРГ-12/УПД (слева-направо):
   │  1  │ 1a     │ 1б │ 2   │ 3       │ 4     │ 5        │ 6  │ 7     │ 8       │ 9           │ 10 │ 11  │
   │ Код │ №      │ Код│ Ед. │ Кол-во  │ Цена  │ СТОИМ.   │НДС │ Налог │ СУММА   │ СТОИМОСТЬ   │... │     │
   │товар│  п/п   │ вид│ изм │         │(тариф)│ БЕЗ нал. │акц.│ ставка│ налога  │ С налогом   │    │     │
   │     │        │    │     │         │ за ед.│ ВСЕГО    │    │       │ (НДС)   │ ВСЕГО       │    │     │

   ПО СТРОКЕ ТОВАРА извлекай:
     name        ← колонка "1a" (наименование). Бренды/артикулы убирай, вес/объём ОСТАВЛЯЙ
                   ("Кальмар Командорский 5кг" → "Кальмар 5кг"; "Вода 1.5л Сладкая жизнь" → "Вода 1.5л")
     row_no      ← колонка "№ п/п" / "№" / "No" (2-я слева после "Код товара").
                   На 2-й странице многолистовой накладной нумерация продолжается (10, 11, ...).
                   НЕ путай с колонкой "Код товара" слева (артикул типа "13-0659", "17-4549")
     quantity    ← колонка "Количество". Это НЕБОЛЬШОЕ число (обычно до нескольких тысяч).
                   Запятую и тысячный разделитель читай ОСТОРОЖНО: "2,000" = 2 штуки (одна запятая как дес.),
                   а "2 000" = 2000 штук. Если получается число > 10000 — ты скорее всего вставил
                   лишние нули, перечитай.
     unit        ← колонка "Единица измерения" (шт, кг, л, уп, пач, упак)
     price       ← цена ЗА ЕДИНИЦУ С НДС = total / quantity. Колонка 4 — цена БЕЗ НДС,
                   НЕ используй её как price.
     total       ← колонка 9 "Стоимость С НАЛОГОМ — всего" (самая правая цифра в строке).
                   НИКОГДА не колонка 5 (без НДС).
     vat_rate    ← колонка 7 (10, 20, 22, 0; "без акциза" → null для акциза, но ставка НДС есть отдельно)

3) ИТОГ (строка под таблицей):
   Ищи строку подписанную одним из: "Всего к оплате", "Всего к оплате (9)",
   "Всего по накладной", "Итого", "К оплате", "Сумма к оплате".
   В этой строке ДВЕ цифры:
     левая  → Σ колонки 5 (без НДС) — НЕ БРАТЬ
     правая → Σ колонки 9 (с НДС)    → total_sum

   Для VAT:
     "В том числе НДС" / "Сумма налога, предъявляемая покупателю" → vat_sum

4) МНОГОСТРАНИЧНАЯ НАКЛАДНАЯ:
   • Если на текущем изображении НЕТ строки "Всего к оплате" (промежуточный лист),
     верни total_sum: null и vat_sum: null. Не пытайся подставить сумму последнего товара.
   • Если в шапке НЕТ "УПД №..." / "Счёт-фактура №..." (продолжение), верни
     invoice_number: null. НЕ используй "Код товара" из первого столбца таблицы
     как номер накладной.

================================================================
САМОПРОВЕРКА ПЕРЕД ВЫДАЧЕЙ JSON
================================================================

  A. Для каждой строки: total ≈ quantity × price (±1%).
     Если total ГОРАЗДО больше, ты взял quantity с лишними нулями ("2,000" → 2000 вместо 2).
     Если total ГОРАЗДО меньше, ты взял price из колонки 4 (без НДС) вместо "с НДС".
     ПЕРЕЧИТАЙ строку.

  B. Если на странице есть строка "Всего к оплате":
       Σ(items[i].total) == total_sum (± 1 руб)
     Если расходится:
       — ты пропустил товар → перечитай таблицу сверху вниз
       — или взял для некоторых total из колонки 5 → перепроверь все позиции
       — или поставил total_sum из колонки 5 → смотри САМУЮ ПРАВУЮ цифру итога.

  C. total_sum − vat_sum ≈ Σ(items[i].total_без_ндс_если_бы_был) — арифметика сходится.

================================================================
ФОРМАТ ОТВЕТА (строго этот JSON, никаких markdown-ограждений)
================================================================

{"invoice_type":"счет_на_оплату|торг_12|упд|счет_фактура","invoice_number":"...","invoice_date":"YYYY-MM-DD","supplier":"...","supplier_inn":"...","supplier_bik":"...","supplier_account":"...","supplier_corr_account":"...","supplier_address":"...","total_sum":число,"vat_sum":число,"items":[{"name":"...","quantity":число,"unit":"шт|кг|л|уп","price":число,"total":число,"vat_rate":число,"row_no":число${catalogBlock ? ',"catalog_idx":номер_или_null' : ''}}]}

Все незаполненные поля ставь null. Числа — с точкой (30.60). Никогда не оборачивай JSON в три обратные кавычки.${catalogBlock}`;
}

// Back-compat export: empty-catalog version used where LLM-mapper is off.
const CLAUDE_API_PROMPT = buildPrompt();

import { jsonrepair } from 'jsonrepair';

/**
 * Clean JSON string from common LLM artifacts: trailing commas, comments, etc.
 */
function cleanJsonString(raw: string): string {
  return raw
    .replace(/,\s*([}\]])/g, '$1')       // trailing commas
    .replace(/\/\/[^\n]*/g, '')           // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '');    // multi-line comments
}

/**
 * Safely parse Claude's JSON response. Catches parse errors and enforces the
 * minimum shape we care about (items is an array). Returns a normalised
 * ParsedInvoiceData on success, or null with logged context on failure — the
 * caller falls through to the regex parser.
 *
 * Three-stage fallback:
 *   1. JSON.parse after cleanup (handles well-formed + trailing commas)
 *   2. jsonrepair (handles unescaped quotes, missing commas, weird Opus quirks)
 *   3. Give up and return null
 */
function safeParseClaudeJson(text: string, label: string): ParsedInvoiceData | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    logger.warn(`${label}: no JSON object found in Claude response`, { sample: text.slice(0, 200) });
    return null;
  }
  let parsed: unknown;
  const cleaned = cleanJsonString(match[0]);
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Stage 2 — try to repair. jsonrepair handles Opus-style breakages like
    // "Expected ',' or '}'" on line 1036 where a quote in a name wasn't
    // escaped.
    logger.warn(`${label}: JSON.parse failed, attempting jsonrepair`, {
      error: (err as Error).message,
    });
    try {
      parsed = JSON.parse(jsonrepair(cleaned));
      logger.info(`${label}: jsonrepair succeeded`);
    } catch (repairErr) {
      logger.warn(`${label}: jsonrepair also failed, giving up`, {
        error: (repairErr as Error).message,
        sample: match[0].slice(0, 300),
      });
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    logger.warn(`${label}: parsed response is not an object`);
    return null;
  }
  const data = parsed as ParsedInvoiceData;
  if (!Array.isArray(data.items)) {
    logger.warn(`${label}: "items" is missing or not an array — coercing to []`);
    data.items = [];
  }
  return data;
}

function createClient(apiKey: string): Anthropic {
  const proxyUrl = config.anthropicProxyUrl;
  if (proxyUrl) {
    logger.info('Claude API: using HTTP proxy', { proxy: proxyUrl.replace(/\/\/.*@/, '//*:*@') });
    const dispatcher = new ProxyAgent(proxyUrl);
    const proxiedFetch: typeof globalThis.fetch = (url, init) =>
      undiciFetch(url as any, { ...init as any, dispatcher }) as any;
    return new Anthropic({ apiKey, fetch: proxiedFetch });
  }
  return new Anthropic({ apiKey });
}

function getMediaType(imagePath: string): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  const ext = path.extname(imagePath).toLowerCase();
  const map: Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/png',
    '.tiff': 'image/png',
  };
  return map[ext] || 'image/jpeg';
}

/**
 * Анализ объединённого OCR-текста нескольких страниц через Anthropic API.
 * Не требует изображений — работает с готовым текстом от Google Vision.
 */
export async function analyzeMultiPageTextWithClaudeApi(
  combinedOcrText: string,
  apiKey: string,
  pageCount: number,
  modelId: string = 'claude-sonnet-4-6',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting multi-page TEXT analysis', { textLength: combinedOcrText.length, pageCount, catalogSize: catalog?.length ?? 0 });

  try {
    const client = createClient(apiKey);
    const prompt = buildPrompt(catalog);

    const response = await withRetry(
      (signal) => client.messages.create({
        model: modelId,
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: `${prompt}\n\nВАЖНО — ОБЪЕДИНЕНИЕ СТРАНИЦ:\n`
              + `Это ОДНА многостраничная накладная на ${pageCount} страниц(ы). Ниже даны JSON-результаты анализа каждой страницы по отдельности, разделённые маркером "--- СТРАНИЦА ---".\n`
              + `\n`
              + `ЗАДАЧА: собрать из них ОДИН итоговый JSON. Правила:\n`
              + `  1. items = КОНКАТЕНАЦИЯ items со всех страниц в порядке row_no. НИ ОДНА ПОЗИЦИЯ не должна быть потеряна. Если на странице 1 items имели row_no 1..9, а на странице 2 — row_no 10, итоговый items должен содержать ВСЕ 10 позиций.\n`
              + `  2. invoice_number/invoice_date/supplier/supplier_inn — бери из той страницы, где они не null (обычно первая).\n`
              + `  3. total_sum — возьми из ПОСЛЕДНЕЙ страницы, где есть значение (обычно последняя страница содержит строку "Всего к оплате"). Это ОБЩИЙ итог документа, НЕ сумма страниц.\n`
              + `  4. vat_sum — аналогично, из страницы с "В том числе НДС" (обычно последняя).\n`
              + `  5. ПРОВЕРКА: Σ(items[i].total) ≈ total_sum (±1 руб). Если не совпадает — значит при чтении страниц какая-то позиция пропущена, ПЕРЕЧИТАЙ обе страницы (OCR-текст ниже).\n`
              + `\n`
              + `ЕСЛИ по данным страниц чего-то нет (например на странице 2 не было invoice_number), бери из страницы 1. НЕ придумывай значения.\n`
              + `\n`
              + `OCR-текст всех страниц:\n${combinedOcrText}`,
          },
        ],
      }, { signal }),
      'Claude API multi-page text'
    );

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }

    const text = textBlock.text.trim();
    logger.info('Claude API Analyzer: multi-page text response received', { length: text.length });

    const parsed = safeParseClaudeJson(text, 'Claude API multi-page text');
    if (!parsed) {
      return { success: false, error: 'Claude API: failed to parse JSON response', rawText: text };
    }

    logger.info('Claude API Analyzer: multi-page text parsed successfully', {
      invoiceNumber: parsed.invoice_number,
      itemsCount: parsed.items.length,
      totalSum: parsed.total_sum,
    });

    return { success: true, data: parsed, rawText: text };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Claude API Analyzer: multi-page text error', { error: msg });
    return { success: false, error: `Claude API error: ${msg}` };
  }
}

export async function analyzeMultipleImagesWithClaudeApi(
  imagePaths: string[],
  apiKey: string,
  modelId: string = 'claude-sonnet-4-6',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting multi-page analysis', { pages: imagePaths.length, catalogSize: catalog?.length ?? 0 });

  try {
    const content: Anthropic.MessageCreateParams['messages'][0]['content'] = [];

    for (const imagePath of imagePaths) {
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      const mediaType = getMediaType(imagePath);
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64Image },
      });
    }

    const prompt = buildPrompt(catalog);
    content.push({
      type: 'text',
      text: `${prompt}\n\nВАЖНО: Это многостраничная накладная (${imagePaths.length} страниц). Объедини ВСЕ товары со ВСЕХ страниц в один список items. Итоговую сумму возьми из последней страницы (строка "Всего по накладной").`,
    });

    const client = createClient(apiKey);

    const response = await withRetry(
      (signal) => client.messages.create({
        model: modelId,
        max_tokens: 8192,
        messages: [{ role: 'user', content }],
      }, { signal }),
      'Claude API multi-image'
    );

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }

    const text = textBlock.text.trim();
    logger.info('Claude API Analyzer: multi-page response received', { length: text.length });

    const parsed = safeParseClaudeJson(text, 'Claude API multi-image');
    if (!parsed) {
      return { success: false, error: 'Claude API: failed to parse JSON response', rawText: text };
    }

    logger.info('Claude API Analyzer: multi-page parsed successfully', {
      invoiceNumber: parsed.invoice_number,
      itemsCount: parsed.items.length,
      totalSum: parsed.total_sum,
    });

    return { success: true, data: parsed, rawText: text };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Claude API Analyzer: multi-page error', { error: msg });
    return { success: false, error: `Claude API error: ${msg}` };
  }
}

/**
 * Ask Claude Haiku how many degrees CLOCKWISE the given image should be
 * rotated for the document inside it to be upright. Used by ocrManager to
 * normalise photo orientation before the main OCR call — sideways pictures
 * cause heavy hallucination on Sonnet/Opus vision.
 *
 * Returns one of 0, 90, 180, 270. On any error, returns 0 (no rotation).
 */
/**
 * Detect orientation by showing Haiku all four rotations side-by-side and
 * asking which one is upright. More reliable than "how many degrees" because
 * the model can compare variants visually instead of doing mental rotation.
 *
 * previewBuffers: [rot0, rot90, rot180, rot270] — all already rotated, JPEG.
 * Returns how many degrees CLOCKWISE the ORIGINAL needs to be rotated.
 */
export async function detectOrientationWithClaude(
  previewsBase64: [string, string, string, string],
  apiKey: string,
): Promise<0 | 90 | 180 | 270> {
  const client = createClient(apiKey);
  try {
    // Sonnet for this tiny task, not Haiku — Haiku consistently picks
    // wrong orientation on sideways document photos in our testing. Cost is
    // negligible because previews are 400x500 at JPEG q60 (~20KB each).
    const response = await withRetry(
      (signal) => client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Вариант 1:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: previewsBase64[0] } },
            { type: 'text', text: 'Вариант 2:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: previewsBase64[1] } },
            { type: 'text', text: 'Вариант 3:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: previewsBase64[2] } },
            { type: 'text', text: 'Вариант 4:' },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: previewsBase64[3] } },
            {
              type: 'text',
              text: 'Выше четыре варианта одной и той же фотографии документа, повернутых по-разному. В каком из них текст читается НОРМАЛЬНО (строки идут горизонтально слева направо, буквы вертикальные)? Ответь одной цифрой: 1, 2, 3 или 4.',
            },
          ],
        }],
      }, { signal }),
      'Claude orientation detection'
    );
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return 0;
    const match = textBlock.text.match(/\b([1-4])\b/);
    if (!match) {
      logger.warn('Orientation: unparseable response', { text: textBlock.text.slice(0, 50) });
      return 0;
    }
    const variant = parseInt(match[1], 10);
    // Variant i was made by rotating the original by (i-1)*90° CW.
    // So the "amount to rotate original to be upright" = (variant-1)*90.
    const rotations: [0, 90, 180, 270] = [0, 90, 180, 270];
    return rotations[variant - 1];
  } catch (err) {
    logger.warn('Claude orientation detection error', { error: (err as Error).message });
    return 0;
  }
}

export async function analyzeImageWithClaudeApi(
  imagePath: string,
  apiKey: string,
  modelId: string = 'claude-sonnet-4-6',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting image analysis', { imagePath, catalogSize: catalog?.length ?? 0 });

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mediaType = getMediaType(imagePath);

    const client = createClient(apiKey);
    const prompt = buildPrompt(catalog);

    const response = await withRetry(
      (signal) => client.messages.create({
        model: modelId,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: prompt,
              },
            ],
          },
        ],
      }, { signal }),
      'Claude API single image'
    );

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }

    const text = textBlock.text.trim();
    logger.info('Claude API Analyzer: response received', { length: text.length });

    const parsed = safeParseClaudeJson(text, 'Claude API single image');
    if (!parsed) {
      return { success: false, error: 'Claude API: failed to parse JSON response', rawText: text };
    }

    logger.info('Claude API Analyzer: successfully parsed data', {
      invoiceNumber: parsed.invoice_number,
      supplier: parsed.supplier,
      invoiceType: parsed.invoice_type,
      itemsCount: parsed.items.length,
    });

    return { success: true, data: parsed, rawText: text };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Claude API Analyzer: error', { error: msg });
    return { success: false, error: `Claude API error: ${msg}` };
  }
}
