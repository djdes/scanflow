import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мини-БД в памяти: достаточно, чтобы проверить, что правило единицы живёт
// «для товара», а не для всего поставщика (инцидент: яйца «С1 360шт» → 1080 кг).
type Row = { id: number; owner_user_id: number; supplier_key: string; field_name: string; original_hash: string; item_key: string; corrected_value: string; active: number; times_seen: number };
const rows: Row[] = [];
const calls: Array<{ sql: string; args: unknown[] }> = [];

vi.mock('../../src/database/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      run: async (...args: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes('INSERT INTO ocr_correction_cards')) {
          const [owner, supplierKey, field, hash, , corrected, itemKey] = args as [number, string, string, string, string, string, string];
          const hit = rows.find(r => r.owner_user_id === owner && r.supplier_key === supplierKey && r.field_name === field && r.original_hash === hash && r.item_key === itemKey);
          if (hit) { hit.corrected_value = corrected; hit.times_seen++; hit.active = 1; }
          else rows.push({ id: rows.length + 1, owner_user_id: owner, supplier_key: supplierKey, field_name: field, original_hash: hash, item_key: itemKey, corrected_value: corrected, active: 1, times_seen: 1 });
        }
        return { changes: 1, lastInsertRowid: 0 };
      },
      get: async (...args: unknown[]) => {
        calls.push({ sql, args });
        if (sql.includes('AND item_key = ?')) {
          const [owner, supplierKey, field, hash, itemKey] = args as [number, string, string, string, string];
          const r = rows.find(x => x.owner_user_id === owner && x.supplier_key === supplierKey && x.field_name === field && x.original_hash === hash && x.item_key === itemKey && x.active === 1);
          return r ? { id: r.id, corrected_value: r.corrected_value } : undefined;
        }
        return undefined;
      },
    }),
  }),
}));

import { ocrCorrectionRepo, itemUnitRuleKey, ITEM_UNIT_STORED_FIELD } from '../../src/database/repositories/ocrCorrectionRepo';

describe('ocrCorrectionRepo: единица — правило для товара', () => {
  beforeEach(() => { rows.length = 0; calls.length = 0; });

  it('правка единицы запоминается только с названием товара', async () => {
    await ocrCorrectionRepo.remember('5258068806', 'item_unit', 'кг', 'шт', 1, 'Яйцо Куриное Коричневое С1 360шт');
    expect(rows).toHaveLength(1);
    expect(rows[0].item_key).toBe(itemUnitRuleKey('Яйцо Куриное Коричневое С1 360шт'));
    // Не 'item_unit': код до v2 (при откате) применил бы такую строку ко всему поставщику.
    expect(rows[0].field_name).toBe(ITEM_UNIT_STORED_FIELD);
    expect(ITEM_UNIT_STORED_FIELD).not.toBe('item_unit');
    await ocrCorrectionRepo.remember('5258068806', 'item_unit', 'шт', 'кг', 1);
    expect(rows).toHaveLength(1); // без товара — не запоминаем
  });

  it('применяется только к этому товару, остальные строки поставщика не трогает', async () => {
    await ocrCorrectionRepo.remember('5258068806', 'item_unit', 'шт', 'кг', 1, 'Батон Нарезной 0,4 кг');
    const data = {
      supplier_inn: '5258068806',
      items: [
        { name: 'Батон Нарезной 0,4 кг', unit: 'шт' },
        { name: 'Яйцо Куриное С1 360шт', unit: 'шт' },
        { name: 'Вода питьевая 1,5л', unit: 'шт' },
      ],
    };
    const out = await ocrCorrectionRepo.apply(data, 1);
    expect(out.items.map(i => i.unit)).toEqual(['кг', 'шт', 'шт']);
  });

  it('другое написание того же товара находит то же правило', async () => {
    await ocrCorrectionRepo.remember('5258068806', 'item_unit', 'шт', 'кг', 1, 'Капуста морская(3кг)');
    const out = await ocrCorrectionRepo.apply({ supplier_inn: '5258068806', items: [{ name: 'КАПУСТА МОРСКАЯ (3 кг)', unit: 'шт' }] }, 1);
    expect(out.items[0].unit).toBe('кг');
  });

  it('чужой владелец правило не видит', async () => {
    await ocrCorrectionRepo.remember('5258068806', 'item_unit', 'шт', 'кг', 1, 'Батон Нарезной 0,4 кг');
    const out = await ocrCorrectionRepo.apply({ supplier_inn: '5258068806', items: [{ name: 'Батон Нарезной 0,4 кг', unit: 'шт' }] }, 3);
    expect(out.items[0].unit).toBe('шт');
  });
});
