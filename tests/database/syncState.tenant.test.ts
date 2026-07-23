import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resetDb, closeTestDb } from '../helpers/db';
import { getDb } from '../../src/database/db';
import { syncStateRepo } from '../../src/database/repositories/syncStateRepo';
import { webhookConfigRepo } from '../../src/database/repositories/webhookConfigRepo';

// Обе таблицы были синглтонами на всю установку:
//   * integration_sync_state — CHECK (id = 1), одна строка. Новая позиция в
//     накладной одной компании поднимала флаг «выгрузи каталог» в базе 1С
//     другой, то есть чужая 1С начинала слать свой справочник.
//   * webhook_config — формально AUTO_INCREMENT, но весь код читал WHERE id = 1.
//     Две компании, настроившие вебхук, перетирали друг другу URL и токен
//     авторизации, и накладные уходили в чужую базу.
// Миграция 54 разводит их по компаниям через integration_sync_state_cards и
// webhook_config_cards с UNIQUE (owner_user_id).
describe.runIf((process.env.DB_NAME || '').includes('test'))('sync-state и вебхук: изоляция между компаниями', () => {
  let companyA = 0;
  let companyB = 0;

  async function makeUser(username: string, role: string): Promise<number> {
    const res = await getDb()
      .prepare(
        `INSERT INTO users (username, password_hash, api_key, role, notify_events)
         VALUES (?, 'x', ?, ?, '[]')`
      )
      .run(username, `key-${username}`, role);
    return Number(res.lastInsertRowid);
  }

  beforeEach(async () => {
    await resetDb();
    companyA = await makeUser('company-a', 'admin');
    companyB = await makeUser('company-b', 'user');
  });

  afterAll(async () => { await closeTestDb(); });

  // --- флаг выгрузки каталога 1С ---

  it('флаг одной компании не виден другой', async () => {
    await syncStateRepo.markNomenclatureSyncRequested(companyA);

    expect((await syncStateRepo.getNomenclatureSyncState(companyA)).requested).toBe(true);
    expect((await syncStateRepo.getNomenclatureSyncState(companyB)).requested).toBe(false);
    expect((await syncStateRepo.getNomenclatureSyncState(companyB)).since).toBeNull();
  });

  it('роль admin не даёт видеть чужой флаг', async () => {
    // companyA заведена админом — сквозного доступа к состоянию Б всё равно нет.
    await syncStateRepo.markNomenclatureSyncRequested(companyB);
    expect((await syncStateRepo.getNomenclatureSyncState(companyA)).requested).toBe(false);
  });

  it('обе компании держат свой флаг независимо', async () => {
    await syncStateRepo.markNomenclatureSyncRequested(companyA);
    await syncStateRepo.markNomenclatureSyncRequested(companyB);

    expect((await syncStateRepo.getNomenclatureSyncState(companyA)).requested).toBe(true);
    expect((await syncStateRepo.getNomenclatureSyncState(companyB)).requested).toBe(true);
  });

  it('сброс флага у одной компании не гасит флаг другой', async () => {
    await syncStateRepo.markNomenclatureSyncRequested(companyA);
    await syncStateRepo.markNomenclatureSyncRequested(companyB);

    const stateA = await syncStateRepo.getNomenclatureSyncState(companyA);
    const cleared = await syncStateRepo.clearNomenclatureSync(stateA.since as string, companyA);

    expect(cleared.cleared).toBe(true);
    expect((await syncStateRepo.getNomenclatureSyncState(companyA)).requested).toBe(false);
    expect((await syncStateRepo.getNomenclatureSyncState(companyB)).requested).toBe(true);
  });

  it('сброс с чужим since не гасит свой флаг', async () => {
    await syncStateRepo.markNomenclatureSyncRequested(companyA);
    // Б флаг не поднимала: её попытка сброса не должна ничего изменить у А.
    const res = await syncStateRepo.clearNomenclatureSync('2000-01-01 00:00:00', companyB);
    expect(res.cleared).toBe(false);
    expect((await syncStateRepo.getNomenclatureSyncState(companyA)).requested).toBe(true);
  });

  // --- настройки легаси-вебхука 1С ---

  it('настройка вебхука одной компании не перетирает другую', async () => {
    await webhookConfigRepo.upsert(
      { url: 'https://a.example/1c', enabled: 1, auth_token: 'token-a', auto_send_1c: 1 },
      companyA,
    );
    await webhookConfigRepo.upsert(
      { url: 'https://b.example/1c', enabled: 1, auth_token: 'token-b', auto_send_1c: 0 },
      companyB,
    );

    const a = await webhookConfigRepo.get(companyA);
    const b = await webhookConfigRepo.get(companyB);
    expect(a?.url).toBe('https://a.example/1c');
    expect(b?.url).toBe('https://b.example/1c');
    expect(a?.auth_token).not.toBe(b?.auth_token);
  });

  it('компания без вебхука не видит чужой', async () => {
    await webhookConfigRepo.upsert(
      { url: 'https://a.example/1c', enabled: 1, auth_token: 'token-a', auto_send_1c: 1 },
      companyA,
    );
    expect(await webhookConfigRepo.get(companyB)).toBeNull();
    expect(await webhookConfigRepo.autoSend1cEnabled(companyB)).toBe(false);
  });

  it('повторный upsert правит только свою строку', async () => {
    await webhookConfigRepo.upsert(
      { url: 'https://a.example/1c', enabled: 1, auth_token: 'token-a', auto_send_1c: 1 },
      companyA,
    );
    await webhookConfigRepo.upsert(
      { url: 'https://b.example/1c', enabled: 1, auth_token: 'token-b', auto_send_1c: 1 },
      companyB,
    );

    await webhookConfigRepo.upsert(
      { url: 'https://a2.example/1c', enabled: 0, auth_token: null, auto_send_1c: 0 },
      companyA,
    );

    const a = await webhookConfigRepo.get(companyA);
    const b = await webhookConfigRepo.get(companyB);
    expect(a?.url).toBe('https://a2.example/1c');
    expect(a?.enabled).toBe(0);
    expect(a?.auth_token).toBeNull();
    expect(b?.url).toBe('https://b.example/1c');
    expect(b?.enabled).toBe(1);
    expect(b?.auth_token).toBe('token-b');
  });

  it('легаси-флаг автоотправки в 1С читается только за свою компанию', async () => {
    await webhookConfigRepo.upsert(
      { url: 'https://a.example/1c', enabled: 1, auth_token: null, auto_send_1c: 1 },
      companyA,
    );
    await webhookConfigRepo.upsert(
      { url: 'https://b.example/1c', enabled: 1, auth_token: null, auto_send_1c: 0 },
      companyB,
    );

    expect(await webhookConfigRepo.autoSend1cEnabled(companyA)).toBe(true);
    expect(await webhookConfigRepo.autoSend1cEnabled(companyB)).toBe(false);
  });
});
