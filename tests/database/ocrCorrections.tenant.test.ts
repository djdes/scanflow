import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { ocrCorrectionRepo } from '../../src/database/repositories/ocrCorrectionRepo';

// Выученные исправления распознавания пер-тенантные. До разделения ключ
// (supplier_key, field_name, original_hash) был глобальным, поэтому правка одной
// компании подставлялась в сканы всех остальных: и утечка (в corrected_value
// видны чужие контрагенты, их счета и адреса), и порча данных (чужой БИК молча
// переписывал распознанный).
describe.runIf((process.env.DB_NAME || '').includes('test'))('ocr_corrections: изоляция между компаниями', () => {
  const INN = '7707083893';
  let companyA = 0;
  let companyB = 0;

  async function makeUser(username: string, role: string): Promise<number> {
    const res = await getDb()
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role, notify_events)
         VALUES (?, 'x', ?, ?, '[]')`
      )
      .run(username, `key-${username}`, role);
    return Number(res.lastInsertRowid);
  }

  /** Свежий «скан» — тот же вход, что приходит из OCR до подстановки исправлений. */
  const scan = (extra: Record<string, unknown> = {}) => ({
    supplier: 'ООО Ромашка',
    supplier_inn: INN,
    supplier_bik: '044525225',
    ...extra,
  });

  beforeEach(async () => {
    await resetDb();
    companyA = await makeUser('company-a', 'admin');
    companyB = await makeUser('company-b', 'user');
  });

  afterAll(async () => { await closeTestDb(); });

  it('исправление компании А не применяется к сканам компании Б', async () => {
    await ocrCorrectionRepo.remember(INN, 'supplier_bik', '044525225', '044525226', companyA);

    expect((await ocrCorrectionRepo.apply(scan(), companyA)).supplier_bik).toBe('044525226');
    expect((await ocrCorrectionRepo.apply(scan(), companyB)).supplier_bik).toBe('044525225');
  });

  it('одинаковый ключ у двух компаний живёт независимо', async () => {
    await ocrCorrectionRepo.remember(INN, 'supplier_address', 'г Москва', 'г. Москва, ул. А', companyA);
    await ocrCorrectionRepo.remember(INN, 'supplier_address', 'г Москва', 'г. Москва, ул. Б', companyB);

    const a = await ocrCorrectionRepo.apply(scan({ supplier_address: 'г Москва' }), companyA);
    const b = await ocrCorrectionRepo.apply(scan({ supplier_address: 'г Москва' }), companyB);
    expect(a.supplier_address).toBe('г. Москва, ул. А');
    expect(b.supplier_address).toBe('г. Москва, ул. Б');

    const rows = await getDb()
      .prepare(`SELECT owner_user_id, corrected_value FROM ocr_correction_cards
                 WHERE supplier_key = ? AND field_name = 'supplier_address'
                 ORDER BY owner_user_id`)
      .all<{ owner_user_id: number; corrected_value: string }>(INN);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.owner_user_id)).toEqual([companyA, companyB]);
  });

  // Корзина 'name:unknown' — фолбэк для сканов, где поставщика опознать не
  // удалось. Она тоже внутри компании, иначе становилась бы общей свалкой.
  it('фолбэк name:unknown компании А не течёт в компанию Б', async () => {
    await ocrCorrectionRepo.remember('name:unknown', 'supplier_kpp', '77 01 01 001', '770101001', companyA);

    const a = await ocrCorrectionRepo.apply(scan({ supplier_kpp: '77 01 01 001' }), companyA);
    const b = await ocrCorrectionRepo.apply(scan({ supplier_kpp: '77 01 01 001' }), companyB);
    expect(a.supplier_kpp).toBe('770101001');
    expect(b.supplier_kpp).toBe('77 01 01 001');
  });

  it('единицы измерения позиций тоже не пересекаются между компаниями', async () => {
    await ocrCorrectionRepo.remember(INN, 'item_unit', 'шт.', 'кг', companyA);

    const a = await ocrCorrectionRepo.apply(scan({ items: [{ name: 'Сахар', unit: 'шт.' }] }), companyA);
    const b = await ocrCorrectionRepo.apply(scan({ items: [{ name: 'Сахар', unit: 'шт.' }] }), companyB);
    expect((a.items as Array<{ unit: string }>)[0].unit).toBe('кг');
    expect((b.items as Array<{ unit: string }>)[0].unit).toBe('шт.');
  });

  // «Ничья» накладная (owner_user_id IS NULL) передаётся вызывающими как -1.
  // Она не должна ни падать, ни получать чужих подстановок, ни писать в чужую
  // память распознавания.
  it('накладная без владельца ничего не читает и ничего не пишет', async () => {
    await ocrCorrectionRepo.remember(INN, 'supplier_bik', '044525225', '044525226', companyA);

    expect((await ocrCorrectionRepo.apply(scan(), -1)).supplier_bik).toBe('044525225');

    await ocrCorrectionRepo.remember(INN, 'supplier_address', 'г Москва', 'подделка', -1);
    const stray = await getDb()
      .prepare(`SELECT COUNT(*) AS cnt FROM ocr_correction_cards WHERE owner_user_id <> ?`)
      .get<{ cnt: number }>(companyA);
    expect(Number(stray?.cnt)).toBe(0);
  });
});
