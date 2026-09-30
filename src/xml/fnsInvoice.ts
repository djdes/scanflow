/**
 * Электронная накладная в формате ФНС (XML из ЭДО: Диадок, СБИС, 1С-ЭДО) →
 * ParsedInvoiceData — та же форма, что отдаёт распознавание фото, поэтому
 * дальше накладная идёт тем же конвейером: сопоставление с 1С, пересчёт
 * единиц, дубли, уведомления, выгрузка в 1С и Сбер.
 *
 * Вид документа определяется по СТРУКТУРЕ, а не по имени файла: ИдФайл бывает
 * нестандартным (реальный файл Диадока — «RL-NB-146830-MARK»).
 *
 * Поддерживается:
 *   - УПД и счёт-фактура: ON_NSCHFDOPPR, ON_NSCHFDOPPRMARK (то же для
 *     маркированных товаров), старое ON_SCHFDOPPR; функции СЧФ, СЧФДОП, ДОП.
 *       5.01 (приказ ММВ-7-15/820@): НомерСчФ/ДатаСчФ, КодОКВ у СвСчФакт,
 *            единица — ДопСведТов/@НаимЕдИзм, ИспрСчФ;
 *       5.02, 5.03 (приказ ЕА-7-26/970@): НомерДок/ДатаДок, ДенИзм/@КодОКВ,
 *            @НаимЕдИзм у СведТов, ИспрДок;
 *   - ТОРГ-12: DP_TOVTORGPR (приказ ММВ-7-10/551@, 5.01/5.02: ИдентДок,
 *     СодФХЖ1/Продавец, СодФХЖ2/СвТов, Всего) и старый DP_OTORG12 (приказ
 *     ММВ-7-6/172@: СвТНО/Поставщик, ТН/Таблица/СвТов, ВсегоНакл).
 * Корректировочные документы (УКД), титулы покупателя, валюта не рубли и
 * прочее — понятная ошибка FnsXmlError, никогда не падение.
 *
 * Соглашения ScanFlow — как у распознавания фото (промпт claudeApiAnalyzer):
 *   - total — стоимость строки С НДС; price — цена за единицу С НДС = total / quantity;
 *   - quantity/unit — как напечатано (raw_* строки, правило 22): пересчёт в
 *     единицу 1С делает convertInvoiceLine, здесь ничего не пересчитывается;
 *   - vat_rate — номинальная ставка: 22, 20, 10, 7, 5; «без НДС» и «0%» → 0;
 *     расчётные ставки (20/120, 16,67%) → номинальные (20); «НДС исчисляется
 *     налоговым агентом» → нет ставки;
 *   - total_sum / vat_sum — из строки «Всего к оплате».
 * Данные документа не «чинятся»: несходящаяся арифметика попадает в warnings,
 * а итог сверит recalculateTotal (флаг «требует проверки»), как у фото.
 */
import type { ParsedInvoiceData, ParsedInvoiceItem } from '../ocr/types';
import { isValidInn } from '../utils/inn';
import { canonUnit } from '../mapping/unitConverter';
import {
  attr, child, childrenNamed, decodeXmlBytes, descendant, findAll, findFirst, parseXml,
  XmlParseError, type XmlElement,
} from './xmlTree';
import { isMultiplierOkei, unitFromOkei } from './okei';

/** Ошибка разбора; сообщение — по-русски, показывается пользователю как ошибка накладной. */
export class FnsXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FnsXmlError';
  }
}

export type FnsDocumentKind = 'upd' | 'torg12';

export interface FnsInvoiceResult {
  kind: FnsDocumentKind;
  data: ParsedInvoiceData;
  meta: {
    /** Что за документ, по-русски: «УПД (формат ФНС 5.03)». */
    title: string;
    file_id: string | null;
    version: string | null;
    /** Документ/@Функция у УПД: СЧФ, СЧФДОП, ДОП. */
    function: string | null;
    encoding: string;
    /** Исправленный документ (строка 1а): номер и дата исправления. */
    correction: { number: string | null; date: string | null } | null;
  };
  /** Замечания (несходящаяся арифметика и т.п.). Данные при этом не меняются. */
  warnings: string[];
}

// ── Числа, даты, ставки ─────────────────────────────────────────────────────

function num(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const t = String(raw).replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const r4 = (x: number) => Math.round((x + Number.EPSILON) * 10000) / 10000;
const money = (x: number) => x.toFixed(2);

/** Сумма, только если известны все слагаемые — частичная сумма хуже, чем никакой. */
function sumAll(values: Array<number | null | undefined>): number | null {
  if (!values.length || values.some(v => v == null)) return null;
  return r2(values.reduce<number>((s, v) => s + (v as number), 0));
}

/** ДД.ММ.ГГГГ (формат ФНС; на всякий случай и ГГГГ-ММ-ДД) → ГГГГ-ММ-ДД. */
function fnsDate(raw: string | null, warnings: string[]): string | undefined {
  if (!raw) return undefined;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const [y, m, d] = ru ? [ru[3], ru[2], ru[1]] : iso ? [iso[1], iso[2], iso[3]] : [];
  if (!y || Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) {
    warnings.push(`Не удалось прочитать дату документа: «${raw}»`);
    return undefined;
  }
  return `${y}-${m}-${d}`;
}

/** Расчётные ставки (НДС внутри суммы: 10/110 = 9,09%) → номинальные. */
const CALCULATED_RATES: Array<[calculated: number, nominal: number]> = [
  [4.76, 5], [6.54, 7], [9.09, 10], [15.25, 18], [16.67, 20], [18.03, 22],
];

/**
 * Ставка НДС из документа ФНС: «22%», «10/110», «16,67%», «без НДС» → 22, 10, 20, 0.
 * «НДС исчисляется налоговым агентом» и нераспознанное → null.
 */
export function parseVatRate(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/без\s+(ндс|налога)|не\s+облага/.test(s)) return 0;
  const frac = /(\d+(?:[.,]\d+)?)\s*\/\s*\d+(?:[.,]\d+)?/.exec(s);
  if (frac) return num(frac[1]);
  const pct = /^(?:ндс\s*)?(\d+(?:[.,]\d+)?)\s*%?$/.exec(s) ?? /(\d+(?:[.,]\d+)?)\s*%/.exec(s);
  if (!pct) return null;
  const v = num(pct[1]);
  if (v == null) return null;
  return CALCULATED_RATES.find(([calculated]) => Math.abs(calculated - v) < 0.005)?.[1] ?? v;
}

/**
 * Сумма налога (СумНДСТип): СумНал — число, БезНДС — «без НДС» (0), ДефНДС —
 * прочерк (нет суммы). Для ТОРГ-12, где сумма — просто текст элемента, — число.
 */
function vatAmount(el: XmlElement | undefined): number | null {
  if (!el) return null;
  if (child(el, 'БезНДС')) return 0;
  const inner = child(el, 'СумНал') ?? child(el, 'СумНДС');
  if (inner) return num(inner.text);
  return num(el.text);
}

function assertRubles(currencyCode: string | null): void {
  if (currencyCode && currencyCode !== '643') {
    throw new FnsXmlError(`Документ в валюте с кодом ${currencyCode} — поддерживаются только документы в рублях.`);
  }
}

// ── Участник (продавец) ─────────────────────────────────────────────────────

interface Party {
  name: string | null;
  inn: string | null;
  kpp: string | null;
  address: string | null;
  account: string | null;
  bik: string | null;
  corrAccount: string | null;
}

function fullName(person: XmlElement | undefined): string | null {
  const f = child(person, 'ФИО');
  if (!f) return null;
  const s = [attr(f, 'Фамилия'), attr(f, 'Имя'), attr(f, 'Отчество')].filter(Boolean).join(' ');
  return s || null;
}

function joinParts(parts: Array<string | null | undefined>): string | null {
  const s = parts.map(p => (p ?? '').trim()).filter(Boolean).join(', ');
  return s || null;
}

function readAddress(adr: XmlElement | undefined): string | null {
  if (!adr) return null;
  const inf = child(adr, 'АдрИнф');
  if (inf) return attr(inf, 'АдрТекст');
  const rf = child(adr, 'АдрРФ');
  if (rf) {
    const labeled = (label: string, v: string | null) => (v ? `${label} ${v}` : null);
    return joinParts([
      attr(rf, 'Индекс'), attr(rf, 'НаимРегион'), attr(rf, 'Район'), attr(rf, 'Город'),
      attr(rf, 'НаселПункт'), attr(rf, 'Улица'), labeled('д.', attr(rf, 'Дом')),
      labeled('корп.', attr(rf, 'Корпус')), labeled('кв.', attr(rf, 'Кварт')),
    ]);
  }
  const gar = child(adr, 'АдрГАР');
  if (gar) {
    // ВидНаимТип (Вид + Наим) и ТипНаимТип (Тип + Наим); у ВидНаимКодТип «ВидКод» —
    // код, а не слово, поэтому для района/поселения берём только наименование.
    const named = (tag: string) => {
      const e = child(gar, tag);
      const n = attr(e, 'Наим');
      return n ? [attr(e, 'Вид') ?? attr(e, 'Тип'), n].filter(Boolean).join(' ') : null;
    };
    const numbered = (e: XmlElement | undefined) => {
      const n = attr(e, 'Номер');
      return n ? [attr(e, 'Тип'), n].filter(Boolean).join(' ') : null;
    };
    const place = named('НаселенПункт') ?? attr(child(gar, 'ГородСелПоселен'), 'Наим') ?? attr(child(gar, 'МуниципРайон'), 'Наим');
    return joinParts([
      attr(gar, 'Индекс'), child(gar, 'НаимРегион')?.text.trim(),
      place, named('ЭлПланСтруктур'), named('ЭлУлДорСети'),
      ...childrenNamed(gar, 'Здание').map(numbered),
      numbered(child(gar, 'ПомещЗдания')), numbered(child(gar, 'ПомещКвартиры')),
    ]);
  }
  return null;
}

/** Элементы ИП в разных версиях: СвИП (УПД 5.01–5.03, ТОРГ-12 551@), ИП (старые форматы). */
const IP_ELEMENTS = new Set(['СвИП', 'ИП']);
/** Физлицо: СвФЛУч (5.02+), СвФЛУчастФХЖ (5.01), СвФЛ (ТОРГ-12), ФЛ. */
const PERSON_ELEMENTS = new Set(['СвИП', 'ИП', 'СвФЛУч', 'СвФЛУчастФХЖ', 'СвФЛ', 'ФЛ']);

/**
 * Реквизиты участника (УчастникТип): организация (СвЮЛУч, СвОрг/СвЮЛ, ЮЛ —
 * по атрибуту ИННЮЛ), ИП, физлицо или иностранная организация (СвИнНеУч:
 * @Наим в 5.02+, @НаимОрг в 5.01), плюс адрес и банк. Читается ТОЛЬКО
 * переданный элемент — покупатель, грузополучатель и оператор ЭДО в продавца
 * не попадают (CLAUDE.md, правило 5).
 */
function readParty(el: XmlElement | undefined): Party | null {
  if (!el) return null;
  const ids = child(el, 'ИдСв') ?? el;
  let name: string | null = null;
  let inn: string | null = null;
  let kpp: string | null = null;
  const org = findFirst(ids, e => e.attrs['ИННЮЛ'] != null)
    ?? findFirst(ids, e => e.name === 'СвЮЛУч' || e.name === 'СвЮЛ' || e.name === 'ЮЛ');
  const person = findFirst(ids, e => PERSON_ELEMENTS.has(e.name) || e.attrs['ИННФЛ'] != null);
  const foreign = findFirst(ids, e => e.name === 'СвИнНеУч' || e.name === 'ИнОрг');
  if (org) {
    name = attr(org, 'НаимОрг');
    inn = attr(org, 'ИННЮЛ');
    kpp = attr(org, 'КПП');
  } else if (person) {
    inn = attr(person, 'ИННФЛ');
    const fio = fullName(person);
    name = fio ? (IP_ELEMENTS.has(person.name) ? `ИП ${fio}` : fio) : null;
  } else if (foreign) {
    name = attr(foreign, 'Наим') ?? attr(foreign, 'НаимОрг');
  }
  const bank = child(el, 'БанкРекв');
  const bankInfo = child(bank, 'СвБанк');
  return {
    name: name ?? attr(el, 'СокрНаим') ?? attr(el, 'КраткНазв'),
    inn,
    kpp,
    address: readAddress(child(el, 'Адрес')),
    account: attr(bank, 'НомерСчета'),
    bik: attr(bankInfo, 'БИК'),
    corrAccount: attr(bankInfo, 'КорСчет'),
  };
}

// ── Строка товара ───────────────────────────────────────────────────────────

interface RawLine {
  rowNo: number;
  name: string | null;
  qty: number | null;
  okei: string | null;
  unitName: string | null;
  priceNoVat: number | null;
  sumNoVat: number | null;
  rateRaw: string | null;
  vat: number | null;
  sumWithVat: number | null;
}

function cleanUnit(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.replace(/\s+/g, ' ').trim().replace(/\.$/, '').trim();
  return s || null;
}

/**
 * Единица «как напечатано». Наименование (графа 2а) — если пересчёт единиц его
 * понимает: его же читает распознавание фото, и оно точнее кода (у «кор» и
 * «упак» разная логика упаковки, а код у самодельных единиц 1С бывает любым).
 * Иначе — единица по коду ОКЕИ (графа 2), иначе наименование как есть.
 */
function pickUnit(l: RawLine, label: string, warnings: string[]): string {
  const byName = cleanUnit(l.unitName);
  const byCode = unitFromOkei(l.okei);
  const nameCanon = canonUnit(byName);
  if (isMultiplierOkei(l.okei)) {
    warnings.push(`${label}: количество указано в единице «${byName ?? byCode}» (ОКЕИ ${l.okei}) — проверьте пересчёт в штуки`);
  }
  if (byName && nameCanon) {
    const codeCanon = canonUnit(byCode);
    if (codeCanon && codeCanon.cls !== nameCanon.cls) {
      warnings.push(`${label}: единица «${byName}» не совпадает с кодом ОКЕИ ${l.okei} («${byCode}»)`);
    }
    return byName;
  }
  return byCode ?? byName ?? 'шт';
}

function buildItem(l: RawLine, warnings: string[]): { item: ParsedInvoiceItem; vat: number | null } {
  const label = `Строка ${l.rowNo}`;
  const rate = parseVatRate(l.rateRaw);
  const vat = l.vat ?? (rate === 0 ? 0 : null);

  let sumNoVat = l.sumNoVat;
  if (sumNoVat == null && l.sumWithVat == null && l.qty != null && l.priceNoVat != null) {
    sumNoVat = r2(l.qty * l.priceNoVat);
    warnings.push(`${label}: нет стоимости — посчитана как количество × цену (${money(sumNoVat)} без НДС)`);
  }

  let total = l.sumWithVat;
  if (total == null && sumNoVat != null) {
    if (vat != null) {
      total = r2(sumNoVat + vat);
    } else if (rate != null) {
      total = r2(sumNoVat * (100 + rate) / 100);
      warnings.push(`${label}: нет стоимости с НДС и суммы налога — стоимость посчитана по ставке ${rate}%`);
    } else {
      total = sumNoVat;
      warnings.push(`${label}: нет стоимости с НДС и ставки налога — взята стоимость без НДС`);
    }
  }
  if (total == null) warnings.push(`${label}: в документе нет стоимости строки`);

  // Перекрёстная проверка (CLAUDE.md, правило 3). XML не правим — только отмечаем.
  // Расхождение бывает и честным: ЦенаТов — прайсовая, а стоимость — со скидкой.
  if (l.qty != null && l.qty !== 0 && l.priceNoVat != null && l.sumNoVat != null) {
    const expected = l.qty * l.priceNoVat;
    if (Math.abs(expected - l.sumNoVat) > Math.max(1, Math.abs(l.sumNoVat) * 0.01)) {
      warnings.push(`${label}: количество × цена (${money(expected)}) не равно стоимости без НДС (${money(l.sumNoVat)})`);
    }
  }
  if (l.sumNoVat != null && vat != null && l.sumWithVat != null && Math.abs(l.sumNoVat + vat - l.sumWithVat) > 0.05) {
    warnings.push(`${label}: стоимость без НДС ${money(l.sumNoVat)} + НДС ${money(vat)} не равно стоимости с НДС ${money(l.sumWithVat)}`);
  }

  const name = l.name ? l.name.replace(/\s+/g, ' ').trim() : '';
  if (!name) warnings.push(`${label}: нет наименования товара`);
  const qty = l.qty;
  // Цена с НДС = стоимость / количество. Нет количества (услуга) — цена равна
  // стоимости, количество остаётся пустым, как в документе.
  const price = total == null ? null : qty == null ? total : qty > 0 ? r4(total / qty) : null;

  const item: ParsedInvoiceItem = {
    name: name || `Позиция ${l.rowNo}`,
    quantity: qty ?? undefined,
    unit: pickUnit(l, label, warnings),
    price: price ?? undefined,
    total: total ?? undefined,
    vat_rate: rate ?? undefined,
    row_no: l.rowNo,
    pack_size: null,
  };
  return { item, vat };
}

// ── Документ ────────────────────────────────────────────────────────────────

interface Assembled {
  invoice_type: ParsedInvoiceData['invoice_type'];
  number: string | null;
  date: string | undefined;
  seller: Party | null;
  lines: Array<{ item: ParsedInvoiceItem; vat: number | null }>;
  docTotal: number | null;
  docVat: number | null;
}

function assemble(a: Assembled, warnings: string[]): ParsedInvoiceData {
  const lineTotal = sumAll(a.lines.map(l => l.item.total));
  if (a.docTotal != null && lineTotal != null
      && Math.abs(a.docTotal - lineTotal) > Math.max(1, a.docTotal * 0.01)) {
    warnings.push(`Сумма строк ${money(lineTotal)} не равна итогу документа ${money(a.docTotal)}`);
  }
  if (!a.number) warnings.push('В документе нет номера');
  if (!a.seller) warnings.push('В документе нет сведений о продавце');
  else if (!a.seller.inn) warnings.push('В документе нет ИНН продавца');
  else if (!isValidInn(a.seller.inn)) warnings.push(`ИНН продавца ${a.seller.inn} не проходит проверку контрольной суммы`);

  const s = a.seller;
  return {
    invoice_type: a.invoice_type,
    invoice_number: a.number ?? undefined,
    invoice_date: a.date,
    supplier: s?.name ?? undefined,
    supplier_inn: s?.inn ?? undefined,
    supplier_kpp: s?.kpp ?? undefined,
    supplier_bik: s?.bik ?? undefined,
    supplier_account: s?.account ?? undefined,
    supplier_corr_account: s?.corrAccount ?? undefined,
    supplier_address: s?.address ?? undefined,
    total_sum: a.docTotal ?? lineTotal ?? undefined,
    vat_sum: a.docVat ?? sumAll(a.lines.map(l => l.vat)) ?? undefined,
    items: a.lines.map(l => l.item),
  };
}

function readCorrection(sf: XmlElement): FnsInvoiceResult['meta']['correction'] {
  // 5.02+: ИспрДок/@НомИспр, @ДатаИспр. 5.01: ИспрСчФ/@НомИспрСчФ, @ДатаИспрСчФ
  // (ДефНомИспрСчФ «-» — исправлений не было, это не исправленный документ).
  const fix = child(sf, 'ИспрДок') ?? child(sf, 'ИспрСчФ');
  const number = attr(fix, 'НомИспр') ?? attr(fix, 'НомИспрСчФ');
  if (!fix || !number) return null;
  return { number, date: attr(fix, 'ДатаИспр') ?? attr(fix, 'ДатаИспрСчФ') };
}

function parseUpd(doc: XmlElement, sf: XmlElement, warnings: string[]): ParsedInvoiceData {
  assertRubles(attr(child(sf, 'ДенИзм'), 'КодОКВ') ?? attr(sf, 'КодОКВ'));
  const table = child(doc, 'ТаблСчФакт');
  const rows = childrenNamed(table, 'СведТов');
  if (!rows.length) throw new FnsXmlError('В документе нет строк с товарами (таблица «ТаблСчФакт» пуста или отсутствует).');
  const lines = rows.map((row, k) => {
    const extra = child(row, 'ДопСведТов');
    return buildItem({
      rowNo: num(attr(row, 'НомСтр')) ?? k + 1,
      name: attr(row, 'НаимТов'),
      qty: num(attr(row, 'КолТов')),
      okei: attr(row, 'ОКЕИ_Тов'),
      unitName: attr(row, 'НаимЕдИзм') ?? attr(extra, 'НаимЕдИзм'),
      priceNoVat: num(attr(row, 'ЦенаТов')),
      sumNoVat: num(attr(row, 'СтТовБезНДС')),
      rateRaw: attr(row, 'НалСт'),
      vat: vatAmount(child(row, 'СумНал')),
      sumWithVat: num(attr(row, 'СтТовУчНал')),
    }, warnings);
  });
  const totals = child(table, 'ВсегоОпл');
  return assemble({
    invoice_type: attr(doc, 'Функция') === 'СЧФ' ? 'счет_фактура' : 'упд',
    number: attr(sf, 'НомерДок') ?? attr(sf, 'НомерСчФ'),
    date: fnsDate(attr(sf, 'ДатаДок') ?? attr(sf, 'ДатаСчФ'), warnings),
    // СвПрод может повторяться (совместная деятельность) — продавец первый.
    seller: readParty(child(sf, 'СвПрод')),
    lines,
    docTotal: num(attr(totals, 'СтТовУчНалВсего')),
    docVat: vatAmount(child(totals, 'СумНалВсего')),
  }, warnings);
}

function parseTorg12(doc: XmlElement, warnings: string[]): ParsedInvoiceData {
  // 551@: СвДокПТПрКроме/СвДокПТПр/ИдентДок; 172@: СвТНО/ТН.
  const ident = descendant(doc, 'ИдентДок');
  const tn = descendant(doc, 'ТН');
  assertRubles(attr(descendant(doc, 'ДенИзм'), 'КодОКВ'));
  const rows = findAll(doc, e => e.name === 'СвТов');
  if (!rows.length) throw new FnsXmlError('В ТОРГ-12 нет строк с товарами (СвТов).');
  const lines = rows.map((row, k) => buildItem({
    rowNo: num(attr(row, 'НомТов')) ?? k + 1,
    name: attr(row, 'НаимТов'),
    qty: num(attr(row, 'НеттоПередано') ?? attr(row, 'Нетто') ?? attr(row, 'КолТов')),
    okei: attr(row, 'ОКЕИ_Тов'),
    unitName: attr(row, 'НаимЕдИзм'),
    priceNoVat: num(attr(row, 'Цена') ?? attr(row, 'ЦенаТов')),
    sumNoVat: num(attr(row, 'СтБезНДС') ?? attr(row, 'СумБезНДС')),
    rateRaw: attr(row, 'НалСт') ?? attr(row, 'СтавкаНДС'),
    vat: attr(row, 'СумНДС') != null ? num(attr(row, 'СумНДС')) : vatAmount(child(row, 'СумНДС')),
    sumWithVat: num(attr(row, 'СтУчНДС') ?? attr(row, 'СумУчНДС')),
  }, warnings));
  const totals = descendant(doc, 'Всего') ?? descendant(doc, 'ВсегоНакл');
  return assemble({
    invoice_type: 'торг_12',
    number: attr(ident, 'НомДокПТ') ?? attr(tn, 'НомТН'),
    date: fnsDate(attr(ident, 'ДатаДокПТ') ?? attr(tn, 'ДатаТН'), warnings),
    // Продавец (551@) / Поставщик (172@) — не Покупатель и не Грузоотправитель.
    seller: readParty(descendant(doc, 'Продавец') ?? descendant(doc, 'Поставщик')),
    lines,
    docTotal: num(attr(totals, 'СтУчНДСВс') ?? attr(totals, 'СумУчНДСВс')),
    docVat: num(attr(totals, 'СумНДСВс')),
  }, warnings);
}

/** Первые два блока ИдФайл: ON_NSCHFDOPPR, DP_TOVTORGPR, ON_NSCHFDOPPOK… (может быть и мусором). */
function fileTypeId(fileId: string | null): string {
  return (fileId ?? '').toUpperCase().split('_').slice(0, 2).join('_');
}

/**
 * Разобрать XML-файл ФНС. Бросает FnsXmlError (сообщение для пользователя) на
 * повреждённом файле, чужом XML, УКД, титуле покупателя и прочих документах.
 */
export function parseFnsInvoiceXml(bytes: Uint8Array): FnsInvoiceResult {
  let root: XmlElement;
  let encoding: string;
  try {
    const decoded = decodeXmlBytes(bytes);
    encoding = decoded.encoding;
    root = parseXml(decoded.text);
  } catch (err) {
    if (err instanceof XmlParseError) {
      throw new FnsXmlError(`Файл не читается как XML: ${err.message}. Выгрузите документ из Диадока или СБИС заново.`);
    }
    throw err;
  }
  if (root.name !== 'Файл') {
    throw new FnsXmlError(`Это XML, но не электронный документ ФНС (корневой элемент «${root.name}», а не «Файл»). `
      + 'Загрузите УПД, счёт-фактуру или ТОРГ-12, выгруженные из Диадока или СБИС.');
  }
  const fileId = attr(root, 'ИдФайл');
  const version = attr(root, 'ВерсФорм');
  const typeId = fileTypeId(fileId);
  const doc = child(root, 'Документ');
  if (!doc) throw new FnsXmlError('В файле ФНС нет раздела «Документ» — файл неполный, выгрузите его заново.');

  if (/KORSCHF|KORSFAKT/.test(typeId) || child(doc, 'СвКСчФ') || child(doc, 'ТаблКСчФ')) {
    throw new FnsXmlError('Корректировочный документ (УКД, корректировочный счёт-фактура) пока не поддерживается — '
      + 'внесите изменения в исходную накладную вручную.');
  }
  // Титул покупателя: ссылка на информацию продавца (ИдИнфПрод), товаров в нём нет.
  if (child(doc, 'ИдИнфПрод') || /POK/.test(typeId) || typeId.startsWith('DP_PTORG')) {
    throw new FnsXmlError(`Это титул покупателя${typeId ? ` (${typeId})` : ''} — в нём нет товаров. `
      + 'Загрузите файл продавца (ON_NSCHFDOPPR…, DP_TOVTORGPR…).');
  }

  const warnings: string[] = [];
  const func = attr(doc, 'Функция');
  const sf = child(doc, 'СвСчФакт');
  if (sf) {
    const data = parseUpd(doc, sf, warnings);
    const correction = readCorrection(sf);
    if (correction) {
      warnings.push(`Исправленный документ: исправление № ${correction.number}`
        + `${correction.date ? ` от ${correction.date}` : ''}. Если исходный документ уже загружен — удалите лишнюю накладную.`);
    }
    const title = `${data.invoice_type === 'счет_фактура' ? 'Счёт-фактура' : 'УПД'} (формат ФНС ${version ?? '—'})`;
    return { kind: 'upd', data, meta: { title, file_id: fileId, version, function: func, encoding, correction }, warnings };
  }
  if (findFirst(doc, e => e.name === 'СвТов')) {
    const data = parseTorg12(doc, warnings);
    const fix = descendant(doc, 'ИспрДокПТ');
    const correction = attr(fix, 'НомИспрДокПТ') ? { number: attr(fix, 'НомИспрДокПТ'), date: attr(fix, 'ДатаИспрДокПТ') } : null;
    if (correction) {
      warnings.push(`Исправленный документ: исправление № ${correction.number}`
        + `${correction.date ? ` от ${correction.date}` : ''}. Если исходный документ уже загружен — удалите лишнюю накладную.`);
    }
    const title = `ТОРГ-12 (формат ФНС ${version ?? '—'})`;
    return { kind: 'torg12', data, meta: { title, file_id: fileId, version, function: func, encoding, correction }, warnings };
  }
  throw new FnsXmlError(`Этот документ ФНС не поддерживается${typeId ? ` (${typeId})` : ''}. `
    + 'Можно загрузить УПД или счёт-фактуру (ON_NSCHFDOPPR, форматы 5.01–5.03) и ТОРГ-12 (DP_TOVTORGPR).');
}
