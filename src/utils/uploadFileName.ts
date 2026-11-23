/**
 * Имена файлов из multipart-формы.
 *
 * Браузеры кладут имя файла в `filename="…"` сырыми байтами UTF-8, а busboy
 * (под multer) по умолчанию читает их как latin1: «Счёт 617.pdf» превращалось
 * в «Ð¡Ñ‡Ñ‘Ñ‚ 617.pdf» и так ложилось в базу (очередь распознавания, 2026-11-23).
 * Новые загрузки читаются как UTF-8 (`MULTIPART_UTF8`), а уже сохранённые
 * имена чинит `repairUploadFileName` при выдаче.
 */

/** Опции multer: имя файла в форме — UTF-8. */
export const MULTIPART_UTF8 = { defParamCharset: 'utf8' } as const;

/**
 * Имя, прочитанное как latin1, обратно в UTF-8. Трогает только строку, где
 * все символы — однобайтовые и есть хотя бы один не-ASCII, и только если её
 * байты — правильный UTF-8. Нормальные имена (кириллица, «café.jpg») не меняются.
 */
export function repairUploadFileName(name: string | null | undefined): string {
  const value = String(name ?? '');
  if (!/[\u0080-ÿ]/.test(value) || /[^\u0000-ÿ]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('�') ? value : decoded;
}
