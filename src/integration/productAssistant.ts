import { productAssistantRepo, ProductAssistantConnection } from '../database/repositories/productAssistantRepo';
import { openSecret, sealSecret } from '../sber/secretBox';

export class ProductAssistantError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type AssistantData = Record<string, unknown>;

export function object(value: unknown): value is AssistantData {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Explicit server-side destinations: a tenant cannot turn the proxy into a
// network scanner or send a saved credential to an arbitrary host/redirect.
export function allowedAssistantOrigins(): string[] {
  return (process.env.PRODUCT_ASSISTANT_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean)
    .flatMap(x => { try { return [new URL(x).origin]; } catch { return []; } });
}

export function assistantBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500) throw new ProductAssistantError(400, 'Укажите адрес API помощника');
  let url: URL;
  try { url = new URL(value); } catch { throw new ProductAssistantError(400, 'Некорректный адрес API'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ProductAssistantError(400, 'Нужен HTTP(S)-адрес API без пароля и параметров');
  }
  if (!allowedAssistantOrigins().includes(url.origin)) {
    throw new ProductAssistantError(400, 'Адрес помощника должен быть добавлен администратором сервера в PRODUCT_ASSISTANT_ALLOWED_ORIGINS');
  }
  return url.href.replace(/\/+$/, '');
}

export function assistantPublicConfig(row: ProductAssistantConnection | null) {
  return { enabled: !!row?.enabled, label: row?.label || 'Помощник по товарам',
    api_base_url: row?.api_base_url || '', token_set: !!row?.api_token_enc, protocol_version: 1 };
}

export function assistantReadiness(status: AssistantData): { ready: boolean; message: string } {
  if (status.upstream_configured === false) return { ready: false, message: 'API помощника доступен, но не настроен его ключ доступа к ScanFlow. Каталог ещё недоступен' };
  if (status.last_synced_at === null || status.catalog_synced_at === null) return { ready: false, message: 'API помощника доступен. Ожидается первая синхронизация каталога' };
  if (status.worker_online === false) return { ready: false, message: 'API помощника доступен, но обработчик консультаций не запущен' };
  return { ready: true, message: 'Подключение и компания проверены' };
}

export async function saveAssistantConfig(owner: number, body: AssistantData): Promise<void> {
  if (typeof body.enabled !== 'boolean' || typeof body.label !== 'string' || !body.label.trim() || body.label.length > 80) {
    throw new ProductAssistantError(400, 'Укажите название (до 80 символов) и переключатель подключения');
  }
  const baseUrl = assistantBaseUrl(body.api_base_url);
  const existing = await productAssistantRepo.get(owner);
  let sealed = existing?.api_base_url === baseUrl ? existing.api_token_enc : '';
  if (body.api_token !== undefined) {
    if (typeof body.api_token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(body.api_token)) {
      throw new ProductAssistantError(400, 'Некорректный токен API');
    }
    try { sealed = sealSecret(body.api_token, `product-assistant-${owner}`); }
    catch { throw new ProductAssistantError(503, 'На сервере не настроен ключ шифрования подключений'); }
  }
  if (!sealed) throw new ProductAssistantError(400, 'Введите токен для этого адреса API');
  const row = { owner_user_id: owner, label: body.label.trim(), api_base_url: baseUrl,
    api_token_enc: sealed, enabled: body.enabled ? 1 : 0 };
  if (row.enabled) await verifyAssistantCompany(row);
  await productAssistantRepo.save(row);
}

export async function assistantRequest(owner: number, path: string, options: { body?: AssistantData; key?: string } = {}): Promise<AssistantData> {
  const row = await productAssistantRepo.get(owner);
  if (!row?.enabled) throw new ProductAssistantError(503, 'Помощник по товарам не подключён');
  // Verify the token's company before sending any invoice or search data.
  // The existing MAG chef reports company_id=1; other bots report their own ID.
  const status = await verifyAssistantCompany(row);
  if (['/chat', '/mappings'].includes(path) || path.startsWith('/products/search?')) {
    const readiness = assistantReadiness(status);
    if (!readiness.ready) throw new ProductAssistantError(503, readiness.message);
  }
  return path === '/status' ? status : sendAssistantRequest(row, path, options);
}

async function verifyAssistantCompany(row: ProductAssistantConnection): Promise<AssistantData> {
  const status = await sendAssistantRequest(row, '/status');
  if (status.company_id !== row.owner_user_id) {
    throw new ProductAssistantError(409, 'Этот токен помощника не принадлежит вашей компании ScanFlow. Проверьте подключение');
  }
  return status;
}

async function sendAssistantRequest(row: ProductAssistantConnection, path: string, options: { body?: AssistantData; key?: string } = {}): Promise<AssistantData> {
  const base = assistantBaseUrl(row.api_base_url);
  let token: string;
  try { token = openSecret(row.api_token_enc, `product-assistant-${row.owner_user_id}`); }
  catch { throw new ProductAssistantError(503, 'Не удалось прочитать токен подключения. Сохраните его заново в профиле'); }
  try {
    const response = await fetch(base + path, {
      method: options.body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-ScanFlow-Assistant-Version': '1',
        'X-ScanFlow-Company-Id': String(row.owner_user_id),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) {
      const messages: Record<number, string> = { 400: 'Помощник отклонил параметры запроса',
        404: 'Запрос или диалог помощника не найден', 409: 'Конфликт с сохранённым решением или повторным запросом',
        429: 'Очередь помощника заполнена. Повторите позже', 503: 'Помощник временно недоступен' };
      throw new ProductAssistantError(messages[response.status] ? response.status : 502,
        messages[response.status] || 'Не удалось обратиться к помощнику. Проверьте подключение в профиле');
    }
    const data: unknown = await response.json();
    if (!object(data) || data.ok !== true) throw new ProductAssistantError(502, 'Помощник вернул ответ неизвестного формата');
    if (data.protocol_version !== undefined && data.protocol_version !== 1) throw new ProductAssistantError(502, 'Версия API помощника не поддерживается');
    return data;
  } catch (error) {
    if (error instanceof ProductAssistantError) throw error;
    throw new ProductAssistantError(502, 'Нет ответа от помощника. Повторите запрос позже');
  }
}
