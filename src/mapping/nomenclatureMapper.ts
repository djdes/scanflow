import Fuse, { IFuseOptions } from 'fuse.js';
import { mappingRepo, NomenclatureMapping } from '../database/repositories/mappingRepo';
import { onecNomenclatureRepo, OnecNomenclatureRow } from '../database/repositories/onecNomenclatureRepo';
import { detectPackFromName } from './packTransform';
import { cleanItemName } from './nameCleaner';
import { logger } from '../utils/logger';

export interface MappingResult {
  original_name: string;
  mapped_name: string;
  onec_guid: string | null;
  confidence: number;
  source: 'learned' | 'onec_token' | 'onec_fuzzy' | 'legacy' | 'none';
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

// --- Stage 2a: stemmed token-IDF matching against the 1C catalog ---------
//
// Fuse's char-level scoring is poor for Russian: it's defeated by word
// reordering ("Филе грудки куриной" vs "Куриное Филе грудки") and morphology
// ("куриного"/"куриная"/"куриное"), and it produces false positives by latching
// onto a shared common word ("Бедро куриное ЗАМОРОЖЕННОЕ" → "Сердце Говяжье
// ЗАМОРОЖЕННОЕ"). We add a token matcher: light Russian stemming → IDF-weighted
// overlap, so distinctive tokens (анчоус, камбал, шаурм, яйц) dominate and
// generic state words (зам, охлажд, говяж) carry little weight.

// Min asymmetric-overlap score to accept a token match.
const MIN_TOKEN_CONFIDENCE = 0.5;

// Inflectional endings stripped to unify morphological variants. Longest first;
// a 4-char stem floor stops over-stemming short roots ("яйцо" stays "яйцо").
const RU_ENDINGS = [
  'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ыми', 'ого',
  'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ый', 'ий', 'ой', 'ом', 'ем',
  'ах', 'ях', 'ам', 'ям', 'ов', 'ев', 'ью', 'ия', 'ие', 'ья', 'ье', 'ьи',
  'ка', 'ки', 'ку', 'ок',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'ь', 'й',
].sort((a, b) => b.length - a.length);

function stemRu(t: string): string {
  for (const e of RU_ENDINGS) {
    if (t.length - e.length >= 4 && t.endsWith(e)) { t = t.slice(0, -e.length); break; }
  }
  // Trim a leftover soft sign so adjective forms collapse together
  // ("говяжья"→"говяжь"→"говяж", matching "говяжий"→"говяж").
  if (t.length >= 5 && t.endsWith('ь')) t = t.slice(0, -1);
  return t;
}

// Mutually-exclusive species — a beef item must never match a pork/chicken one,
// even when the cut ("лопатка") and state ("зам") tokens coincide. Keys are
// stemmed token forms; values are the species class.
const SPECIES = new Map<string, string>([
  ['говяж', 'beef'], ['говядин', 'beef'],
  ['свин', 'pork'], ['свинин', 'pork'],
  ['курин', 'chicken'], ['куриц', 'chicken'], ['кур', 'chicken'],
  ['индейк', 'turkey'], ['индюш', 'turkey'],
  ['баран', 'lamb'], ['ягнятин', 'lamb'],
  ['утк', 'duck'], ['утин', 'duck'],
  ['крол', 'rabbit'], ['индоутк', 'duck'],
  ['телятин', 'veal'], ['теляч', 'veal'],
]);
function speciesOf(tokens: Set<string>): Set<string> {
  const s = new Set<string>();
  for (const t of tokens) { const sp = SPECIES.get(t); if (sp) s.add(sp); }
  return s;
}
function speciesConflict(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const x of a) if (b.has(x)) return false; // share at least one species → ok
  return true; // both name a species, none in common → conflict
}

// Collapse state/temperature word variants so "зам" matches "замороженная" and
// "охл" matches "охлажденное" — this both links abbreviations and disambiguates
// a frozen scan toward the frozen catalog item over the chilled one.
const STATE_MAP = new Map<string, string>([
  ['зам', 'замор'], ['замор', 'замор'], ['заморож', 'замор'], ['заморозк', 'замор'],
  ['заморожен', 'замор'], ['замороженн', 'замор'],
  ['охл', 'охлажд'], ['охлажд', 'охлажд'], ['охлажден', 'охлажд'], ['охлажденн', 'охлажд'],
]);
function canonicalToken(stem: string): string {
  return STATE_MAP.get(stem) ?? stem;
}

// Words whose FOLLOWING token is negated and must be dropped: "без кости"
// (boneless) must not match the "Кости" (bones) product.
const NEGATIONS = new Set(['без', 'не']);

// Order-aware tokenizer: light Russian stemming + negation skip + state-word
// canonicalisation. (Distinct from `tokenize`, which is order-free and feeds the
// learned-mapping Jaccard stage.)
function stemmedTokenSet(s: string): Set<string> {
  const raw = normalizeName(s)
    .toLowerCase()
    .replace(/[^а-яёa-z0-9%\-\s]/gi, ' ')
    .split(/[\s\-]+/)
    .map(t => t.trim())
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (NEGATIONS.has(t)) { i++; continue; } // skip the negation AND the negated word
    if (t.length < 3 || LEARNED_STOPWORDS.has(t)) continue;
    if (/^\d+$/.test(t)) continue; // bare numbers ("300", "500") are not identity words
    out.add(canonicalToken(stemRu(t)));
  }
  return out;
}

interface OnecTokenDoc {
  item: OnecNomenclatureRow;
  tokens: Set<string>;
  idfSum: number;
  // The catalog item's single most distinctive token (highest IDF). The scan
  // MUST contain it to match — this is the product's identity word, so it stops
  // "Лопатка говяжья" matching "Печень говяжья" on shared category/state words.
  topToken: string | null;
}

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
  private onecTokenIndex: OnecTokenDoc[] | null = null;
  private onecIdf: ((token: string) => number) | null = null;
  private onecDf: Map<string, number> | null = null;

  private async refreshIndex(): Promise<void> {
    const items = await onecNomenclatureRepo.listItems({ excludeFolders: true });
    this.onecFuse = new Fuse(items, ONEC_FUSE_OPTIONS);

    // Build the stemmed-token index + IDF weights over the same catalog.
    const docs = items.map(it => ({
      item: it,
      tokens: stemmedTokenSet(`${it.name} ${it.full_name ?? ''}`),
    }));
    const df = new Map<string, number>();
    for (const d of docs) for (const tk of d.tokens) df.set(tk, (df.get(tk) ?? 0) + 1);
    const N = docs.length || 1;
    // +1 smoothing keeps common tokens positive but small; rare tokens score high.
    const idf = (tk: string): number => Math.log(N / (1 + (df.get(tk) ?? 0))) + 1;
    this.onecIdf = idf;
    this.onecDf = df;
    this.onecTokenIndex = docs.map(d => {
      let idfSum = 0;
      let topToken: string | null = null;
      let topIdf = -1;
      for (const tk of d.tokens) {
        const w = idf(tk);
        idfSum += w;
        if (w > topIdf) { topIdf = w; topToken = tk; }
      }
      return { item: d.item, tokens: d.tokens, idfSum, topToken };
    });

    logger.debug('Nomenclature mapper index refreshed', { onecItems: items.length });
  }

  private async refreshLearnedIndex(): Promise<void> {
    // Only rows with a live onec_guid — legacy rows without guid can't help
    // link a new scan to 1С.
    const all = (await mappingRepo.getAll()).filter(m => m.onec_guid);
    this.learnedTokens = all.map(row => ({
      row,
      tokens: tokenize(normalizeName(row.scanned_name)),
    }));
    logger.debug('Learned mappings index refreshed', { learnedCount: all.length });
  }

  private async ensureIndex(): Promise<Fuse<OnecNomenclatureRow>> {
    if (!this.onecFuse) {
      await this.refreshIndex();
    }
    return this.onecFuse!;
  }

  private async ensureLearnedIndex(): Promise<LearnedToken[]> {
    if (!this.learnedTokens) {
      await this.refreshLearnedIndex();
    }
    return this.learnedTokens!;
  }

  invalidateCache(): void {
    this.onecFuse = null;
    this.learnedTokens = null;
    this.onecTokenIndex = null;
    this.onecIdf = null;
    this.onecDf = null;
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
  async map(scannedName: string): Promise<MappingResult> {
    const cleanName = normalizeName(scannedName);

    // 1. Learned mapping (try original first, then cleaned)
    const learned = (await mappingRepo.getByScannedName(scannedName))
      || (cleanName !== scannedName ? (await mappingRepo.getByScannedName(cleanName)) : null);
    if (learned) {
      if (learned.onec_guid) {
        const onec = await onecNomenclatureRepo.getByGuid(learned.onec_guid);
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
    const learnedIdx = await this.ensureLearnedIndex();
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
        const onec = await onecNomenclatureRepo.getByGuid(best.row.onec_guid);
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

    const fuse = await this.ensureIndex();
    const searchTerm = cleanName || scannedName;

    // Shared query analysis for both the token stage and the Fuse guard.
    const qTokens = stemmedTokenSet(searchTerm);
    const qSpecies = speciesOf(qTokens);
    // The scan's IDENTITY token = its most distinctive token that (a) is not a
    // species word and (b) actually exists in the catalog. Any accepted match
    // MUST share it — that's what stops "Лопатка говяжья" matching "Говяжий
    // фарш" (both beef, but the identity word "лопатка" is absent from фарш).
    // Catalog-absent tokens (потрошеная, пряного) are skipped — they can never
    // be shared and must not become an impossible requirement.
    let qIdentity: string | null = null;
    if (this.onecIdf && this.onecDf) {
      let bestIdf = -1;
      for (const tk of qTokens) {
        if (SPECIES.has(tk)) continue;
        if ((this.onecDf.get(tk) ?? 0) === 0) continue;
        const w = this.onecIdf(tk);
        if (w > bestIdf) { bestIdf = w; qIdentity = tk; }
      }
    }

    // 2a. Stemmed token-IDF match against the catalog. Runs BEFORE Fuse because
    // it handles Russian word-order/morphology and resists common-word false
    // positives. Score = asymmetric IDF overlap (best of query-coverage and
    // catalog-coverage), so a short catalog name fully contained in a verbose
    // scan ("Анчоусы" ⊂ "Анчоусы Пряного Посола") still scores ~1.
    if (qIdentity && this.onecTokenIndex && this.onecTokenIndex.length > 0 && this.onecIdf) {
      let qSum = 0;
      for (const tk of qTokens) qSum += this.onecIdf(tk);
      if (qTokens.size > 0 && qSum > 0) {
        let best: { item: OnecNomenclatureRow; score: number } | null = null;
        for (const doc of this.onecTokenIndex) {
          // The scan's identity word must be present in the candidate.
          if (!doc.tokens.has(qIdentity)) continue;
          // The candidate's identity word must be present in the scan.
          if (doc.topToken && !qTokens.has(doc.topToken)) continue;
          // Never cross species (beef ≠ pork ≠ chicken …).
          if (speciesConflict(qSpecies, speciesOf(doc.tokens))) continue;
          let shared = 0;
          for (const tk of qTokens) if (doc.tokens.has(tk)) shared += this.onecIdf(tk);
          if (shared <= 0) continue;
          const score = Math.max(shared / qSum, shared / (doc.idfSum || 1));
          if (!best || score > best.score) best = { item: doc.item, score };
        }
        if (best && best.score >= MIN_TOKEN_CONFIDENCE) {
          logger.info('Mapping via catalog token-IDF', {
            scannedName, target: best.item.name, score: best.score.toFixed(3),
          });
          return {
            original_name: scannedName,
            mapped_name: best.item.name,
            onec_guid: best.item.guid,
            confidence: best.score,
            source: 'onec_token',
            mapping_id: null,
            pack_size: null,
            pack_unit: null,
          };
        }
      }
    }

    // 2. Fuzzy search against onec_nomenclature (use cleaned name)
    const results = fuse.search(searchTerm);
    if (results.length > 0 && results[0].score !== undefined) {
      const best = results[0];
      const confidence = 1 - (best.score as number);
      // Validate Fuse's char-level pick with the token stage's structural guards
      // so similarity can't cross species or match a different part/cut
      // ("Лопатка говяжья" → "Говяжий фарш"). Both share "говяж" but the
      // identity word (фарш) is absent from the scan.
      const fuseItemTokens = stemmedTokenSet(`${best.item.name} ${best.item.full_name ?? ''}`);
      let fuseTop: string | null = null, fuseTopIdf = -1;
      if (this.onecIdf) for (const tk of fuseItemTokens) { const w = this.onecIdf(tk); if (w > fuseTopIdf) { fuseTopIdf = w; fuseTop = tk; } }
      const fuseIdentityOk = !!qIdentity && fuseItemTokens.has(qIdentity) && (!fuseTop || qTokens.has(fuseTop));
      const fuseSpeciesOk = !speciesConflict(qSpecies, speciesOf(fuseItemTokens));
      if (confidence >= MIN_FUZZY_CONFIDENCE && fuseIdentityOk && fuseSpeciesOk) {
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
            const existing = await mappingRepo.getByScannedName(scannedName);
            if (!existing) {
              await mappingRepo.create({
                scanned_name: scannedName,
                mapped_name_1c: best.item.name,
                onec_guid: best.item.guid,
                ...packFields,
              });
            }
            // Also save cleaned name variant if different
            if (cleanName !== scannedName) {
              const existingClean = await mappingRepo.getByScannedName(cleanName);
              if (!existingClean) {
                // Cleaned name has no pack suffix, so no pack fields here.
                await mappingRepo.create({
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

    // 3. None — unmatched. Clean the scan name so 1C creates a tidy
    // Справочники.Номенклатура (trims "3-4кг", "d120", "ведро", etc.).
    return {
      original_name: scannedName,
      mapped_name: cleanItemName(scannedName),
      onec_guid: null,
      confidence: 0,
      source: 'none',
      mapping_id: null,
      pack_size: null,
      pack_unit: null,
    };
  }

  async mapAll(names: string[]): Promise<MappingResult[]> {
    const results: MappingResult[] = [];
    for (const n of names) {
      results.push(await this.map(n));
    }
    return results;
  }

  async getSuggestions(scannedName: string, limit: number = 5): Promise<Array<{ guid: string; name: string; confidence: number }>> {
    const fuse = await this.ensureIndex();
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
