/**
 * Аналитика (п.7 «качество по поставщикам» и п.11 «закупочные цены») — чистые
 * помощники без БД: период, доли, процент изменения, серия «без правок»,
 * ключ поставщика, «у кого дешевле», экономия, дата закупки.
 *
 * Медиану здесь не пишем заново: везде src/pricing/medianOf — та же функция,
 * на которой стоит «обычная цена» позиции (nomenclature_price_stat_cards).
 */
import { medianOf } from '../pricing/medianOf';
import { normalizeSupplierName } from '../utils/invoiceNumber';

const DAY_MS = 86_400_000;

// ─── Период отчёта ───────────────────────────────────────────────────────────

export const ANALYTICS_PERIODS = [30, 90, 180, 365] as const;
export type AnalyticsPeriod = (typeof ANALYTICS_PERIODS)[number];
export const DEFAULT_PERIOD: AnalyticsPeriod = 90;

/** ?days=… → один из разрешённых периодов; пусто — по умолчанию; мусор — null (400). */
export function parsePeriod(raw: unknown): AnalyticsPeriod | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PERIOD;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(raw);
  return (ANALYTICS_PERIODS as readonly number[]).includes(n) ? (n as AnalyticsPeriod) : null;
}

// ─── Числа ───────────────────────────────────────────────────────────────────

/** Доля 0…1; null, когда делить не на что. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Изменение в процентах от `from` к `to`; null без базы (0, отрицательная, пусто). */
export function pctChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

export function roundTo(n: number | null | undefined, digits: number): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  const k = 10 ** digits;
  return Math.round(n * k) / k;
}

// ─── Даты ────────────────────────────────────────────────────────────────────

/**
 * «YYYY-MM-DD HH:MM:SS» (так mysql2 отдаёт DATETIME при dateStrings) или
 * «YYYY-MM-DD» → миллисекунды. Часовой пояс не важен: сравниваем даты из одной
 * базы между собой. null — если строка не дата (в т.ч. 31 февраля).
 */
export function parseDbDateTime(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d, Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (!Number.isFinite(t)) return null;
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

/** Дни (дробные) от `from` до `to`; null, если чего-то нет или порядок обратный. */
export function daysBetween(from: string | null | undefined, to: string | null | undefined): number | null {
  const a = parseDbDateTime(from);
  const b = parseDbDateTime(to);
  if (a == null || b == null || b < a) return null;
  return (b - a) / DAY_MS;
}

/** «YYYY-MM-DD» для момента `ms`. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** «YYYY-MM-DD» за `days` дней до `now`. */
export function dayMinus(now: Date, days: number): string {
  return isoDay(now.getTime() - days * DAY_MS);
}

/** «YYYY-MM-DD», сдвинутая на `days` дней (отрицательные — назад); не дата — как есть. */
export function isoDayShift(iso: string, days: number): string {
  const t = parseDbDateTime(iso);
  return t == null ? iso : isoDay(t + days * DAY_MS);
}

/**
 * Дата закупки: дата документа, если она правдоподобна, иначе дата загрузки.
 * Дата документа — это когда купили, но OCR иногда ошибается годом (2025 вместо
 * 2026), и такая точка улетела бы на графике на год назад. Правдоподобна — не
 * раньше чем за 180 дней до загрузки и не позже недели после.
 */
export function effectiveDate(invoiceDate: string | null | undefined, createdAt: string | null | undefined): string | null {
  const created = parseDbDateTime(createdAt);
  if (invoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(invoiceDate)) {
    const d = parseDbDateTime(invoiceDate);
    if (d != null && (created == null || (d >= created - 180 * DAY_MS && d <= created + 7 * DAY_MS))) {
      return invoiceDate;
    }
  }
  return created == null ? null : isoDay(created);
}

/** ISO-неделя «2026-W40» — ключ еженедельной сводки. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // четверг этой недели определяет год
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// ─── Серии и медианы ─────────────────────────────────────────────────────────

/** Сколько элементов подряд с начала списка (самые свежие — первыми) «чистые». */
export function cleanStreak<T>(newestFirst: readonly T[], isClean: (x: T) => boolean): number {
  let n = 0;
  for (const x of newestFirst) {
    if (!isClean(x)) break;
    n++;
  }
  return n;
}

/** Медиана дней «загрузка → отправка в 1С» по отправленным накладным. */
export function medianDaysToSend(rows: ReadonlyArray<{ created_at: string | null; sent_at: string | null }>): number | null {
  const days = rows
    .map(r => daysBetween(r.created_at, r.sent_at))
    .filter((d): d is number => d != null);
  return medianOf(days);
}

/**
 * Изменение цены за период: медиана первых k закупок против медианы последних k
 * (k ≤ 3 и окна не перекрываются). Одна случайная закупка не делает «подорожания».
 */
export function periodChangePct(pricesChrono: readonly number[]): number | null {
  const n = pricesChrono.length;
  if (n < 2) return null;
  const k = Math.min(3, Math.floor(n / 2));
  return pctChange(medianOf(pricesChrono.slice(0, k)), medianOf(pricesChrono.slice(n - k)));
}

/**
 * Отсечь явные ошибки цены — в `spread` раз дальше медианы (тот же порог, что у
 * robustMedian для «обычной цены»): 0,21 ₽/кг творога — это неверно
 * пересчитанное количество, а не цена, и на графике такая точка сплющила бы всё.
 */
export function dropPriceOutliers<T>(items: readonly T[], price: (x: T) => number, spread = 5): { kept: T[]; dropped: number } {
  const m = medianOf(items.map(price).filter(v => Number.isFinite(v) && v > 0));
  if (m == null) return { kept: [], dropped: items.length };
  const kept = items.filter(x => {
    const v = price(x);
    return Number.isFinite(v) && v >= m / spread && v <= m * spread;
  });
  return { kept, dropped: items.length - kept.length };
}

// ─── Поставщики ──────────────────────────────────────────────────────────────

/** ИНН из 10 или 12 цифр, иначе null. */
export function innOf(raw: unknown): string | null {
  const s = String(raw ?? '').replace(/\D/g, '');
  return s.length === 10 || s.length === 12 ? s : null;
}

export interface SupplierIdentity {
  key: string;
  inn: string | null;
  nameKey: string;
}

/** Ключ поставщика: `inn:…`, а без ИНН — `name:<название без ОПФ>` (`name:` — не указан). */
export function supplierIdentity(inn: unknown, name: unknown): SupplierIdentity {
  const i = innOf(inn);
  const nameKey = normalizeSupplierName(typeof name === 'string' ? name : null);
  return { key: i ? `inn:${i}` : `name:${nameKey}`, inn: i, nameKey };
}

/**
 * Резолвер ключа по набору строк. Накладная без ИНН, чьё название однозначно
 * совпадает с поставщиком, у которого ИНН есть в других накладных, уходит к нему:
 * иначе один поставщик делился бы на две строки отчёта.
 */
export function buildSupplierKeyResolver(
  rows: ReadonlyArray<{ supplier_inn: unknown; supplier: unknown }>,
): (row: { supplier_inn: unknown; supplier: unknown }) => string {
  const nameToInns = new Map<string, Set<string>>();
  for (const r of rows) {
    const id = supplierIdentity(r.supplier_inn, r.supplier);
    if (!id.inn || !id.nameKey) continue;
    const set = nameToInns.get(id.nameKey) ?? new Set<string>();
    set.add(id.inn);
    nameToInns.set(id.nameKey, set);
  }
  return (r) => {
    const id = supplierIdentity(r.supplier_inn, r.supplier);
    if (id.inn) return id.key;
    const inns = id.nameKey ? nameToInns.get(id.nameKey) : undefined;
    if (inns && inns.size === 1) return `inn:${[...inns][0]}`;
    return id.key;
  };
}

// ─── «У кого дешевле» ────────────────────────────────────────────────────────

/**
 * Самый дешёвый поставщик по медиане последних закупок. Сравнивать можно только
 * двух и больше; при равенстве — первый в списке.
 */
export function pickCheapest<T extends { key: string; recent_median: number | null }>(suppliers: readonly T[]): T | null {
  const priced = suppliers.filter(s => s.recent_median != null && Number.isFinite(s.recent_median) && s.recent_median > 0);
  if (priced.length < 2) return null;
  return priced.reduce((best, s) => (s.recent_median! < best.recent_median! ? s : best));
}

/**
 * Сколько стоили бы недавние закупки у других поставщиков по цене самого
 * дешёвого: переплата в ₽ и в % от потраченного на них. null — переплаты нет
 * (или объёма у других поставщиков не было).
 */
export function savingVsCheapest(
  purchases: ReadonlyArray<{ supplier_key: string; price: number; qty: number | null }>,
  cheapest: { key: string; recent_median: number },
): { rub: number; pct: number; volume: number } | null {
  let over = 0;
  let spent = 0;
  let volume = 0;
  for (const p of purchases) {
    if (p.supplier_key === cheapest.key) continue;
    const q = p.qty;
    if (q == null || !(q > 0) || !(p.price > 0)) continue;
    over += (p.price - cheapest.recent_median) * q;
    spent += p.price * q;
    volume += q;
  }
  if (!(over > 0.005) || !(spent > 0)) return null;
  return { rub: over, pct: (over / spent) * 100, volume };
}

// ─── Цветовые подсказки ──────────────────────────────────────────────────────

export type Tone = 'good' | 'warn' | 'bad';

/** Меньше — лучше: ≤ goodMax — норма, ≤ warnMax — присмотреться, выше — проблема. */
export function toneLowerBetter(v: number | null | undefined, goodMax: number, warnMax: number): Tone | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v <= goodMax ? 'good' : v <= warnMax ? 'warn' : 'bad';
}

/** Больше — лучше: ≥ goodMin — норма, ≥ warnMin — присмотреться, ниже — проблема. */
export function toneHigherBetter(v: number | null | undefined, goodMin: number, warnMin: number): Tone | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v >= goodMin ? 'good' : v >= warnMin ? 'warn' : 'bad';
}

const TONE_RANK: Record<Tone, number> = { good: 0, warn: 1, bad: 2 };

/** Худшая из подсказок; null — если оценить нечего. */
export function worstTone(tones: ReadonlyArray<Tone | null | undefined>): Tone | null {
  let worst: Tone | null = null;
  for (const t of tones) {
    if (!t) continue;
    if (worst == null || TONE_RANK[t] > TONE_RANK[worst]) worst = t;
  }
  return worst;
}
