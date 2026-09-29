import { getDb } from '../database/db';
import { isValidInn } from '../utils/inn';
import { getEngineFlags } from '../services/engineFlags';
import { logger } from '../utils/logger';

/**
 * «Памятка по поставщикам» для распознавания (пакет v2, п.16).
 *
 * Отдельный кэшируемый system-блок после каталога: известные поставщики
 * компании из справочника (ИНН/КПП), как их название и ИНН встречались на
 * фото, и в каких единицах эти поставщики печатают товары, для которых есть
 * правила пересчёта. Только подсказка для чтения неразборчивого: модель
 * обязана вернуть напечатанное и НЕ пересчитывать единицы (иначе правило
 * сработало бы второй раз). Коэффициенты пересчёта сюда намеренно не попадают.
 */
export interface MemorySupplier {
  inn: string;
  name: string;
  kpp: string | null;
  nameVariants: string[];
  innVariants: string[];
  units: Array<{ name: string; unit: string }>;
}

/** ~3k токенов: кириллица в среднем ~2,5–3 символа на токен. */
export const SUPPLIER_MEMORY_MAX_CHARS = 7000;
const MAX_SUPPLIERS = 25;
const MAX_UNITS_PER_SUPPLIER = 12;
const CACHE_TTL_MS = 10 * 60_000;

const HEADER = `ПАМЯТКА ПО ПОСТАВЩИКАМ ЭТОЙ КОМПАНИИ (подтверждённые данные).
Используй её ТОЛЬКО чтобы вернее прочитать неразборчивое: цифры ИНН/КПП, название поставщика, единицу измерения в строке.
• Возвращай то, что НАПЕЧАТАНО. Если документ явно отличается от памятки (другой ИНН, другая единица) — верь документу.
• Количество и единицы НЕ пересчитывай: quantity и unit — как в накладной; пересчёт в единицы 1С делает система.
• Поставщика из памятки не подставляй, если на документе его нет.
`;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function supplierBlock(s: MemorySupplier, units: MemorySupplier['units']): string {
  const lines = [`— ${clean(s.name)}: ИНН ${s.inn}${s.kpp ? `, КПП ${s.kpp}` : ''}`];
  if (s.nameVariants.length) lines.push(`  на фото название встречалось как: ${s.nameVariants.map(v => `«${clean(v)}»`).join(', ')}`);
  if (s.innVariants.length) lines.push(`  на фото вместо этого ИНН читалось: ${s.innVariants.join(', ')} — перечитай цифры внимательно`);
  if (units.length) lines.push(`  единицы в накладных этого поставщика: ${units.map(u => `«${clean(u.name)}» — ${u.unit}`).join('; ')}`);
  return lines.join('\n');
}

/** Чистое форматирование с жёстким лимитом длины: сначала режем единицы, потом поставщиков. */
export function formatSupplierMemory(suppliers: MemorySupplier[], maxChars = SUPPLIER_MEMORY_MAX_CHARS): string {
  if (!suppliers.length) return '';
  const blocks: string[] = [];
  let used = HEADER.length;
  for (const s of suppliers) {
    let units = s.units.slice(0, MAX_UNITS_PER_SUPPLIER);
    let block = supplierBlock(s, units);
    while (used + block.length + 1 > maxChars && units.length) {
      units = units.slice(0, -1);
      block = supplierBlock(s, units);
    }
    if (used + block.length + 1 > maxChars) break;
    blocks.push(block);
    used += block.length + 1;
  }
  return blocks.length ? `${HEADER}\n${blocks.join('\n')}` : '';
}

const cache = new Map<number, { text: string; at: number }>();

export function invalidateSupplierMemory(ownerUserId?: number): void {
  if (ownerUserId == null) cache.clear();
  else cache.delete(ownerUserId);
}

function ruleName(note: string | null, nameKey: string): string {
  const m = /^«(.+?)»/.exec(note ?? '');
  return m ? m[1] : nameKey;
}

async function loadSuppliers(ownerUserId: number): Promise<MemorySupplier[]> {
  const db = getDb();
  const top = await db.prepare(`
    SELECT supplier_inn AS inn, COUNT(*) AS n FROM invoices
     WHERE owner_user_id = ? AND supplier_inn IS NOT NULL AND supplier_inn <> ''
       AND created_at >= (NOW() - INTERVAL 180 DAY)
     GROUP BY supplier_inn ORDER BY n DESC LIMIT ${MAX_SUPPLIERS * 2}
  `).all<{ inn: string; n: number }>(ownerUserId);
  const inns = top.map(t => t.inn).filter(inn => isValidInn(inn));
  if (!inns.length) return [];
  const ph = inns.map(() => '?').join(',');

  // Только поставщики из справочника (карточка = подтверждённые реквизиты).
  const cards = await db.prepare(`SELECT inn, name, kpp FROM supplier_cards WHERE owner_user_id = ? AND inn IN (${ph})`)
    .all<{ inn: string; name: string; kpp: string | null }>(ownerUserId, ...inns);
  const cardByInn = new Map(cards.map(c => [c.inn, c]));

  const seen = await db.prepare(`
    SELECT supplier_inn AS inn, supplier AS name, supplier_inn_ocr AS inn_ocr, supplier_name_ocr AS name_ocr
      FROM invoices
     WHERE owner_user_id = ? AND supplier_inn IN (${ph}) AND created_at >= (NOW() - INTERVAL 180 DAY)
     ORDER BY id DESC LIMIT 3000
  `).all<{ inn: string; name: string | null; inn_ocr: string | null; name_ocr: string | null }>(ownerUserId, ...inns);

  const rules = await db.prepare(`
    SELECT supplier_key, name_key, raw_unit, note FROM item_unit_rules
     WHERE owner_user_id = ? AND active = 1 AND raw_unit <> '' AND supplier_key LIKE 'inn:%'
     ORDER BY times_used DESC, updated_at DESC LIMIT 600
  `).all<{ supplier_key: string; name_key: string; raw_unit: string; note: string | null }>(ownerUserId);

  const norm = (s: string) => s.toLocaleLowerCase('ru-RU').replace(/[«»"'.,]/g, '').replace(/\s+/g, ' ').trim();
  const out: MemorySupplier[] = [];
  for (const inn of inns) {
    const card = cardByInn.get(inn);
    if (!card) continue;
    const names = new Set<string>();
    const innVariants = new Set<string>();
    for (const r of seen) {
      if (r.inn !== inn) continue;
      for (const n of [r.name_ocr, r.name]) {
        if (n && norm(n) !== norm(card.name) && names.size < 3) names.add(clean(n).slice(0, 120));
      }
      const io = (r.inn_ocr ?? '').replace(/\D/g, '');
      if (io && io !== inn && innVariants.size < 3) innVariants.add(io);
    }
    const units = rules
      .filter(r => r.supplier_key === `inn:${inn}`)
      .map(r => ({ name: ruleName(r.note, r.name_key).slice(0, 100), unit: r.raw_unit }));
    out.push({ inn, name: card.name, kpp: card.kpp, nameVariants: [...names], innVariants: [...innVariants], units });
    if (out.length >= MAX_SUPPLIERS) break;
  }
  return out;
}

/**
 * Текст памятки для компании ('' — нечего сказать или флаг ocr_memory
 * выключен). Кэш 10 минут: в пачке фото текст одинаковый и prompt-кэш Claude
 * переиспользуется. Никогда не бросает.
 */
export async function buildSupplierMemory(ownerUserId: number | null | undefined): Promise<string> {
  if (ownerUserId == null || !Number.isInteger(ownerUserId) || ownerUserId <= 0) return '';
  try {
    if (!(await getEngineFlags()).ocr_memory) return '';
    const hit = cache.get(ownerUserId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;
    const text = formatSupplierMemory(await loadSuppliers(ownerUserId));
    cache.set(ownerUserId, { text, at: Date.now() });
    return text;
  } catch (err) {
    logger.warn('supplier memory: build failed', { ownerUserId, error: (err as Error).message });
    return '';
  }
}
