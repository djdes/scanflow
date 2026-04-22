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

// Stage 1.5: fuzzy lookup among previously-saved learned mappings.
// Fuse (char-level) was too strict for long Russian names like
// "Продукт жировой йогуртовый без наполнителя 3кг" vs
// "Продукт жировой йогуртовый 20% ведро 3л" — Fuse score stayed 0.79
// (confidence 0.21) even though these are the same product.
//
// Switched to Jaccard similarity on normalised tokens. Normalisation strips
// weight/volume suffixes and standalone digits, then we split on whitespace
// and dashes and throw away 3-letter stop-words ("для", "без"). Similarity
// is |A∩B| / |A∪B| — the two pairs from the failing case score 0.75 and
// 0.67, both ≥ threshold 0.5.
const LEARNED_TOKEN_MIN_SIMILARITY = 0.5;
const LEARNED_STOPWORDS = new Set([
  'для', 'без', 'из', 'от', 'при', 'на', 'по', 'со', 'до', 'и', 'в',
  'упак', 'уп', 'шт', 'кг', 'гр', 'мл', 'короб', 'ведро', 'бут', 'пач',
]);

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
      .replace(/[^а-яёa-z0-9%\-\s]/gi, ' ')
      .split(/[\s\-]+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !LEARNED_STOPWORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

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

interface LearnedToken {
  row: NomenclatureMapping;
  tokens: Set<string>;
}

export class NomenclatureMapper {
  private onecFuse: Fuse<OnecNomenclatureRow> | null = null;
  private learnedTokens: LearnedToken[] | null = null;

  private refreshIndex(): void {
    const items = onecNomenclatureRepo.listItems({ excludeFolders: true });
    this.onecFuse = new Fuse(items, ONEC_FUSE_OPTIONS);
    logger.debug('Nomenclature mapper index refreshed', { onecItems: items.length });
  }

  private refreshLearnedIndex(): void {
    // Only rows with a live onec_guid — legacy rows without guid can't help
    // link a new scan to 1С.
    const all = mappingRepo.getAll().filter(m => m.onec_guid);
    this.learnedTokens = all.map(row => ({
      row,
      tokens: tokenize(normalizeName(row.scanned_name)),
    }));
    logger.debug('Learned mappings index refreshed', { learnedCount: all.length });
  }

  private ensureIndex(): Fuse<OnecNomenclatureRow> {
    if (!this.onecFuse) {
      this.refreshIndex();
    }
    return this.onecFuse!;
  }

  private ensureLearnedIndex(): LearnedToken[] {
    if (!this.learnedTokens) {
      this.refreshLearnedIndex();
    }
    return this.learnedTokens!;
  }

  invalidateCache(): void {
    this.onecFuse = null;
    this.learnedTokens = null;
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

    // 1.5 Token-based fuzzy against previously-learned scanned names.
    //
    // The catalog often lacks the exact phrase a supplier writes, but the
    // user has usually already mapped a SIMILAR phrase before. Example:
    //   old scan:   "Продукт жировой для блюд 45%"       → Сыр Моцарелла
    //   new scan:   "Продукт белково-жировой для лепки 45%"
    // Onec fuzzy finds nothing (catalog has no "для лепки"), but the two
    // scans share 3+ content tokens — Jaccard here gets us to Моцарелла.
    //
    // Jaccard is used instead of Fuse because Fuse's char-level scoring
    // stays >0.7 even on pairs like ("…йогуртовый без наполнителя 3кг",
    // "…йогуртовый 20% ведро 3л") that obviously refer to the same item.
    const learnedIdx = this.ensureLearnedIndex();
    const incomingTokens = tokenize(cleanName || scannedName);
    if (incomingTokens.size >= 2 && learnedIdx.length > 0) {
      let best: { row: NomenclatureMapping; sim: number } | null = null;
      for (const entry of learnedIdx) {
        const sim = jaccard(incomingTokens, entry.tokens);
        if (sim >= LEARNED_TOKEN_MIN_SIMILARITY && (!best || sim > best.sim)) {
          best = { row: entry.row, sim };
        }
      }
      if (best && best.row.onec_guid) {
        const onec = onecNomenclatureRepo.getByGuid(best.row.onec_guid);
        if (onec) {
          logger.info('Mapping via learned-name token fuzzy', {
            scannedName,
            matchedScanName: best.row.scanned_name,
            target: onec.name,
            similarity: best.sim.toFixed(3),
          });
          return {
            original_name: scannedName,
            mapped_name: onec.name,
            onec_guid: best.row.onec_guid,
            confidence: best.sim,
            source: 'learned',
            // Never inherit the OTHER row's mapping_id — it belongs to a
            // different scanned_name and shouldn't be overwritten.
            mapping_id: null,
            pack_size: best.row.pack_size,
            pack_unit: best.row.pack_unit,
          };
        }
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
