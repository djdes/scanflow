import Fuse, { IFuseOptions } from 'fuse.js';
import { mappingRepo, NomenclatureMapping } from '../database/repositories/mappingRepo';
import { logger } from '../utils/logger';

export interface MappingResult {
  original_name: string;
  mapped_name: string;
  confidence: number;
  source: 'exact' | 'fuzzy' | 'none';
}

const FUSE_OPTIONS: IFuseOptions<NomenclatureMapping> = {
  keys: ['scanned_name', 'mapped_name_1c'],
  threshold: 0.4,
  includeScore: true,
  minMatchCharLength: 3,
};

export class NomenclatureMapper {
  private fuse: Fuse<NomenclatureMapping> | null = null;

  private refreshIndex(): void {
    const allMappings = mappingRepo.getAll();
    this.fuse = new Fuse(allMappings, FUSE_OPTIONS);
    logger.debug('Nomenclature index refreshed', { count: allMappings.length });
  }

  private ensureIndex(): Fuse<NomenclatureMapping> {
    if (!this.fuse) {
      this.refreshIndex();
    }
    return this.fuse!;
  }

  map(scannedName: string): MappingResult {
    // 1. Exact match
    const exact = mappingRepo.getByScannedName(scannedName);
    if (exact) {
      logger.debug('Exact mapping found', { scannedName, mappedName: exact.mapped_name_1c });
      return {
        original_name: scannedName,
        mapped_name: exact.mapped_name_1c,
        confidence: 1.0,
        source: 'exact',
      };
    }

    // 2. Fuzzy search
    const fuse = this.ensureIndex();
    const results = fuse.search(scannedName);

    if (results.length > 0 && results[0].score !== undefined) {
      const best = results[0];
      const confidence = 1 - best.score!;

      if (confidence >= 0.6) {
        logger.debug('Fuzzy mapping found', {
          scannedName,
          mappedName: best.item.mapped_name_1c,
          confidence,
        });
        return {
          original_name: scannedName,
          mapped_name: best.item.mapped_name_1c,
          confidence,
          source: 'fuzzy',
        };
      }
    }

    // 3. No match — return original name
    logger.debug('No mapping found', { scannedName });
    return {
      original_name: scannedName,
      mapped_name: scannedName,
      confidence: 0,
      source: 'none',
    };
  }

  mapAll(names: string[]): MappingResult[] {
    return names.map(name => this.map(name));
  }

  invalidateCache(): void {
    this.fuse = null;
    logger.info('Nomenclature cache invalidated');
  }

  getSuggestions(scannedName: string, limit: number = 5): Array<{ name: string; confidence: number }> {
    const fuse = this.ensureIndex();
    const results = fuse.search(scannedName, { limit });

    return results.map(r => ({
      name: r.item.mapped_name_1c,
      confidence: 1 - (r.score || 1),
    }));
  }
}
