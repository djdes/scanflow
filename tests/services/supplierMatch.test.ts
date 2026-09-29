import { describe, it, expect, vi, beforeEach } from 'vitest';

// Репозитории замоканы: сопоставление названий — чистая логика, а привязку
// проверяем по вызовам setSupplierLink/setSupplierMatch. БД не нужна.
vi.mock('../../src/database/repositories/supplierRepo', () => ({
  supplierRepo: { findByInn: vi.fn(), listAll: vi.fn() },
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { getById: vi.fn(), setSupplierLink: vi.fn(), setSupplierMatch: vi.fn() },
}));

import { supplierRepo, type Supplier } from '../../src/database/repositories/supplierRepo';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import {
  supplierCoreName,
  supplierNameScore,
  rankSuppliersByName,
  pickAutoLinkCandidate,
  dropInvalidInnTwins,
  linkApprovedSupplier,
  AUTO_LINK_MIN_SCORE,
} from '../../src/services/supplierMatch';

function card(inn: string, name: string, verified = 1): Supplier {
  return {
    id: Number(inn.slice(-4)), owner_user_id: 1, inn, name, kpp: null, account: '40702810000000000001',
    bank_bic: '044525225', bank_corr_account: null, bank_name: null, address: null, verified,
    source: 'manual', notes: null, created_at: '', updated_at: '', last_used_at: null,
    verification_source: null, verified_at: null, verification_fingerprint: null, verification_risk: null,
  };
}

describe('supplierCoreName — название без ОПФ', () => {
  it('убирает ООО/ИП/АО, кавычки, регистр и пробелы', () => {
    expect(supplierCoreName('ООО "Свит Лайф Фудсервис"')).toBe('свитлайффудсервис');
    expect(supplierCoreName('Свит Лайф Фудсервис')).toBe('свитлайффудсервис');
    expect(supplierCoreName('Общество с ограниченной ответственностью «Свит Лайф Фудсервис»')).toBe('свитлайффудсервис');
    expect(supplierCoreName('ИП Кнутова Александра Сергеевна')).toBe('кнутоваалександрасергеевна');
    expect(supplierCoreName('АО "Тандер"')).toBe('тандер');
  });

  it('понимает OCR-двойники: латинское OOO, «000», латиница внутри слова', () => {
    expect(supplierCoreName('OOO "CВИТ ЛАЙФ"')).toBe('свитлайф');
    expect(supplierCoreName('000 Свит Лайф')).toBe('свитлайф');
  });

  it('не вырезает ОПФ из середины слова («Липецк», «Паоло»)', () => {
    expect(supplierCoreName('ООО Липецкмолоко')).toBe('липецкмолоко');
    expect(supplierCoreName('Паоло')).toBe('паоло');
  });
});

describe('supplierNameScore', () => {
  it('1 — одинаковые без учёта ОПФ', () => {
    expect(supplierNameScore('ООО "Свит Лайф Фудсервис"', 'Свит Лайф Фудсервис')).toBe(1);
  });

  it('OCR-опечатка в длинном названии — выше порога автопривязки', () => {
    expect(supplierNameScore('ООО "Свит Лаиф Фудсервис"', 'Свит Лайф Фудсервис')).toBeGreaterThanOrEqual(AUTO_LINK_MIN_SCORE);
  });

  it('ИП с инициалами ≡ полное ФИО', () => {
    expect(supplierNameScore('ИП Кнутова А.С.', 'ИП Кнутова Александра Сергеевна')).toBeGreaterThanOrEqual(AUTO_LINK_MIN_SCORE);
  });

  it('разные компании с общим первым словом не совпадают', () => {
    expect(supplierNameScore('Свит Лайф Фудсервис', 'Свит Лимонад')).toBeLessThan(0.6);
    expect(supplierNameScore('ИП Иванов Иван', 'ИП Иванов Игорь')).toBeLessThan(AUTO_LINK_MIN_SCORE);
  });

  it('название с «хвостом» — только подсказка, не автопривязка', () => {
    const s = supplierNameScore('Фудсервис', 'Фудсервис Плюс Регион');
    expect(s).toBeGreaterThan(0.6);
    expect(s).toBeLessThan(AUTO_LINK_MIN_SCORE);
  });

  it('0 для пустых', () => {
    expect(supplierNameScore('', 'Свит')).toBe(0);
    expect(supplierNameScore('ООО', 'ООО')).toBe(0);
  });
});

describe('rankSuppliersByName / pickAutoLinkCandidate', () => {
  const cards = [
    card('5258005002', 'ООО "Свит Лайф Фудсервис"'),
    card('7700000001', 'ООО "Тандер"'),
    card('7700000002', 'ИП Кнутова Александра Сергеевна'),
  ];

  it('лучший кандидат первым, мусор отсечён', () => {
    const r = rankSuppliersByName('СВИТ ЛАЙФ ФУДСЕРВИС ООО', cards);
    expect(r.map(c => c.supplier.inn)).toEqual(['5258005002']);
    expect(pickAutoLinkCandidate(r)?.supplier.inn).toBe('5258005002');
  });

  it('две близкие карточки с разными ИНН — без автопривязки', () => {
    const twins = [card('1111111111', 'ООО "Ромашка"'), card('2222222222', 'ИП Ромашка')];
    const r = rankSuppliersByName('Ромашка', twins);
    expect(r).toHaveLength(2);
    expect(pickAutoLinkCandidate(r)).toBeNull();
  });
});

describe('linkApprovedSupplier', () => {
  const inv = (over: Record<string, unknown>) => ({
    id: 10, owner_user_id: 1, supplier: 'ООО "Свит Лайф Фудсервис"', supplier_inn: '5258009999',
    supplier_match: null, supplier_inn_ocr: null, supplier_name_ocr: null, ...over,
  });

  beforeEach(() => { vi.clearAllMocks(); });

  it('ИНН с фото есть в справочнике — привязка по ИНН, по названию не ищем', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue(inv({ supplier_inn: '5258005002' }) as never);
    vi.mocked(supplierRepo.findByInn).mockResolvedValue(card('5258005002', 'ООО "Свит Лайф Фудсервис"'));
    const r = await linkApprovedSupplier(10);
    expect(r.match).toBe('inn');
    expect(invoiceRepo.setSupplierMatch).toHaveBeenCalledWith(10, 'inn');
    expect(supplierRepo.listAll).not.toHaveBeenCalled();
    expect(invoiceRepo.setSupplierLink).not.toHaveBeenCalled();
  });

  it('ИНН с фото нет в справочнике — берёт карточку по названию и помнит, что было на фото', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue(inv({}) as never);
    vi.mocked(supplierRepo.findByInn).mockResolvedValue(null);
    vi.mocked(supplierRepo.listAll).mockResolvedValue([card('5258005002', 'Свит Лайф Фудсервис'), card('7700000001', 'Тандер')]);
    const r = await linkApprovedSupplier(10);
    expect(r.match).toBe('name');
    expect(invoiceRepo.setSupplierLink).toHaveBeenCalledWith(10, {
      supplier: 'Свит Лайф Фудсервис',
      supplier_inn: '5258005002',
      match: 'name',
      supplier_inn_ocr: '5258009999',
      supplier_name_ocr: 'ООО "Свит Лайф Фудсервис"',
    });
  });

  it('неподтверждённые карточки для автопривязки не используются', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue(inv({ supplier_inn: null }) as never);
    vi.mocked(supplierRepo.listAll).mockResolvedValue([card('5258005002', 'Свит Лайф Фудсервис', 0)]);
    const r = await linkApprovedSupplier(10);
    expect(r.match).toBeNull();
    expect(invoiceRepo.setSupplierLink).not.toHaveBeenCalled();
  });

  it('ручную привязку и привязку по названию не перезаписывает', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue(inv({ supplier_match: 'manual' }) as never);
    const r = await linkApprovedSupplier(10);
    expect(r.match).toBe('manual');
    expect(supplierRepo.findByInn).not.toHaveBeenCalled();
    expect(invoiceRepo.setSupplierLink).not.toHaveBeenCalled();
  });

  it('накладная без владельца — справочник не трогаем', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue(inv({ owner_user_id: null }) as never);
    const r = await linkApprovedSupplier(10);
    expect(r.match).toBeNull();
    expect(supplierRepo.findByInn).not.toHaveBeenCalled();
  });

  it('никогда не бросает', async () => {
    vi.mocked(invoiceRepo.getById).mockRejectedValue(new Error('db down'));
    await expect(linkApprovedSupplier(10)).resolves.toEqual({ match: null, supplier: null });
  });
});

// Реальный случай 29.09: две подтверждённые карточки «Вкусный мир ТК» —
// верная 7724357632 и двойник 7724357832 (OCR перепутал цифру, ИНН не проходит
// контрольную сумму). Раньше одинаковое название с разными ИНН блокировало
// автопривязку, а накладная с ИНН-опечаткой цеплялась к двойнику.
describe('двойники с невалидным ИНН', () => {
  const GOOD = '7724357632';
  const TYPO = '7724357832';
  const good = card(GOOD, 'ООО "Вкусный мир ТК"');
  const typo = card(TYPO, 'ООО "Вкусный мир ТК"');

  beforeEach(() => { vi.resetAllMocks(); });

  it('rankSuppliersByName отбрасывает двойника с битым ИНН', () => {
    const r = rankSuppliersByName('ВКУСНЫЙ МИР ТК ООО', [typo, good]);
    expect(r.map(c => c.supplier.inn)).toEqual([GOOD]);
  });

  it('pickAutoLinkCandidate берёт верную карточку, а не отказывается от выбора', () => {
    const r = pickAutoLinkCandidate([{ supplier: typo, score: 1 }, { supplier: good, score: 1 }]);
    expect(r?.supplier.inn).toBe(GOOD);
  });

  it('карточка с битым ИНН без верного двойника остаётся кандидатом', () => {
    expect(rankSuppliersByName('Вкусный мир ТК', [typo]).map(c => c.supplier.inn)).toEqual([TYPO]);
    expect(pickAutoLinkCandidate(rankSuppliersByName('Вкусный мир ТК', [typo]))?.supplier.inn).toBe(TYPO);
  });

  it('битый ИНН у поставщика с другим названием не выбрасывается', () => {
    const other = card('5258006806', 'ООО "Ромашка"'); // ИНН не проходит проверку
    const r = dropInvalidInnTwins([{ supplier: good, score: 1 }, { supplier: other, score: 0.7 }]);
    expect(r.map(c => c.supplier.inn)).toEqual([GOOD, '5258006806']);
  });

  it('linkApprovedSupplier: ИНН с фото нашёл двойника — привязка к верной карточке по названию', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue({
      id: 10, owner_user_id: 1, supplier: 'ВКУСНЫЙ МИР ТК', supplier_inn: TYPO,
      supplier_match: null, supplier_inn_ocr: null, supplier_name_ocr: null,
    } as never);
    vi.mocked(supplierRepo.findByInn).mockResolvedValue(typo);
    vi.mocked(supplierRepo.listAll).mockResolvedValue([typo, good]);

    const r = await linkApprovedSupplier(10);

    expect(r).toEqual({ match: 'name', supplier: good });
    expect(invoiceRepo.setSupplierLink).toHaveBeenCalledWith(10, {
      supplier: 'ООО "Вкусный мир ТК"',
      supplier_inn: GOOD,
      match: 'name',
      supplier_inn_ocr: TYPO,
      supplier_name_ocr: 'ВКУСНЫЙ МИР ТК',
    });
    expect(invoiceRepo.setSupplierMatch).not.toHaveBeenCalled();
  });

  it('linkApprovedSupplier: у двойника нет верной подтверждённой пары — прежняя привязка по ИНН', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue({
      id: 10, owner_user_id: 1, supplier: 'Вкусный мир ТК', supplier_inn: TYPO, supplier_match: null,
    } as never);
    vi.mocked(supplierRepo.findByInn).mockResolvedValue(typo);
    // Верная карточка есть, но не подтверждена — подменять ею нельзя.
    vi.mocked(supplierRepo.listAll).mockResolvedValue([typo, card(GOOD, 'ООО "Вкусный мир ТК"', 0)]);

    const r = await linkApprovedSupplier(10);

    expect(r).toEqual({ match: 'inn', supplier: typo });
    expect(invoiceRepo.setSupplierMatch).toHaveBeenCalledWith(10, 'inn');
    expect(invoiceRepo.setSupplierLink).not.toHaveBeenCalled();
  });

  it('linkApprovedSupplier не бросает, если запись привязки к двойнику упала', async () => {
    vi.mocked(invoiceRepo.getById).mockResolvedValue({
      id: 10, owner_user_id: 1, supplier: 'Вкусный мир ТК', supplier_inn: TYPO, supplier_match: null,
    } as never);
    vi.mocked(supplierRepo.findByInn).mockResolvedValue(typo);
    vi.mocked(supplierRepo.listAll).mockResolvedValue([typo, good]);
    vi.mocked(invoiceRepo.setSupplierLink).mockRejectedValue(new Error('db down'));

    await expect(linkApprovedSupplier(10)).resolves.toEqual({ match: null, supplier: null });
  });
});
