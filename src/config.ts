import dotenv from 'dotenv';
import path from 'path';

// Always load .env from project root (one level above src/ or dist/)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function envStr(key: string, defaultVal: string = ''): string {
  return process.env[key] || defaultVal;
}

function envInt(key: string, defaultVal: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : defaultVal;
}

function envBool(key: string, defaultVal: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultVal;
  return val === 'true' || val === '1';
}

export const config = {
  // OCR
  ocrChain: envStr('OCR_CHAIN', 'google_vision,claude_cli,tesseract').split(',').map(s => s.trim()),
  ocrForceEngine: envStr('OCR_FORCE_ENGINE') || null,
  googleCredentials: envStr('GOOGLE_APPLICATION_CREDENTIALS', './google-credentials.json'),
  claudeCliPath: envStr('CLAUDE_CLI_PATH', 'claude'),
  claudeCodeGitBashPath: envStr('CLAUDE_CODE_GIT_BASH_PATH', ''),
  useClaudeAnalyzer: envBool('USE_CLAUDE_ANALYZER', false),
  anthropicApiKey: envStr('ANTHROPIC_API_KEY', ''),

  // Paths
  inboxDir: path.resolve(envStr('INBOX_DIR', './data/inbox')),
  processedDir: path.resolve(envStr('PROCESSED_DIR', './data/processed')),
  failedDir: path.resolve(envStr('FAILED_DIR', './data/failed')),
  dbPath: path.resolve(envStr('DB_PATH', './data/database.sqlite')),

  // API
  apiPort: envInt('API_PORT', 3000),
  apiKey: envStr('API_KEY', 'your-secret-api-key'),

  // Webhook 1C
  webhook1cUrl: envStr('WEBHOOK_1C_URL', ''),
  webhook1cToken: envStr('WEBHOOK_1C_TOKEN', ''),
  webhookEnabled: envBool('WEBHOOK_ENABLED', false),

  // Debug
  debug: envBool('DEBUG', false),
  logLevel: envStr('LOG_LEVEL', 'info'),
  dryRun: envBool('DRY_RUN', false),
};
