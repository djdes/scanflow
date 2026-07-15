import { createHash } from 'crypto';
import { getDb } from '../db';

export interface SupplierMappingRow {
  id: number;
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

export const supplierMappingRepo = {
  async get(supplierKey: string, scannedName: string): Promise<SupplierMappingRow | null> {
    const row = await getDb().prepare(`
      SELECT * FROM supplier_nomenclature_mappings
       WHERE supplier_key = ? AND scanned_hash = ? LIMIT 1
    `).get<SupplierMappingRow>(supplierKey, scanHash(scannedName));
    return row ?? null;
  },

  async upsert(input: { supplierKey: string; scannedName: string; mappedName: string; onecGuid: string }): Promise<void> {
    await getDb().prepare(`
      INSERT INTO supplier_nomenclature_mappings
        (supplier_key, scanned_hash, scanned_name, mapped_name_1c, onec_guid)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE mapped_name_1c = VALUES(mapped_name_1c),
                              onec_guid = VALUES(onec_guid),
                              times_seen = times_seen + 1
    `).run(
      input.supplierKey,
      scanHash(input.scannedName),
      input.scannedName.trim(),
      input.mappedName,
      input.onecGuid,
    );
  },
};
