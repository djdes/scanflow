import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { replacementParams } from '../../src/database/repositories/queueRepo';

describe.runIf((process.env.DB_NAME || '').includes('test'))('mapping explanations survive storage and human corrections', () => {
  let invoiceId: number;
  beforeAll(async () => {
    await resetDb();
    await getDb().prepare("INSERT INTO users (id, username, password_hash, api_key, role, notify_events) VALUES (1, 'usage-owner', 'x', 'usage-key', 'admin', '[]')").run();
    const created = await getDb().prepare("INSERT INTO invoices (owner_user_id, file_name, status) VALUES (1, 'usage.jpg', 'processed')").run();
    invoiceId = Number(created.lastInsertRowid);
  });
  afterAll(closeTestDb);

  it('saves the checked counts, refreshes the explanation, then replaces it on manual selection/clear', async () => {
    const reason = 'Выбрано по спецификациям: 12 спецификаций, 3 прихода. Проверено 16.10.2026.';
    const item = await invoiceRepo.addItem({ invoice_id: invoiceId, original_name: 'Бекон', onec_guid: 'a', mapping_reason: reason });
    expect((await invoiceRepo.getItemById(item.id))?.mapping_reason).toBe(reason);
    await invoiceRepo.updateItemMapping(item.id, 'b', 'Бекон Б', 0.95, 'Новая проверка: 20 спецификаций.');
    expect((await invoiceRepo.getItemById(item.id))?.mapping_reason).toBe('Новая проверка: 20 спецификаций.');
    await invoiceRepo.mapItem(item.id, 'c', 'Бекон В');
    expect((await invoiceRepo.getItemById(item.id))?.mapping_reason).toBe('Выбрано вручную.');
    await invoiceRepo.mapItem(item.id, null, null);
    expect((await invoiceRepo.getItemById(item.id))?.mapping_reason).toBe('Сопоставление снято вручную.');
    await invoiceRepo.setItemCustomName(item.id, 'Бекон новый');
    expect((await invoiceRepo.getItemById(item.id))?.mapping_reason).toBe('Название задано вручную.');
  });
});

it('queue replacement parameters keep an explanation with the exact candidate and counts', () => {
  const mapping_reason = 'Бекон Б — 12 спецификаций; Бекон А — 1 спецификация.';
  const params = replacementParams(1, {
    original_name: 'Бекон', mapped_name: 'Бекон Б', onec_guid: 'b', mapping_confidence: 0.95, mapping_reason,
    quantity: 2, unit: 'кг', price: 10, total: 20, vat_rate: 10,
    conversion: { raw_quantity: 2, raw_unit: 'кг', raw_price: 10, raw_total: 20, conv_factor: 1, conv_note: null, conv_source: null, qty_flag: null, qty_flag_note: null },
  });
  expect(params.mapping_reason).toBe(mapping_reason);
});
