import { describe, it, expect, vi, beforeEach } from 'vitest';

// БД замокана целиком: вместо MySQL — таблицы в памяти и маленький
// интерпретатор тех нескольких SQL, что шлёт сервис. Транзакция откатывается
// снимком, UNIQUE-ключи правил проверяются — так тест ловит и «переехало не
// то», и «UPDATE упал бы на дубликате». К реальной базе тест не ходит (правило 17).
type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};
let executed: string[] = [];

const UNIQUE: Record<string, string[]> = {
  supplier_nomenclature_mapping_cards: ['owner_user_id', 'supplier_key', 'scanned_hash'],
  ocr_correction_cards: ['owner_user_id', 'supplier_key', 'field_name', 'original_hash'],
};

function checkUnique(table: string): void {
  const cols = UNIQUE[table];
  if (!cols) return;
  const seen = new Set<string>();
  for (const r of tables[table]) {
    const k = cols.map(c => String(r[c])).join('|');
    if (seen.has(k)) throw new Error(`ER_DUP_ENTRY in ${table}: ${k}`);
    seen.add(k);
  }
}

/** SET слева направо, как в MySQL/MariaDB: правая часть видит уже присвоенное. */
function applySet(row: Row, setClause: string, args: unknown[]): void {
  let argIdx = 0;
  const re = /(\w+)\s*=\s*(COALESCE\((\w+),\s*(\w+)\)|\?|'([^']*)')/g;
  for (const m of setClause.matchAll(re)) {
    const col = m[1];
    if (m[3]) row[col] = row[m[3]] ?? row[m[4]];
    else if (m[2] === '?') row[col] = args[argIdx++];
    else row[col] = m[5];
  }
}

function stmt(sql: string) {
  const s = sql.replace(/\s+/g, ' ').trim();
  return {
    async get(...args: unknown[]): Promise<Row | undefined> {
      executed.push(s);
      if (s.startsWith('SELECT * FROM supplier_cards WHERE owner_user_id = ? AND inn = ? FOR UPDATE')) {
        const [owner, inn] = args;
        const r = tables.supplier_cards.find(c => c.owner_user_id === owner && c.inn === inn);
        return r ? { ...r } : undefined;
      }
      throw new Error(`unexpected get: ${s}`);
    },
    async all(...args: unknown[]): Promise<Row[]> {
      executed.push(s);
      const m = /^SELECT (.+) FROM (\w+) WHERE owner_user_id = \? AND supplier_key = \? FOR UPDATE$/.exec(s);
      if (!m) throw new Error(`unexpected all: ${s}`);
      const cols = m[1].split(',').map(c => c.trim());
      const [owner, key] = args;
      return tables[m[2]]
        .filter(r => r.owner_user_id === owner && r.supplier_key === key)
        .map(r => Object.fromEntries(cols.map(c => [c, r[c]])));
    },
    async run(...args: unknown[]): Promise<{ changes: number; lastInsertRowid: number }> {
      executed.push(s);
      let m = /^UPDATE invoices SET (.+) WHERE owner_user_id = \? AND supplier_inn = \?$/.exec(s);
      if (m) {
        const setArgs = args.slice(0, -2);
        const [owner, inn] = args.slice(-2);
        const hit = tables.invoices.filter(r => r.owner_user_id === owner && r.supplier_inn === inn);
        for (const r of hit) applySet(r, m[1], setArgs);
        return { changes: hit.length, lastInsertRowid: 0 };
      }
      m = /^UPDATE (\w+) SET supplier_key = \? WHERE owner_user_id = \? AND supplier_key = \? AND id IN \((.+)\)$/.exec(s);
      if (m) {
        const [toKey, owner, fromKey, ...ids] = args;
        const hit = tables[m[1]].filter(r => r.owner_user_id === owner && r.supplier_key === fromKey && ids.includes(r.id));
        for (const r of hit) r.supplier_key = toKey;
        checkUnique(m[1]);
        return { changes: hit.length, lastInsertRowid: 0 };
      }
      if (s === 'DELETE FROM supplier_cards WHERE id = ? AND owner_user_id = ?') {
        const [id, owner] = args;
        const before = tables.supplier_cards.length;
        tables.supplier_cards = tables.supplier_cards.filter(r => !(r.id === id && r.owner_user_id === owner));
        return { changes: before - tables.supplier_cards.length, lastInsertRowid: 0 };
      }
      throw new Error(`unexpected run: ${s}`);
    },
  };
}

vi.mock('../../src/database/db', () => ({
  getDb: () => ({
    prepare: (sql: string) => stmt(sql),
    async transaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
      const snapshot = JSON.stringify(tables);
      try {
        return await fn({ prepare: (sql: string) => stmt(sql) });
      } catch (err) {
        tables = JSON.parse(snapshot);
        throw err;
      }
    },
  }),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mergeSupplierCards, SupplierMergeError } from '../../src/services/supplierMerge';
import { logger } from '../../src/utils/logger';

const OWNER = 1;
const OTHER = 2;
const GOOD = '7724357632'; // «Вкусный мир ТК», верный ИНН
const TYPO = '7724357832'; // тот же поставщик, OCR перепутал цифру

function card(id: number, owner: number, inn: string, name: string): Row {
  return { id, owner_user_id: owner, inn, name, bank_bic: '044525225', account: '40702810000000000001', verified: 1 };
}

beforeEach(() => {
  vi.clearAllMocks();
  executed = [];
  tables = {
    supplier_cards: [
      card(1, OWNER, GOOD, 'ООО "Вкусный мир ТК"'),
      card(2, OWNER, TYPO, 'ООО "Вкусный мир ТК"'),
      card(3, OTHER, GOOD, 'ООО "Вкусный мир ТК"'),
      card(4, OWNER, '5258006806', 'ООО "Битый ИНН"'),
    ],
    invoices: [
      // Привязана к двойнику по ИНН с фото: на фото был ИНН с опечаткой.
      { id: 10, owner_user_id: OWNER, supplier_inn: TYPO, supplier: 'ВКУСНЫЙ МИР ТК', supplier_match: 'inn', supplier_inn_ocr: null, supplier_name_ocr: null },
      // Уже подобрана к двойнику по названию — «что было на фото» не затираем.
      { id: 11, owner_user_id: OWNER, supplier_inn: TYPO, supplier: 'ООО "Вкусный мир ТК"', supplier_match: 'name', supplier_inn_ocr: '7724350000', supplier_name_ocr: 'Вкусный мир' },
      { id: 12, owner_user_id: OWNER, supplier_inn: GOOD, supplier: 'ООО "Вкусный мир ТК"', supplier_match: 'inn', supplier_inn_ocr: null, supplier_name_ocr: null },
      // Чужая компания с тем же ИНН — не трогаем.
      { id: 13, owner_user_id: OTHER, supplier_inn: TYPO, supplier: 'X', supplier_match: null, supplier_inn_ocr: null, supplier_name_ocr: null },
    ],
    supplier_nomenclature_mapping_cards: [
      { id: 100, owner_user_id: OWNER, supplier_key: `inn:${TYPO}`, scanned_hash: 'h-sugar' },
      { id: 101, owner_user_id: OWNER, supplier_key: `inn:${TYPO}`, scanned_hash: 'h-flour' },
      { id: 102, owner_user_id: OWNER, supplier_key: `inn:${GOOD}`, scanned_hash: 'h-flour' }, // у цели уже есть
      { id: 103, owner_user_id: OTHER, supplier_key: `inn:${TYPO}`, scanned_hash: 'h-sugar' },
    ],
    ocr_correction_cards: [
      { id: 200, owner_user_id: OWNER, supplier_key: TYPO, field_name: 'item_unit', original_hash: 'u-sht' },
      { id: 201, owner_user_id: OWNER, supplier_key: TYPO, field_name: 'supplier_kpp', original_hash: 'k-1' },
      { id: 202, owner_user_id: OWNER, supplier_key: GOOD, field_name: 'item_unit', original_hash: 'u-sht' }, // у цели уже есть
      { id: 203, owner_user_id: OWNER, supplier_key: TYPO, field_name: 'supplier_bik', original_hash: 'u-sht' },
    ],
  };
});

describe('mergeSupplierCards — «Объединить карточки»', () => {
  it('двойник с опечаткой в ИНН вливается в верную карточку', async () => {
    const r = await mergeSupplierCards(OWNER, TYPO, GOOD);

    expect(r.moved_invoices).toBe(2);
    expect(r.moved_rules).toBe(3);   // h-sugar + supplier_kpp + supplier_bik
    expect(r.skipped_rules).toBe(2); // h-flour и item_unit/u-sht у цели уже были
    expect(r.deleted_card).toMatchObject({ id: 2, inn: TYPO, name: 'ООО "Вкусный мир ТК"', account: '40702810000000000001' });

    // Карточка-источник удалена, остальные на месте.
    expect(tables.supplier_cards.map(c => c.id)).toEqual([1, 3, 4]);

    const inv = (id: number) => tables.invoices.find(i => i.id === id)!;
    expect(inv(10)).toMatchObject({
      supplier_inn: GOOD, supplier: 'ООО "Вкусный мир ТК"', supplier_match: 'manual',
      // ИНН и название с фото сохранены, а не перезаписаны значениями цели.
      supplier_inn_ocr: TYPO, supplier_name_ocr: 'ВКУСНЫЙ МИР ТК',
    });
    expect(inv(11)).toMatchObject({
      supplier_inn: GOOD, supplier_match: 'manual', supplier_inn_ocr: '7724350000', supplier_name_ocr: 'Вкусный мир',
    });
    expect(inv(12)).toMatchObject({ supplier_inn: GOOD, supplier_match: 'inn', supplier_inn_ocr: null });
    expect(inv(13)).toMatchObject({ supplier_inn: TYPO, supplier: 'X', supplier_match: null });
  });

  it('правила: переносит только бесконфликтные и только свои', async () => {
    await mergeSupplierCards(OWNER, TYPO, GOOD);
    const key = (t: string, id: number) => tables[t].find(r => r.id === id)!.supplier_key;
    expect(key('supplier_nomenclature_mapping_cards', 100)).toBe(`inn:${GOOD}`);
    expect(key('supplier_nomenclature_mapping_cards', 101)).toBe(`inn:${TYPO}`); // конфликт — остался
    expect(key('supplier_nomenclature_mapping_cards', 103)).toBe(`inn:${TYPO}`); // чужая компания
    expect(key('ocr_correction_cards', 200)).toBe(TYPO);                          // конфликт — остался
    expect(key('ocr_correction_cards', 201)).toBe(GOOD);
    expect(key('ocr_correction_cards', 203)).toBe(GOOD); // тот же hash, но другое поле — не конфликт
  });

  it('пишет в лог удалённую карточку целиком (для восстановления)', async () => {
    await mergeSupplierCards(OWNER, TYPO, GOOD);
    expect(logger.warn).toHaveBeenCalledWith('Supplier cards merged', expect.objectContaining({
      ownerUserId: OWNER, from_inn: TYPO, to_inn: GOOD, moved_invoices: 2,
      deleted_card: expect.objectContaining({ inn: TYPO, bank_bic: '044525225' }),
    }));
  });

  it('в карточку с невалидным ИНН не объединяет — и ничего не меняет', async () => {
    const before = JSON.stringify(tables);
    const err = await mergeSupplierCards(OWNER, GOOD, '5258006806').catch(e => e);
    expect(err).toBeInstanceOf(SupplierMergeError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/не проходит проверку контрольной суммы/);
    expect(JSON.stringify(tables)).toBe(before);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('карточки нет (или она чужая) — 404', async () => {
    const missing = await mergeSupplierCards(OWNER, '1234567890', GOOD).catch(e => e);
    expect(missing).toBeInstanceOf(SupplierMergeError);
    expect(missing.status).toBe(404);

    // Карточка 7724357632 есть только у OWNER и OTHER; у компании 3 её нет.
    const foreign = await mergeSupplierCards(3, TYPO, GOOD).catch(e => e);
    expect(foreign.status).toBe(404);
    expect(tables.supplier_cards).toHaveLength(4);
  });

  it('сама с собой — 400 без обращения к базе', async () => {
    const err = await mergeSupplierCards(OWNER, GOOD, GOOD).catch(e => e);
    expect(err).toBeInstanceOf(SupplierMergeError);
    expect(err.status).toBe(400);
    expect(executed).toHaveLength(0);
  });
});
