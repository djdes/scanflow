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

const CLAUDE_API_PROMPT = `Ты эксперт по распознаванию накладных. Проанализируй это изображение накладной и извлеки структурированные данные.

ВАЖНО:
- Верни ТОЛЬКО валидный JSON без пояснений и markdown
- Названия товаров указывай ТОЧНО как на изображении
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

/**
 * Clean JSON string from common LLM artifacts: trailing commas, comments, etc.
 */
function cleanJsonString(raw: string): string {
  return raw
    .replace(/,\s*([}\]])/g, '$1')       // trailing commas
    .replace(/\/\/[^\n]*/g, '')           // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '');    // multi-line comments
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
  modelId: string = 'claude-sonnet-4-5-20250514',
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting multi-page TEXT analysis', { textLength: combinedOcrText.length, pageCount });

  try {
    const client = createClient(apiKey);

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 8192,
      messages: [
        {
          role: 'user',
          content: `${CLAUDE_API_PROMPT}\n\nВАЖНО: Это многостраничная накладная (${pageCount} страниц). OCR-текст всех страниц объединён ниже с разделителем "--- СТРАНИЦА ---". Объедини ВСЕ товары со ВСЕХ страниц в один список items. Итоговую сумму возьми из последней страницы (строка "Всего по накладной" или "На сумму").\n\nOCR-ТЕКСТ:\n${combinedOcrText}`,
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }

    const text = textBlock.text.trim();
    logger.info('Claude API Analyzer: multi-page text response received', { length: text.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'Claude API: no JSON found in response', rawText: text };
    }

    const parsed = JSON.parse(cleanJsonString(jsonMatch[0])) as ParsedInvoiceData;
    if (!parsed.items) parsed.items = [];

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
  modelId: string = 'claude-sonnet-4-5-20250514',
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

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 8192,
      messages: [{ role: 'user', content }],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }

    const text = textBlock.text.trim();
    logger.info('Claude API Analyzer: multi-page response received', { length: text.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'Claude API: no JSON found in response', rawText: text };
    }

    const parsed = JSON.parse(cleanJsonString(jsonMatch[0])) as ParsedInvoiceData;
    if (!parsed.items) parsed.items = [];

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
  modelId: string = 'claude-sonnet-4-5-20250514',
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

    const response = await client.messages.create({
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
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }

    const text = textBlock.text.trim();
    logger.info('Claude API Analyzer: response received', { length: text.length });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'Claude API: no JSON found in response', rawText: text };
    }

    const parsed = JSON.parse(cleanJsonString(jsonMatch[0])) as ParsedInvoiceData;
    if (!parsed.items) {
      parsed.items = [];
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
