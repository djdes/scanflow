/**
 * ProjectsFlow dispatcher integration.
 *
 * When analyzer_config.mode === 'dispatcher', ScanFlow creates a task in
 * ProjectsFlow with a YAML-block description containing photo_url +
 * callback_url + per-task token. A separately-running Claude Code session
 * (the "dispatcher") claims the task via MCP, downloads the photo,
 * recognises it locally, and POSTs the parsed JSON back to ScanFlow.
 *
 * Single function entry: `dispatchInvoice(invoiceId, photoFileName)`.
 *
 * Flow:
 *   1. Generate per-task token (32 bytes hex).
 *   2. UPDATE invoices SET dispatcher_token, dispatcher_started_at.
 *   3. POST {projectsflowApiUrl}/agent/projects/{projectId}/tasks
 *      with Bearer agent token. Description body is a YAML frontmatter +
 *      free-text instruction that the dispatcher Claude session parses.
 *   4. Store returned task.id in invoices.dispatcher_task_id.
 *   5. Return — caller continues, awaiting the callback.
 */
import crypto from 'crypto';
import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { config } from '../config';
import { invoiceRepo } from '../database/repositories/invoiceRepo';

export class DispatcherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DispatcherConfigError';
  }
}

export class DispatcherApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'DispatcherApiError';
  }
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function buildDescription(args: {
  invoiceId: number;
  photoUrl: string;
  callbackUrl: string;
  token: string;
}): string {
  // YAML frontmatter is parsed by the dispatcher session. The text below it
  // is the instruction the human-readable kanban viewer reads — it also tells
  // the LLM (in case the dispatcher is naive) what to do with the YAML.
  return `---
type: scanflow_ocr
invoice_id: ${args.invoiceId}
photo_url: ${args.photoUrl}
callback_url: ${args.callbackUrl}
token: ${args.token}
expected_format: invoice_json
---

ScanFlow OCR job for invoice #${args.invoiceId}.

**Действие для диспетчера:**

1. Скачай фото из \`photo_url\` (он публичный по токену).
2. Прогони через Claude (этой же сессии) с инвойс-промптом — извлеки JSON по схеме \`ParsedInvoiceData\` (invoice_type / invoice_number / invoice_date / supplier / supplier_inn / total_sum / vat_sum / items[]).
3. POST на \`callback_url\` с телом:
   \`\`\`json
   {"token":"${args.token}","success":true,"data":<распарсенный JSON>}
   \`\`\`
   Или при ошибке:
   \`\`\`json
   {"token":"${args.token}","success":false,"error":"описание"}
   \`\`\`
4. Помеси PF-задачу как done.

Описание схемы JSON и стандартный промпт — в \`src/ocr/claudeApiAnalyzer.ts:buildPrompt()\` репозитория ScanFlow.`;
}

export async function dispatchInvoice(invoiceId: number, photoFileName: string): Promise<void> {
  // Token: DB takes precedence over env (UI-editable in /#/settings).
  // Falls back to env for back-compat with installs that haven't migrated
  // settings via the UI yet.
  const cfg = await invoiceRepo.getAnalyzerConfig();
  const token = cfg.projectsflow_token || config.projectsflowToken;
  if (!token) {
    throw new DispatcherConfigError(
      'ProjectsFlow agent token is not set. Configure in /#/settings → Диспетчер.',
    );
  }
  if (!config.projectsflowScanflowProjectId) {
    throw new DispatcherConfigError('PROJECTSFLOW_SCANFLOW_PROJECT_ID is not set');
  }

  const perTaskToken = generateToken();
  const photoUrl = `${config.publicBaseUrl}/api/dispatcher/photo/${invoiceId}?token=${perTaskToken}`;
  const callbackUrl = `${config.publicBaseUrl}/api/dispatcher/result/${invoiceId}`;

  // Reserve the per-task token in DB BEFORE posting to PF so a fast callback
  // can't race the local UPDATE.
  await getDb()
    .prepare(
      `UPDATE invoices
         SET dispatcher_token = ?,
             dispatcher_started_at = NOW(),
             status = 'ocr_processing'
       WHERE id = ?`,
    )
    .run(perTaskToken, invoiceId);

  const description = buildDescription({ invoiceId, photoUrl, callbackUrl, token: perTaskToken });
  const apiUrl = `${config.projectsflowApiUrl}/agent/projects/${encodeURIComponent(
    config.projectsflowScanflowProjectId,
  )}/tasks`;

  let resp: Response;
  try {
    resp = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ description, status: 'backlog' }),
    });
  } catch (err) {
    logger.error('dispatcher: PF API unreachable', { error: (err as Error).message, invoiceId });
    throw new DispatcherApiError(`ProjectsFlow unreachable: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    logger.error('dispatcher: PF API non-2xx', { status: resp.status, body, invoiceId });
    throw new DispatcherApiError(`ProjectsFlow returned ${resp.status}: ${body.slice(0, 200)}`, resp.status);
  }
  const json = (await resp.json()) as { task?: { id?: string } };
  const taskId = json.task?.id;
  if (!taskId) {
    logger.error('dispatcher: PF response missing task.id', { json, invoiceId });
    throw new DispatcherApiError('ProjectsFlow returned no task id');
  }

  await getDb()
    .prepare('UPDATE invoices SET dispatcher_task_id = ? WHERE id = ?')
    .run(taskId, invoiceId);

  logger.info('dispatcher: task created', {
    invoiceId,
    taskId,
    photoFileName,
    callbackUrl,
  });
}

/**
 * Validate a callback token against the invoice row. Returns the invoice's
 * row if the token matches AND the row is still in ocr_processing state.
 * Used by both `GET /photo` and `POST /dispatcher-result`.
 */
export async function validateDispatcherToken(
  invoiceId: number,
  token: string,
): Promise<{ id: number; file_path: string; status: string } | null> {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const row = await getDb()
    .prepare(
      'SELECT id, file_path, status, dispatcher_token FROM invoices WHERE id = ?',
    )
    .get<{ id: number; file_path: string; status: string; dispatcher_token: string | null }>(invoiceId);
  if (!row) return null;
  if (!row.dispatcher_token || row.dispatcher_token !== token) return null;
  return { id: row.id, file_path: row.file_path, status: row.status };
}

/**
 * Clear the dispatcher token + started_at on a row (called once the
 * callback is handled, success or fail). Idempotent.
 */
export async function clearDispatcherState(invoiceId: number): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE invoices
         SET dispatcher_token = NULL,
             dispatcher_started_at = NULL
       WHERE id = ?`,
    )
    .run(invoiceId);
}
