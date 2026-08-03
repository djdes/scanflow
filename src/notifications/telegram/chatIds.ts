/**
 * Разбор и нормализация списка Telegram chat_id.
 *
 * Хранятся они одной строкой через запятую в `users.telegram_chat_id` — раньше
 * там лежал ровно один id, поэтому одиночное значение остаётся валидным и
 * миграция данных не потребовалась.
 *
 * См. docs/superpowers/specs/2026-08-03-multiple-telegram-chats-design.md
 */

/** Больше двадцати чатов — это уже вставленный по ошибке мусор, а не настройка. */
export const MAX_CHAT_IDS = 20;

// У групп и супергрупп chat_id отрицательный (-100…), у личных чатов — обычное
// целое. Ведущие нули Telegram не использует, но и не запрещаем — отсекаем
// только явно нечисловое.
const CHAT_ID_RE = /^-?\d{1,32}$/;

export function isValidChatId(v: string): boolean {
  return CHAT_ID_RE.test(v);
}

/**
 * Строка из формы → массив id. Разделители: запятая, точка с запятой, пробелы,
 * переводы строк — пользователь копирует id откуда угодно, и требовать от него
 * единственный формат нет причин. Дубликаты убираются, порядок сохраняется.
 */
export function parseChatIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = String(raw).split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Те же id, но только валидные — для рассылки. */
export function parseValidChatIds(raw: string | null | undefined): string[] {
  return parseChatIds(raw).filter(isValidChatId);
}

/** Канонический вид для хранения: «id,id,id». Пустой список → null. */
export function serializeChatIds(ids: string[]): string | null {
  return ids.length ? ids.join(',') : null;
}
