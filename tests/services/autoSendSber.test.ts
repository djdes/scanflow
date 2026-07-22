import { describe, it, expect, vi, beforeEach } from 'vitest';

const getMock = vi.fn(async () => ({ api_key: 'key-of-owner' }));
vi.mock('../../src/database/db', () => ({
  getDb: () => ({ prepare: () => ({ get: getMock }) }),
}));
vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: { getById: vi.fn(async () => ({ id: 5, owner_user_id: 7 })) },
}));
vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: { firstUserId: vi.fn(async () => 7) },
}));
// config и logger мокаем обязательно: настоящий src/config грузит dotenv
// побочным эффектом и подставляет боевые DB_*. Тест не должен уметь дотянуться
// до реальной базы даже случайно (правило 17).
vi.mock('../../src/config', () => ({ config: { apiPort: 8899 } }));
vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { autoSendSberForInvoice } from '../../src/services/autoSendSber';
import { invoiceRepo } from '../../src/database/repositories/invoiceRepo';
import { userRepo } from '../../src/database/repositories/userRepo';

describe('autoSendSberForInvoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMock.mockResolvedValue({ api_key: 'key-of-owner' });
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as never;
  });

  it('отправляет под ключом владельца накладной', async () => {
    await autoSendSberForInvoice(5);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const init = call[1] as { headers: Record<string, string> };
    expect(init.headers['X-API-Key']).toBe('key-of-owner');
  });

  it('не отправляет, если владелец накладной не владеет подключением к Сберу', async () => {
    (userRepo.firstUserId as ReturnType<typeof vi.fn>).mockResolvedValueOnce(99);

    await autoSendSberForInvoice(5);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('не отправляет, если у накладной нет владельца', async () => {
    (invoiceRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 5, owner_user_id: null });

    await autoSendSberForInvoice(5);

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
