import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/utils/mailer', () => ({ sendMail: vi.fn(), sendErrorEmail: vi.fn() }));

import { aggregateRootCauses, rootCauseName } from '../../src/api/routes/operations';

describe('operations root causes', () => {
  it('groups reasons by name without the count after the colon', () => {
    expect(rootCauseName('Не сопоставлено: 3')).toBe('Не сопоставлено');
    expect(rootCauseName('Ошибка 1С: нет склада')).toBe('Ошибка 1С');
    expect(rootCauseName('Поставщик не подтверждён')).toBe('Поставщик не подтверждён');
  });

  it('counts each invoice once per reason and shows human document types', () => {
    const r = aggregateRootCauses([
      { reasons: ['Не сопоставлено: 3', 'Низкая точность сопоставления'], supplier: 'A', invoice_type: 'упд' },
      { reasons: ['Не сопоставлено: 4'], supplier: 'B', invoice_type: 'торг_12' },
      { reasons: ['Не сопоставлено: 1'], supplier: null, invoice_type: 'упд' },
    ]);
    expect(r.by_reason[0]).toEqual({ name: 'Не сопоставлено', count: 3 });
    expect(r.by_document_type).toEqual([{ name: 'УПД', count: 2 }, { name: 'ТОРГ-12', count: 1 }]);
  });
});
