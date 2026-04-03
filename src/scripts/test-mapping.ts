/**
 * Тест маппинга номенклатуры
 * Использование: npm run test:mapping -- "Молоко 3.2%"
 */
import '../config';
import { getDb } from '../database/db';
import { mappingRepo } from '../database/repositories/mappingRepo';
import { NomenclatureMapper } from '../mapping/nomenclatureMapper';

function main(): void {
  const name = process.argv[2];
  if (!name) {
    console.log('Usage: npm run test:mapping -- "Название товара"');
    console.log('Example: npm run test:mapping -- "Молоко 3.2%"\n');

    // Show current mappings
    getDb();
    const allMappings = mappingRepo.getAll();
    console.log(`Current mappings in database: ${allMappings.length}`);

    if (allMappings.length === 0) {
      console.log('\nNo mappings yet. Add some with:');
      console.log('  curl -X POST http://localhost:3000/api/mappings \\');
      console.log('    -H "X-API-Key: your-secret-api-key" \\');
      console.log('    -H "Content-Type: application/json" \\');
      console.log('    -d \'{"scanned_name": "Молоко 3.2% 1л", "mapped_name_1c": "Молоко пастеризованное 3.2% 1л"}\'');
    } else {
      allMappings.forEach(m => {
        console.log(`  "${m.scanned_name}" → "${m.mapped_name_1c}" ${m.approved ? '✓' : '?'}`);
      });
    }
    return;
  }

  getDb();
  const mapper = new NomenclatureMapper();

  console.log(`\n=== Mapping test for: "${name}" ===\n`);

  // Direct mapping
  const result = mapper.map(name);
  console.log('Direct mapping:');
  console.log(`  Original: ${result.original_name}`);
  console.log(`  Mapped:   ${result.mapped_name}`);
  console.log(`  Source:   ${result.source}`);
  console.log(`  Confidence: ${(result.confidence * 100).toFixed(0)}%`);

  // Suggestions
  console.log('\nTop-5 suggestions:');
  const suggestions = mapper.getSuggestions(name);
  if (suggestions.length === 0) {
    console.log('  No suggestions (add mappings to database first)');
  } else {
    suggestions.forEach((s, i) => {
      console.log(`  ${i + 1}. "${s.name}" (${(s.confidence * 100).toFixed(0)}%)`);
    });
  }
}

main();
