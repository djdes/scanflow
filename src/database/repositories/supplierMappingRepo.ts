import { createHash } from 'crypto';
import { getDb } from '../db';

export interface SupplierMappingRow {
  id: number;
  /** Компания-владелец. Сопоставления по поставщику пер-тенантные, как и каталог. */
  owner_user_id: number;
  supplier_key: string;
  scanned_hash: string;
  scanned_name: string;
  mapped_name_1c: string;
  onec_guid: string;
  times_seen: number;
}

function normalizeScan(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
}

function scanHash(value: string): string {
  return createHash('sha256').update(normalizeScan(value)).digest('hex');
}

export function makeSupplierKey(inn?: string | null, name?: string | null): string | null {
  const digits = (inn || '').replace(/\D/g, '');
  if (digits) return `inn:${digits}`;
  const normalized = (name || '').trim().toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ');
  if (!normalized) return null;
  return `name:${createHash('sha256').update(normalized).digest('hex').slice(0, 48)}`;
}

// Владелец — обязательный параметр: сопоставления по поставщику указывают на
// GUID из каталога 1С, а каталог у каждой компании свой.
export const supplierMappingRepo = {
  async get(supplierKey: string, scannedName: string, ownerUserId: number): Promise<SupplierMappingRow | null> {
    const row = await getDb().prepare(`
      SELECT * FROM supplier_nomenclature_mapping_cards
       WHERE owner_user_id = ? AND supplier_key = ? AND scanned_hash = ? LIMIT 1
    `).get<SupplierMappingRow>(ownerUserId, supplierKey, scanHash(scannedName));
    return row ?? null;
  },

  async upsert(input: { supplierKey: string; scannedName: string; mappedName: string; onecGuid: string }, ownerUserId: number): Promise<void> {
    await getDb().prepare(`
      INSERT INTO supplier_nomenclature_mapping_cards
        (owner_user_id, supplier_key, scanned_hash, scanned_name, mapped_name_1c, onec_guid)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE mapped_name_1c = VALUES(mapped_name_1c),
                              onec_guid = VALUES(onec_guid),
                              times_seen = times_seen + 1
    `).run(
      ownerUserId,
      input.supplierKey,
      scanHash(input.scannedName),
      input.scannedName.trim(),
      input.mappedName,
      input.onecGuid,
    );
  },
};
