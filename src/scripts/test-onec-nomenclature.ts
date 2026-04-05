/**
 * Tests for onecNomenclatureRepo.
 * Usage: npx ts-node src/scripts/test-onec-nomenclature.ts
 */
import '../config';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { getDb } from '../database/db';

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passCount++;
  } else {
    console.log(`  ❌ FAIL: ${message}`);
    failCount++;
  }
}

async function main(): Promise<void> {
  console.log('onecNomenclatureRepo tests');
  console.log('==========================');

  // Clean slate for deterministic tests
  const db = getDb();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-%'").run();

  console.log('\n=== bulkUpsert inserts new rows ===');
  const inserted = onecNomenclatureRepo.bulkUpsert([
    { guid: 'test-1', code: 'НФ-001', name: 'Картофель сырой', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-2', code: 'НФ-002', name: 'Морковь свежая', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-grp', code: null, name: 'Овощи', unit: null, is_folder: true, is_weighted: false },
  ]);
  assert(inserted === 3, `bulkUpsert returned 3, got ${inserted}`);

  console.log('\n=== getByGuid finds inserted row ===');
  const row = onecNomenclatureRepo.getByGuid('test-1');
  assert(row !== undefined, 'row is defined');
  assert(row?.name === 'Картофель сырой', `name matches, got ${row?.name}`);
  assert(row?.is_weighted === 1, `is_weighted stored as 1 (sqlite int), got ${row?.is_weighted}`);

  console.log('\n=== bulkUpsert updates existing rows ===');
  onecNomenclatureRepo.bulkUpsert([
    { guid: 'test-1', code: 'НФ-001', name: 'Картофель новый', unit: 'кг', is_folder: false, is_weighted: true },
  ]);
  const updated = onecNomenclatureRepo.getByGuid('test-1');
  assert(updated?.name === 'Картофель новый', 'name updated');

  console.log('\n=== listItems excludes folders by default ===');
  const items = onecNomenclatureRepo.listItems({ excludeFolders: true });
  const testItems = items.filter(i => i.guid.startsWith('test-'));
  assert(testItems.length === 2, `got 2 items (folder excluded), got ${testItems.length}`);

  console.log('\n=== stats returns counts ===');
  const stats = onecNomenclatureRepo.stats();
  assert(typeof stats.total === 'number' && stats.total >= 3, 'total ≥ 3');
  assert(typeof stats.folders === 'number', 'folders is number');
  assert(typeof stats.items === 'number', 'items is number');

  // Cleanup
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-%'").run();

  console.log(`\n==========================`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
