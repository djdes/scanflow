import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { FnsXmlError, parseFnsInvoiceXml, parseVatRate } from '../../src/xml/fnsInvoice';

const FIXTURES = path.join(__dirname, 'fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));
const xml = (s: string) => Buffer.from(s, 'utf8');

/** Минимальный УПД 5.03 с одной строкой — для точечных случаев. */
function upd503(opts: { table?: string; sf?: string; doc?: string; root?: string } = {}): Buffer {
  return xml(`<?xml version="1.0" encoding="utf-8"?>
<Файл ИдФайл="ON_NSCHFDOPPR_A_B_20260928_x" ВерсФорм="5.03" ВерсПрог="1С" ${opts.root ?? ''}>
  <Документ КНД="1115131" Функция="СЧФДОП" ДатаИнфПр="28.09.2026" ВремИнфПр="10.00.00" ${opts.doc ?? ''}>
    <СвСчФакт НомерДок="77" ДатаДок="28.09.2026">
      ${opts.sf ?? ''}
      <СвПрод><ИдСв><СвЮЛУч НаимОрг="ООО Ромашка" ИННЮЛ="7701234560" КПП="770101001"/></ИдСв></СвПрод>
      <СвПокуп><ИдСв><СвЮЛУч НаимОрг="ООО Покупатель" ИННЮЛ="5003012349"/></ИдСв></СвПокуп>
      <ДенИзм КодОКВ="643" НаимОКВ="Российский рубль"/>
    </СвСчФакт>
    <ТаблСчФакт>
      ${opts.table ?? `<СведТов НомСтр="1" НаимТов="Молоко" ОКЕИ_Тов="796" НаимЕдИзм="шт" КолТов="10" ЦенаТов="80" СтТовБезНДС="800" НалСт="10%" СтТовУчНал="880"><СумНал><СумНал>80</СумНал></СумНал></СведТов>`}
      <ВсегоОпл СтТовБезНДСВсего="800" СтТовУчНалВсего="880"><СумНалВсего><СумНал>80</СумНал></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`);
}

function row(attrs: string, vat = '<СумНал><СумНал>0</СумНал></СумНал>', extra = ''): string {
  return `<СведТов ${attrs}>${vat}${extra}</СведТов>`;
}

describe('УПД 5.03, продавец — организация, windows-1251', () => {
  const r = parseFnsInvoiceXml(fixture('upd_503_ul_win1251.xml'));

  it('вид документа и служебные сведения', () => {
    expect(r.kind).toBe('upd');
    expect(r.meta.title).toBe('УПД (формат ФНС 5.03)');
    expect(r.meta.version).toBe('5.03');
    expect(r.meta.function).toBe('СЧФДОП');
    expect(r.meta.encoding).toBe('windows-1251');
    expect(r.meta.file_id).toMatch(/^ON_NSCHFDOPPR_2BM-5003012349/);
    expect(r.meta.correction).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('шапка: продавец, а не покупатель/грузополучатель; реквизиты и адрес по ГАР', () => {
    expect(r.data).toMatchObject({
      invoice_type: 'упд',
      invoice_number: 'ТД-01234',
      invoice_date: '2026-09-28',
      supplier: 'Общество с ограниченной ответственностью "Северное молоко"',
      supplier_inn: '7701234560',
      supplier_kpp: '770101001',
      supplier_bik: '044525225',
      supplier_account: '40702810938000012345',
      supplier_corr_account: '30101810400000000225',
      supplier_address: '129090, г. Москва, муниципальный округ Мещанский, ул. Щепкина, д. 33, помещ. 4/1',
      total_sum: 7740.25,
      vat_sum: 734.75,
    });
  });

  it('строки: цена и сумма С НДС, количество и единица как напечатано, номинальная ставка', () => {
    const items = r.data.items;
    expect(items).toHaveLength(4);
    expect(items[0]).toEqual({
      name: 'Молоко питьевое ультрапастеризованное 3,2% 1 л',
      quantity: 24, unit: 'шт', price: 88, total: 2112, vat_rate: 10, row_no: 1, pack_size: null,
    });
    expect(items[1]).toMatchObject({ name: 'Сыр "Российский" 50%', quantity: 5.25, unit: 'кг', price: 682, total: 3580.5, vat_rate: 10 });
    expect(items[2]).toMatchObject({ name: 'Салфетки бумажные 24х24 (х100/2400)', quantity: 3, unit: 'упак', total: 347.7, vat_rate: 22 });
    expect(items[2].price).toBeCloseTo(115.9, 4);
    expect(items[3]).toMatchObject({ quantity: 10, unit: 'шт', total: 1700.05, vat_rate: 10, row_no: 4 });
    expect(items[3].price).toBeCloseTo(170.005, 4);
    const sum = items.reduce((s, it) => s + (it.total ?? 0), 0);
    expect(sum).toBeCloseTo(r.data.total_sum!, 2);
  });
});

describe('УПД 5.01, продавец — ИП на УСН, UTF-8, строки без НДС', () => {
  const r = parseFnsInvoiceXml(fixture('upd_501_ip_utf8.xml'));

  it('шапка', () => {
    expect(r.kind).toBe('upd');
    expect(r.meta).toMatchObject({ title: 'УПД (формат ФНС 5.01)', function: 'ДОП', encoding: 'utf-8', correction: null });
    expect(r.data).toMatchObject({
      invoice_type: 'упд',
      invoice_number: '145',
      invoice_date: '2026-09-29',
      supplier: 'ИП Иванова Мария Петровна',
      supplier_inn: '500601234575',
      supplier_bik: '044525974',
      supplier_account: '40802810400000012345',
      supplier_corr_account: '30101810145250000974',
      supplier_address: '141400, Химки, Ленинградская, д. 12, кв. 7',
      total_sum: 4390,
      vat_sum: 0,
    });
    expect(r.data.supplier_kpp).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it('«без НДС» → ставка 0; единица из ДопСведТов; услуга без количества и единицы', () => {
    const items = r.data.items;
    expect(items.map(i => i.vat_rate)).toEqual([0, 0, 0, 0]);
    expect(items[0]).toMatchObject({ name: 'Хлеб «Бородинский» нарезка 400 г', quantity: 30, unit: 'шт', price: 58, total: 1740 });
    expect(items[2]).toMatchObject({ quantity: 2.5, unit: 'кг', price: 180, total: 450 });
    expect(items[3]).toMatchObject({ name: 'Доставка товара', unit: 'шт', price: 500, total: 500 });
    expect(items[3].quantity).toBeUndefined();
  });
});

describe('ТОРГ-12 (DP_TOVTORGPR, приказ 551@), windows-1251', () => {
  const r = parseFnsInvoiceXml(fixture('torg12_551_win1251.xml'));

  it('продавец из СодФХЖ1/Продавец, итог из «Всего», количество — НеттоПередано', () => {
    expect(r.kind).toBe('torg12');
    expect(r.meta.title).toBe('ТОРГ-12 (формат ФНС 5.01)');
    expect(r.warnings).toEqual([]);
    expect(r.data).toMatchObject({
      invoice_type: 'торг_12',
      invoice_number: 'РН-000512',
      invoice_date: '2025-12-27',
      supplier: 'ООО "Овощная база №3"',
      supplier_inn: '7715024676',
      supplier_kpp: '771501001',
      supplier_bik: '044525187',
      supplier_account: '40702810500000054321',
      supplier_address: '127282, Москва, Полярная, д. 31, корп. В',
      total_sum: 3203,
      vat_sum: 313,
    });
    expect(r.data.items).toEqual([
      { name: 'Картофель мытый', quantity: 50, unit: 'кг', price: 38.5, total: 1925, vat_rate: 10, row_no: 1, pack_size: null },
      { name: 'Лук репчатый (сетка 10 кг)', quantity: 3, unit: 'шт', price: 330, total: 990, vat_rate: 10, row_no: 2, pack_size: null },
      { name: 'Пакет фасовочный 25х40 (х100)', quantity: 2, unit: 'упак', price: 144, total: 288, vat_rate: 20, row_no: 3, pack_size: null },
    ]);
  });

  it('старый ТОРГ-12 (DP_OTORG12, приказ 172@): СвТНО/Поставщик, ТН, ВсегоНакл', () => {
    const old = parseFnsInvoiceXml(xml(`<?xml version="1.0" encoding="utf-8"?>
<Файл ИдФайл="DP_OTORG12_A_B_20150101_x" ВерсФорм="5.02" ВерсПрог="1С">
  <Документ КНД="1175004" ДатаДок="15.03.2015" ВремДок="10.00.00">
    <СвТНО>
      <ГрузОт><ГрузОтпр><ИдСв><СвЮЛ НаимОрг="ООО Склад" ИННЮЛ="5003012349" КПП="500301001"/></ИдСв></ГрузОтпр></ГрузОт>
      <Поставщик><ИдСв><СвЮЛ НаимОрг="ООО Старая база" ИННЮЛ="7801012346" КПП="780101001"/></ИдСв></Поставщик>
      <Плательщик><ИдСв><СвЮЛ НаимОрг="ООО Кафе" ИННЮЛ="5003012349"/></ИдСв></Плательщик>
      <ТН НомТН="00017" ДатаТН="15.03.2015">
        <Таблица>
          <СвТов НомТов="1" НаимТов="Мука пшеничная (50кг)" НаимЕдИзм="шт" ОКЕИ_Тов="796" Нетто="2" Цена="1500" СумБезНДС="3000" СтавкаНДС="10%" СумНДС="300" СумУчНДС="3300"/>
          <СвТов НомТов="2" НаимТов="Соль" НаимЕдИзм="кг" ОКЕИ_Тов="166" Нетто="10" Цена="20" СумБезНДС="200" СтавкаНДС="без НДС" СумУчНДС="200"/>
          <ВсегоНакл НеттоВс="12" СумБезНДСВс="3200" СумНДСВс="300" СумУчНДСВс="3500"/>
        </Таблица>
      </ТН>
    </СвТНО>
  </Документ>
</Файл>`));
    expect(old.kind).toBe('torg12');
    expect(old.warnings).toEqual([]);
    expect(old.data).toMatchObject({
      invoice_number: '00017', invoice_date: '2015-03-15', supplier: 'ООО Старая база', supplier_inn: '7801012346',
      total_sum: 3500, vat_sum: 300,
    });
    expect(old.data.items.map(i => [i.name, i.quantity, i.unit, i.total, i.vat_rate]))
      .toEqual([['Мука пшеничная (50кг)', 2, 'шт', 3300, 10], ['Соль', 10, 'кг', 200, 0]]);
  });
});

describe('определение вида документа — по структуре, а не по имени', () => {
  it('нестандартный ИдФайл («…-MARK», маркированные товары): это всё равно УПД; скидка — только замечание', () => {
    const r = parseFnsInvoiceXml(xml(`<?xml version="1.0" encoding="utf-8"?>
<Файл ИдФайл="RL-NB-146830-MARK" ВерсФорм="5.01" ВерсПрог="Diadoc 1.0">
  <Документ КНД="1115131" Функция="ДОП" ДатаИнфПр="06.01.2022" ВремИнфПр="00.00.00" НаимЭконСубСост="ИП">
    <СвСчФакт НомерСчФ="RL-NB-146830" ДатаСчФ="06.01.2022" КодОКВ="643">
      <СвПрод ОКПО="0117061905"><ИдСв><СвИП ИННФЛ="500601234575"><ФИО Фамилия="Богданов" Имя="Александр"/></СвИП></ИдСв></СвПрод>
      <СвПокуп><ИдСв><СвЮЛУч НаимОрг="ООО БАСК" ИННЮЛ="7717801381" КПП="771701001"/></ИдСв></СвПокуп>
    </СвСчФакт>
    <ТаблСчФакт>
      <СведТов НомСтр="1" НаимТов="Рюкзак 120 V3" ОКЕИ_Тов="796" КолТов="1" ЦенаТов="12500" СтТовБезНДС="11250" НалСт="без НДС" СтТовУчНал="11250">
        <Акциз><БезАкциз>без акциза</БезАкциз></Акциз>
        <СумНал><БезНДС>без НДС</БезНДС></СумНал>
        <ДопСведТов ПрТовРаб="1" КодТов="3496-70364" НаимЕдИзм="шт"><НомСредИдентТов><КИЗ>010290002067072721Snhpvp"/g(-:B</КИЗ></НомСредИдентТов></ДопСведТов>
      </СведТов>
      <ВсегоОпл СтТовБезНДСВсего="11250" СтТовУчНалВсего="11250"><СумНалВсего><БезНДС>без НДС</БезНДС></СумНалВсего></ВсегоОпл>
    </ТаблСчФакт>
  </Документ>
</Файл>`));
    expect(r.kind).toBe('upd');
    expect(r.data).toMatchObject({ invoice_number: 'RL-NB-146830', supplier: 'ИП Богданов Александр', total_sum: 11250, vat_sum: 0 });
    expect(r.data.items[0]).toMatchObject({ quantity: 1, price: 11250, total: 11250, vat_rate: 0 });
    expect(r.warnings).toEqual(['Строка 1: количество × цена (12500.00) не равно стоимости без НДС (11250.00)']);
  });

  it('счёт-фактура (Функция=СЧФ) — тип «счет_фактура»', () => {
    const r = parseFnsInvoiceXml(xml(upd503().toString('utf8').replace('Функция="СЧФДОП"', 'Функция="СЧФ"')));
    expect(r.data.invoice_type).toBe('счет_фактура');
    expect(r.meta.title).toBe('Счёт-фактура (формат ФНС 5.03)');
  });

  it('исправленный документ (ИспрДок) — замечание и сведения об исправлении', () => {
    const r = parseFnsInvoiceXml(upd503({ sf: '<ИспрДок НомИспр="2" ДатаИспр="30.09.2026"/>' }));
    expect(r.meta.correction).toEqual({ number: '2', date: '30.09.2026' });
    expect(r.warnings.join(' ')).toContain('Исправленный документ: исправление № 2 от 30.09.2026');
  });

  it('5.01: ИспрСчФ с прочерком (ДефНомИспрСчФ) — не исправление', () => {
    const src = fixture('upd_501_ip_utf8.xml').toString('utf8')
      .replace('<СвПрод>', '<ИспрСчФ ДефНомИспрСчФ="-" ДефДатаИспрСчФ="-"/><СвПрод>');
    const r = parseFnsInvoiceXml(xml(src));
    expect(r.meta.correction).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it.each([
    ['УКД (СвКСчФ)', `<Файл ИдФайл="ON_NKORSCHFDOPPR_A_B" ВерсФорм="5.01"><Документ КНД="1115127"><СвКСчФ/><ТаблКСчФ/></Документ></Файл>`, /Корректировочный документ/],
    ['титул покупателя по структуре', `<Файл ИдФайл="X" ВерсФорм="5.01"><Документ КНД="1115132"><ИдИнфПрод ИдФайлИнфПр="ON_NSCHFDOPPR_A"/></Документ></Файл>`, /титул покупателя/],
    ['титул покупателя по ИдФайл', `<Файл ИдФайл="ON_NSCHFDOPPOK_A_B" ВерсФорм="5.01"><Документ КНД="1115132"/></Файл>`, /титул покупателя \(ON_NSCHFDOPPOK\)/],
    ['не ФНС', `<КоммерческаяИнформация ВерсияСхемы="2.10"/>`, /не электронный документ ФНС \(корневой элемент «КоммерческаяИнформация»/],
    ['нет раздела Документ', `<Файл ИдФайл="ON_NSCHFDOPPR_A_B" ВерсФорм="5.03"/>`, /нет раздела «Документ»/],
    ['неизвестный документ', `<Файл ИдФайл="ON_AKTSVEROTP_A_B" ВерсФорм="5.01"><Документ КНД="1111111"><СвАкт/></Документ></Файл>`, /не поддерживается \(ON_AKTSVEROTP\)/],
  ])('%s → понятная ошибка', (_title, src, message) => {
    expect(() => parseFnsInvoiceXml(xml(src))).toThrow(FnsXmlError);
    expect(() => parseFnsInvoiceXml(xml(src))).toThrow(message);
  });

  it('валюта не рубли → ошибка', () => {
    const src = upd503().toString('utf8').replace('КодОКВ="643" НаимОКВ="Российский рубль"', 'КодОКВ="840" НаимОКВ="Доллар США"');
    expect(() => parseFnsInvoiceXml(xml(src))).toThrow(/в валюте с кодом 840/);
  });

  it('таблица без строк → ошибка', () => {
    expect(() => parseFnsInvoiceXml(upd503({ table: ' ' }))).toThrow(/нет строк с товарами/);
  });

  it('повреждённый (оборванный) файл → ошибка с понятным текстом, не исключение парсера', () => {
    let err: unknown;
    try { parseFnsInvoiceXml(fixture('upd_malformed.xml')); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(FnsXmlError);
    expect((err as Error).message).toMatch(/^Файл не читается как XML: файл обрывается: не закрыт тег <СумНал>/);
    expect((err as Error).message).toContain('Выгрузите документ из Диадока или СБИС заново');
  });

  it('не XML вовсе (PDF с расширением .xml) → ошибка', () => {
    expect(() => parseFnsInvoiceXml(Buffer.from('%PDF-1.7\n1 0 obj'))).toThrow(/Файл не читается как XML/);
  });
});

describe('строки: суммы, ставки, единицы', () => {
  it('нет стоимости с НДС — стоимость без НДС + сумма налога', () => {
    const r = parseFnsInvoiceXml(upd503({
      table: row('НомСтр="1" НаимТов="Сок" ОКЕИ_Тов="796" КолТов="4" ЦенаТов="100" СтТовБезНДС="400" НалСт="22%"', '<СумНал><СумНал>88</СумНал></СумНал>'),
    }));
    expect(r.data.items[0]).toMatchObject({ total: 488, price: 122, vat_rate: 22 });
  });

  it('нет ни стоимости с НДС, ни суммы налога — по ставке, с замечанием', () => {
    const r = parseFnsInvoiceXml(upd503({
      table: row('НомСтр="1" НаимТов="Сок" ОКЕИ_Тов="796" КолТов="4" ЦенаТов="100" СтТовБезНДС="400" НалСт="20%"', '<СумНал><ДефНДС>-</ДефНДС></СумНал>'),
    }));
    expect(r.data.items[0]).toMatchObject({ total: 480, price: 120 });
    expect(r.warnings.join(' ')).toContain('посчитана по ставке 20%');
  });

  it('нет никаких стоимостей — количество × цену, с замечанием', () => {
    const r = parseFnsInvoiceXml(upd503({
      table: row('НомСтр="1" НаимТов="Сок" ОКЕИ_Тов="796" КолТов="4" ЦенаТов="100" НалСт="без НДС"', '<СумНал><БезНДС>без НДС</БезНДС></СумНал>'),
    }));
    expect(r.data.items[0]).toMatchObject({ total: 400, price: 100, vat_rate: 0 });
    expect(r.warnings.join(' ')).toContain('количество × цену');
  });

  it('налоговый агент — без ставки; расчётная ставка 20/120 → 20', () => {
    const r = parseFnsInvoiceXml(upd503({
      table: row('НомСтр="1" НаимТов="A" ОКЕИ_Тов="796" КолТов="1" СтТовБезНДС="100" НалСт="НДС исчисляется налоговым агентом" СтТовУчНал="100"')
        + row('НомСтр="2" НаимТов="B" ОКЕИ_Тов="796" КолТов="1" СтТовБезНДС="100" НалСт="20/120" СтТовУчНал="120"', '<СумНал><СумНал>20</СумНал></СумНал>'),
    }));
    expect(r.data.items[0].vat_rate).toBeUndefined();
    expect(r.data.items[1].vat_rate).toBe(20);
  });

  it.each([
    ['уп.', '778', 'уп'],               // наименование понятно пересчёту — как напечатано
    ['бут', '796', 'бут'],
    ['лоток', '796', 'шт'],             // наименование непонятно — по коду ОКЕИ
    ['лоток', '999', 'лоток'],          // и код неизвестен — как напечатано
    [null, '112', 'л'],
    [null, '0166', 'кг'],               // четырёхзначная запись кода
    [null, null, 'шт'],
  ])('единица: «%s» + ОКЕИ %s → %s', (name, okei, unit) => {
    const attrs = [`НомСтр="1" НаимТов="Товар" КолТов="1" СтТовБезНДС="10" НалСт="без НДС" СтТовУчНал="10"`,
      name ? `НаимЕдИзм="${name}"` : '', okei ? `ОКЕИ_Тов="${okei}"` : ''].join(' ');
    const r = parseFnsInvoiceXml(upd503({ table: row(attrs, '<СумНал><БезНДС>без НДС</БезНДС></СумНал>') }));
    expect(r.data.items[0].unit).toBe(unit);
  });

  it('наименование единицы противоречит коду (кг и 796) — берётся наименование, замечание', () => {
    const r = parseFnsInvoiceXml(upd503({
      table: row('НомСтр="1" НаимТов="Фарш" НаимЕдИзм="кг" ОКЕИ_Тов="796" КолТов="2" СтТовБезНДС="10" НалСт="без НДС" СтТовУчНал="10"', '<СумНал><БезНДС>без НДС</БезНДС></СумНал>'),
    }));
    expect(r.data.items[0].unit).toBe('кг');
    expect(r.warnings.join(' ')).toContain('не совпадает с кодом ОКЕИ 796');
  });

  it('тысячи штук (ОКЕИ 798) — замечание про пересчёт', () => {
    const r = parseFnsInvoiceXml(upd503({
      table: row('НомСтр="1" НаимТов="Стаканы" НаимЕдИзм="тыс. шт" ОКЕИ_Тов="798" КолТов="2" СтТовБезНДС="10" НалСт="без НДС" СтТовУчНал="10"', '<СумНал><БезНДС>без НДС</БезНДС></СумНал>'),
    }));
    expect(r.warnings.join(' ')).toContain('проверьте пересчёт в штуки');
  });

  it('несходящийся итог и неверный ИНН — только замечания, данные не меняются', () => {
    const src = upd503().toString('utf8')
      .replace('СтТовУчНалВсего="880"', 'СтТовУчНалВсего="990"')
      .replace('ИННЮЛ="7701234560"', 'ИННЮЛ="7701234561"');
    const r = parseFnsInvoiceXml(xml(src));
    expect(r.data.total_sum).toBe(990);
    expect(r.data.items[0].total).toBe(880);
    expect(r.data.supplier_inn).toBe('7701234561');
    expect(r.warnings).toEqual([
      'Сумма строк 880.00 не равна итогу документа 990.00',
      'ИНН продавца 7701234561 не проходит проверку контрольной суммы',
    ]);
  });
});

describe('продавец: разные виды участника', () => {
  const withSeller = (seller: string) => upd503().toString('utf8')
    .replace(/<СвПрод>.*?<\/СвПрод>/s, `<СвПрод>${seller}</СвПрод>`);

  it('физлицо (СвФЛУч) — ФИО без «ИП»', () => {
    const r = parseFnsInvoiceXml(xml(withSeller('<ИдСв><СвФЛУч ИННФЛ="500601234575"><ФИО Фамилия="Петров" Имя="Пётр"/></СвФЛУч></ИдСв>')));
    expect(r.data).toMatchObject({ supplier: 'Петров Пётр', supplier_inn: '500601234575' });
  });

  it('иностранная организация (СвИнНеУч, 5.02+) — @Наим, без ИНН', () => {
    const r = parseFnsInvoiceXml(xml(withSeller('<ИдСв><СвИнНеУч ИдСтат="ИО" КодСтр="112" НаимСтран="Беларусь" Наим="ОАО Савушкин продукт"/></ИдСв>')));
    expect(r.data.supplier).toBe('ОАО Савушкин продукт');
    expect(r.data.supplier_inn).toBeUndefined();
    expect(r.warnings).toContain('В документе нет ИНН продавца');
  });

  it('нет сведений о продавце — замечание', () => {
    const r = parseFnsInvoiceXml(xml(upd503().toString('utf8').replace(/<СвПрод>.*?<\/СвПрод>/s, '')));
    expect(r.data.supplier).toBeUndefined();
    expect(r.warnings).toContain('В документе нет сведений о продавце');
  });
});

describe('parseVatRate', () => {
  it.each([
    ['22%', 22], ['20%', 20], ['10%', 10], ['7%', 7], ['5%', 5], ['0%', 0], ['18%', 18],
    ['20/120', 20], ['22/122', 22], ['10/110', 10], ['5/105', 5], ['7/107', 7],
    ['16,67%', 20], ['18,03%', 22], ['9,09%', 10],
    ['без НДС', 0], ['Без НДС', 0], ['НДС 20%', 20], [' 20 % ', 20],
    ['НДС исчисляется налоговым агентом', null], ['', null], [null, null], ['абв', null],
  ])('%s → %s', (raw, expected) => {
    expect(parseVatRate(raw as string | null)).toBe(expected);
  });
});
