import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { OcrEngine, OcrResult } from './types';
import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Claude Code CLI Bridge для OCR
 *
 * ТЕКУЩЕЕ ОГРАНИЧЕНИЕ (февраль 2026):
 * Claude Code CLI в non-interactive режиме (-p) не поддерживает передачу изображений.
 * При запросе Read для файла изображения Claude читает CLAUDE.md проекта вместо файла.
 *
 * Возможные решения в будущем:
 * 1. Anthropic добавит флаг --image для передачи изображений
 * 2. Использовать Anthropic API напрямую (требует API ключ, платно)
 * 3. Использовать MCP сервер для Claude Code
 *
 * Пока что этот движок отключён в OCR_CHAIN.
 */

const CLAUDE_PROMPT_SIMPLE =
  `Проанализируй фото накладной и верни ТОЛЬКО валидный JSON без пояснений: ` +
  `{"invoice_number":"номер","invoice_date":"YYYY-MM-DD","supplier":"поставщик","total_sum":число,"items":[{"name":"название","quantity":число,"unit":"кг/шт/л","price":число,"total":число}]}. ` +
  `Названия товаров указывай ТОЧНО как написано на фото. Если поле не найдено - null.`;

// Mutex to prevent concurrent Claude CLI calls
let isProcessing = false;
let currentProcess: ChildProcess | null = null;

export class ClaudeCodeBridgeEngine implements OcrEngine {
  name = 'claude_cli';

  async recognize(imagePath: string): Promise<OcrResult> {
    // Prevent concurrent calls - Claude CLI doesn't handle them well
    if (isProcessing) {
      throw new Error('Claude CLI: already processing another image, skipping');
    }

    logger.info('Claude CLI: starting recognition', { imagePath });

    if (!fs.existsSync(imagePath)) {
      throw new Error(`Claude CLI: file not found: ${imagePath}`);
    }

    const cliPath = config.claudeCliPath;
    isProcessing = true;

    try {
      const result = await this.runClaudeCli(cliPath, imagePath);
      return result;
    } finally {
      isProcessing = false;
      currentProcess = null;
    }
  }

  private runClaudeCli(cliPath: string, imagePath: string): Promise<OcrResult> {
    return new Promise((resolve, reject) => {
      // NOTE: This approach doesn't work - Claude CLI doesn't read the image file
      // It reads CLAUDE.md instead. Keeping this code for future reference.
      const prompt = `Используй Read tool чтобы прочитать изображение "${imagePath}" и извлеки данные накладной как JSON.`;

      const args = [
        '-p', prompt,
        '--tools', 'Read',
        '--add-dir', path.dirname(imagePath),
        '--dangerously-skip-permissions',
      ];

      logger.debug('Claude CLI: spawning process', { cliPath, imagePath });

      const proc = spawn(cliPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
        cwd: os.tmpdir(),
        env: {
          ...process.env,
          CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Users\\djdes\\scoop\\apps\\git\\2.52.0\\usr\\bin\\bash.exe',
        },
      });

      currentProcess = proc;

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timeout = setTimeout(() => {
        if (!killed) {
          killed = true;
          logger.warn('Claude CLI: timeout, killing process');
          this.killProcess(proc);
          reject(new Error('Claude CLI: timeout after 90 seconds'));
        }
      }, 90_000);

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
            reject(new Error(`Claude CLI: command not found at "${cliPath}"`));
          } else {
            reject(new Error(`Claude CLI: ${err.message}`));
          }
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (killed) return;

        if (stderr) {
          logger.debug('Claude CLI: stderr', { stderr: stderr.substring(0, 300) });
        }

        if (code !== 0) {
          reject(new Error(`Claude CLI: exited with code ${code}`));
          return;
        }

        const text = stdout.trim();
        if (!text) {
          reject(new Error('Claude CLI: empty response'));
          return;
        }

        logger.info('Claude CLI: response received', { length: text.length });

        // Try to parse as structured JSON
        let structured;
        try {
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            structured = JSON.parse(jsonMatch[0]);
            logger.info('Claude CLI: parsed structured data', {
              itemsCount: structured.items?.length ?? 0,
            });
          }
        } catch (parseErr) {
          logger.warn('Claude CLI: could not parse response as JSON, using as raw text');
        }

        resolve({
          text,
          engine: this.name,
          structured,
        });
      });
    });
  }

  private killProcess(proc: ChildProcess): void {
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
      logger.warn('Claude CLI: error killing process', { error: (err as Error).message });
    }
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
