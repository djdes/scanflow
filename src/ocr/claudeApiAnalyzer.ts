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

// Per-call Claude API timeouts. На structured outputs + adaptive thinking (effort
// medium) плотная страница ТОРГ-12 на 20 позиций читается ~120-180с (Sonnet 5
// думает над каждой строкой), а редкая огромная — дольше. 120с убивали такие
// страницы посреди чтения → подняли single до 240с. Multi-page (image OR text)
// тоже 240с. Worst-case = timeout × 3 попытки + backoff; фон, пользователь видит
// только статус, не блокирующий ответ.
const CLAUDE_API_TIMEOUT_SINGLE_MS = 240_000;
const CLAUDE_API_TIMEOUT_MULTIPAGE_MS = 240_000;

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
СТРУКТУРА ДОКУМЕНТА (ТОРГ-12, УПД, счёт-фактура, счёт на оплату,
акт, кассовый чек, авансовый отчёт)
================================================================

1) ШАПКА (верх страницы, до таблицы товаров):
   • Сначала определи invoice_type по заголовку. Для акта выполненных работ — "акт",
     кассового/товарного чека — "кассовый_чек", авансового отчёта — "авансовый_отчет".
     Если документ не относится ни к одному поддержанному виду — "прочее".
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

{"invoice_type":"счет_на_оплату|торг_12|упд|счет_фактура|акт|кассовый_чек|авансовый_отчет|прочее","invoice_number":"...","invoice_date":"YYYY-MM-DD","supplier":"...","supplier_inn":"...","supplier_kpp":"...","supplier_bik":"...","supplier_account":"...","supplier_corr_account":"...","supplier_address":"...","total_sum":число,"vat_sum":число,"items":[{"name":"...","quantity":число,"unit":"шт|кг|л|уп","price":число,"total":число,"vat_rate":число,"row_no":число,"pack_size":число_или_null${catalogBlock ? ',"catalog_idx":номер_или_null' : ''}}]}

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

// NB: safeParseClaudeJson удалён — на claude_api-пути JSON гарантирован
// output_config.format (см. normalizeStructuredResponse ниже). cleanJsonString
// оставлен: им ещё пользуется mapItemsWithClaudeApi (mapping-only вызов).

export function createClient(apiKey: string): Anthropic {
  const proxyUrl = config.anthropicProxyUrl;
  if (proxyUrl) {
    logger.info('Claude API: using HTTP proxy', { proxy: proxyUrl.replace(/\/\/.*@/, '//*:*@') });
    const dispatcher = new ProxyAgent(proxyUrl);
    const proxiedFetch: typeof globalThis.fetch = (url, init) =>
      undiciFetch(url as any, { ...init as any, dispatcher }) as any;
    // maxRetries:0 — withRetry() is the sole retry layer (see below). Leaving the
    // SDK default (2) would compound multiplicatively to ~9 calls per analysis.
    return new Anthropic({ apiKey, fetch: proxiedFetch, maxRetries: 0 });
  }
  return new Anthropic({ apiKey, maxRetries: 0 });
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

// ============================================================================
//  Structured-output путь (Sonnet 5): system-инструкции + prompt caching +
//  гарантированный JSON через output_config.format + adaptive thinking.
//  См. docs/superpowers/specs/2026-07-09-ocr-accuracy-improvement-design.md
// ============================================================================

import { validateParsedInvoice, ValidationIssue } from './invoiceValidator';

// max_tokens под adaptive thinking: размышления тратят тот же бюджет, поэтому
// заметно больше прежних 4096/8192. Одиночная — non-streaming (16k безопасно
// под HTTP-таймаутом), многостраничная — только streaming (SDK требует stream
// для больших max_tokens).
// Единый потолок вывода (thinking + JSON) для structured-output пути. 32k с
// запасом покрывает плотные накладные на effort medium. Всегда через streaming.
const STRUCTURED_MAX_TOKENS_MULTI = 32000;

// effort: 'low' читает плотные таблицы (15-20 позиций) НЕБРЕЖНО — систематически
// сдвигает суммы соседних строк (проверено на #202: позиции 9-11 стабильно
// перепутаны в двух прогонах). Такой сдвиг НЕ ловится валидатором на листе без
// «Итого» (total_sum=null → нет сверки Σ). 'medium' читает аккуратно (правильно
// с первого раза на тех же накладных), а max_tokens=32k + streaming снимают
// прежнюю проблему обрезки/таймаута. Латентность ~2-3 мин на плотную страницу
// приемлема для фоновой обработки. Вынесено в константу.
const STRUCTURED_EFFORT: 'low' | 'medium' | 'high' | 'max' = 'medium';

/**
 * Статичные доменные инструкции. Переезжают в `system` с cache_control, поэтому
 * между накладными читаются из кэша (~0.1× цены) и имеют вес system-роли —
 * Sonnet 5 следует им буквальнее, чем тому же тексту в user-сообщении.
 *
 * Формат ответа сюда НЕ входит — его гарантирует output_config.format (schema).
 * Каталог номенклатуры — отдельный system-блок (свой cache breakpoint).
 */
const INVOICE_INSTRUCTIONS = `Ты эксперт по русским товарным накладным. Тебе дают фотографию (или OCR-текст) накладной, ты извлекаешь из неё структурированные данные строго по заданной JSON-схеме.

================================================================
СТРУКТУРА НАКЛАДНОЙ (ТОРГ-12, УПД, счёт-фактура, счёт на оплату)
================================================================

1) ШАПКА (верх страницы, до таблицы товаров):
   • "Счёт-фактура №", "УПД №", "Накладная №", "Счёт №" → invoice_number
     (обычно короткий: "261", "1/153468", "17-0048600").
   • "от DD месяца YYYY г." → invoice_date (строго YYYY-MM-DD).
   • "Продавец"/"Поставщик"/"Грузоотправитель" → supplier. Это ПРОДАВЕЦ товара
     (ООО/АО/ИП/самозанятый). Покупателя (обычно ООО "БФС") игнорируй.
     ⚠️ НЕ путай поставщика с его БАНКОМ! Строки вида «"АЛЬФА-БАНК"», «Сбербанк»,
     «ВТБ (ПАО)», «Точка Банк» рядом с БИК/к-сч — это банк поставщика, а НЕ supplier.
     Если поставщик — ИП (напр. «ИП Горбунов А.В., ИНН ...»), в supplier пиши именно
     ИП/ФИО, а не название банка из его реквизитов.
   • "ИНН/КПП продавца", "ИНН поставщика" → supplier_inn (10 или 12 цифр до "/").
   • После "/" в "ИНН/КПП продавца" → supplier_kpp (ровно 9 цифр; у ИП КПП нет — null).
   • Для "счёт на оплату" ищи также supplier_bik, supplier_account (р/сч),
     supplier_corr_account (к/сч), supplier_address.

2) ТАБЛИЦА ТОВАРОВ. Колонки ТОРГ-12/УПД (слева-направо):
   │ Код товара │ № п/п │ Код вида │ Ед.изм │ Кол-во │ Цена(тариф) │ Стоим. БЕЗ нал. │ НДС акц │ Ставка │ Сумма налога │ Стоимость С налогом │
   Из строки товара извлекай:
     name      ← "Наименование". Бренды/артикулы убирай, вес/объём ОСТАВЛЯЙ
                 ("Кальмар Командорский 5кг" → "Кальмар 5кг").
     row_no    ← "№ п/п" (2-я колонка слева). НЕ путай с "Код товара" (артикул "13-0659").
                 На 2-й странице нумерация продолжается (10, 11, ...).
     quantity  ← "Количество".
     unit      ← "Единица измерения" (шт, кг, л, уп, пач, упак).
     price     ← цена ЗА ЕДИНИЦУ С НДС = total / quantity. Колонка «БЕЗ налога» — НЕ price.
     total     ← "Стоимость С налогом — всего" (самая правая цифра строки). НИКОГДА не «без НДС».
     vat_rate  ← ставка НДС (10, 20, 22, 0). "без акциза" акциза не касается.

3) ИТОГ (строка под таблицей): "Всего к оплате", "Всего по накладной", "Итого", "К оплате".
   В строке две цифры: левая = Σ без НДС (НЕ брать), правая = Σ с НДС → total_sum.

4) НДС:
   • "В том числе НДС" / "Сумма налога, предъявляемая покупателю" → vat_sum.
   • vat_sum бери ТОЛЬКО из ИТОГОВОЙ строки по ВСЕЙ накладной (нижней/наибольшей),
     НИКОГДА из промежуточного "Итого" по странице/разделу.
   • Если ячейка "в т.ч. НДС" пуста/прочерк, но в позициях есть ставка НДС —
     посчитай vat_sum = Σ(total × ставка / (100 + ставка)).
   • НЕТ колонки «ставка НДС» по позициям (частый случай для «счёта на оплату») —
     НЕ ставь 20% по умолчанию! Вычисли ставку из напечатанной строки «В том числе НДС»:
     ставка = vat_sum / (total_sum − vat_sum) × 100, округли до стандартной (10, 20 или 22).
     Пример: НДС 7097.91 при итоге 39361.10 → 7097.91/(39361.10−7097.91)=0.22 → ставка 22%.
     Проставь эту ставку ВСЕМ позициям, а vat_sum оставь как напечатано (НЕ пересчитывай
     его под угаданную ставку). В 2026 году ставка НДС часто 22%, не 20%.

5) МНОГОСТРАНИЧНАЯ НАКЛАДНАЯ:
   • total_sum/vat_sum — из итоговой строки, которая ЕСТЬ на ЭТОМ листе:
       – есть "Всего по накладной"/"Всего к оплате" → бери её (общий итог накладной);
       – на листе только "Итого" по листу (промежуточный субитог, без общего итога)
         → всё равно верни сумму этого "Итого" (с НДС → total_sum, НДС → vat_sum).
         Это итог ЛИСТА; общий итог всей накладной возьмётся с последнего листа при
         сшивке. Так серверная проверка сверит Σ(позиций листа) с итогом листа.
     total_sum = null ТОЛЬКО если на листе нет НИКАКОЙ итоговой строки. НЕ подставляй
     сумму последнего товара как итог.
   • Нет "УПД №..."/"Счёт-фактура №..." в шапке (лист-продолжение) → invoice_number = null
     (если номер продублирован на листе — можно вернуть его). НЕ бери "Код товара" из
     первого столбца как номер накладной.

ОБЩЕЕ ПРАВИЛО ПУСТЫХ ПОЛЕЙ: значение неизвестно/отсутствует → ставь null (для
банковских реквизитов — можно просто не указывать поле). НЕ выдумывай значения.

================================================================
ДИСЦИПЛИНА ЧТЕНИЯ ЦИФР (главный источник ошибок — читай медленно)
================================================================
  • Запятая = десятичный разделитель: "2,000" = 2 штуки, "2,5" = 2.5. Пробел =
    разделитель тысяч: "2 000" = 2000. Если получилось количество > 10000 —
    ты вставил лишние нули, перечитай.
  • quantity НЕ может быть длиннее 4 цифр — это код товара (артикул "113393"),
    а не количество.
  • price — это колонка «Цена С НДС» (= total / quantity), а НЕ колонка «без НДС».
  • total — самая правая цифра строки (со всеми налогами).
  • Числа возвращай с точкой как десятичным разделителем (30.60), без пробелов.

================================================================
ТОЧНОСТЬ НАЗВАНИЙ
================================================================
  • Кириллицу сохраняй как есть (UTF-8), не транслитерируй.
  • Вес/объём/упаковку в названии сохраняй дословно. Если есть упаковочная подсказка
    ("1/12", "*48", "×100", "/72", "10/216") — ОСТАВЬ её в name КАК ЕСТЬ и верни число
    штук в упаковке в pack_size (для "*48" → 48, "1/12" → 12; для диапазона "9-12" → pack_size: null).
    Пример: "Горбуша нат. 245г*48 ГОСТ (Вяземский РК)" → name "Горбуша натуральная 245г*48", pack_size 48.
  • Бренды/производителя/артикул из name убирай.
  • Если фрагмент названия нечитаем — НЕ выдумывай, перепиши только читаемую часть.

================================================================
САМОПРОВЕРКА (инварианты — сверься перед выдачей)
================================================================
  • Для каждой строки: total ≈ quantity × price (±1%).
  • Σ(items.total) ≈ total_sum (если total_sum есть).
  • vat_sum ≈ Σ(items.total × ставка / (100 + ставка)).
  Если инвариант не сходится — перечитай проблемное место на изображении.`;

/**
 * Инструкции по сопоставлению с каталогом 1С — отдельный system-блок (свой
 * cache breakpoint, т.к. каталог меняется реже инструкций).
 */
function buildCatalogSystemText(catalog: CatalogEntry[]): string {
  const lines = catalog.map((c, i) => {
    const unit = c.unit ? ` (${c.unit})` : '';
    return `[${i + 1}] ${c.name}${unit}`;
  }).join('\n');
  return `================================================================
СПРАВОЧНИК НОМЕНКЛАТУРЫ 1С (${catalog.length} позиций)
================================================================

Для КАЖДОЙ позиции накладной найди соответствующий товар в списке ниже и укажи его
номер в поле "catalog_idx". Правила:
  • Сопоставляй по смыслу, а не по буквальному совпадению (OCR искажает имена).
  • Производителя/бренд/артикул игнорируй — в справочнике обобщённые названия.
  • Размер/объём учитывай ВНИМАТЕЛЬНО: "Молоко 1л" и "Молоко 2л" — РАЗНЫЕ позиции.
  • Нет подходящей позиции → catalog_idx: null. Лучше пусто, чем неверно.

СПИСОК:
${lines}`;
}

/**
 * Собирает массив system-блоков с cache_control. Блок 1 — инструкции, блок 2 —
 * каталог (если LLM-маппер включён). Порядок фиксирован → кэш стабилен.
 */
export function buildSystemBlocks(catalog?: CatalogEntry[]): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: INVOICE_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
  ];
  if (catalog && catalog.length > 0) {
    blocks.push({ type: 'text', text: buildCatalogSystemText(catalog), cache_control: { type: 'ephemeral' } });
  }
  return blocks;
}

/**
 * JSON-схема ответа для output_config.format. Повторяет ParsedInvoiceData.
 *
 * Structured outputs накладывает ДВА независимых ограничения, между которыми
 * нужно пройти:
 *   1. Не больше 16 параметров с union-типами (["string","null"] / anyOf) —
 *      иначе 400 "too many parameters with union types".
 *   2. Не слишком много ОПЦИОНАЛЬНЫХ полей (отсутствующих в required): грамматика
 *      «любое подмножество полей» комбинаторно взрывается — иначе 400 "Schema is
 *      too complex" (все ~19 полей опциональными не проходят).
 *
 * Решение: часто встречающиеся поля делаем required + nullable-union (модель
 * ОБЯЗАНА их вернуть, значением или null — никакой комбинаторики подмножеств).
 * Опциональными (plain-тип, вне required, 0 unions) оставляем только редкие
 * банковские реквизиты — они есть лишь на «счёте на оплату». Итого 14–15 unions
 * и 4 опциональных поля — с запасом по обоим лимитам. null downstream = «нет
 * значения» (ParsedInvoiceData всё равно опционально типизирует эти поля).
 * Прочее: additionalProperties:false везде, без minimum/maxLength (валидация —
 * invoiceValidator), без рекурсии.
 */
export function buildInvoiceSchema(withCatalogIdx: boolean): Record<string, unknown> {
  const num = { type: ['number', 'null'] };
  const str = { type: ['string', 'null'] };
  const itemProps: Record<string, unknown> = {
    name: { type: 'string' },
    quantity: num,
    unit: str,
    price: num,
    total: num,
    vat_rate: num,
    row_no: num,
    pack_size: num,
  };
  const itemRequired = ['name', 'quantity', 'unit', 'price', 'total', 'vat_rate', 'row_no', 'pack_size'];
  if (withCatalogIdx) {
    itemProps.catalog_idx = num;
    itemRequired.push('catalog_idx');
  }
  return {
    type: 'object',
    additionalProperties: false,
    // required + nullable — модель вернёт поле всегда (значение или null).
    required: ['invoice_type', 'invoice_number', 'invoice_date', 'supplier', 'supplier_inn', 'supplier_kpp', 'total_sum', 'vat_sum', 'items'],
    properties: {
      invoice_type: { type: 'string', enum: ['счет_на_оплату', 'торг_12', 'упд', 'счет_фактура', 'акт', 'кассовый_чек', 'авансовый_отчет', 'прочее'] },
      invoice_number: str,
      invoice_date: str,
      supplier: str,
      supplier_inn: str,
      supplier_kpp: str,
      // Банковские реквизиты — опциональные (только на «счёте на оплату»), plain-тип.
      supplier_bik: { type: 'string' },
      supplier_account: { type: 'string' },
      supplier_corr_account: { type: 'string' },
      supplier_address: { type: 'string' },
      total_sum: num,
      vat_sum: num,
      items: {
        type: 'array',
        items: { type: 'object', additionalProperties: false, required: itemRequired, properties: itemProps },
      },
    },
  };
}

/**
 * Нормализует ответ structured-output пути в ParsedInvoiceData. JSON гарантирован
 * API, поэтому здесь только: найти text-блок, распарсить, привести items к массиву
 * без null-элементов (downstream делает items.map — один null сломал бы всё).
 */
function normalizeStructuredResponse(text: string, label: string): ParsedInvoiceData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger.warn(`${label}: structured JSON.parse failed (unexpected — schema-constrained)`, {
      error: (err as Error).message,
      sample: text.slice(0, 300),
    });
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    logger.warn(`${label}: parsed response is not an object`);
    return null;
  }
  const data = parsed as ParsedInvoiceData;
  if (!Array.isArray(data.items)) {
    data.items = [];
  } else {
    data.items = data.items.filter((it) => it != null && typeof it === 'object');
  }
  return data;
}

interface StructuredCallParams {
  client: Anthropic;
  modelId: string;
  system: Anthropic.TextBlockParam[];
  userContent: Anthropic.MessageParam['content'];
  withCatalogIdx: boolean;
  multipage: boolean;
  label: string;
  timeoutMs: number;
}

/**
 * Единственная точка обращения к API на structured-output пути. Собирает запрос
 * (system + schema + adaptive thinking), гоняет через withRetry, извлекает и
 * нормализует JSON. Никогда не бросает на ошибках API — возвращает {success:false}.
 */
async function callClaudeStructured(p: StructuredCallParams): Promise<ApiAnalyzerResult> {
  const schema = buildInvoiceSchema(p.withCatalogIdx);
  const baseParams = {
    model: p.modelId,
    // Всегда 32k: на effort medium adaptive thinking на плотной странице легко
    // съедает 16k (thinking + JSON) и обрезает ответ. Запас снимает риск.
    max_tokens: STRUCTURED_MAX_TOKENS_MULTI,
    thinking: { type: 'adaptive' as const },
    system: p.system,
    output_config: { effort: STRUCTURED_EFFORT, format: { type: 'json_schema' as const, schema } },
    messages: [{ role: 'user' as const, content: p.userContent }],
  };
  try {
    // Всегда streaming: SDK требует его при больших max_tokens (иначе HTTP-таймаут),
    // и он же даёт «живой» прогресс. finalMessage() собирает полный ответ.
    const response = await withRetry(async (signal) => {
      const stream = p.client.messages.stream(baseParams, { signal });
      return await stream.finalMessage();
    }, p.label, p.timeoutMs);

    if (response.stop_reason === 'max_tokens') {
      logger.warn(`${p.label}: stop_reason=max_tokens — ответ обрезан`, {
        maxTokens: baseParams.max_tokens,
      });
    }

    // Usage/cache telemetry — подтверждает, что prompt caching работает
    // (cache_read_input_tokens > 0 на повторных вызовах) и виден расход output.
    const u = response.usage;
    logger.info(`${p.label}: usage`, {
      input: u.input_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      output: u.output_tokens,
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }
    const text = textBlock.text.trim();
    const parsed = normalizeStructuredResponse(text, p.label);
    if (!parsed) {
      return { success: false, error: 'Claude API: failed to parse structured JSON', rawText: text };
    }
    logger.info(`${p.label}: parsed`, {
      invoiceNumber: parsed.invoice_number,
      itemsCount: parsed.items.length,
      totalSum: parsed.total_sum,
    });
    return { success: true, data: parsed, rawText: text };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`${p.label}: error`, { error: msg });
    return { success: false, error: `Claude API error: ${msg}` };
  }
}

/** Собирает user-текст repair-вызова: прошлый JSON + список расхождений. */
function buildRepairUserText(prevJson: string, issues: ValidationIssue[]): string {
  const list = issues.map((it, i) => `  ${i + 1}. ${it.message}`).join('\n');
  return `Ты уже проанализировал этот документ и вернул такой JSON:\n\n${prevJson}\n\n`
    + `СЕРВЕРНАЯ ПРОВЕРКА арифметики/реквизитов нашла расхождения:\n${list}\n\n`
    + `Перечитай указанные места на исходном документе и верни ПОЛНЫЙ исправленный JSON по той же схеме. `
    + `Значения, которые проверку прошли, НЕ меняй. Если проверка ошибочна, а значение верное — оставь как есть.`;
}

type RepairFn = (prevJson: string, issues: ValidationIssue[]) => Promise<ApiAnalyzerResult>;

/**
 * Валидация + одно точечное до-чтение. Основной результат прогоняется через
 * invoiceValidator; при расхождениях делается ОДИН repair-вызов (тот же system —
 * cache hit, тот же документ). Исправленный результат берётся только при СТРОГОМ
 * уменьшении числа issues — иначе оставляем первый (защита от «починил верное»).
 */
async function verifyAndRepair(
  label: string,
  primary: ApiAnalyzerResult,
  repair: RepairFn,
): Promise<ApiAnalyzerResult> {
  if (!primary.success || !primary.data) return primary;

  const issues = validateParsedInvoice(primary.data);
  if (issues.length === 0) {
    logger.info(`${label}: validation clean, no repair needed`);
    return primary;
  }

  logger.warn(`${label}: validation found ${issues.length} issue(s), running one repair`, {
    codes: issues.map(i => i.code),
  });

  const prevJson = primary.rawText ?? JSON.stringify(primary.data);
  const repaired = await repair(prevJson, issues);
  if (!repaired.success || !repaired.data) {
    logger.warn(`${label}: repair call failed, keeping original`, { error: repaired.error });
    return primary;
  }

  const after = validateParsedInvoice(repaired.data);
  if (after.length < issues.length) {
    logger.info(`${label}: repair ${after.length === 0 ? 'fixed' : 'partial'} (${issues.length}→${after.length} issues)`, {
      remaining: after.map(i => i.code),
    });
    return repaired;
  }
  logger.info(`${label}: repair unchanged (${issues.length}→${after.length} issues), keeping original`);
  return primary;
}

/**
 * Анализ объединённого OCR-текста нескольких страниц через Anthropic API.
 * Не требует изображений — работает с готовым текстом от Google Vision.
 */
/** User-текст объединения постраничных результатов в один documento. */
function buildMultiPageTextUserContent(combinedOcrText: string, pageCount: number): string {
  return `Это ОДНА многостраничная накладная на ${pageCount} страниц(ы). Ниже — OCR-текст всех страниц `
    + `(или JSON-результаты постраничного анализа, разделённые маркером "--- СТРАНИЦА ---").\n\n`
    + `ЗАДАЧА — собери ОДИН итоговый JSON по схеме:\n`
    + `  1. items = КОНКАТЕНАЦИЯ позиций со всех страниц в порядке row_no. НИ ОДНА позиция не теряется `
    + `(если стр.1 = row_no 1..9, а стр.2 = row_no 10, в items должно быть ВСЕ 10).\n`
    + `  2. invoice_number/invoice_date/supplier/supplier_inn/supplier_kpp — из страницы, где они не null (обычно первая).\n`
    + `  3. total_sum — из ПОСЛЕДНЕЙ страницы со значением (строка "Всего к оплате"). Это общий итог документа, НЕ сумма страниц.\n`
    + `  4. vat_sum — аналогично, из строки "В том числе НДС" (обычно последняя).\n`
    + `  5. Проверка: Σ(items.total) ≈ total_sum. Не сходится → пропущена позиция, перечитай страницы.\n`
    + `Чего нет на странице — бери с той, где есть. НЕ придумывай значения.\n\n`
    + `OCR-текст всех страниц:\n${combinedOcrText}`;
}

async function analyzeMultiPageTextCore(
  combinedOcrText: string,
  apiKey: string,
  pageCount: number,
  modelId: string,
  catalog?: CatalogEntry[],
): Promise<{ result: ApiAnalyzerResult; repair: RepairFn }> {
  const failRepair: RepairFn = async () => ({ success: false, error: 'Anthropic API key not configured' });
  if (!apiKey) {
    return { result: { success: false, error: 'Anthropic API key not configured' }, repair: failRepair };
  }

  logger.info('Claude API Analyzer: starting multi-page TEXT analysis', { textLength: combinedOcrText.length, pageCount, catalogSize: catalog?.length ?? 0 });

  const client = createClient(apiKey);
  const system = buildSystemBlocks(catalog);
  const withCatalogIdx = !!(catalog && catalog.length);
  const call = (content: string, label: string) => callClaudeStructured({
    client, modelId, system, userContent: content, withCatalogIdx,
    multipage: true, label, timeoutMs: CLAUDE_API_TIMEOUT_MULTIPAGE_MS,
  });

  const result = await call(buildMultiPageTextUserContent(combinedOcrText, pageCount), 'Claude API multi-page text');
  const repair: RepairFn = (prevJson, issues) => call(
    `${buildRepairUserText(prevJson, issues)}\n\nOCR-текст всех страниц (перечитай):\n${combinedOcrText}`,
    'Claude API multi-page text repair',
  );
  return { result, repair };
}

export async function analyzeMultiPageTextWithClaudeApi(
  combinedOcrText: string,
  apiKey: string,
  pageCount: number,
  modelId: string = 'claude-sonnet-5',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  const { result } = await analyzeMultiPageTextCore(combinedOcrText, apiKey, pageCount, modelId, catalog);
  return result;
}

/** Как analyzeMultiPageTextWithClaudeApi, но с серверной валидацией + одним до-чтением. */
export async function analyzeMultiPageTextWithVerification(
  combinedOcrText: string,
  apiKey: string,
  pageCount: number,
  modelId: string = 'claude-sonnet-5',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  const { result, repair } = await analyzeMultiPageTextCore(combinedOcrText, apiKey, pageCount, modelId, catalog);
  return verifyAndRepair('Claude API multi-page text', result, repair);
}

async function analyzeMultipleImagesCore(
  imagePaths: string[],
  apiKey: string,
  modelId: string,
  catalog?: CatalogEntry[],
): Promise<{ result: ApiAnalyzerResult; repair: RepairFn }> {
  const failRepair: RepairFn = async () => ({ success: false, error: 'Anthropic API key not configured' });
  if (!apiKey) {
    return { result: { success: false, error: 'Anthropic API key not configured' }, repair: failRepair };
  }

  logger.info('Claude API Analyzer: starting multi-page analysis', { pages: imagePaths.length, catalogSize: catalog?.length ?? 0 });

  const imageBlocks: Anthropic.ImageBlockParam[] = [];
  try {
    for (const imagePath of imagePaths) {
      const { data, mediaType } = await encodeImageForApi(imagePath);
      imageBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Claude API Analyzer: multi-image encode error', { error: msg });
    return { result: { success: false, error: `Claude API error: ${msg}` }, repair: failRepair };
  }

  const client = createClient(apiKey);
  const system = buildSystemBlocks(catalog);
  const withCatalogIdx = !!(catalog && catalog.length);
  const call = (extraText: string, label: string) => callClaudeStructured({
    client, modelId, system,
    userContent: [...imageBlocks, { type: 'text', text: extraText }],
    withCatalogIdx, multipage: true, label, timeoutMs: CLAUDE_API_TIMEOUT_MULTIPAGE_MS,
  });

  const task = `Это многостраничная накладная (${imagePaths.length} страниц). Объедини товары со ВСЕХ страниц `
    + `в один список items (в порядке row_no, ничего не теряя). Итог (total_sum, vat_sum) — из последней страницы, `
    + `строка "Всего по накладной". Верни данные по схеме.`;
  const result = await call(task, 'Claude API multi-image');
  const repair: RepairFn = (prevJson, issues) => call(buildRepairUserText(prevJson, issues), 'Claude API multi-image repair');
  return { result, repair };
}

export async function analyzeMultipleImagesWithClaudeApi(
  imagePaths: string[],
  apiKey: string,
  modelId: string = 'claude-sonnet-5',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  const { result } = await analyzeMultipleImagesCore(imagePaths, apiKey, modelId, catalog);
  return result;
}

/** Как analyzeMultipleImagesWithClaudeApi, но с серверной валидацией + одним до-чтением. */
export async function analyzeMultipleImagesWithVerification(
  imagePaths: string[],
  apiKey: string,
  modelId: string = 'claude-sonnet-5',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  const { result, repair } = await analyzeMultipleImagesCore(imagePaths, apiKey, modelId, catalog);
  return verifyAndRepair('Claude API multi-image', result, repair);
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
 * Таймаут держим коротким (не сидеть на накладной минутами), но делаем 2 попытки:
 * разовый транзиентный таймаут = чтение повёрнутой фотки боком = каскад ошибок,
 * поэтому один ретрай окупается. После двух неудач возвращаем 0 (без поворота).
 */
const ORIENT_TIMEOUT_MS = 40_000;
const ORIENT_MAX_ATTEMPTS = 2;

export async function detectOrientationWithClaude(
  previewsBase64: [string, string, string, string],
  apiKey: string,
): Promise<0 | 90 | 180 | 270> {
  const client = createClient(apiKey);
  const content: Anthropic.MessageParam['content'] = [
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
  ];
  // Две попытки: разовый таймаут этого вызова роняет ориентацию в 0 (без
  // поворота), а на повёрнутой фотке это = боковое чтение → каскад ошибок
  // (перепутанные строки, поставщик вместо покупателя). Ретрай гасит транзиент.
  for (let attempt = 1; attempt <= ORIENT_MAX_ATTEMPTS; attempt++) {
    try {
      const signal = AbortSignal.timeout(ORIENT_TIMEOUT_MS);
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        messages: [{ role: 'user', content }],
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
      logger.warn(`Claude orientation detection error (attempt ${attempt}/${ORIENT_MAX_ATTEMPTS})`, { error: (err as Error).message });
      // Последняя попытка исчерпана — вернём 0 ниже (без поворота).
    }
  }
  return 0;
}

async function analyzeImageCore(
  imagePath: string,
  apiKey: string,
  modelId: string,
  catalog?: CatalogEntry[],
): Promise<{ result: ApiAnalyzerResult; repair: RepairFn }> {
  const failRepair: RepairFn = async () => ({ success: false, error: 'Anthropic API key not configured' });
  if (!apiKey) {
    return { result: { success: false, error: 'Anthropic API key not configured' }, repair: failRepair };
  }

  logger.info('Claude API Analyzer: starting image analysis', { imagePath, catalogSize: catalog?.length ?? 0 });

  let documentBlock: Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam;
  try {
    if (path.extname(imagePath).toLowerCase() === '.pdf') {
      const data = fs.readFileSync(imagePath).toString('base64');
      documentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    } else {
      const { data, mediaType } = await encodeImageForApi(imagePath);
      documentBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    }
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Claude API Analyzer: image encode error', { error: msg });
    return { result: { success: false, error: `Claude API error: ${msg}` }, repair: failRepair };
  }

  const client = createClient(apiKey);
  const system = buildSystemBlocks(catalog);
  const withCatalogIdx = !!(catalog && catalog.length);
  const call = (extraText: string, label: string) => callClaudeStructured({
    client, modelId, system,
    userContent: [documentBlock, { type: 'text', text: extraText }],
    withCatalogIdx, multipage: false, label, timeoutMs: CLAUDE_API_TIMEOUT_SINGLE_MS,
  });

  const result = await call('Проанализируй эту накладную или счёт и верни данные по JSON-схеме.', 'Claude API single document');
  const repair: RepairFn = (prevJson, issues) => call(buildRepairUserText(prevJson, issues), 'Claude API single image repair');
  return { result, repair };
}

export async function analyzeImageWithClaudeApi(
  imagePath: string,
  apiKey: string,
  modelId: string = 'claude-sonnet-5',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  const { result } = await analyzeImageCore(imagePath, apiKey, modelId, catalog);
  return result;
}

/** Как analyzeImageWithClaudeApi, но с серверной валидацией + одним до-чтением. */
export async function analyzeImageWithVerification(
  imagePath: string,
  apiKey: string,
  modelId: string = 'claude-sonnet-5',
  catalog?: CatalogEntry[],
): Promise<ApiAnalyzerResult> {
  const { result, repair } = await analyzeImageCore(imagePath, apiKey, modelId, catalog);
  return verifyAndRepair('Claude API single image', result, repair);
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
  modelId: string = 'claude-sonnet-5',
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
