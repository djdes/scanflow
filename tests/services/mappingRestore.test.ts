import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/database/db', () => ({ getDb: vi.fn() }));

import { classifyRestoreRow, type RestoreFacts } from '../../src/services/mappingRestore';
import { parseDumpTable, toRestoreRows } from '../../src/scripts/restore-mappings-from-dump';

const facts = (over: Partial<RestoreFacts> = {}): RestoreFacts => ({
  exists: false, nameKeyTaken: false, catalogName: 'Печень говяжья замороженная', isFolder: false, rejected: false, ...over,
});
const row = (scanned_name: string) => ({ scanned_name, onec_guid: 'g-1' });

describe('classifyRestoreRow', () => {
  it('restores a genuinely missing rule whose 1C item still exists', () => {
    expect(classifyRestoreRow(row('Печень Говяжья Замороженная Аргентина 4кг'), facts()).verdict).toBe('restore');
  });

  it('never overwrites: existing name or taken name key wins', () => {
    expect(classifyRestoreRow(row('Печень говяж зам'), facts({ exists: true })).verdict).toBe('exists');
    expect(classifyRestoreRow(row('Печень говяж зам'), facts({ nameKeyTaken: true })).verdict).toBe('name_key_taken');
  });

  it('skips items gone from the catalog and folders', () => {
    expect(classifyRestoreRow(row('Печень'), facts({ catalogName: null })).verdict).toBe('guid_missing');
    expect(classifyRestoreRow(row('Печень'), facts({ isFolder: true })).verdict).toBe('guid_missing');
  });

  it('skips identity and word-prefix fragments of the 1C name', () => {
    const f = facts({ catalogName: 'Продукт жировой сметанный 20%' });
    expect(classifyRestoreRow(row('Продукт жировой сметанный 20%'), f).verdict).toBe('identity');
    expect(classifyRestoreRow(row('ПРОДУКТ'), f).verdict).toBe('fragment');
    expect(classifyRestoreRow(row('Продукт жировой'), f).verdict).toBe('fragment');
  });

  it('skips conflicting attributes and rejected pairs', () => {
    const r = classifyRestoreRow(row('Продукт Рассольный Сиртаки 55% 330г 15/1'), facts({ catalogName: 'Сыр Сыртаки 500гр для греческого' }));
    expect(r.verdict).toBe('attrs_conflict');
    expect(r.reason).toMatch(/масса/);
    expect(classifyRestoreRow(row('Печень говяж зам'), facts({ rejected: true })).verdict).toBe('rejected');
  });

  it('flags invalid input', () => {
    expect(classifyRestoreRow({ scanned_name: ' ', onec_guid: 'g' }, facts()).verdict).toBe('invalid');
    expect(classifyRestoreRow({ scanned_name: 'x', onec_guid: '' }, facts()).verdict).toBe('invalid');
  });
});

describe('parseDumpTable', () => {
  const create = "CREATE TABLE `nomenclature_mappings` (\n  `id` int NOT NULL,\n  `scanned_name` varchar(512) NOT NULL,\n  `onec_guid` varchar(64) DEFAULT NULL,\n  `pack_size` double DEFAULT NULL\n) ENGINE=InnoDB;\n";

  it('reads mysqldump tuples with escapes and NULLs', () => {
    const sql = create + "INSERT INTO `nomenclature_mappings` VALUES (1,'Сыр \\'Российский\\' 45%','g-1',NULL),(2,'Мука, в\\\\с','g-2',50);\n";
    expect(parseDumpTable(sql, 'nomenclature_mappings')).toEqual([
      { id: 1, scanned_name: "Сыр 'Российский' 45%", onec_guid: 'g-1', pack_size: null },
      { id: 2, scanned_name: 'Мука, в\\с', onec_guid: 'g-2', pack_size: 50 },
    ]);
  });

  it('reads INSERTs with an explicit column list and keeps only rows with a 1C guid', () => {
    const sql = "INSERT INTO `nomenclature_mapping_cards` (`owner_user_id`,`scanned_name`,`onec_guid`) VALUES\n(1,'Батон','g-1'),\n(1,'Без позиции',NULL),\n(3,'Чужой','g-3');\n";
    const rows = parseDumpTable(sql, 'nomenclature_mapping_cards');
    expect(rows).toHaveLength(3);
    expect(toRestoreRows(rows, 1)).toEqual([
      { scanned_name: 'Батон', onec_guid: 'g-1', pack_size: null, pack_unit: null, default_unit: null, category: null },
    ]);
  });
});
