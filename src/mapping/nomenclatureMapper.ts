import Fuse, { IFuseOptions } from 'fuse.js';
import { mappingRepo, NomenclatureMapping } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo, OnecNomenclatureRow } from '../database/repositories/onecNomenclatureRepo';
import { detectPackFromName } from './packTransform';
import { logger } from '../utils/logger';

export interface MappingResult {
  original_name: string;
  mapped_name: string;
  onec_guid: string | null;
  confidence: number;
  source: 'learned' | 'onec_fuzzy' | 'legacy' | 'none';
  mapping_id: number | null; // id of nomenclature_mappings row if matched
  // Pack transform carried through from the learned mapping (if any).
  // When both are non-null, the watcher rewrites the item:
  //   quantity *= pack_size, unit = pack_unit, price = total / new quantity
  pack_size: number | null;
  pack_unit: string | null;
}

const ONEC_FUSE_OPTIONS: IFuseOptions<OnecNomenclatureRow> = {
  keys: ['name', 'full_name'],
  threshold: 0.4, // Fuse score — best score must be ≤ 0.4, i.e. confidence ≥ 0.6
  includeScore: true,
  minMatchCharLength: 3,
};

// Fuse options for learned-mappings lookup (Stage 1.5). We match the scanned
// name of the INCOMING invoice against the scanned_names of previously-saved
// learned mappings — NOT against the catalog. This catches cases where a new
// invoice has a scan-name the catalog doesn't cover, but the user already
// mapped a very similar name manually before (e.g. "Продукт белково-жировой
// для лепки 45%" vs the previously-mapped "Продукт жировой для блюд 45%").
const LEARNED_FUSE_OPTIONS: IFuseOptions<NomenclatureMapping> = {
  keys: ['scanned_name'],
  threshold: 0.35, // slightly stricter than onec — these must be "the same product in a different wording"
  includeScore: true,
  minMatchCharLength: 4,
};
const LEARNED_MIN_CONFIDENCE = 0.75;

// Minimum confidence to return a fuzzy match at all (user sees it)
const MIN_FUZZY_CONFIDENCE = 0.6;

// Minimum confidence to AUTO-SAVE a fuzzy match as a learned mapping.
// Higher than MIN_FUZZY_CONFIDENCE so questionable matches don't pollute
// learned mappings (they would become "exact" 1.0-confidence lookups next time).
// Matches between 0.6 and 0.8 are shown but NOT saved — user can approve manually.
const AUTO_SAVE_CONFIDENCE = 0.8;

/**
 * Strip weight/volume/count suffixes and packaging info from scanned names.
 * "Капуста морская(3кг)" → "Капуста морская"
 * "Батон Нарезной 0,4 кг" → "Батон Нарезной"
 * "Вода 1.5л пэт" → "Вода пэт"  (keeps non-measure words)
 */
export function normalizeName(name: string): string {
  let s = name;
  // Remove ALL content in parentheses: "(помидоры)", "(вес)", "(3кг)" etc.
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ');
  // Remove weight/volume/count anywhere: "5кг", "0,4 кг", "1.5л", "500г", "10шт", "360шт", "50мл"
  s = s.replace(/\d+[.,]?\d*\s*(?:кг|г|гр|л|мл|шт|уп|упак|пач|бут)\.?/gi, '');
  // Remove standalone numbers that look like weight: "5", "1.5", "0,4" (only if surrounded by spaces/edges)
  s = s.replace(/(?:^|\s)\d+[.,]?\d*(?:\s|$)/g, ' ');
  // Remove packaging/brand suffixes: "пэт", "в/у", "б/у", "вбу", "в вакууме"
  s = s.replace(/\b(?:пэт|ПЭТ|в\/у|б\/у|вбу|б\/к|б\/г|в вакууме|с\/м|с\/к|с\/с|в\/к|в\/с)\b/gi, '');
  // Remove trailing dashes with content: "- 5,3 кг"
  s = s.replace(/\s*-\s*[\d.,]+\s*(?:кг|г|л|мл|шт)?\.?\s*/gi, '');
  // Clean up extra spaces
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

export class NomenclatureMapper {
  private onecFuse: Fuse<OnecNomenclatureRow> | null = null;
  private learnedFuse: Fuse<NomenclatureMapping> | null = null;

  private refreshIndex(): void {
    const items = onecNomenclatureRepo.listItems({ excludeFolders: true });
    this.onecFuse = new Fuse(items, ONEC_FUSE_OPTIONS);
    logger.debug('Nomenclature mapper index refreshed', { onecItems: items.length });
  }

  private refreshLearnedIndex(): void {
    // Only learned rows that resolve to a live onec_guid — legacy rows
    // without guid won't help us link a new scan to 1С anyway.
    const all = mappingRepo.getAll().filter(m => m.onec_guid);
    this.learnedFuse = new Fuse(all, LEARNED_FUSE_OPTIONS);
    logger.debug('Learned mappings index refreshed', { learnedCount: all.length });
  }

  private ensureIndex(): Fuse<OnecNomenclatureRow> {
    if (!this.onecFuse) {
      this.refreshIndex();
    }
    return this.onecFuse!;
  }

  private ensureLearnedIndex(): Fuse<NomenclatureMapping> {
    if (!this.learnedFuse) {
      this.refreshLearnedIndex();
    }
    return this.learnedFuse!;
  }

  invalidateCache(): void {
    this.onecFuse = null;
    this.learnedFuse = null;
    logger.info('Nomenclature mapper cache invalidated');
  }

  /**
   * Resolve a scanned item name to a 1C Номенклатура reference.
   * Lookup order:
   *   1. Learned mapping by exact scanned_name → returns onec_guid + name from onec_nomenclature
   *      (or legacy mapped_name_1c if the old row has no onec_guid set)
   *   2. Fuzzy search against onec_nomenclature (confidence ≥ 0.7)
   *   3. None
   */
  map(scannedName: string): MappingResult {
    const cleanName = normalizeName(scannedName);

    // 1. Learned mapping (try original first, then cleaned)
    const learned = mappingRepo.getByScannedName(scannedName)
      || (cleanName !== scannedName ? mappingRepo.getByScannedName(cleanName) : null);
    if (learned) {
      if (learned.onec_guid) {
        const onec = onecNomenclatureRepo.getByGuid(learned.onec_guid);
        if (onec) {
          return {
            original_name: scannedName,
            mapped_name: onec.name,
            onec_guid: learned.onec_guid,
            confidence: 1.0,
            source: 'learned',
            mapping_id: learned.id,
            pack_size: learned.pack_size,
            pack_unit: learned.pack_unit,
          };
        }
        // GUID existed in learned mapping but is no longer in onec_nomenclature
        // (deleted since last sync or catalog not re-synced). Log and fall through
        // to fuzzy search so we don't propagate a dead GUID to 1C.
        logger.warn('Learned mapping has onec_guid not found in onec_nomenclature — treating as unresolved', {
          scannedName,
          onec_guid: learned.onec_guid,
          mapping_id: learned.id,
        });
        // intentional fallthrough — do not return here
      } else {
        // Legacy mapping without onec_guid
        return {
          original_name: scannedName,
          mapped_name: learned.mapped_name_1c,
          onec_guid: null,
          confidence: 0.9,
          source: 'legacy',
          mapping_id: learned.id,
          pack_size: learned.pack_size,
          pack_unit: learned.pack_unit,
        };
      }
    }

    // 1.5 Fuzzy search against learned mappings' scanned_names.
    //
    // Why this exists: the catalog (onec_nomenclature) often doesn't contain
    // the exact phrase the supplier writes on their invoice. But if the SAME
    // product came through before with a slightly different wording and the
    // user mapped it manually, we should reuse that mapping. Example:
    //   old scan:   "Продукт жировой для блюд 45%"       → Сыр Моцарелла
    //   new scan:   "Продукт белково-жировой для лепки 45%"
    // The onec catalog doesn't have "белково-жировой для лепки"; onec fuzzy
    // returns nothing. But learned-scanned-name fuzzy recognises the family
    // "Продукт ... жировой ... 45%" and reuses the Моцарелла target.
    const learnedFuse = this.ensureLearnedIndex();
    const searchTerm = cleanName || scannedName;
    const learnedResults = learnedFuse.search(searchTerm);
    if (learnedResults.length > 0 && learnedResults[0].score !== undefined) {
      const best = learnedResults[0];
      const confidence = 1 - (best.score as number);
      if (confidence >= LEARNED_MIN_CONFIDENCE && best.item.onec_guid) {
        const onec = onecNomenclatureRepo.getByGuid(best.item.onec_guid);
        if (onec) {
          logger.info('Mapping via learned-name fuzzy', {
            scannedName,
            matchedScanName: best.item.scanned_name,
            target: onec.name,
            confidence: confidence.toFixed(3),
          });
          return {
            original_name: scannedName,
            mapped_name: onec.name,
            onec_guid: best.item.onec_guid,
            confidence,
            source: 'learned',
            // Do NOT pass mapping_id of the OTHER scan's row — that row
            // belongs to a different scanned_name. Null it out to avoid
            // accidentally updating somebody else's pack fields.
            mapping_id: null,
            pack_size: best.item.pack_size,
            pack_unit: best.item.pack_unit,
          };
        }
      }
    }

    // 2. Fuzzy search against onec_nomenclature (use cleaned name)
    const fuse = this.ensureIndex();
    const results = fuse.search(searchTerm);
    if (results.length > 0 && results[0].score !== undefined) {
      const best = results[0];
      const confidence = 1 - (best.score as number);
      if (confidence >= MIN_FUZZY_CONFIDENCE) {
        // Auto-save ONLY if confidence is high enough to avoid polluting
        // learned mappings. Matches in [0.6, 0.8) are returned to the user
        // but not persisted — they need manual confirmation.
        if (confidence >= AUTO_SAVE_CONFIDENCE) {
          try {
            // If the scanned name carries pack info ("Мука 50кг"), persist it on
            // the new mapping so future runs skip the regex fallback.
            const detected = detectPackFromName(scannedName);
            const packFields = detected
              ? { pack_size: detected.pack_size, pack_unit: detected.pack_unit }
              : {};
            const existing = mappingRepo.getByScannedName(scannedName);
            if (!existing) {
              mappingRepo.create({
                scanned_name: scannedName,
                mapped_name_1c: best.item.name,
                onec_guid: best.item.guid,
                ...packFields,
              });
            }
            // Also save cleaned name variant if different
            if (cleanName !== scannedName) {
              const existingClean = mappingRepo.getByScannedName(cleanName);
              if (!existingClean) {
                // Cleaned name has no pack suffix, so no pack fields here.
                mappingRepo.create({
                  scanned_name: cleanName,
                  mapped_name_1c: best.item.name,
                  onec_guid: best.item.guid,
                });
              }
            }
          } catch (e) {
            logger.warn('Auto-save mapping failed', { scannedName, error: (e as Error).message });
          }
        }

        return {
          original_name: scannedName,
          mapped_name: best.item.name,
          onec_guid: best.item.guid,
          confidence,
          source: 'onec_fuzzy',
          mapping_id: null,
          pack_size: null,
          pack_unit: null,
        };
      }
    }

    // 3. None
    return {
      original_name: scannedName,
      mapped_name: scannedName,
      onec_guid: null,
      confidence: 0,
      source: 'none',
      mapping_id: null,
      pack_size: null,
      pack_unit: null,
    };
  }

  mapAll(names: string[]): MappingResult[] {
    return names.map(n => this.map(n));
  }

  getSuggestions(scannedName: string, limit: number = 5): Array<{ guid: string; name: string; confidence: number }> {
    const fuse = this.ensureIndex();
    const results = fuse.search(normalizeName(scannedName) || scannedName, { limit });
    return results.map(r => ({
      guid: r.item.guid,
      name: r.item.name,
      confidence: 1 - (r.score || 1),
    }));
  }
}

// Re-export for callers that previously used NomenclatureMapping
export type { NomenclatureMapping };
