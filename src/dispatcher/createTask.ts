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
import { supplierExtractJobRepo } from '../database/repositories/supplierExtractJobRepo';
import { buildPrompt } from '../ocr/claudeApiAnalyzer';

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
  promptUrl: string;
}): string {
  // PF has a 5000-char limit on description. Keep this lean; the full OCR
  // prompt is served separately via GET /api/dispatcher/prompt (URL in YAML).
  return `---
type: scanflow_ocr
invoice_id: ${args.invoiceId}
photo_url: ${args.photoUrl}
callback_url: ${args.callbackUrl}
prompt_url: ${args.promptUrl}
token: ${args.token}
expected_format: invoice_json
---

ScanFlow OCR job for invoice #${args.invoiceId}.

## Шаги

1. **Скачай фото** из \`photo_url\` → \`data/photo_${args.invoiceId}.jpg\`.
2. **Скачай OCR-промпт** из \`prompt_url\` (plain text). Применяй его к фото — в нём правила распознавания шапки, таблицы, ед. изм. и \`pack_size\`.
3. **Распознавание** даст JSON \`ParsedInvoiceData\` (invoice_type / invoice_number / invoice_date / supplier / supplier_inn / total_sum / vat_sum / items[] с полями name, quantity, unit, price, total, vat_rate, row_no, pack_size).
4. **Сохрани JSON в файл** \`data/result_${args.invoiceId}.json\` — оборачивая в:
   \`\`\`json
   {"token":"${args.token}","success":true,"data":<JSON>}
   \`\`\`
   На ошибку: \`{"token":"${args.token}","success":false,"error":"описание"}\`.
5. **POST на callback** (важно \`--data-binary @file\`, не \`-d\` — Windows bash ломает UTF-8):
   \`\`\`bash
   curl -X POST '${args.callbackUrl}' \\
     -H 'Content-Type: application/json; charset=utf-8' \\
     --data-binary @data/result_${args.invoiceId}.json
   \`\`\`
6. **Закрой PF-задачу** через \`mcp__projectsflow__pf_move_task\` со \`targetStatus: 'done'\`.

**На 400 «encoding-broken»** — пересохрани JSON через Write tool, повтори. Токен валиден 15 мин с момента создания задачи.`;
}

/**
 * Resolve PF agent token + project id. DB (analyzer_config, UI-editable in
 * /#/settings → Диспетчер) takes precedence over env. Throws if either missing.
 */
async function resolvePfConfig(): Promise<{ token: string; projectId: string }> {
  const cfg = await invoiceRepo.getAnalyzerConfig();
  const token = cfg.projectsflow_token || config.projectsflowToken;
  const projectId = cfg.projectsflow_project_id || config.projectsflowScanflowProjectId;
  if (!token) {
    throw new DispatcherConfigError('ProjectsFlow agent token is not set. Configure in /#/settings → Диспетчер.');
  }
  if (!projectId) {
    throw new DispatcherConfigError('ProjectsFlow project ID is not set. Configure in /#/settings → Диспетчер.');
  }
  return { token, projectId };
}

/**
 * POST a task to ProjectsFlow and return its id. status='todo' lands it in the
 * ВОРКЕР column where the dispatcher Claude Code session picks it up ('backlog'
 * would hide it in ЧЕРНОВИКИ). Shared by invoice + supplier-extract dispatch.
 */
async function postPfTask(token: string, projectId: string, description: string): Promise<string> {
  const apiUrl = `${config.projectsflowApiUrl}/agent/projects/${encodeURIComponent(projectId)}/tasks`;
  let resp: Response;
  try {
    resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ description, status: 'todo' }),
    });
  } catch (err) {
    logger.error('dispatcher: PF API unreachable', { error: (err as Error).message });
    throw new DispatcherApiError(`ProjectsFlow unreachable: ${(err as Error).message}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    logger.error('dispatcher: PF API non-2xx', { status: resp.status, body });
    throw new DispatcherApiError(`ProjectsFlow returned ${resp.status}: ${body.slice(0, 200)}`, resp.status);
  }
  const json = (await resp.json()) as { task?: { id?: string } };
  const taskId = json.task?.id;
  if (!taskId) {
    logger.error('dispatcher: PF response missing task.id', { json });
    throw new DispatcherApiError('ProjectsFlow returned no task id');
  }
  return taskId;
}

export async function dispatchInvoice(invoiceId: number, photoFileName: string): Promise<void> {
  const { token, projectId } = await resolvePfConfig();

  const perTaskToken = generateToken();
  const photoUrl = `${config.publicBaseUrl}/api/dispatcher/photo/${invoiceId}?token=${perTaskToken}`;
  const callbackUrl = `${config.publicBaseUrl}/api/dispatcher/result/${invoiceId}`;
  const promptUrl = `${config.publicBaseUrl}/api/dispatcher/prompt`;

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

  const description = buildDescription({ invoiceId, photoUrl, callbackUrl, token: perTaskToken, promptUrl });
  const taskId = await postPfTask(token, projectId, description);

  await getDb()
    .prepare('UPDATE invoices SET dispatcher_task_id = ? WHERE id = ?')
    .run(taskId, invoiceId);

  logger.info('dispatcher: task created', { invoiceId, taskId, photoFileName, callbackUrl });
}

/**
 * Build the PF task description for a supplier-requisite extraction job. Leaner
 * than the invoice description: the dispatcher downloads the document, applies
 * the requisites prompt, and POSTs back the payee requisites JSON.
 */
function buildSupplierDescription(args: {
  jobId: number; photoUrl: string; callbackUrl: string; token: string; promptUrl: string; ext: string;
}): string {
  return `---
type: scanflow_supplier_requisites
job_id: ${args.jobId}
photo_url: ${args.photoUrl}
callback_url: ${args.callbackUrl}
prompt_url: ${args.promptUrl}
token: ${args.token}
expected_format: supplier_requisites_json
---

ScanFlow: распознавание реквизитов поставщика (job #${args.jobId}).

## Шаги

1. **Скачай документ** из \`photo_url\` → \`data/supplier_${args.jobId}${args.ext}\` (это может быть фото ИЛИ PDF).
2. **Скачай промпт** из \`prompt_url\` (plain text) и примени его к документу. Нужны реквизиты ПОЛУЧАТЕЛЯ.
3. **Сформируй JSON** \`{inn, kpp, name, bank_bic, account, bank_corr_account, bank_name, address}\` (поля, которых нет → null).
4. **Сохрани в файл** \`data/supplier_result_${args.jobId}.json\`:
   \`\`\`json
   {"token":"${args.token}","success":true,"data":<JSON реквизитов>}
   \`\`\`
   На ошибку: \`{"token":"${args.token}","success":false,"error":"описание"}\`.
5. **POST на callback** (важно \`--data-binary @file\`, не \`-d\` — Windows bash ломает UTF-8):
   \`\`\`bash
   curl -X POST '${args.callbackUrl}' \\
     -H 'Content-Type: application/json; charset=utf-8' \\
     --data-binary @data/supplier_result_${args.jobId}.json
   \`\`\`
6. **Закрой PF-задачу** через \`mcp__projectsflow__pf_move_task\` со \`targetStatus: 'done'\`.

Токен валиден 15 мин с момента создания задачи.`;
}

/**
 * Dispatch a supplier-requisite extraction job to ProjectsFlow. The job row +
 * token must already exist (created by the suppliers route). Stores the PF
 * task id on the job. Mirrors dispatchInvoice but targets the job table and
 * the supplier prompt/photo/callback endpoints.
 */
export async function dispatchSupplierExtract(jobId: number, token: string, ext: string): Promise<void> {
  const pf = await resolvePfConfig();
  const photoUrl = `${config.publicBaseUrl}/api/dispatcher/photo-job/${jobId}?token=${token}`;
  const callbackUrl = `${config.publicBaseUrl}/api/dispatcher/supplier-result/${jobId}`;
  const promptUrl = `${config.publicBaseUrl}/api/dispatcher/prompt-supplier`;

  const description = buildSupplierDescription({ jobId, photoUrl, callbackUrl, token, promptUrl, ext });
  const taskId = await postPfTask(pf.token, pf.projectId, description);
  await supplierExtractJobRepo.setTaskId(jobId, taskId);

  logger.info('dispatcher: supplier-extract task created', { jobId, taskId, callbackUrl });
}

/**
 * Validate a supplier-extract callback token against the job row. Returns the
 * job if the token matches AND the job is still 'processing'. Used by
 * `GET /photo-job` and `POST /supplier-result`.
 */
export async function validateSupplierJobToken(
  jobId: number,
  token: string,
): Promise<{ id: number; file_path: string; content_type: string; status: string; file_name: string } | null> {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const job = await supplierExtractJobRepo.getById(jobId);
  if (!job) return null;
  if (job.status !== 'processing') return null;
  if (!job.token || job.token !== token) return null;
  return { id: job.id, file_path: job.file_path, content_type: job.content_type, status: job.status, file_name: job.file_name };
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
             dispatcher_started_at = NULL,
             dispatcher_fetched_at = NULL
       WHERE id = ?`,
    )
    .run(invoiceId);
}
