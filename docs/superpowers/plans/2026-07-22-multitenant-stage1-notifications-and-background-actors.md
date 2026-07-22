# Мультитенантность, этап 1: уведомления и фоновые актёры — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать `userRepo.firstUserId()` как подмену арендатора, чтобы уведомления и фоновые действия выполнялись в контексте владельца накладной, а не первого пользователя.

**Architecture:** Получатель события выводится из `invoice.owner_user_id` (накладная и так загружается внутри `emit()`). Дублирующая логика автоотправки в Сбер из `fileWatcher` и `dispatcher` съезжает в один сервис `src/services/autoSendSber.ts`, который работает под ключом владельца и отказывается отправлять, пока владелец накладной не совпадает с владельцем единственного подключения к Сберу. Схема почти не меняется: одна аддитивная миграция добавляет владельца задачам извлечения реквизитов.

**Tech Stack:** Node.js 25, TypeScript (strict), Express 5, MySQL 9 (`mysql2/promise`), vitest.

**Спека:** [`docs/superpowers/specs/2026-07-22-multitenant-isolation-design.md`](../specs/2026-07-22-multitenant-isolation-design.md), раздел 6.

## Global Constraints

- Тесты **никогда** не коннектятся никуда, кроме `127.0.0.1`, и требуют `test` в `DB_NAME` (правило 17 CLAUDE.md). Гард в `tests/helpers/db.ts` не отключать. Тесты этого плана — модульные на `vi.mock`, к БД не обращаются вовсе.
- Локально `npm test` запускать **нельзя** (`.env` смотрит на боевую базу). Проверка типов — `npx tsc --noEmit`. Тесты — только `DB_NAME=scanflow_test npx vitest run <путь>`.
- Изменения схемы — только новой миграцией в `src/database/migrations.ts`, никогда правкой существующей. Каждая идемпотентна (`hasColumn`-гарды), потому что DDL в MySQL нетранзакционен (правило 16).
- `emit()` в `src/notifications/events.ts` **не должен бросать исключения** ни при каких условиях — все ошибки логируются и глотаются (правило 9).
- Максимальная существующая версия миграции — **46**. Новая — **47**.
- Все репозитории асинхронные: забытый `await` — «невидимый» баг (правило 15).

## File Structure

| Файл | Ответственность | Действие |
|---|---|---|
| `src/notifications/events.ts` | адресация событий владельцу накладной | изменить |
| `src/database/migrations.ts` | миграция 47 — владелец у задач извлечения реквизитов | дополнить |
| `src/database/repositories/supplierExtractJobRepo.ts` | проставление владельца при создании задачи | изменить |
| `src/services/autoSendSber.ts` | единая автоотправка в Сбер в контексте владельца | **создать** |
| `src/watcher/fileWatcher.ts` | убрать локальную копию автоотправки | изменить |
| `src/api/routes/dispatcher.ts` | убрать локальную копию автоотправки, передать владельца | изменить |
| `src/api/routes/invoices.ts` | шаблон назначения платежа из профиля владельца | изменить |
| `src/api/routes/suppliers.ts` | передать владельца из HTTP-контекста | изменить |
| `src/index.ts` | передать владельца из задачи | изменить |
| `tests/notifications/events.owner.test.ts` | получатель события — владелец | **создать** |
| `tests/services/autoSendSber.test.ts` | автоотправка только владельцу подключения | **создать** |

---

### Task 1: Получатель уведомления — владелец накладной

Корневое исправление подтверждённой утечки: скан в одной компании присылал сообщение в Telegram-бот другой.

**Files:**
- Modify: `src/notifications/events.ts:24-48`
- Test: `tests/notifications/events.owner.test.ts` (создать)

**Interfaces:**
- Consumes: `invoiceRepo.getById(id)` → объект с полем `owner_user_id: number | null`; `userRepo.getNotifyConfig(id)`, `userRepo.getTelegramConfig(id)`.
- Produces: сигнатура `emit()` не меняется — `emit(eventType, payload, triggeredByUserId)`. Меняется только правило выбора получателя, поэтому все существующие вызовы с `null` начинают работать правильно без правок.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/notifications/events.owner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/repositories/userRepo', () => ({
  userRepo: {
    firstUserId: vi.fn(async () => 1),
    getNotifyConfig: vi.fn(async () => ({
      email: null, notify_mode: 'realtime', notify_events: ['photo_uploaded'],
    })),
    getTelegramConfig: vi.fn(async () => ({ chat_id: 'chat', bot_token: 'token' })),
  },
}));

vi.mock('../../src/database/repositories/invoiceRepo', () => ({
  invoiceRepo: {
    getById: vi.fn(async () => ({
      id: 10, owner_user_id: 7, invoice_number: '№1', supplier: 'ООО Тест', total_sum: 100,
    })),
  },
}));

vi.mock('../../src/notifications/telegram/telegramNotifier', () => ({
  sendInvoiceNotification: vi.fn(async () => undefined),
}));
vi.mock('../../src/notifications/telegram/telegramClient', () => ({
  sendMessage: vi.fn(async () => undefined),
}));
vi.mock('../../src/utils/mailer', () => ({
  sendNotification: vi.fn(async () => undefined),
  smtpConfigured: () => false,
}));
vi.mock('../../src/notifications/rateLimit', () => ({
  checkAndRecordSend: vi.fn(async () => ({ allow: true, announce: false, sentInWindow: 1 })),
  NOTIFY_HOURLY_CAP: 30,
}));
// Логгер мокаем обязательно: настоящий тянет src/config, а тот грузит dotenv
// побочным эффектом и подставляет боевые DB_*. Тест не должен уметь дотянуться
// до реальной базы даже случайно (правило 17).
vi.mock('../../src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { emit } from '../../src/notifications/events';
import { userRepo } from '../../src/database/repositories/userRepo';
import { sendInvoiceNotification } from '../../src/notifications/telegram/telegramNotifier';

describe('emit(): получатель — владелец накладной', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('берёт получателя из invoice.owner_user_id, а не из первого пользователя', async () => {
    await emit('photo_uploaded', { invoice_id: 10 } as never, null);

    expect(userRepo.getTelegramConfig).toHaveBeenCalledWith(7);
    expect(userRepo.getNotifyConfig).toHaveBeenCalledWith(7);
    expect(userRepo.firstUserId).not.toHaveBeenCalled();
    expect(sendInvoiceNotification).toHaveBeenCalledTimes(1);
  });

  it('ничего не шлёт, если у накладной нет владельца и вызов фоновый', async () => {
    const { invoiceRepo } = await import('../../src/database/repositories/invoiceRepo');
    (invoiceRepo.getById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 11, owner_user_id: null, invoice_number: '№2', supplier: 'X', total_sum: 1,
    });

    await emit('photo_uploaded', { invoice_id: 11 } as never, null);

    expect(sendInvoiceNotification).not.toHaveBeenCalled();
    expect(userRepo.firstUserId).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `DB_NAME=scanflow_test npx vitest run tests/notifications/events.owner.test.ts`
Expected: FAIL — `getTelegramConfig` вызван с `1` вместо `7`, и `firstUserId` вызван.

- [ ] **Step 3: Переставить порядок и сменить правило выбора получателя**

В `src/notifications/events.ts` заменить блок в начале `emit()` (сейчас строки 30-49) на:

```ts
    // Накладная загружается ПЕРВОЙ: получатель выводится из неё.
    const invoice = await invoiceRepo.getById(payload.invoice_id);
    if (!invoice) {
      logger.debug('notifications.emit: invoice not found', { invoiceId: payload.invoice_id });
      return;
    }

    // Получатель — владелец накладной. triggeredByUserId остаётся только
    // подстраховкой для легаси-строк без проставленного владельца.
    //
    // Отката к firstUserId() здесь быть не должно: именно он доставлял события
    // одной компании в Telegram-бот другой (инцидент 2026-07-22).
    const userId = invoice.owner_user_id ?? triggeredByUserId;
    if (userId == null) {
      logger.debug('notifications.emit: invoice has no owner, skipping', {
        eventType, invoiceId: payload.invoice_id,
      });
      return;
    }

    const cfg = await userRepo.getNotifyConfig(userId);
    if (!cfg) {
      logger.debug('notifications.emit: no config row', { eventType, userId });
      return;
    }
    if (!cfg.notify_events.includes(eventType)) {
      logger.debug('notifications.emit: event disabled in config', { eventType, userId });
      return;
    }
```

Удалить старую загрузку накладной ниже (блок `const invoice = await invoiceRepo.getById(...)` вместе с его проверкой `if (!invoice)`), чтобы она не осталась дважды.

Обновить комментарий к параметру над сигнатурой `emit()`:

```ts
// triggeredByUserId: pass req.user?.id when in HTTP context. Background callers
// (file watcher, cron) pass null — the recipient is then the invoice's owner.
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `DB_NAME=scanflow_test npx vitest run tests/notifications/events.owner.test.ts`
Expected: PASS, 2 теста.

- [ ] **Step 5: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода.

- [ ] **Step 6: Коммит**

```bash
git add src/notifications/events.ts tests/notifications/events.owner.test.ts
git commit -m "fix(notifications): address events to the invoice owner, not the first user"
```

---

### Task 2: Владелец у задач извлечения реквизитов (миграция 47)

`supplier_extract_jobs` не знает, чья это задача, поэтому фоновые уведомления о неудачном распознавании реквизитов адресовать некому. Аддитивная колонка, без перестройки ключей.

**Files:**
- Modify: `src/database/migrations.ts` (добавить объект версии 47 в конец массива)
- Modify: `src/database/repositories/supplierExtractJobRepo.ts:20-35`
- Modify: `src/api/routes/suppliers.ts` (передать владельца при создании задачи)

**Interfaces:**
- Produces: `supplierExtractJobRepo.create({ token, file_name, file_path, content_type, owner_user_id })`; строка задачи получает поле `owner_user_id: number | null`, которое Task 3 читает у фоновых вызывающих.

- [ ] **Step 1: Добавить миграцию 47**

В `src/database/migrations.ts`, в конец массива `MIGRATIONS`:

```ts
  {
    version: 47,
    name: 'supplier_extract_jobs.owner_user_id — владелец задачи извлечения реквизитов',
    // Аддитивно и идемпотентно: только nullable-колонка + индекс. Ключи не трогаем.
    detect: async (exec) => hasColumn(exec, 'supplier_extract_jobs', 'owner_user_id'),
    run: async (exec) => {
      if (!(await hasColumn(exec, 'supplier_extract_jobs', 'owner_user_id'))) {
        await exec.query(`ALTER TABLE supplier_extract_jobs ADD COLUMN owner_user_id INT NULL`);
        await exec.query(
          `CREATE INDEX idx_supplier_extract_jobs_owner ON supplier_extract_jobs(owner_user_id)`
        );
      }
    },
  },
```

Бэкфилл не нужен: старые задачи одноразовые и живут минуты; строка без владельца просто не породит уведомление (см. Task 3).

- [ ] **Step 2: Принять владельца в репозитории**

В `src/database/repositories/supplierExtractJobRepo.ts` расширить тип аргумента `create` полем `owner_user_id: number | null` и переписать вставку:

```ts
      `INSERT INTO supplier_extract_jobs (token, file_name, file_path, content_type, status, owner_user_id)
       VALUES (:token, :file_name, :file_path, :content_type, 'processing', :owner_user_id)`
    ).run({
      token: data.token,
      file_name: data.file_name,
      file_path: data.file_path,
      content_type: data.content_type,
      owner_user_id: data.owner_user_id,
    });
```

Также добавить `owner_user_id: number | null` в тип строки, возвращаемой `getById`, чтобы Task 3 мог его прочитать.

- [ ] **Step 3: Передать владельца из HTTP-контекста**

В `src/api/routes/suppliers.ts` в месте вызова `supplierExtractJobRepo.create({...})` добавить поле:

```ts
        owner_user_id: req.user?.id ?? null,
```

- [ ] **Step 4: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода. Если компилятор ругается на отсутствующий `owner_user_id` в других вызовах `create` — добавить его там же по тому же принципу (владелец из `req.user?.id`, иначе `null`).

- [ ] **Step 5: Коммит**

```bash
git add src/database/migrations.ts src/database/repositories/supplierExtractJobRepo.ts src/api/routes/suppliers.ts
git commit -m "feat(db): migration 47 — owner_user_id on supplier_extract_jobs"
```

---

### Task 3: `notifySupplierExtractError` получает владельца явно

**Files:**
- Modify: `src/notifications/events.ts:157-175`
- Modify: `src/api/routes/suppliers.ts:157`
- Modify: `src/api/routes/dispatcher.ts:222`
- Modify: `src/index.ts:177`

**Interfaces:**
- Consumes: `supplierExtractJobRepo.getById(id)` → `{ file_name, owner_user_id }` (из Task 2).
- Produces: `notifySupplierExtractError(fileName: string, errorMessage: string, ownerUserId: number | null): Promise<void>` — третий параметр обязателен, значения по умолчанию нет.

- [ ] **Step 1: Изменить сигнатуру и убрать `firstUserId()`**

В `src/notifications/events.ts` заменить начало функции:

```ts
/**
 * Уведомить владельца о неудачном распознавании реквизитов поставщика.
 * Отдельно от emit(), потому что у задач извлечения нет invoice_id.
 *
 * ownerUserId обязателен и не имеет значения по умолчанию: молчание безопаснее,
 * чем доставка чужой компании. Отката к firstUserId() быть не должно.
 */
export async function notifySupplierExtractError(
  fileName: string,
  errorMessage: string,
  ownerUserId: number | null,
): Promise<void> {
  try {
    if (ownerUserId == null) {
      logger.debug('notifySupplierExtractError: no owner, skipping', { fileName });
      return;
    }
    const userId = ownerUserId;
    const cfg = await userRepo.getNotifyConfig(userId);
```

Остальное тело функции не меняется.

- [ ] **Step 2: Обновить вызывающих**

`src/api/routes/suppliers.ts:157` — владелец известен из запроса:

```ts
      notifySupplierExtractError(req.file.originalname, (err as Error).message, req.user?.id ?? null).catch(() => {});
```

`src/api/routes/dispatcher.ts:222` — владельца берём из задачи:

```ts
    notifySupplierExtractError(job.file_name, msg, job.owner_user_id ?? null).catch(() => {});
```

`src/index.ts:177` — то же, из просроченной задачи:

```ts
          notifySupplierExtractError(j.file_name, 'Диспетчер не ответил в течение 15 минут (таймаут).', j.owner_user_id ?? null).catch(() => {});
```

Если запрос, который выбирает просроченные задачи (`supplierExtractJobRepo`, `SELECT id, file_name FROM supplier_extract_jobs`), не возвращает `owner_user_id` — добавить колонку в список выборки и в тип результата.

- [ ] **Step 3: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода. Компилятор обязан подсветить любой пропущенный третий аргумент — это и есть защита от забытого вызывающего.

- [ ] **Step 4: Коммит**

```bash
git add src/notifications/events.ts src/api/routes/suppliers.ts src/api/routes/dispatcher.ts src/index.ts src/database/repositories/supplierExtractJobRepo.ts
git commit -m "fix(notifications): require an explicit owner for supplier-extract errors"
```

---

### Task 4: Единая автоотправка в Сбер в контексте владельца

Самое опасное место: обе копии берут API-ключ первого админа, поэтому платёж по чужой накладной создаётся от имени и со счёта первой компании. Две копии сводим в один сервис.

**Files:**
- Create: `src/services/autoSendSber.ts`
- Modify: `src/watcher/fileWatcher.ts:187-229` (удалить приватный метод), `:1454` (вызов)
- Modify: `src/api/routes/dispatcher.ts:81-100` (удалить локальную функцию), `:74` (вызов)
- Test: `tests/services/autoSendSber.test.ts` (создать)

**Interfaces:**
- Produces: `autoSendSberForInvoice(invoiceId: number): Promise<void>` — никогда не бросает, все отказы логируются.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/services/autoSendSber.test.ts`:

```ts
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
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as never;
  });

  it('отправляет под ключом владельца накладной', async () => {
    await autoSendSberForInvoice(5);
    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
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
```

- [ ] **Step 2: Запустить тест и убедиться, что он падает**

Run: `DB_NAME=scanflow_test npx vitest run tests/services/autoSendSber.test.ts`
Expected: FAIL — модуль `src/services/autoSendSber` не существует.

- [ ] **Step 3: Создать сервис**

Создать `src/services/autoSendSber.ts`:

```ts
import { getDb } from '../database/db';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
import { userRepo } from '../database/repositories/userRepo';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Владелец единственного подключения к Сберу.
 *
 * ВРЕМЕННО: пока `sber_tokens` — одна строка на всю установку (CHECK (id = 1)),
 * подключение принадлежит начальному админу. Этап 2 добавит
 * `sber_tokens.owner_user_id`, и эта функция станет чтением этой колонки.
 * Это единственное оставшееся законное использование firstUserId() вне бутстрапа,
 * и оно только ОГРАНИЧИВАЕТ отправку, а не расширяет её.
 */
async function sberConnectionOwnerId(): Promise<number | null> {
  return userRepo.firstUserId();
}

/**
 * Loopback POST на /send-sber в контексте ВЛАДЕЛЬЦА накладной — переиспользуем
 * всю валидацию эндпоинта, не дублируя её.
 *
 * Два правила, которые нельзя ослаблять:
 *  1. Ключ — владельца накладной, а не «первого админа»; иначе платёж создаётся
 *     от имени и со счёта другой компании.
 *  2. Пока подключение к Сберу одно на установку, автоотправка разрешена только
 *     компании-владельцу этого подключения; остальные пропускаются.
 *
 * Никогда не бросает: автоотправка не должна ронять конвейер.
 */
export async function autoSendSberForInvoice(invoiceId: number): Promise<void> {
  try {
    const invoice = await invoiceRepo.getById(invoiceId);
    const ownerId = invoice?.owner_user_id ?? null;
    if (ownerId == null) {
      logger.warn('Auto-send Sber: у накладной нет владельца, пропуск', { invoiceId });
      return;
    }

    const connectionOwnerId = await sberConnectionOwnerId();
    if (connectionOwnerId == null || connectionOwnerId !== ownerId) {
      logger.warn('Auto-send Sber: владелец накладной не владеет подключением, пропуск', {
        invoiceId, ownerId, connectionOwnerId,
      });
      return;
    }

    const row = await getDb()
      .prepare('SELECT api_key FROM users WHERE id = ?')
      .get<{ api_key: string }>(ownerId);
    const apiKey = row?.api_key;
    if (!apiKey) {
      logger.warn('Auto-send Sber: у владельца нет api_key', { invoiceId, ownerId });
      return;
    }

    const url = `http://127.0.0.1:${config.apiPort}/api/invoices/${invoiceId}/send-sber`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.ok) {
      const data = (await res.json().catch(() => ({}))) as { payment_number?: string };
      logger.info('Auto-sent to Sber', { invoiceId, ownerId, paymentNumber: data.payment_number ?? null });
    } else {
      const text = await res.text().catch(() => '');
      logger.warn('Auto-send Sber rejected', { invoiceId, status: res.status, body: text.slice(0, 300) });
    }
  } catch (err) {
    logger.warn('Auto-send Sber error', { invoiceId, error: (err as Error).message });
  }
}
```

- [ ] **Step 4: Запустить тест и убедиться, что он проходит**

Run: `DB_NAME=scanflow_test npx vitest run tests/services/autoSendSber.test.ts`
Expected: PASS, 3 теста.

- [ ] **Step 5: Заменить обе копии на сервис**

В `src/watcher/fileWatcher.ts` удалить приватный метод `autoSendSber` целиком (строки 187-229 вместе с doc-комментарием), добавить импорт вверху:

```ts
import { autoSendSberForInvoice } from '../services/autoSendSber';
```

и заменить вызов на строке 1454:

```ts
          await autoSendSberForInvoice(targetInvoiceId);
```

В `src/api/routes/dispatcher.ts` удалить локальную функцию `autoSendSber` целиком (вместе с комментарием «Loopback POST to /send-sber … Admin api_key from DB.»), добавить импорт:

```ts
import { autoSendSberForInvoice } from '../../services/autoSendSber';
```

и заменить вызов на строке 74:

```ts
      await autoSendSberForInvoice(targetInvoiceId);
```

- [ ] **Step 6: Убедиться, что дублей не осталось**

Run: `grep -rn "firstUserId" --include=*.ts src/ | grep -v "userRepo.ts:" | grep -v "services/autoSendSber.ts"`
Expected: только строка из `src/api/routes/invoices.ts` (её чинит Task 5). Ничего в `fileWatcher.ts` и `dispatcher.ts`.

- [ ] **Step 7: Проверить типы и закоммитить**

Run: `npx tsc --noEmit`
Expected: без вывода.

```bash
git add src/services/autoSendSber.ts src/watcher/fileWatcher.ts src/api/routes/dispatcher.ts tests/services/autoSendSber.test.ts
git commit -m "fix(sber): auto-send runs as the invoice owner and only for the connection owner"
```

---

### Task 5: Шаблон назначения платежа — из профиля владельца

Шаблон назначения — профильное, то есть индивидуальное поле (раздел 4.1 спеки). Сейчас в платёжку любой компании подставляется шаблон первого пользователя.

**Files:**
- Modify: `src/api/routes/invoices.ts:1690-1695`

**Interfaces:**
- Consumes: `invoice.owner_user_id` (переменная `invoice` уже загружена выше в обработчике `POST /:id/send-sber`), `userRepo.getPurposeTemplate(id)`.

- [ ] **Step 1: Заменить выбор пользователя на владельца накладной**

В `src/api/routes/invoices.ts` заменить:

```ts
  const purposeOverride = (req.body as { purpose_override?: string }).purpose_override;
  const userId = (await userRepo.firstUserId()) ?? 1;
  const tpl =
    purposeOverride ??
    (await userRepo.getPurposeTemplate(userId)) ??
    'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}';
```

на:

```ts
  const purposeOverride = (req.body as { purpose_override?: string }).purpose_override;
  // Шаблон назначения — профильное (индивидуальное) поле, поэтому берётся у
  // владельца накладной. firstUserId() подставлял сюда шаблон чужой компании.
  const templateOwnerId = invoice.owner_user_id;
  const tpl =
    purposeOverride ??
    (templateOwnerId != null ? await userRepo.getPurposeTemplate(templateOwnerId) : null) ??
    'Оплата по накладной № {invoice_number} от {invoice_date_dot}, {vat_clause}';
```

- [ ] **Step 2: Убедиться, что `firstUserId` больше не используется вне бутстрапа**

Run: `grep -rn "firstUserId" --include=*.ts src/ | grep -v "userRepo.ts:"`
Expected: единственная строка — в `src/services/autoSendSber.ts` (документированное временное использование из Task 4).

- [ ] **Step 3: Проверить, что импорт `userRepo` в invoices.ts всё ещё нужен**

Run: `grep -n "userRepo\." src/api/routes/invoices.ts`
Expected: остаётся как минимум вызов `getPurposeTemplate`. Если больше ничего нет — импорт не трогать, он используется.

- [ ] **Step 4: Проверить типы**

Run: `npx tsc --noEmit`
Expected: без вывода.

- [ ] **Step 5: Коммит**

```bash
git add src/api/routes/invoices.ts
git commit -m "fix(sber): take the payment purpose template from the invoice owner's profile"
```

---

### Task 6: Прогон и выкатка

**Files:** нет изменений кода — только проверка.

- [ ] **Step 1: Прогнать оба новых набора тестов**

Run: `DB_NAME=scanflow_test npx vitest run tests/notifications/events.owner.test.ts tests/services/autoSendSber.test.ts`
Expected: PASS, 5 тестов.

- [ ] **Step 2: Полная проверка типов**

Run: `npx tsc --noEmit`
Expected: без вывода.

- [ ] **Step 3: Убедиться, что миграция идемпотентна**

Прочитать объект версии 47 и проверить: `detect()` возвращает true при уже добавленной колонке, а `run()` защищён тем же `hasColumn`. Повторный прогон на применённой базе не должен падать.

- [ ] **Step 4: Выкатка**

```bash
git push origin HEAD:main
```

Деплой идёт автоматически через GitHub Actions. Миграция 47 применяется на старте процесса.

- [ ] **Step 5: Проверка на проде**

Отсканировать накладную под второй компанией и убедиться, что уведомление пришло **в её** бот, а в бот первой компании — нет. В логах (`pm2 logs scanflow`) не должно быть строк `Auto-send Sber` для чужих владельцев.

---

## Что этот план сознательно НЕ делает

Остаётся на этап 2 (отдельный план) — справочники всё ещё общие:

- `suppliers`, `onec_nomenclature`, `nomenclature_mappings`, `nomenclature_price_stats`, `supplier_nomenclature_mappings` — без владельца, видны всем компаниям.
- `sber_tokens` — одна строка на установку; поэтому Task 4 вынужденно ограничивает автоотправку владельцем подключения вместо честной пер-тенантной проверки.
- `NomenclatureMapper` — общий кэш каталога в памяти.
- `DATA_SCOPING_ENABLED` и сквозной доступ роли `admin` — снимаются на этапе 2.
