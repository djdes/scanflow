import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { ParsedInvoiceData } from './types';
import { logger } from '../utils/logger';
import { config } from '../config';
import { preprocessInvoiceImage } from './imagePreprocess';

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

// Per-call Claude API timeouts. Single-page invoice scans on Opus take 30-60s
// real-world; multi-page (image OR text) routinely run 60-120s on long invoices.
// Bumped from a flat 90s after observing genuine 65s+ runs being killed by the
// old timeout. Worst-case wall time per invoice = timeout × 3 attempts + 3s
// of backoff, so single = 363s, multi = 543s. Acceptable since user only sees
// status updates, not blocking response.
const CLAUDE_API_TIMEOUT_SINGLE_MS = 120_000;
const CLAUDE_API_TIMEOUT_MULTIPAGE_MS = 180_000;

// Total retries = 2 (3 attempts). Backoff: 1s, 2s.
const CLAUDE_API_MAX_RETRIES = 2;

/**
 * Wrap a Claude API call with retry + exponential backoff.
 * - Retries on 5xx and 429 (rate limit)
 * - Does NOT retry on 4xx auth/bad-request errors (they're not transient)
 * - Each attempt gets its own timeout signal
 *
 * `timeoutMs` defaults to single-page; pass CLAUDE_API_TIMEOUT_MULTIPAGE_MS
 * for multi-page invoice analysis.
 */
async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  label: string,
  timeoutMs: number = CLAUDE_API_TIMEOUT_SINGLE_MS,
): Promise<T> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= CLAUDE_API_MAX_RETRIES; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
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
/**
 * Lean prompt for extracting ONLY the payee (получатель) requisites from a
 * document — invoice, счёт, or платёжное поручение. Used by the dispatcher
 * "Распознать реквизиты с фото" flow on the suppliers page. The dispatcher
 * Claude Code session fetches this verbatim via GET /api/dispatcher/prompt-supplier.
 */
export function buildSupplierPrompt(): string {
  return `Ты — ассистент по распознаванию банковских реквизитов российских контрагентов.

На фото/в PDF — счёт, накладная или платёжное поручение. Извлеки реквизиты ПОЛУЧАТЕЛЯ
(поставщика, продавца, «Получатель»), НЕ плательщика/покупателя.

Если это платёжное поручение — бери блок «Получатель» (а не «Плательщик»).
Если счёт/накладная — бери реквизиты поставщика (продавца), обычно в шапке.

Верни СТРОГО один JSON-объект без markdown-обёртки и без комментариев:
{
  "inn": "ИНН получателя, 10 или 12 цифр, иначе null",
  "kpp": "КПП, 9 цифр, иначе null",
  "name": "наименование организации/ИП, иначе null",
  "bank_bic": "БИК банка получателя, 9 цифр, иначе null",
  "account": "расчётный счёт получателя, 20 цифр, иначе null",
  "bank_corr_account": "корреспондентский счёт банка, 20 цифр, иначе null",
  "bank_name": "наименование банка, иначе null",
  "address": "юридический адрес, иначе null"
}

Правила:
- Только цифры в inn/kpp/bic/account/corr_account (без пробелов и знаков).
- Если поле не нашёл — ставь null, НЕ выдумывай.
- Кириллицу сохраняй как есть (UTF-8), не транслитерируй.
- Никакого текста вне JSON.`;
}

export function buildPrompt(catalog?: CatalogEntry[]): string {
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
   • После "/" в "ИНН/КПП продавца" → supplier_kpp (9 цифр; у ИП КПП отсутствует — оставь null)
   • Для "счёт на оплату": ищи также БИК банка, р/сч, к/сч, адрес поставщика.

2) ТАБЛИЦА ТОВАРОВ. Структура колонок для ТОРГ-12/УПД (слева-направо):
   │  1  │ 1a     │ 1б │ 2   │ 3       │ 4     │ 5        │ 6  │ 7     │ 8       │ 9           │ 10 │ 11  │
   │ Код │ №      │ Код│ Ед. │ Кол-во  │ Цена  │ СТОИМ.   │НДС │ Налог │ СУММА   │ СТОИМОСТЬ   │... │     │
   │товар│  п/п   │ вид│ изм │         │(тариф)│ БЕЗ нал. │акц.│ ставка│ налога  │ С налогом   │    │     │
   │     │        │    │     │         │ за ед.│ ВСЕГО    │    │       │ (НДС)   │ ВСЕГО       │    │     │

   ПО СТРОКЕ ТОВАРА извлекай:
     name        ← колонка "1a" (наименование). Бренды/артикулы убирай, вес/объём ОСТАВЛЯЙ
                   ("Кальмар Командорский 5кг" → "Кальмар 5кг"; "Вода 1.5л Сладкая жизнь" → "Вода 1.5л").
                   ВАЖНО: если в названии есть УПАКОВОЧНАЯ ПОДСКАЗКА — "1/12", "1/15", "1/24",
                   "*48", "×100", "/72", "9-12", "10/216" — СОХРАНЯЙ её в name КАК ЕСТЬ.
                   Это критичная информация о коэффициенте упаковки, она нужна для учёта.
                   Пример: "Горбуша нат. 245г*48 ГОСТ (Вяземский РК)" → "Горбуша натуральная 245г*48".
                   "Маслины 280г без косточки, 1/12" → "Маслины без косточки 280г 1/12".
     pack_size   ← если в названии есть такая подсказка, верни ЧИСЛО штук в упаковке
                   (для "*48" → 48, "1/12" → 12, "1/15" → 15, "1/24" → 24, "9-12" → null — это диапазон).
                   Если подсказки нет, верни null.
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
     vat_sum БЕРИ ТОЛЬКО из ИТОГОВОЙ строки по ВСЕЙ накладной
     ("Всего по накладной" / "Всего к оплате" — самая нижняя, самая большая).
     НИКОГДА не из промежуточного "Итого" по странице/разделу: на многолистовой
     накладной "Итого" внизу листа — это сумма ТОЛЬКО этого листа, его НДС
     меньше общего. Если в кадре несколько ячеек "в т.ч. НДС" — бери ту, что
     стоит в строке "Всего по накладной" (нижнюю/наибольшую).
     Если ячейка "в т.ч. НДС" — прочерк/пусто/нечитаема, НО в позициях есть
     колонка "ставка НДС" → НЕ ставь null, посчитай vat_sum как
     Σ(item.total × ставка / (100 + ставка)).

4) МНОГОСТРАНИЧНАЯ НАКЛАДНАЯ:
   • Если на текущем изображении НЕТ строки "Всего к оплате"/"Всего по накладной"
     (промежуточный лист — внизу только "Итого" по этому листу), верни
     total_sum: null и vat_sum: null. Промежуточный "Итого" листа — НЕ итог
     накладной. Не пытайся подставить сумму последнего товара.
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
     И ПРОВЕРЬ: vat_sum ≈ Σ(items[i].total × ставка_i / (100 + ставка_i)).
     Если vat_sum заметно МЕНЬШЕ этой суммы — ты, скорее всего, взял НДС из
     промежуточного "Итого" по листу, а не из "Всего по накладной". Перечитай
     итоговый блок и возьми НДС из строки по всей накладной.

================================================================
ФОРМАТ ОТВЕТА (строго этот JSON, никаких markdown-ограждений)
================================================================

{"invoice_type":"счет_на_оплату|торг_12|упд|счет_фактура","invoice_number":"...","invoice_date":"YYYY-MM-DD","supplier":"...","supplier_inn":"...","supplier_kpp":"...","supplier_bik":"...","supplier_account":"...","supplier_corr_account":"...","supplier_address":"...","total_sum":число,"vat_sum":число,"items":[{"name":"...","quantity":число,"unit":"шт|кг|л|уп","price":число,"total":число,"vat_rate":число,"row_no":число,"pack_size":число_или_null${catalogBlock ? ',"catalog_idx":номер_или_null' : ''}}]}

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
  } else {
    // Drop null/non-object elements (jsonrepair can introduce holes). Every
    // downstream consumer does items.map(i => ({ ...i.quantity })), so a single
    // null element would turn a recoverable response into a hard invoice failure.
    const before = data.items.length;
    data.items = data.items.filter((it) => it != null && typeof it === 'object');
    if (data.items.length !== before) {
      logger.warn(`${label}: dropped ${before - data.items.length} null/non-object item(s)`);
    }
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
 * Read an image file, run the Phase-1 pre-OCR enhancement (contrast/sharpen —
 * see imagePreprocess.ts), and return base64 + the matching media type. The
 * preprocessor outputs JPEG on success (sniffed via FF D8 magic) and falls back
 * to the original bytes on any failure, so the media type stays correct.
 */
async function encodeImageForApi(imagePath: string): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }> {
  const raw = await fs.promises.readFile(imagePath);
  const pre = await preprocessInvoiceImage(raw);
  const isJpeg = pre.length > 2 && pre[0] === 0xFF && pre[1] === 0xD8;
  return { data: pre.toString('base64'), mediaType: isJpeg ? 'image/jpeg' : getMediaType(imagePath) };
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
              + `  2. invoice_number/invoice_date/supplier/supplier_inn/supplier_kpp — бери из той страницы, где они не null (обычно первая).\n`
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
      'Claude API multi-page text',
      CLAUDE_API_TIMEOUT_MULTIPAGE_MS,
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
      const { data: base64Image, mediaType } = await encodeImageForApi(imagePath);
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
      'Claude API multi-image',
      CLAUDE_API_TIMEOUT_MULTIPAGE_MS,
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
 * Detect orientation by showing Sonnet all four rotations side-by-side and
 * asking which one is upright. More reliable than "how many degrees" because
 * the model can compare variants visually instead of doing mental rotation.
 *
 * previewBuffers: [rot0, rot90, rot180, rot270] — all already rotated, JPEG.
 * Returns how many degrees CLOCKWISE the ORIGINAL needs to be rotated.
 *
 * Aggressive timeout + no retries: if this hangs or fails, we must fall
 * through to the main OCR quickly (rather than sit on the invoice for
 * minutes). Wrong rotation is a much milder failure than a stuck queue.
 */
const ORIENT_TIMEOUT_MS = 30_000;

export async function detectOrientationWithClaude(
  previewsBase64: [string, string, string, string],
  apiKey: string,
): Promise<0 | 90 | 180 | 270> {
  const client = createClient(apiKey);
  try {
    // Single attempt with its own signal — don't use withRetry. If it
    // fails, caller gets 0 back and OCR proceeds with the original orientation.
    const signal = AbortSignal.timeout(ORIENT_TIMEOUT_MS);
    const response = await client.messages.create({
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
    }, { signal });
    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') return 0;
    const match = textBlock.text.match(/\b([1-4])\b/);
    if (!match) {
      logger.warn('Orientation: unparseable response', { text: textBlock.text.slice(0, 50) });
      return 0;
    }
    const variant = parseInt(match[1], 10);
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
    const { data: base64Image, mediaType } = await encodeImageForApi(imagePath);

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

/**
 * Narrow mapping-only call. Given a set of invoice items (name + unit only)
 * and the 1C catalog, ask Claude which catalog entry each item corresponds
 * to — or null if no match. No OCR, no re-parsing of the invoice; this is
 * dramatically cheaper and less error-prone than re-running the full analyzer.
 *
 * Input:   [{ key: <opaque caller id>, name, unit? }]
 * Output:  Map<key, { catalog_idx, guid, name }>  (only successful matches)
 */
export interface LlmMapHit {
  catalog_idx: number;
  guid: string;
  name: string;
  pack_size: number | null;
  unit_override: string | null;
}

export async function mapItemsWithClaudeApi(
  items: Array<{ key: string; name: string; unit?: string | null }>,
  catalog: CatalogEntry[],
  apiKey: string,
  modelId: string = 'claude-sonnet-4-6',
): Promise<{
  success: boolean;
  matched?: Map<string, LlmMapHit>;
  error?: string;
  rawText?: string;
}> {
  if (!apiKey) return { success: false, error: 'Anthropic API key not configured' };
  if (!items.length) return { success: true, matched: new Map() };
  if (!catalog.length) return { success: false, error: 'Catalog is empty' };

  const catalogLines = catalog.map((c, i) => {
    const unit = c.unit ? ` (${c.unit})` : '';
    return `[${i + 1}] ${c.name}${unit}`;
  }).join('\n');

  const itemLines = items.map(it => {
    const unit = it.unit ? ` — ${it.unit}` : '';
    return `${it.key}: ${it.name}${unit}`;
  }).join('\n');

  const prompt = `Ты сопоставляешь товары из накладной со справочником номенклатуры 1С.

ПРАВИЛА СОПОСТАВЛЕНИЯ:
  • Сопоставляй по смыслу. OCR мог исказить имя — пытайся восстановить исходный смысл.
  • Производителя/бренд/артикул игнорируй. В справочнике обобщённые названия.
  • Размер/объём/упаковку учитывай ВНИМАТЕЛЬНО: "Молоко 1л" и "Молоко 2л" — РАЗНЫЕ позиции.
  • Если в справочнике НЕТ подходящей позиции — верни catalog_idx: null. Лучше пусто, чем неверно.
  • Единицы измерения должны совпадать ИЛИ быть совместимыми (шт ↔ упак допустимо, кг ↔ шт — НЕТ).

ПРАВИЛА ЕДИНИЦ (unit_override + pack_size):

  Верни единицу так, как она учитывается в 1С для этой позиции (чаще "шт").

  Если в 1С товар ведётся ПОШТУЧНО, а в накладной пришёл в упаковке — два случая:

  (1) КОЭФФИЦИЕНТ ЯВНО УКАЗАН в названии ("100шт/упак", "300шт в упак") →
      pack_size: N, unit_override: "шт"
      Сервер сам умножит qty на N и поделит цену.

  (2) КОЭФФИЦИЕНТА НЕТ, но единица просто другое слово того же смысла
      ("рул" = 1 рулон = 1 шт; "кор" = 1 коробка = 1 шт; "бут" = 1 бутылка = 1 шт) →
      pack_size: null, unit_override: "шт"
      Сервер только переименует единицу, qty и цену не тронет.

  (3) qty измеряется в весе/объёме ("кг", "л", "мл") а 1С тоже в весе → unit_override: null.

  (4) В НАЗВАНИИ В СКОБКАХ указан вес/объём ("Мука (50кг)", "Сахар (50кг)",
      "Масло (5л)"), scan unit="шт" qty=мешков-или-канистр, 1С учёт в "кг" или "л" →
      pack_size: N (из скобок), unit_override: "кг" (или "л").
      Сервер умножит qty на N и переведёт единицу на 1С-единицу.
      Это ВАЖНЫЙ кейс — поставщик продаёт мешками/канистрами, склад в 1С учитывает в весе.

  Примеры:
    "Перчатки 100шт/упак", scan unit="упак", 1С="шт"       → pack_size: 100, unit_override: "шт"
    "Подложка 300шт/упак", scan unit="упак", 1С="шт"       → pack_size: 300, unit_override: "шт"
    "Полотенце рулон 50м",  scan unit="рул",  1С="шт"      → pack_size: null, unit_override: "шт"  (1 рул = 1 шт)
    "Анти-Жир 0,6л триггер", scan unit="кор", 1С="шт"      → pack_size: null, unit_override: "шт"  (1 кор = 1 шт)
    "Молоко 1л канистра",   scan unit="шт",  1С="шт"       → pack_size: null, unit_override: null (уже в шт)
    "Золушка 5л",           scan unit="шт",  1С="шт"       → pack_size: null, unit_override: null
    "Бутылка ПЭТ 150шт/упак", scan unit="шт" qty=150, 1С="шт" → pack_size: null, unit_override: null
                                                              (qty в скане уже в штуках, не развораЧивай снова!)
    "Мука (50кг)",          scan unit="шт", qty=1, 1С="кг"  → pack_size: 50,  unit_override: "кг"  (правило 4)
    "Сахар (50кг)",         scan unit="шт", qty=2, 1С="кг"  → pack_size: 50,  unit_override: "кг"  (2 мешка → 100 кг)
    "Капуста морская (3кг)", scan unit="шт", qty=3, 1С="кг" → pack_size: 3,   unit_override: "кг"  (3 пакета → 9 кг)
    "Масло подсолн (5л)",   scan unit="шт", qty=4, 1С="л"   → pack_size: 5,   unit_override: "л"

  НЕ ВЫДУМЫВАЙ pack_size — только если коэффициент ЯВНО написан в названии
  (число + единица в скобках, или "Nшт/упак").
  Если scan unit уже совпадает с 1С-единицей — pack_size ДОЛЖЕН быть null.

ФОРМАТ ОТВЕТА (строго этот JSON, без markdown, без комментариев):
{"matches":[{"key":"...","catalog_idx":число_или_null,"pack_size":число_или_null,"unit_override":"шт"или_null},...]}

ТОВАРЫ ДЛЯ СОПОСТАВЛЕНИЯ (формат "key: название — единица"):
${itemLines}

================================================================
СПРАВОЧНИК НОМЕНКЛАТУРЫ 1С (${catalog.length} позиций, формат "[номер] имя (единица)"):
================================================================
${catalogLines}`;

  logger.info('Claude API Mapper: start', {
    itemsCount: items.length,
    catalogSize: catalog.length,
    promptBytes: prompt.length,
  });

  try {
    const client = createClient(apiKey);
    const response = await withRetry(
      (signal) => client.messages.create({
        model: modelId,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }, { signal }),
      'Claude API mapper',
    );

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }
    const text = textBlock.text.trim();

    // Reuse the same lenient JSON pipeline as the OCR analyzer.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      logger.warn('Claude API Mapper: no JSON object found', { sample: text.slice(0, 200) });
      return { success: false, error: 'no JSON in response', rawText: text };
    }
    let parsed: { matches?: Array<{ key: string; catalog_idx: number | null; pack_size?: number | null; unit_override?: string | null }> };
    try {
      parsed = JSON.parse(cleanJsonString(match[0]));
    } catch {
      try {
        parsed = JSON.parse(jsonrepair(cleanJsonString(match[0])));
      } catch (err2) {
        logger.warn('Claude API Mapper: JSON repair failed', { error: (err2 as Error).message });
        return { success: false, error: 'json parse failed', rawText: text };
      }
    }

    const matched = new Map<string, LlmMapHit>();
    for (const m of parsed.matches ?? []) {
      if (m.catalog_idx == null || !Number.isFinite(m.catalog_idx)) continue;
      const row = catalog[m.catalog_idx - 1];
      if (!row) continue;
      const ps = typeof m.pack_size === 'number' && isFinite(m.pack_size) && m.pack_size > 0
        ? m.pack_size
        : null;
      const uo = typeof m.unit_override === 'string' && m.unit_override.trim()
        ? m.unit_override.trim()
        : null;
      matched.set(String(m.key), {
        catalog_idx: m.catalog_idx,
        guid: row.guid,
        name: row.name,
        pack_size: ps,
        // unit_override stands on its own (rename only, no qty math) OR pairs
        // with pack_size (rename + multiply). Default to "шт" when pack_size
        // is set but model forgot to echo unit_override.
        unit_override: uo || (ps ? 'шт' : null),
      });
    }

    logger.info('Claude API Mapper: done', {
      requested: items.length,
      matched: matched.size,
    });

    return { success: true, matched, rawText: text };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Claude API Mapper: error', { error: msg });
    return { success: false, error: `Claude API error: ${msg}` };
  }
}
