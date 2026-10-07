import { describe, it, expect } from 'vitest';
import { convertLine, eggPieceGrams } from '../../src/mapping/unitConverter';

// «Всё в килограммах» (решение владельца 2026-10-07): каждая строка в кг — вес из
// названия, литры = кг, яйца по весу категории. Нет веса — строка ждёт ввода.
const kg = (name: string, quantity: number, unit: string, total: number) =>
  convertLine({ name, raw: { quantity, unit, price: Math.round((total / quantity) * 100) / 100, total }, onecUnit: 'кг', forcedTarget: true });

describe('eggPieceGrams — вес яйца по категории', () => {
  it('С3 35 г, С2 45 г, С1 55 г, СО 65 г, СВ 75 г', () => {
    expect(eggPieceGrams('Яйцо куриное С3')).toBe(35);
    expect(eggPieceGrams('Яйцо куриное С2 10шт')).toBe(45);
    expect(eggPieceGrams('Яйцо Куриное Коричневое С1 360шт')).toBe(55);
    expect(eggPieceGrams('Яйцо куриное СО столовое')).toBe(65);
    expect(eggPieceGrams('ЯЙЦО КУРИНОЕ СВ')).toBe(75);
  });
  it('написания, которые путает чтение фото: ноль, латиница, дефис; диетические Д', () => {
    expect(eggPieceGrams('Яйцо куриное С0')).toBe(65);
    expect(eggPieceGrams('Яйцо куриное CO')).toBe(65);   // латинские C и O
    expect(eggPieceGrams('Яйцо куриное CB')).toBe(75);   // латинские C и B
    expect(eggPieceGrams('Яйцо куриное С-1')).toBe(55);
    expect(eggPieceGrams('Яйцо куриное диетическое Д1')).toBe(55);
  });
  it('не яйцо, перепелиные и без категории — null', () => {
    expect(eggPieceGrams('Масло сливочное С1')).toBeNull();
    expect(eggPieceGrams('Яйцо перепелиное С1 20шт')).toBeNull();
    expect(eggPieceGrams('Яйцо куриное 360шт')).toBeNull();
    expect(eggPieceGrams('Яйцо куриное столовое 1 категории')).toBeNull();
  });
});

describe('convertLine с правилом «всё в кг»', () => {
  it('яйца поштучно: 1080 шт С1 → 59,4 кг, сумма та же', () => {
    const r = kg('Яйцо Куриное Коричневое С1 360шт', 1080, 'шт', 7560);
    expect(r).toMatchObject({ quantity: 59.4, unit: 'кг', total: 7560 });
    expect(r.price).toBeCloseTo(127.2727, 3);
    expect(r.note).toContain('вес яйца по категории');
  });
  it('яйца коробами: 3 кор × 360 × 55 г = 59,4 кг', () => {
    expect(kg('Яйцо С1 360шт', 3, 'кор', 7560)).toMatchObject({ quantity: 59.4, unit: 'кг' });
  });
  it('лоток записан одной «штукой» — по правдоподобию цены это 360 яиц', () => {
    const r = kg('Яйцо Куриное Коричневое С1 360шт', 1, 'шт', 3405.6);
    expect(r).toMatchObject({ quantity: 19.8, unit: 'кг', source: 'price_fit' });
  });
  it('вода в бутылках: литры = кг', () => {
    expect(kg('Вода питьевая негазированная 1,5л ПЭТ', 24, 'шт', 960)).toMatchObject({ quantity: 36, unit: 'кг', price: 26.6667 });
  });
  it('сухой вес — только когда другого веса нет (решение владельца)', () => {
    expect(kg('Опята консервированные 3,1л сух. вес 1,8кг', 3, 'шт', 2310)).toMatchObject({ quantity: 5.4, unit: 'кг' });
    expect(kg('Огурчики 9-12 "Праздничные" маринов. 7,5 кг (сух.вес 4кг) Добросот', 4, 'упак', 3832)).toMatchObject({ quantity: 30 });
  });
  it('рядом с «N×мера» напечатан вес всей упаковки — штука накладной это упаковка (УПД 17-0605773)', () => {
    // было: 20 шт × 60 г = 1,2 кг (6 801 ₽/кг) и 5 шт × 130 г = 0,65 кг (11 269 ₽/кг)
    expect(kg('Котлеты Черкизово Пф-60 Foodservice Куриные Рубленые в Панировке 16*60г 960г', 20, 'шт', 8161.8))
      .toMatchObject({ quantity: 19.2, unit: 'кг', total: 8161.8, flag: null });
    expect(kg('Чизкейк Smart Chef Клубничный Премиум Пирог Открытый 12*130г 1,56кг', 5, 'шт', 7325))
      .toMatchObject({ quantity: 7.8, unit: 'кг', flag: null });
    expect(kg('Чизкейк Smart Chef Классический Нью Йорк Пирог Открытый 12*130г 1,56 кг', 2, 'шт', 2397.7))
      .toMatchObject({ quantity: 3.12, unit: 'кг' });
    // «мера × N» с итогом — так же; без итога «245г*48» за 1 упак — прежний расчёт (ВМ-1582)
    expect(kg('Сосиски 50г*20 1кг', 3, 'шт', 900)).toMatchObject({ quantity: 3 });
    expect(kg('Горбуша нат. 245г*48 ГОСТ', 1, 'упак', 7680)).toMatchObject({ quantity: 11.76 });
    // итог не сходится с N × мера — это не вес упаковки, остаётся вес штуки
    expect(kg('Набор 10*50г 2кг', 4, 'шт', 400)).toMatchObject({ quantity: 0.2 });
  });
  it('веса нет — строка как напечатана, пометка «нужен вес»', () => {
    const r = kg('Веник 10шт/упак ЛЮКС (пятилучевой)', 5, 'шт', 644);
    expect(r).toMatchObject({ quantity: 5, unit: 'шт', total: 644, flag: 'needs_weight', source: 'none' });
    expect(r.flagNote).toContain('укажите вес в кг');
    // Тара: объём бутылки — вместимость, а не вес.
    expect(kg('Бутылка ПЭТ 0,3л Прозрачная d-38мм 150шт/упак', 4, 'упак', 3622.08)).toMatchObject({ unit: 'упак', flag: 'needs_weight' });
  });
  it('без правила (единица от позиции 1С) — прежняя пометка «единица не как в 1С»', () => {
    const r = convertLine({ name: 'Веник 10шт/упак', raw: { quantity: 5, unit: 'шт', price: 128.8, total: 644 }, onecUnit: 'кг' });
    expect(r.flag).toBe('unit_mismatch');
  });
});

describe('счёт ВМ-1582 (Вкусный мир) — как владелец завёл в 1С', () => {
  const lines: Array<[string, number, number, number]> = [
    ['Масло подсол. "Южный полюс" 1л раф/дез. ГОСТ 1/15', 4, 8160, 60],
    ['Соль "Полесье" Экстра 1кг 1/12', 2, 672, 24],
    ['Томатная паста "Tabiat" 800г, брикс 26,5-28,5%, 1/12, ж/б', 1, 1512, 9.6],
    ['Крупа "Гречневая" 5кг (Винол)', 2, 576, 10],
    ['Масло фритюрное "Gaspar food master" 5л 1/2', 3, 4788, 30],
    ['Крупа "Горох" 900г 1/10 (Акра)', 1, 446, 9],
    ['Горбуша нат. 245г*48 ГОСТ ООО "Вяземский РК"', 1, 7680, 11.76],
    ['Уксус столовый 9% 1л (ТМ Боген, ГОСТ Р) пл/бут, 1/12', 1, 438, 12],
    ['Огурчики 9-12 "Праздничные" маринов. 7,5 кг (сух.вес 4кг) Добросот', 4, 3832, 30],
    ['Маслины "Донская кухня" 280г без косточки, 1/12', 1, 887.64, 3.36],
    ['Кукуруза Ekoland 340г, ж/б, 1/24', 1, 1608, 8.16],
    ['Перец меланж кубик 10кг', 1, 1700, 10],
  ];
  it.each(lines)('%s → %d упак → кг как в 1С', (name, qty, total, want) => {
    const r = kg(name, qty, 'упак', total);
    expect(r.unit).toBe('кг');
    expect(r.quantity).toBeCloseTo(want, 3);
    expect(r.total).toBe(total);
    expect(r.flag).toBeNull();
  });
});
