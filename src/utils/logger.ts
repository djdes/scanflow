import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '../config';

const { combine, timestamp, printf, colorize } = winston.format;

// Any meta key whose name matches one of these is redacted before being
// serialized. We log a LOT of fields including tokens, keys, and full OCR
// text; redaction here is the last line of defence before disk + stdout.
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|auth[_-]?token|authorization|password|secret|credential|anthropic[_-]?key|x[_-]api[_-]key)/i;
const TRUNCATE_KEY_PATTERN = /^(raw_text|ocr_text|combined_text|prompt|body|response)$/i;
const MAX_TRUNCATED_LEN = 400;

function redactValue(key: string, value: unknown, seen: WeakSet<object>): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (TRUNCATE_KEY_PATTERN.test(key) && typeof value === 'string' && value.length > MAX_TRUNCATED_LEN) {
    return value.slice(0, MAX_TRUNCATED_LEN) + `…[+${value.length - MAX_TRUNCATED_LEN} chars]`;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
    if (Array.isArray(value)) return value.map((v, i) => redactValue(String(i), v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v, seen);
    }
    return out;
  }
  return value;
}

const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const safe = redactValue('', meta, new WeakSet()) as Record<string, unknown>;
  const metaStr = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : '';
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: config.logLevel,
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat,
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat,
      ),
    }),
    // Daily rotating error log, 30 days retention, gzipped.
    new DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
    }),
    // Daily rotating combined log, 30 days retention, gzipped.
    new DailyRotateFile({
      filename: 'logs/combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
    }),
  ],
});
