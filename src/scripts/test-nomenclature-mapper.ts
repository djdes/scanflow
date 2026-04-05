/**
 * Tests for NomenclatureMapper with GUID-first learned lookup + fuzzy onec_nomenclature.
 * Usage: npx ts-node src/scripts/test-nomenclature-mapper.ts
 */
import '../config';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';
import { onecNomenclatureRepo } from '../database/repositories/onecNomenclatureRepo';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { getDb } from '../database/db';

let passCount = 0;
let failCount = 0;
function assert(condition: boolean, message: string): void {
  if (condition) { console.log(`  ✅ ${message}`); passCount++; }
  else { console.log(`  ❌ FAIL: ${message}`); failCount++; }
}

async function main(): Promise<void> {
  console.log('NomenclatureMapper tests');
  console.log('========================');

  // Clean slate
  const db = getDb();
  db.prepare("DELETE FROM nomenclature_mappings WHERE scanned_name LIKE 'testmap:%'").run();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-map-%'").run();

  // Seed onec_nomenclature
  onecNomenclatureRepo.bulkUpsert([
    { guid: 'test-map-1', code: 'НФ-001', name: 'Картофель сырой', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-map-2', code: 'НФ-002', name: 'Морковь свежая', unit: 'кг', is_folder: false, is_weighted: true },
    { guid: 'test-map-3', code: 'НФ-003', name: 'Молоко 3.2% 1л', unit: 'шт', is_folder: false, is_weighted: false },
  ]);

  const mapper = new NomenclatureMapper();

  console.log('\n=== Case 1: no mapping, fuzzy hit against onec_nomenclature ===');
  const r1 = mapper.map('Картофель');
  assert(r1.source === 'onec_fuzzy', `source=onec_fuzzy, got ${r1.source}`);
  assert(r1.onec_guid === 'test-map-1', `onec_guid test-map-1, got ${r1.onec_guid}`);
  assert(r1.mapped_name === 'Картофель сырой', `mapped_name=Картофель сырой, got ${r1.mapped_name}`);
  assert(r1.confidence >= 0.5, `confidence ≥ 0.5, got ${r1.confidence}`);

  console.log('\n=== Case 2: learned mapping (exact scan name) wins over fuzzy ===');
  const created = mappingRepo.create({
    scanned_name: 'testmap:моло',
    mapped_name_1c: 'Молоко 3.2% 1л',
    onec_guid: 'test-map-3',
  });
  mapper.invalidateCache();
  const r2 = mapper.map('testmap:моло');
  assert(r2.source === 'learned', `source=learned, got ${r2.source}`);
  assert(r2.onec_guid === 'test-map-3', `onec_guid test-map-3, got ${r2.onec_guid}`);
  assert(r2.confidence === 1.0, `confidence=1.0, got ${r2.confidence}`);

  console.log('\n=== Case 3: nothing matches → source = none, onec_guid = null ===');
  const r3 = mapper.map('xyzunknown12345');
  assert(r3.source === 'none', `source=none, got ${r3.source}`);
  assert(r3.onec_guid === null, `onec_guid null, got ${r3.onec_guid}`);
  assert(r3.confidence === 0, `confidence=0, got ${r3.confidence}`);

  console.log('\n=== Case 4: learned mapping without onec_guid is still returned (legacy) ===');
  db.prepare(`INSERT INTO nomenclature_mappings (scanned_name, mapped_name_1c) VALUES (?, ?)`)
    .run('testmap:legacy', 'Legacy Item Name');
  mapper.invalidateCache();
  const r4 = mapper.map('testmap:legacy');
  assert(r4.source === 'learned' || r4.source === 'legacy', `source=learned|legacy, got ${r4.source}`);
  assert(r4.onec_guid === null, `onec_guid null for legacy, got ${r4.onec_guid}`);
  assert(r4.mapped_name === 'Legacy Item Name', `mapped_name=Legacy Item Name, got ${r4.mapped_name}`);

  // Cleanup
  mappingRepo.delete(created.id);
  db.prepare("DELETE FROM nomenclature_mappings WHERE scanned_name LIKE 'testmap:%'").run();
  db.prepare("DELETE FROM onec_nomenclature WHERE guid LIKE 'test-map-%'").run();

  console.log(`\n========================`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);
  if (failCount > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
