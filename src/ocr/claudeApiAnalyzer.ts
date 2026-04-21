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

const CLAUDE_API_PROMPT = `Ты эксперт по распознаванию накладных. Проанализируй это изображение накладной и извлеки структурированные данные.

ВАЖНО:
- Верни ТОЛЬКО валидный JSON без пояснений и markdown
- Названия товаров: убирай торговые марки и артикулы, но ОСТАВЛЯЙ вес/объём (1кг, 0.5л, 360шт). Примеры:
  "Вода Питьевая Негазированная 5л пэт Сладкая Жизнь" → "Вода питьевая негазированная 5л"
  "Кальмар Командорский Очищенный 5кг" → "Кальмар очищенный 5кг"
  "Филе Грудки Куриной Черкизово Охлажденное 1кг" → "Филе грудки куриной охлажденное 1кг"
  "Яйцо Куриное Чамзинка Коричневое С1 360шт" → "Яйцо куриное С1 360шт"
  "Лопатка свиная б/к охл. в/у Мираторг - 5,3 кг" → "Лопатка свиная б/к охлажденная 5.3кг"
- Если поле не найдено, используй null
- Для чисел используй точку как десятичный разделитель (30.60, не 30,60)
- Определи тип документа: "счет_на_оплату", "торг_12", "упд" или "счет_фактура"
- Данные покупателя (ООО "БФС") НЕ нужны — извлекай только данные ПОСТАВЩИКА
- Для "счет_на_оплату": извлеки ИНН, БИК, расчетный счет, корр. счет и адрес поставщика
- Для остальных типов: извлеки только ИНН поставщика (если есть)
- vat_rate — ставка НДС в процентах для каждого товара (10, 20, 0 или null если не указана). У разных товаров может быть разная ставка!
- vat_sum — общая сумма НДС по накладной (из строки "В том числе НДС" или "НДС" в итогах)

Формат ответа:
{"invoice_type":"тип документа","invoice_number":"номер или null","invoice_date":"YYYY-MM-DD или null","supplier":"название поставщика или null","supplier_inn":"ИНН поставщика или null","supplier_bik":"БИК банка или null","supplier_account":"расчетный счет или null","supplier_corr_account":"корр. счет или null","supplier_address":"адрес поставщика или null","total_sum":число или null,"vat_sum":число или null,"items":[{"name":"название товара","quantity":число или null,"unit":"кг/шт/л/уп или null","price":число или null,"total":число или null,"vat_rate":число или null}]}`;

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
            content: `${CLAUDE_API_PROMPT}\n\nВАЖНО: Это многостраничная накладная (${pageCount} страниц). OCR-текст всех страниц объединён ниже с разделителем "--- СТРАНИЦА ---". Объедини ВСЕ товары со ВСЕХ страниц в один список items. Итоговую сумму возьми из последней страницы (строка "Всего по накладной" или "На сумму").\n\nOCR-ТЕКСТ:\n${combinedOcrText}`,
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
