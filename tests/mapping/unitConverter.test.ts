import { describe, it, expect } from 'vitest';
import { convertLine, parsePack, canonUnit, type ConvertInput } from '../../src/mapping/unitConverter';

const line = (name: string, quantity: number, unit: string, total: number, onecUnit: string | null, extra: Partial<ConvertInput> = {}): ConvertInput => ({
  name, onecUnit, raw: { quantity, unit, price: +(total / quantity).toFixed(4), total }, ...extra,
});

describe('canonUnit', () => {
  it('написания единиц', () => {
    expect(canonUnit('шт.')?.unit).toBe('шт');
    expect(canonUnit('КГ')?.unit).toBe('кг');
    expect(canonUnit('упак.')?.unit).toBe('упак');
    expect(canonUnit('л (дм3)')?.unit).toBe('л');
    expect(canonUnit('гр')?.unit).toBe('г');
    expect(canonUnit('г')?.toBase).toBeCloseTo(0.001);
    expect(canonUnit('непонятно')).toBeNull();
  });
});

describe('parsePack', () => {
  it('мера, диапазон, упаковка', () => {
    expect(parsePack('Батон "Нарезной" в/с 0,4 кг без упаковки').measures[0]).toMatchObject({ value: 0.4, unit: 'кг' });
    expect(parsePack('Печень говяжья зам 4-5кг').ranges[0]).toMatchObject({ low: 4, high: 5, unit: 'кг' });
    expect(parsePack('Печень говяжья зам 4-5кг').measures).toEqual([]);
    expect(parsePack('Горбуша нат. 240г*24 ГОСТ').perPack).toBe(24);
    expect(parsePack('Перчатки нитриловые 100шт/упак').perPack).toBe(100);
    const c = parsePack('Контейнер ПП К-139, 500мл (х50/500)');
    expect(c.perPack).toBe(50);
    expect(c.perCase).toBe(500);
    expect(parsePack('Масло подсолнечное 1л 1/15').perPack).toBe(15);
    expect(parsePack('Сахар Порционный 500*5г').perPack).toBe(500);
    expect(parsePack('Огурчики 7,5 кг (сух.вес 4кг)').measures.map(m => m.kind)).toEqual(['nominal', 'drained']);
  });
});

describe('convertLine — реальные строки прода', () => {
  it('«Батон 0,4 кг» 60 шт, 1С в кг → 24 кг, 80,50 ₽/кг', () => {
    const r = convertLine(line('Батон "Нарезной" в/с 0,4 кг без упаковки', 60, 'шт', 1932, 'кг'));
    expect(r.quantity).toBe(24);
    expect(r.unit).toBe('кг');
    expect(r.price).toBeCloseTo(80.5, 2);
    expect(r.total).toBe(1932);
    expect(r.source).toBe('name');
    expect(r.note).toContain('0,4');
  });

  it('«Мука (50кг)» 2 шт → 100 кг', () => {
    const r = convertLine(line('Мука (50кг)', 2, 'шт', 3800, 'кг'));
    expect(r.quantity).toBe(100);
    expect(r.flag).toBeNull();
  });

  it('«Горбуша 240г*24» 48 шт (банки) → 11,52 кг; 2 кор → тоже 11,52 кг', () => {
    expect(convertLine(line('Горбуша нат. 240г*24 ГОСТ', 48, 'шт', 9408, 'кг')).quantity).toBeCloseTo(11.52, 3);
    const box = convertLine(line('Горбуша нат. 240г*24 ГОСТ', 2, 'кор', 9408, 'кг'));
    expect(box.quantity).toBeCloseTo(11.52, 3);
    expect(box.source).toBe('name_count');
  });

  it('«Сахар 500*5г» 1 шт → коробка 2,5 кг: по истории цен, а без истории — по правдоподобию (87 000 ₽/кг не бывает)', () => {
    const fit = convertLine(line('Сахар Порционный 500*5г', 1, 'шт', 435, 'кг', { medianPrice: 150 }));
    expect(fit.quantity).toBeCloseTo(2.5, 3);
    expect(fit.source).toBe('price_fit');
    const noHist = convertLine(line('Сахар Порционный 500*5г', 1, 'шт', 435, 'кг'));
    expect(noHist.quantity).toBeCloseTo(2.5, 3);
    expect(noHist.source).toBe('price_fit');
    expect(noHist.note).toMatch(/правдоподоб/);
  });

  it('«Кофе 3в1 20*14г» 40 шт по 19,31 — это стики, коробку не выдумываем', () => {
    const r = convertLine(line('Кофе Растворимый 3в1 Cappuccino 20*14г', 40, 'шт', 772.4, 'кг'));
    expect(r.quantity).toBeCloseTo(0.56, 3);
    expect(r.source).toBe('name');
  });

  it('история цен не перебивает правдоподобный вариант: «Масло фритюрное 5л 1/2» 3 упак → 30 кг, даже если в истории 314,8 ₽', () => {
    const r = convertLine(line('Масло фритюрное 5л 1/2', 3, 'упак', 4722, 'кг', { medianPrice: 314.8 }));
    expect(r.quantity).toBe(30);
    expect(r.source).toBe('name_count');
    expect(r.flag).toBeNull();
  });

  it('«Перчатки 100шт/упак» 2 упак, 1С в шт → 200 шт', () => {
    const r = convertLine(line('Перчатки нитриловые (Черные) М 100шт/упак', 2, 'упак', 588, 'шт'));
    expect(r.quantity).toBe(200);
    expect(r.unit).toBe('шт');
    expect(r.price).toBeCloseTo(2.94, 2);
  });

  it('«Контейнер (х50/500)» 500 шт, 1С в шт → 500 шт без пересчёта', () => {
    const r = convertLine(line('Контейнер средний ПП К-139, 500мл 139х102х56мм (х50/500)', 500, 'шт', 2200, 'шт'));
    expect(r.quantity).toBe(500);
    expect(r.source).toBe('same');
  });

  it('«Печень 4-5кг» 3 шт, 1С в кг → без пересчёта, флаг «нужен вес»', () => {
    const r = convertLine(line('Печень говяжья замороженная 4-5кг', 3, 'шт', 5000, 'кг'));
    expect(r.quantity).toBe(3);
    expect(r.flag).toBe('needs_weight');
  });

  it('«Камбала 300-500г» 10 кг, 1С в кг → 10 кг (калибр не вес)', () => {
    const r = convertLine(line('Камбала потрошеная 300-500г', 10, 'кг', 3500, 'кг'));
    expect(r.quantity).toBe(10);
    expect(r.source).toBe('same');
    expect(r.flag).toBeNull();
  });

  it('«Майонез 10л/9,6кг» 3 шт, 1С в кг → 28,8 кг (масса нетто)', () => {
    const r = convertLine(line('Майонез Московский Провансаль 67% 10л/9,6кг', 3, 'шт', 5040, 'кг'));
    expect(r.quantity).toBeCloseTo(28.8, 3);
  });

  it('«Яйцо С1 360шт» 1080 шт, 1С в шт → 1080 шт', () => {
    const r = convertLine(line('Яйцо Куриное Коричневое С1 360шт', 1080, 'шт', 7560, 'шт'));
    expect(r.quantity).toBe(1080);
    expect(r.source).toBe('same');
  });

  it('«Перец желтый» 3,5 кг, 1С в шт → без пересчёта, флаг несовпадения единиц', () => {
    const r = convertLine(line('Перец желтый', 3.5, 'кг', 840, 'шт'));
    expect(r.quantity).toBe(3.5);
    expect(r.flag).toBe('unit_mismatch');
  });

  it('«Сыр 1,107кг» 2,214 кг, 1С в шт → 2 шт', () => {
    const r = convertLine(line('Сыр Плавленый Чеддер 45% 1,107кг', 2.214, 'кг', 1200, 'шт'));
    expect(r.quantity).toBe(2);
    expect(r.unit).toBe('шт');
  });

  it('«Масло 1л 1/15» 30 шт, 1С в кг → 30 кг (плотность не учтена — в заметке)', () => {
    const r = convertLine(line('Масло подсолнечное раф/дез ГОСТ 1л 1/15', 30, 'шт', 4326, 'кг'));
    expect(r.quantity).toBe(30);
    expect(r.note).toMatch(/плотность/);
  });

  it('«Бедро 600г» 10 шт, 1С в кг → 6 кг', () => {
    expect(convertLine(line('Бедро Куриное Замороженное 600г', 10, 'шт', 1800, 'кг')).quantity).toBe(6);
  });

  it('«Вода 1,5л» 12 шт, 1С в шт → 12 шт', () => {
    expect(convertLine(line('Вода Питьевая Негазированная 1,5л пэт', 12, 'шт', 480, 'шт')).quantity).toBe(12);
  });

  it('тара: объём — вместимость, не содержимое (1С по ошибке в кг) → без пересчёта, флаг', () => {
    const r = convertLine(line('Контейнер средний без крыш. ПП К-139, 500мл 139х102х56мм (х50/500)', 500, 'шт', 2200, 'кг'));
    expect(r.quantity).toBe(500);
    expect(r.flag).toBe('unit_mismatch');
    expect(convertLine(line('Мусорные мешки 180л ПВД 90*120см 25шт/рул', 240, 'шт', 2324.78, 'кг')).quantity).toBe(240);
    expect(convertLine(line('Бутылка ПЭТ 0,3л Прозрачная 150шт/упак', 4, 'упак', 3621, 'кг')).quantity).toBe(4);
  });

  it('«в пакете» в хвосте названия тарой товар не делает', () => {
    expect(convertLine(line('Молоко 3,2% 1л в пакете', 10, 'шт', 900, 'л')).quantity).toBe(10);
    expect(convertLine(line('Молоко 3,2% 0,95л в пакете', 10, 'шт', 900, 'л')).quantity).toBeCloseTo(9.5, 3);
  });

  it('масса тары (фасовка «1400гр») пересчитывается', () => {
    expect(convertLine(line('Фасовка СУПЕР ПАК 32*40 1400гр 10пач/упак (1,4кг)', 2, 'шт', 800, 'кг')).quantity).toBeCloseTo(2.8, 3);
  });

  it('кг → шт с мелким весом штуки не делим (стик 14 г, «40 кг» — ошибка единицы)', () => {
    const r = convertLine(line('Кофе Растворимый 3в1 Cappuccino 20*14г', 40, 'кг', 772.4, 'шт'));
    expect(r.quantity).toBe(40);
    expect(r.flag).toBe('unit_mismatch');
  });

  it('дробные «штуки» — уже вес: «Филе 13кг» 348,92 шт → 348,92 кг, а не 4 536', () => {
    const r = convertLine(line('Филе Грудки Куриной Охлажденное 13кг', 348.92, 'шт', 139568, 'кг'));
    expect(r.quantity).toBeCloseTo(348.92, 3);
    expect(r.note).toMatch(/дробное/);
  });

  it('«180г/м2» — плотность, не вес', () => {
    const r = convertLine(line('Полотно холстопрошивное 80см х 50 180г/м2', 1, 'шт', 1972.97, 'кг'));
    expect(r.quantity).toBe(1);
    expect(r.flag).toBe('unit_mismatch');
  });

  it('неправдоподобно дешёвый кг после пересчёта — флаг', () => {
    const r = convertLine(line('Карбонад Свиной без Кости Охл 2,5кг', 2700, 'шт', 7398, 'кг'));
    expect(r.flag).toBe('price_outlier');
  });

  it('латинская x: «10x1кг» 3 кор, 1С в кг → 30 кг', () => {
    expect(convertLine(line('Крупа гречневая 10x1кг', 3, 'кор', 3000, 'кг')).quantity).toBe(30);
  });

  it('граммы в накладной, 1С в кг → масштаб', () => {
    const r = convertLine(line('Специи', 500, 'г', 250, 'кг'));
    expect(r.quantity).toBe(0.5);
    expect(r.source).toBe('scale');
  });

  it('правило поставщика+товара важнее названия', () => {
    const r = convertLine(line('Батон "Нарезной" в/с 0,4 кг', 60, 'шт', 1932, 'кг', { rule: { factor: 0.35, targetUnit: 'кг', source: 'user' } }));
    expect(r.quantity).toBe(21);
    expect(r.source).toBe('rule');
  });

  it('старая упаковка с сопоставления — только если в названии своей меры нет', () => {
    const leaked = convertLine(line('Сметана 20% 3кг', 2, 'шт', 1200, 'кг', { legacyPack: { size: 5, unit: 'кг' } }));
    expect(leaked.quantity).toBe(6); // «3кг» из названия, а не протёкшие 5 кг
    const manual = convertLine(line('Капуста морская', 2, 'шт', 1200, 'кг', { legacyPack: { size: 3, unit: 'кг' } }));
    expect(manual.quantity).toBe(6);
    expect(manual.source).toBe('legacy');
  });

  it('выброс цены после пересчёта помечается', () => {
    const r = convertLine(line('Батон "Нарезной" в/с 0,4 кг', 60, 'шт', 1932, 'кг', { medianPrice: 900 }));
    expect(r.flag).toBe('price_outlier');
  });

  it('инвариант: сумма строки не меняется; повторный вызов от тех же raw даёт тот же результат', () => {
    const inputs: ConvertInput[] = [
      line('Батон "Нарезной" в/с 0,4 кг', 60, 'шт', 1932, 'кг'),
      line('Перчатки 100шт/упак', 2, 'упак', 588, 'шт'),
      line('Горбуша 240г*24', 2, 'кор', 9408, 'кг'),
      line('Печень 4-5кг', 3, 'шт', 5000, 'кг'),
    ];
    for (const inp of inputs) {
      const a = convertLine(inp);
      const b = convertLine(inp);
      expect(a.total).toBe(inp.raw.total);
      expect(b).toEqual(a);
    }
  });

  it('без единицы 1С: упаковки поставщика → «шт», мера не трогается', () => {
    expect(convertLine(line('Салфетки', 3, 'упак', 300, null)).unit).toBe('шт');
    expect(convertLine(line('Сахар', 3, 'кг', 300, null)).unit).toBe('кг');
  });

  it('единица 1С передаётся в написании 1С («л (дм3)»)', () => {
    const r = convertLine(line('Уксус 9% 1л', 6, 'шт', 300, 'л (дм3)'));
    expect(r.unit).toBe('л (дм3)');
    expect(r.quantity).toBe(6);
  });
});
