import Fuse, { IFuseOptions } from 'fuse.js';
import { mappingRepo, NomenclatureMapping } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo, OnecNomenclatureRow } from '../database/repositories/onecNomenclatureRepo';
import { logger } from '../utils/logger';

export interface MappingResult {
  original_name: string;
  mapped_name: string;
  onec_guid: string | null;
  confidence: number;
  source: 'learned' | 'onec_fuzzy' | 'legacy' | 'none';
  mapping_id: number | null; // id of nomenclature_mappings row if matched
}

const ONEC_FUSE_OPTIONS: IFuseOptions<OnecNomenclatureRow> = {
  keys: ['name', 'full_name'],
  threshold: 0.3, // Fuse score — best score must be ≤ 0.3, i.e. confidence ≥ 0.7
  includeScore: true,
  minMatchCharLength: 3,
};

const MIN_FUZZY_CONFIDENCE = 0.7;

/**
 * Strip weight/volume/count suffixes and packaging info from scanned names.
 * "Капуста морская(3кг)" → "Капуста морская"
 * "Батон Нарезной 0,4 кг" → "Батон Нарезной"
 * "Вода 1.5л пэт" → "Вода пэт"  (keeps non-measure words)
 */
function normalizeName(name: string): string {
  let s = name;
  // Remove content in parentheses: "(3кг)", "(вес)", "(1л)" etc.
  s = s.replace(/\s*\([^)]*\)\s*/g, ' ');
  // Remove standalone weight/volume/count patterns: "3кг", "0,4 кг", "1.5 л", "500г", "10шт", "50 мл"
  s = s.replace(/\b\d+[.,]?\d*\s*(?:кг|г|гр|л|мл|шт|уп|упак|пач|бут)\.?\b/gi, '');
  // Remove trailing "в/у", "б/к", "зам.", "охл.", "свежемор." etc. — keep as is, they're descriptive
  // Clean up extra spaces
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

export class NomenclatureMapper {
  private onecFuse: Fuse<OnecNomenclatureRow> | null = null;

  private refreshIndex(): void {
    const items = onecNomenclatureRepo.listItems({ excludeFolders: true });
    this.onecFuse = new Fuse(items, ONEC_FUSE_OPTIONS);
    logger.debug('Nomenclature mapper index refreshed', { onecItems: items.length });
  }

  private ensureIndex(): Fuse<OnecNomenclatureRow> {
    if (!this.onecFuse) {
      this.refreshIndex();
    }
    return this.onecFuse!;
  }

  invalidateCache(): void {
    this.onecFuse = null;
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
        };
      }
    }

    // 2. Fuzzy search against onec_nomenclature (use cleaned name)
    const fuse = this.ensureIndex();
    const searchTerm = cleanName || scannedName;
    const results = fuse.search(searchTerm);
    if (results.length > 0 && results[0].score !== undefined) {
      const best = results[0];
      const confidence = 1 - (best.score as number);
      if (confidence >= MIN_FUZZY_CONFIDENCE) {
        // Auto-save as learned mapping for future exact match
        try {
          const existing = mappingRepo.getByScannedName(scannedName);
          if (!existing) {
            mappingRepo.create({
              scanned_name: scannedName,
              mapped_name_1c: best.item.name,
              onec_guid: best.item.guid,
            });
          }
          // Also save cleaned name variant if different
          if (cleanName !== scannedName) {
            const existingClean = mappingRepo.getByScannedName(cleanName);
            if (!existingClean) {
              mappingRepo.create({
                scanned_name: cleanName,
                mapped_name_1c: best.item.name,
                onec_guid: best.item.guid,
              });
            }
          }
        } catch (e) {
          // Don't fail mapping if auto-save fails
          logger.warn('Auto-save mapping failed', { scannedName, error: (e as Error).message });
        }

        return {
          original_name: scannedName,
          mapped_name: best.item.name,
          onec_guid: best.item.guid,
          confidence,
          source: 'onec_fuzzy',
          mapping_id: null,
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
