import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ParsedInvoiceData } from './types';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Claude Text Analyzer
 *
 * Использует Claude CLI для интеллектуального структурирования OCR-текста.
 * Работает через MAX подписку (текст передаётся напрямую в -p промпт).
 *
 * Workflow:
 *   1. Google Vision OCR → raw text
 *   2. Claude CLI -p "структурируй этот текст" → JSON
 *   3. Возврат ParsedInvoiceData
 */

const CLAUDE_ANALYSIS_PROMPT = `Ты эксперт по распознаванию накладных. Проанализируй этот OCR-текст и извлеки структурированные данные.

ВАЖНО:
- Верни ТОЛЬКО валидный JSON без пояснений и markdown
- Названия товаров указывай ТОЧНО как в тексте
- Если поле не найдено, используй null
- Для чисел используй точку как десятичный разделитель (30.60, не 30,60)
- Определи тип документа: "счет_на_оплату", "торг_12", "упд" или "счет_фактура"
- Данные покупателя (ООО "БФС") НЕ нужны — извлекай только данные ПОСТАВЩИКА
- Для "счет_на_оплату": извлеки ИНН, БИК, расчетный счет, корр. счет и адрес поставщика
- Для остальных типов: извлеки только ИНН поставщика (если есть)

- vat_rate — ставка НДС в процентах для каждого товара (10, 20, 0 или null если не указана). У разных товаров может быть разная ставка!
- vat_sum — общая сумма НДС по накладной (из строки "В том числе НДС" или "НДС" в итогах)

Формат ответа:
{"invoice_type":"тип документа","invoice_number":"номер или null","invoice_date":"YYYY-MM-DD или null","supplier":"название поставщика или null","supplier_inn":"ИНН поставщика или null","supplier_bik":"БИК банка или null","supplier_account":"расчетный счет или null","supplier_corr_account":"корр. счет или null","supplier_address":"адрес поставщика или null","total_sum":число или null,"vat_sum":число или null,"items":[{"name":"название товара","quantity":число или null,"unit":"кг/шт/л/уп или null","price":число или null,"total":число или null,"vat_rate":число или null}]}

OCR-ТЕКСТ ДЛЯ АНАЛИЗА:
`;

// Queue for sequential processing of Claude CLI calls
let isAnalyzing = false;
let currentProcess: ChildProcess | null = null;
const analysisQueue: Array<{
  ocrText: string;
  resolve: (result: AnalyzerResult) => void;
}> = [];

export interface AnalyzerResult {
  success: boolean;
  data?: ParsedInvoiceData;
  error?: string;
  rawResponse?: string;
}

/**
 * Обрабатывает следующий запрос из очереди (если есть).
 */
async function processNextInQueue(): Promise<void> {
  if (isAnalyzing || analysisQueue.length === 0) {
    return;
  }

  const next = analysisQueue.shift()!;
  const cliPath = config.claudeCliPath;
  isAnalyzing = true;

  logger.info('Claude Analyzer: starting text analysis from queue', {
    textLength: next.ocrText.length,
    queueRemaining: analysisQueue.length,
  });

  try {
    const result = await runClaudeAnalysis(cliPath, next.ocrText);
    next.resolve(result);
  } catch (err) {
    next.resolve({
      success: false,
      error: `Claude Analyzer error: ${(err as Error).message}`,
    });
  } finally {
    isAnalyzing = false;
    currentProcess = null;
    // Process next item in queue
    processNextInQueue();
  }
}

/**
 * Анализирует OCR-текст через Claude CLI и возвращает структурированные данные.
 * Использует MAX подписку Claude Code.
 * Если анализатор занят, запрос добавляется в очередь.
 */
export async function analyzeTextWithClaude(ocrText: string): Promise<AnalyzerResult> {
  if (!ocrText || ocrText.trim().length < 20) {
    return {
      success: false,
      error: 'OCR text too short for analysis',
    };
  }

  // If analyzer is busy, add to queue and wait
  if (isAnalyzing) {
    logger.info('Claude Analyzer: busy, adding to queue', {
      queueLength: analysisQueue.length + 1,
    });

    return new Promise<AnalyzerResult>((resolve) => {
      analysisQueue.push({ ocrText, resolve });
    });
  }

  // Process immediately
  const cliPath = config.claudeCliPath;
  isAnalyzing = true;

  logger.info('Claude Analyzer: starting text analysis', { textLength: ocrText.length });

  try {
    const result = await runClaudeAnalysis(cliPath, ocrText);
    return result;
  } finally {
    isAnalyzing = false;
    currentProcess = null;
    // Process next item in queue (if any)
    processNextInQueue();
  }
}

function runClaudeAnalysis(cliPath: string, ocrText: string): Promise<AnalyzerResult> {
  return new Promise((resolve) => {
    // Build the full prompt with OCR text
    const fullPrompt = CLAUDE_ANALYSIS_PROMPT + ocrText;

    // Write prompt to temp file to avoid shell escaping issues on Windows
    const promptFile = path.join(os.tmpdir(), `claude_prompt_${Date.now()}.txt`);
    fs.writeFileSync(promptFile, fullPrompt, 'utf-8');

    // Use stdin redirect from file for reliable prompt passing
    // Format: claude -p "$(cat promptfile)" doesn't work well on Windows
    // Instead we use shell command to pipe the file content
    const shellCommand = process.platform === 'win32'
      ? `type "${promptFile}" | "${cliPath}" -p - --dangerously-skip-permissions`
      : `cat "${promptFile}" | "${cliPath}" -p - --dangerously-skip-permissions`;

    logger.debug('Claude Analyzer: spawning process via shell', { promptLength: fullPrompt.length, promptFile });

    const proc = spawn(shellCommand, [], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        CLAUDE_CODE_GIT_BASH_PATH: config.claudeCodeGitBashPath || undefined,
      },
    });

    // Cleanup temp file after process ends
    const cleanupPromptFile = () => {
      try {
        if (fs.existsSync(promptFile)) {
          fs.unlinkSync(promptFile);
        }
      } catch {
        // ignore cleanup errors
      }
    };

    currentProcess = proc;

    let stdout = '';
    let stderr = '';
    let killed = false;

    // Timeout after 15 seconds — CLI on MAX subscription is unreliable on Windows
    // If it doesn't respond in 15s, fall through to API fallback quickly
    const TIMEOUT_MS = 15_000;
    const timeout = setTimeout(() => {
      if (!killed) {
        killed = true;
        logger.warn('Claude Analyzer: timeout, killing process');
        killProcess(proc);
        resolve({
          success: false,
          error: `Claude Analyzer: timeout after ${TIMEOUT_MS / 1000} seconds`,
        });
      }
    }, TIMEOUT_MS);

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf-8');
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf-8');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (!killed) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({
            success: false,
            error: `Claude CLI not found at "${cliPath}"`,
          });
        } else {
          resolve({
            success: false,
            error: `Claude Analyzer error: ${err.message}`,
          });
        }
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      cleanupPromptFile();

      if (killed) return;

      if (stderr) {
        logger.debug('Claude Analyzer: stderr', { stderr: stderr.substring(0, 300) });
      }

      if (code !== 0) {
        resolve({
          success: false,
          error: `Claude Analyzer: exited with code ${code}`,
          rawResponse: stdout,
        });
        return;
      }

      const text = stdout.trim();
      if (!text) {
        resolve({
          success: false,
          error: 'Claude Analyzer: empty response',
        });
        return;
      }

      logger.info('Claude Analyzer: response received', { length: text.length });

      // Try to parse JSON from response
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as ParsedInvoiceData;

          // Ensure items is an array
          if (!parsed.items) {
            parsed.items = [];
          }

          logger.info('Claude Analyzer: successfully parsed data', {
            invoiceNumber: parsed.invoice_number,
            supplier: parsed.supplier,
            itemsCount: parsed.items.length,
            totalSum: parsed.total_sum,
          });

          resolve({
            success: true,
            data: parsed,
            rawResponse: text,
          });
        } else {
          resolve({
            success: false,
            error: 'Claude Analyzer: no JSON found in response',
            rawResponse: text,
          });
        }
      } catch (parseErr) {
        logger.warn('Claude Analyzer: JSON parse error', { error: (parseErr as Error).message });
        resolve({
          success: false,
          error: `Claude Analyzer: JSON parse error - ${(parseErr as Error).message}`,
          rawResponse: text,
        });
      }
    });
  });
}

function killProcess(proc: ChildProcess): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', proc.pid.toString(), '/f', '/t'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (err) {
    logger.warn('Claude Analyzer: error killing process', { error: (err as Error).message });
  }
}

// Cleanup on process exit
process.on('exit', () => {
  if (currentProcess && !currentProcess.killed) {
    try {
      currentProcess.kill();
    } catch {
      // ignore
    }
  }
});
