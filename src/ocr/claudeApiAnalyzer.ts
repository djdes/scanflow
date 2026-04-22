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

const CLAUDE_API_PROMPT = `Ты эксперт по русским товарным накладным. Проанализируй изображение и верни ТОЛЬКО валидный JSON (без markdown, без комментариев, без пояснений).

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
     total       ← колонка 9 "Стоимость С НАЛОГОМ — всего" (САМАЯ ПРАВАЯ большая цифра
                   в строке, после колонок 5/6/7/8). НИКОГДА не колонка 5 (без НДС).

                   КАК ОТЛИЧИТЬ 5 от 9:
                   — Колонка 9 > колонка 5 ровно на размер НДС (для vat_rate=20%: 9 = 5 × 1.2;
                     для vat_rate=10%: 9 = 5 × 1.1).
                   — Колонка 9 находится ПРАВЕЕ колонки 8 (сумма налога).
                   — В ИТОГОВОЙ строке "Всего к оплате" правая большая цифра = Σ колонки 9,
                     левая = Σ колонки 5. Правую бери для total_sum, ЭТА ЖЕ колонка — для
                     item.total в каждой строке.

                   ПРОВЕРКА НА УРОВНЕ СТРОКИ:
                   total = quantity × price (в пределах 1%). Если total ≈ qty × price × 1.0,
                   значит price УЖЕ с НДС — ok. Если total ≈ qty × price × 1.1 или × 1.2 —
                   ты взял price без НДС, ПЕРЕЧИТАЙ.
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
ОБЯЗАТЕЛЬНАЯ САМОПРОВЕРКА (двухэтапная — если пропустить, будут ошибки)
================================================================

ЭТАП 1 — ПОСЛЕ ЧТЕНИЯ ВСЕХ СТРОК, ПЕРЕД ВЫДАЧЕЙ JSON:

  A. Для каждой строки: total ≈ quantity × price (±1%).
     Если total ≫ qty × price, ты взял qty с лишними нулями ("2,000" → 2000 вместо 2).
     Если total < qty × price × 1.05, возможен правильный post-VAT price
     (qty × price ≈ total, всё ок).
     Если total ≈ qty × price × (1 + vat_rate/100) — ты взял total из колонки 5 (БЕЗ НДС),
     а price — с НДС. Должно быть наоборот.
     ПЕРЕЧИТАЙ строку.

  B. Если на странице есть строка "Всего к оплате":
       Σ(items[i].total) ДОЛЖНА РАВНЯТЬСЯ total_sum (± 1 руб).

     ЕСЛИ РАСХОДИТСЯ БОЛЬШЕ ЧЕМ НА 1% — СТОП. Не возвращай JSON с неверной суммой.
     Диагностика:
       1. Посчитай Σ items на калькуляторе: какая разница с total_sum?
       2. Если разница ≈ Σ(items[i].total × vat_rate/100) — значит для ВСЕХ строк
          ты взял total из колонки 5 (без НДС). Перечитай, бери колонку 9.
       3. Если разница МЕНЬШЕ Σ VAT — ты взял колонку 5 только для ЧАСТИ строк.
          Найди каждую строку, где total ≈ qty × price (подозрительно — это и есть
          pre-VAT). Для каждой такой строки сверь с соседней колонкой справа:
          правильное значение должно быть больше ровно на (1 + vat_rate/100).
       4. Если разница не похожа на VAT вообще — проверь, не пропустил ли ты строку
          товара, или не сдвоил ли qty. Перечитай таблицу сверху вниз.

  C. total_sum − vat_sum ≈ Σ(items[i].total) / (1 + средний_vat/100).
     Это проверка что vat_sum = Σ(item.total × vat_rate / (100 + vat_rate)).

ЭТАП 2 — ЕСЛИ ЛЮБАЯ ПРОВЕРКА A/B/C УПАЛА, ВЕРНИСЬ К ТАБЛИЦЕ И ПЕРЕЧИТАЙ СТРОКИ, У
КОТОРЫХ total не бьётся. НЕ возвращай JSON с известно-неверными числами. Лучше
исправить сейчас, чем прислать результат, где сумма не сходится с накладной.

================================================================
ФОРМАТ ОТВЕТА (строго этот JSON, никаких markdown-ограждений)
================================================================

{"invoice_type":"счет_на_оплату|торг_12|упд|счет_фактура","invoice_number":"...","invoice_date":"YYYY-MM-DD","supplier":"...","supplier_inn":"...","supplier_bik":"...","supplier_account":"...","supplier_corr_account":"...","supplier_address":"...","total_sum":число,"vat_sum":число,"items":[{"name":"...","quantity":число,"unit":"шт|кг|л|уп","price":число,"total":число,"vat_rate":число,"row_no":число}]}

Все незаполненные поля ставь null. Числа — с точкой (30.60). Никогда не оборачивай JSON в три обратные кавычки.`;

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
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting multi-page TEXT analysis', { textLength: combinedOcrText.length, pageCount });

  try {
    const client = createClient(apiKey);

    const response = await withRetry(
      (signal) => client.messages.create({
        model: modelId,
        max_tokens: 8192,
        messages: [
          {
            role: 'user',
            content: `${CLAUDE_API_PROMPT}\n\nВАЖНО — ОБЪЕДИНЕНИЕ СТРАНИЦ:\n`
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
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting multi-page analysis', { pages: imagePaths.length });

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

    content.push({
      type: 'text',
      text: `${CLAUDE_API_PROMPT}\n\nВАЖНО: Это многостраничная накладная (${imagePaths.length} страниц). Объедини ВСЕ товары со ВСЕХ страниц в один список items. Итоговую сумму возьми из последней страницы (строка "Всего по накладной").`,
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

export async function analyzeImageWithClaudeApi(
  imagePath: string,
  apiKey: string,
  modelId: string = 'claude-sonnet-4-6',
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting image analysis', { imagePath });

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mediaType = getMediaType(imagePath);

    const client = createClient(apiKey);

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
                text: CLAUDE_API_PROMPT,
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
