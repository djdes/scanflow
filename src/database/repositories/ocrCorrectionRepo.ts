import crypto from 'crypto';
import { getDb } from '../db';

const LEARNABLE_FIELDS = new Set([
  'invoice_type', 'supplier', 'supplier_kpp', 'supplier_bik',
  'supplier_account', 'supplier_corr_account', 'supplier_address',
  'item_unit',
]);

function normalize(value: unknown): string {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

export function supplierCorrectionKey(input: { supplier_inn?: unknown; supplier?: unknown }): string {
  const inn = String(input.supplier_inn ?? '').replace(/\D/g, '');
  return inn || `name:${normalize(input.supplier).slice(0, 100) || 'unknown'}`;
}

/**
 * «Ничья» накладная (owner_user_id IS NULL) в пер-тенантные данные не ходит
 * вовсе — ни читает, ни пишет. Вызывающие передают такого владельца как -1
 * (сложившаяся в watcher-е и роутах конвенция `invoice.owner_user_id ?? -1`),
 * поэтому отсекаем всё, что не похоже на реальный users.id. Падать нельзя:
 * накладная без владельца должна просто разобраться без подстановок.
 */
function isRealOwner(ownerUserId: number): boolean {
  return Number.isInteger(ownerUserId) && ownerUserId > 0;
}

// Владелец — обязательный параметр обоих методов, без значения по умолчанию.
// Это единственное, что превращает забытого вызывающего из тихой межтенантной
// утечки (исправление одной компании подставляется в сканы всех остальных) в
// ошибку компиляции.
export const ocrCorrectionRepo = {
  async remember(
    supplierKey: string,
    fieldName: string,
    originalValue: unknown,
    correctedValue: unknown,
    ownerUserId: number,
  ): Promise<void> {
    if (!isRealOwner(ownerUserId)) return;
    if (!LEARNABLE_FIELDS.has(fieldName)) return;
    const original = normalize(originalValue);
    const corrected = String(correctedValue ?? '').trim();
    if (!original || !corrected || original === normalize(corrected)) return;
    const hash = crypto.createHash('sha256').update(original).digest('hex');
    await getDb().prepare(`
      INSERT INTO ocr_correction_cards
        (owner_user_id, supplier_key, field_name, original_hash, original_value, corrected_value)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE corrected_value = VALUES(corrected_value),
        times_seen = times_seen + 1, updated_at = NOW()
    `).run(ownerUserId, supplierKey, fieldName, hash, String(originalValue ?? '').slice(0, 1024), corrected.slice(0, 1024));
  },

  async apply<T extends Record<string, unknown>>(data: T, ownerUserId: number): Promise<T> {
    if (!isRealOwner(ownerUserId)) return data;
    const supplierKey = supplierCorrectionKey(data);
    const fields = [...LEARNABLE_FIELDS].filter(field => normalize(data[field]));
    if (fields.length === 0) return data;
    for (const field of fields) {
      const hash = crypto.createHash('sha256').update(normalize(data[field])).digest('hex');
      // 'name:unknown' — общая корзина исправлений, выученных когда поставщика
      // опознать не удалось. Она тоже внутри компании: фильтр по владельцу стоит
      // до IN, поэтому чужая корзина сюда не попадает.
      const correction = await getDb().prepare(`
        SELECT id, corrected_value FROM ocr_correction_cards
         WHERE owner_user_id = ? AND supplier_key IN (?, 'name:unknown')
           AND field_name = ? AND original_hash = ?
         ORDER BY supplier_key = ? DESC, times_seen DESC LIMIT 1
      `).get<{ id: number; corrected_value: string }>(ownerUserId, supplierKey, field, hash, supplierKey);
      if (!correction) continue;
      (data as Record<string, unknown>)[field] = correction.corrected_value;
      await getDb()
        .prepare('UPDATE ocr_correction_cards SET last_used_at = NOW() WHERE id = ? AND owner_user_id = ?')
        .run(correction.id, ownerUserId);
    }
    const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : [];
    for (const item of items) {
      const unit = normalize(item.unit);
      if (!unit) continue;
      const hash = crypto.createHash('sha256').update(unit).digest('hex');
      const correction = await getDb().prepare(`
        SELECT id, corrected_value FROM ocr_correction_cards
         WHERE owner_user_id = ? AND supplier_key = ? AND field_name = 'item_unit' AND original_hash = ?
         ORDER BY times_seen DESC LIMIT 1
      `).get<{ id: number; corrected_value: string }>(ownerUserId, supplierKey, hash);
      if (!correction) continue;
      item.unit = correction.corrected_value;
      await getDb()
        .prepare('UPDATE ocr_correction_cards SET last_used_at = NOW() WHERE id = ? AND owner_user_id = ?')
        .run(correction.id, ownerUserId);
    }
    return data;
  },
};
