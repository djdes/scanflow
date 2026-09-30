import { supplierRepo, type Supplier } from '../database/repositories/supplierRepo';
import { invoiceRepo, type Invoice, type SupplierMatchKind } from '../database/repositories/invoiceRepo';
import { isValidInn } from '../utils/inn';
import { logger } from '../utils/logger';

/**
 * Привязка накладной к карточке справочника утверждённых поставщиков.
 *
 * Платить нужно по реквизитам из справочника, а не по OCR. Основной ключ —
 * ИНН. Если ИНН с фото в справочнике не нашёлся (не распознан, распознан с
 * ошибкой, филиал), карточка подбирается по названию без организационно-
 * правовой формы: «ООО "Свит Лайф Фудсервис"» ≡ «Свит Лайф Фудсервис». Такая
 * привязка помечается supplier_match='name' — UI, Telegram и отправка в Сбер
 * предупреждают, что реквизиты найдены НЕ по ИНН.
 */

/** Не ниже — привязываем при распознавании автоматически (плюс единственность). */
export const AUTO_LINK_MIN_SCORE = 0.9;
/** Не ниже — предлагаем в окне отправки в Сбер как «похожий поставщик». */
export const SUGGEST_MIN_SCORE = 0.6;

// Длинные формы раньше коротких: «акционерное общество» не должно съесться
// по кусочку. «000» — OCR-двойник ООО (латинское OOO сводится к кириллице
// через HOMOGLYPHS ещё до этой замены).
const LEGAL_FORMS = [
  'общество с ограниченной ответственностью',
  'непубличное акционерное общество',
  'публичное акционерное общество',
  'открытое акционерное общество',
  'закрытое акционерное общество',
  'акционерное общество',
  'индивидуальный предприниматель',
  'крестьянское фермерское хозяйство',
  'ооо', '000', 'пао', 'оао', 'зао', 'нао', 'ао', 'ип', 'кфх', 'ано', 'нко',
];
const LEGAL_FORM_RE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${LEGAL_FORMS.map(f => f.replace(/ /g, '\\s+')).join('|')})(?![\\p{L}\\p{N}])`,
  'gu',
);

// Латиница, которую OCR подсовывает вместо похожей кириллицы. Отображение
// применяется к обеим сторонам сравнения, поэтому честно-латинские названия
// тоже сравниваются корректно.
const HOMOGLYPHS: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
};

/** Слова названия без ОПФ, кавычек и пунктуации: 'ООО "Свит Лайф"' → ['свит', 'лайф']. */
export function supplierNameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const s = name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[a-z]/g, ch => HOMOGLYPHS[ch] ?? ch)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(LEGAL_FORM_RE, ' ');
  return s.split(/\s+/).filter(Boolean);
}

/** Ключ сравнения: слова без ОПФ, склеенные без пробелов. */
export function supplierCoreName(name: string | null | undefined): string {
  return supplierNameTokens(name).join('');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * ИП: «Кнутова А.С.» ≡ «Кнутова Александра Сергеевна» — фамилия совпадает
 * целиком, инициал совпадает с первой буквой имени/отчества, полные слова —
 * целиком. Без инициалов это не ФИО, а обычное название: «Свит Лайф» и
 * «Свит Лимонад» совпадать не должны.
 */
function personScore(ta: string[], tb: string[]): number {
  if (ta.length < 2 || tb.length < 2 || ta.length > 3 || tb.length > 3) return 0;
  if (ta[0] !== tb[0] || ta[0].length < 3) return 0;
  let hasInitial = false;
  for (let i = 1; i < Math.min(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x.length <= 2 || y.length <= 2) {
      if (x[0] !== y[0]) return 0;
      hasInitial = true;
    } else if (x !== y) {
      return 0;
    }
  }
  return hasInitial ? 0.92 : 0;
}

/** Похожесть двух названий поставщиков, 0..1 (1 — совпали без учёта ОПФ). */
export function supplierNameScore(a: string | null | undefined, b: string | null | undefined): number {
  const ta = supplierNameTokens(a);
  const tb = supplierNameTokens(b);
  const ca = ta.join('');
  const cb = tb.join('');
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;

  const [shorter, longer] = ca.length <= cb.length ? [ca, cb] : [cb, ca];
  let score = personScore(ta, tb);
  // Одно название — часть другого («Свит Лайф» / «Свит Лайф Фудсервис»).
  // Чем больше «хвост», тем вероятнее, что это другое юрлицо, поэтому оценка
  // растёт с долей совпавшего.
  if (shorter.length >= 5 && longer.includes(shorter)) {
    score = Math.max(score, 0.7 + 0.25 * (shorter.length / longer.length));
  }
  // OCR-опечатки на длинных названиях.
  if (shorter.length >= 6) {
    score = Math.max(score, 1 - levenshtein(ca, cb) / longer.length);
  }
  return score;
}

export interface SupplierCandidate {
  supplier: Supplier;
  score: number;
}

/**
 * Двойники с опечаткой в ИНН. OCR путает соседние цифры, и в справочник
 * попадает вторая карточка того же поставщика с ИНН, не проходящим контрольную
 * сумму («Вкусный мир ТК» 7724357632 и 7724357832). Одно название при разных
 * ИНН делало подбор неоднозначным — автопривязка отказывалась выбирать.
 * Кандидат с невалидным ИНН отбрасывается, если среди кандидатов есть карточка
 * с тем же названием (без ОПФ) и верным ИНН. Без такого двойника он остаётся:
 * другой карточки этого поставщика может просто не быть.
 */
export function dropInvalidInnTwins(candidates: SupplierCandidate[]): SupplierCandidate[] {
  const validNames = new Set(
    candidates
      .filter(c => isValidInn(c.supplier.inn))
      .map(c => supplierCoreName(c.supplier.name))
      .filter(Boolean),
  );
  if (validNames.size === 0) return candidates;
  return candidates.filter(c => isValidInn(c.supplier.inn) || !validNames.has(supplierCoreName(c.supplier.name)));
}

/** Карточки, похожие на название, лучшие первыми (при равенстве — подтверждённые). */
export function rankSuppliersByName(
  name: string | null | undefined,
  cards: Supplier[],
  minScore: number = SUGGEST_MIN_SCORE,
): SupplierCandidate[] {
  if (!supplierCoreName(name)) return [];
  const ranked = cards
    .map(supplier => ({ supplier, score: supplierNameScore(name, supplier.name) }))
    .filter(c => c.score >= minScore)
    .sort((x, y) => (y.score - x.score) || (y.supplier.verified - x.supplier.verified));
  return dropInvalidInnTwins(ranked);
}

/**
 * Единственный уверенный кандидат для автопривязки или null. Две близкие
 * карточки с разными ИНН — неоднозначность: выбирать за человека не будем.
 * Исключение — двойник с невалидным ИНН при верной карточке того же названия:
 * он в выборе не участвует (см. dropInvalidInnTwins).
 */
export function pickAutoLinkCandidate(candidates: SupplierCandidate[]): SupplierCandidate | null {
  const [best, second] = dropInvalidInnTwins(candidates);
  if (!best || best.score < AUTO_LINK_MIN_SCORE) return null;
  if (second && second.supplier.inn !== best.supplier.inn && second.score >= best.score - 0.05) return null;
  return best;
}

export async function findSuppliersByName(
  name: string | null | undefined,
  ownerUserId: number,
  opts: { verifiedOnly?: boolean; minScore?: number } = {},
): Promise<SupplierCandidate[]> {
  if (!supplierCoreName(name)) return [];
  let cards = await supplierRepo.listAll(ownerUserId);
  if (opts.verifiedOnly) cards = cards.filter(c => c.verified === 1);
  return rankSuppliersByName(name, cards, opts.minScore);
}

export interface LinkResult {
  match: SupplierMatchKind | null;
  supplier: Supplier | null;
}

/**
 * Подтверждённая карточка того же поставщика (то же название без ОПФ) с верным
 * ИНН — для карточки, чей ИНН контрольную сумму не проходит. Если таких
 * несколько (разные верные ИНН при одном названии) — неоднозначно, null.
 */
async function findValidInnTwin(card: Supplier, ownerUserId: number): Promise<Supplier | null> {
  const core = supplierCoreName(card.name);
  if (!core) return null;
  const twins = (await supplierRepo.listAll(ownerUserId)).filter(c =>
    c.verified === 1 && c.inn !== card.inn && isValidInn(c.inn) && supplierCoreName(c.name) === core);
  return twins.length === 1 ? twins[0] : null;
}

/**
 * Привязка «по названию»: ИНН и название берутся из карточки, а то, что было на
 * фото, сохраняется в supplier_inn_ocr/supplier_name_ocr; supplier_match='name'
 * (UI, Telegram и Сбер предупреждают, что реквизиты подобраны не по ИНН с фото).
 */
async function linkByName(
  invoiceId: number,
  inv: Pick<Invoice, 'supplier' | 'supplier_inn'>,
  card: Supplier,
  reason: string,
  extra: Record<string, unknown> = {},
): Promise<LinkResult> {
  await invoiceRepo.setSupplierLink(invoiceId, {
    supplier: card.name,
    supplier_inn: card.inn,
    match: 'name',
    supplier_inn_ocr: inv.supplier_inn,
    supplier_name_ocr: inv.supplier,
  });
  logger.info(`Supplier linked by NAME (${reason})`, {
    invoiceId,
    ocrInn: inv.supplier_inn,
    ocrName: inv.supplier,
    cardInn: card.inn,
    cardName: card.name,
    ...extra,
  });
  return { match: 'name', supplier: card };
}

/**
 * Вызывается в конце распознавания (перед статусом 'processed'): привязывает
 * накладную к утверждённой карточке справочника. Порядок:
 *   1. Карточка с ИНН с фото есть → привязка 'inn' (если подтверждена).
 *      Исключение: ИНН этой карточки не проходит контрольную сумму, а рядом есть
 *      подтверждённая карточка с тем же названием и верным ИНН — это двойник с
 *      опечаткой, привязываем к верной карточке по пути «по названию».
 *   2. Иначе — уверенный единственный кандидат по названию среди подтверждённых
 *      карточек → supplier_inn/supplier берутся из карточки, исходные значения с
 *      фото сохраняются в supplier_inn_ocr/supplier_name_ocr, supplier_match='name'.
 * Уже сделанную привязку ('name'/'manual') не трогает: updateInvoiceData
 * сбрасывает её сама, если перераспознавание принесло другой ИНН.
 * exactInn — ИНН взят из электронного документа (XML ЭДО), а не с фото: он не
 * ошибка чтения, и если он верный (контрольная сумма), карточка «по названию»
 * его не подменяет — похожее название с другим ИНН — это другое юрлицо.
 * Никогда не бросает — сбой подбора не должен ронять распознавание.
 */
export async function linkApprovedSupplier(invoiceId: number, opts: { exactInn?: boolean } = {}): Promise<LinkResult> {
  const none: LinkResult = { match: null, supplier: null };
  try {
    const inv = await invoiceRepo.getById(invoiceId);
    // Справочник пер-тенантный: у «ничьей» накладной подбирать не из чего.
    if (!inv || inv.owner_user_id == null) return none;
    if (inv.supplier_match === 'name' || inv.supplier_match === 'manual') {
      return { match: inv.supplier_match, supplier: null };
    }
    const owner = inv.owner_user_id;

    if (inv.supplier_inn) {
      const byInn = await supplierRepo.findByInn(inv.supplier_inn, owner);
      if (byInn) {
        const twin = isValidInn(byInn.inn) ? null : await findValidInnTwin(byInn, owner);
        if (twin) {
          // await обязателен: без него отказ промиса миновал бы catch ниже.
          return await linkByName(invoiceId, inv, twin, 'card found by INN fails the checksum, valid twin used', {
            twinOfInn: byInn.inn,
          });
        }
        const match = byInn.verified ? 'inn' : null;
        if (inv.supplier_match !== match) await invoiceRepo.setSupplierMatch(invoiceId, match);
        // Карточка с этим ИНН есть — ИНН установлен, по названию не ищем,
        // даже если карточка ещё не подтверждена.
        return { match, supplier: byInn };
      }
    }

    if (opts.exactInn && isValidInn(inv.supplier_inn)) {
      if (inv.supplier_match != null) await invoiceRepo.setSupplierMatch(invoiceId, null);
      return none;
    }

    const best = pickAutoLinkCandidate(
      await findSuppliersByName(inv.supplier, owner, { verifiedOnly: true }),
    );
    if (!best) {
      if (inv.supplier_match != null) await invoiceRepo.setSupplierMatch(invoiceId, null);
      return none;
    }

    return await linkByName(invoiceId, inv, best.supplier, 'INN from photo not in directory', {
      score: Number(best.score.toFixed(3)),
    });
  } catch (err) {
    logger.warn('linkApprovedSupplier failed', { invoiceId, error: (err as Error).message });
    return none;
  }
}
