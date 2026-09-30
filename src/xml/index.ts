/**
 * Приём электронных накладных в XML (формат ФНС) — точка входа для конвейера.
 *
 * XML-файл приходит теми же путями, что и фото (загрузка на сайте, почтовый
 * канал и Telegram, папка inbox/), и FileWatcher.processFile вместо
 * распознавания зовёт readFnsXmlInvoice: результат — тот же OcrResult со
 * structured-данными, дальше — те же шаги, что у фото. Отличия, которые держит
 * конвейер (src/watcher/fileWatcher.ts, processXmlDocument):
 *   - нет распознавания, поворота и предобработки картинки, нет диспетчера;
 *   - поправки распознавания (ocr_correction_cards) и санитайзеры НДС/арифметики
 *     к XML не применяются — в нём нет ошибок чтения, данные документа точные;
 *   - XML — всегда документ целиком: он не склеивается с другими накладными как
 *     «страница», и в него не вклеиваются страницы фото (фото того же документа
 *     ловит детектор дублей);
 *   - ИНН продавца из XML точный: привязка к карточке справочника «по названию»
 *     его не подменяет (supplierMatch, exactInn).
 */
import fs from 'fs';
import path from 'path';
import type { OcrResult } from '../ocr/types';
import { logger } from '../utils/logger';
import { parseFnsInvoiceXml } from './fnsInvoice';

export { FnsXmlError, parseFnsInvoiceXml, parseVatRate } from './fnsInvoice';
export type { FnsInvoiceResult } from './fnsInvoice';

/** invoices.ocr_engine накладных из XML. Всё, что начинается с «xml_», — не фото. */
export const XML_ENGINE_UPD = 'xml_upd';
export const XML_ENGINE_TORG12 = 'xml_torg12';

const XML_MIME_TYPES = new Set(['application/xml', 'text/xml']);

export function isXmlFileName(name: string | null | undefined): boolean {
  return path.extname(String(name ?? '').trim()).toLowerCase() === '.xml';
}

/** MIME вложения/загрузки: application/xml, text/xml (параметры вроде charset не важны). */
export function isXmlMimeType(mime: string | null | undefined): boolean {
  const base = String(mime ?? '').split(';')[0].trim().toLowerCase();
  return XML_MIME_TYPES.has(base);
}

export function isXmlOcrEngine(engine: string | null | undefined): boolean {
  return typeof engine === 'string' && engine.startsWith('xml_');
}

/** Накладная из XML: по движку, а пока он не записан (первые миллисекунды) — по имени файла. */
export function isXmlInvoice(inv: { ocr_engine?: string | null; file_name?: string | null } | null | undefined): boolean {
  if (!inv) return false;
  if (isXmlOcrEngine(inv.ocr_engine)) return true;
  return String(inv.file_name ?? '').split(',').some(isXmlFileName);
}

/** Вид файла накладной для карточки: картинка, PDF или электронный документ. */
export function invoiceFileKind(name: string | null | undefined): 'xml' | 'pdf' | 'image' {
  if (isXmlFileName(name)) return 'xml';
  return path.extname(String(name ?? '').trim()).toLowerCase() === '.pdf' ? 'pdf' : 'image';
}

/**
 * Имя для скачивания исходного XML: ИдФайл из разбора (так файл назывался в
 * ЭДО: ON_NSCHFDOPPR_…), а если его нет или он странный — имя на диске.
 */
export function xmlDownloadName(rawText: string | null | undefined, storedName: string): string {
  let fileId: unknown = null;
  try {
    fileId = rawText ? (JSON.parse(rawText) as { file_id?: unknown }).file_id : null;
  } catch { /* raw_text не JSON — берём имя на диске */ }
  const safe = typeof fileId === 'string'
    ? fileId.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[._]+/, '').slice(0, 180)
    : '';
  return safe ? `${safe}.xml` : storedName;
}

/**
 * Прочитать XML-файл ФНС как «распознанную» накладную. text — JSON разобранных
 * данных (в invoices.raw_text, как ответ Claude у фото: его читают вкладка
 * «OCR-текст», карточка документа и восстановление итога в /remap). Бросает
 * FnsXmlError с сообщением для пользователя — конвейер ставит накладной статус
 * «ошибка».
 */
export async function readFnsXmlInvoice(filePath: string): Promise<OcrResult> {
  const result = parseFnsInvoiceXml(await fs.promises.readFile(filePath));
  const file = path.basename(filePath);
  logger.info('XML invoice parsed', {
    file,
    document: result.meta.title,
    encoding: result.meta.encoding,
    itemsCount: result.data.items.length,
    totalSum: result.data.total_sum,
  });
  if (result.warnings.length) logger.warn('XML invoice: arithmetic/requisite warnings', { file, warnings: result.warnings });
  const text = JSON.stringify({
    source: 'xml',
    document: result.meta.title,
    file_id: result.meta.file_id,
    version: result.meta.version,
    function: result.meta.function,
    encoding: result.meta.encoding,
    correction: result.meta.correction,
    ...result.data,
    warnings: result.warnings,
  }, null, 2);
  return {
    text,
    engine: result.kind === 'torg12' ? XML_ENGINE_TORG12 : XML_ENGINE_UPD,
    structured: result.data,
  };
}
