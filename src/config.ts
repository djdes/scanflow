import dotenv from 'dotenv';
import path from 'path';

// Always load .env from project root (one level above src/ or dist/)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function envStr(key: string, defaultVal: string = ''): string {
  return process.env[key] || defaultVal;
}

function envInt(key: string, defaultVal: number): number {
  const val = process.env[key];
  if (!val) return defaultVal;
  const n = parseInt(val, 10);
  // Guard against non-numeric env (e.g. DB_PORT=abc) returning NaN, which then
  // silently poisons every downstream use (LIMIT NaN, port NaN, …).
  return Number.isNaN(n) ? defaultVal : n;
}

function envBool(key: string, defaultVal: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultVal;
  return val === 'true' || val === '1';
}

export const config = {
  // OCR
  ocrChain: envStr('OCR_CHAIN', 'google_vision,tesseract').split(',').map(s => s.trim()),
  ocrForceEngine: envStr('OCR_FORCE_ENGINE') || null,
  googleCredentials: envStr('GOOGLE_APPLICATION_CREDENTIALS', './google-credentials.json'),
  useClaudeAnalyzer: envBool('USE_CLAUDE_ANALYZER', false),
  anthropicApiKey: envStr('ANTHROPIC_API_KEY', ''),
  anthropicProxyUrl: envStr('ANTHROPIC_PROXY_URL', ''),

  // Paths
  inboxDir: path.resolve(envStr('INBOX_DIR', './data/inbox')),
  processedDir: path.resolve(envStr('PROCESSED_DIR', './data/processed')),
  failedDir: path.resolve(envStr('FAILED_DIR', './data/failed')),
  // Persistent staging for async supplier-requisite extraction jobs (dispatcher
  // downloads the file minutes later, so it must outlive the request).
  supplierExtractDir: path.resolve(envStr('SUPPLIER_EXTRACT_DIR', './data/supplier_extracts')),

  // MySQL/MariaDB
  // Default to loopback: a missing DB_HOST should fail against a local dev DB,
  // never silently connect to the production instance (the old '192.168.33.3'
  // default is the prod box — a script run without .env would hit prod).
  dbHost: envStr('DB_HOST', '127.0.0.1'),
  dbPort: envInt('DB_PORT', 3306),
  dbUser: envStr('DB_USER', 'scanflow'),
  dbPassword: envStr('DB_PASSWORD', ''),
  dbName: envStr('DB_NAME', 'scanflow'),

  // API
  apiPort: envInt('API_PORT', 3000),
  apiKey: envStr('API_KEY', 'your-secret-api-key'),

  // Webhook 1C
  webhook1cUrl: envStr('WEBHOOK_1C_URL', ''),
  webhook1cToken: envStr('WEBHOOK_1C_TOKEN', ''),
  webhookEnabled: envBool('WEBHOOK_ENABLED', false),

  // Dispatcher mode (analyzer_config.mode === 'dispatcher')
  // ScanFlow creates tasks in ProjectsFlow; user's Claude Code session
  // processes them via MCP and calls back. See docs/dispatcher-runner.md.
  publicBaseUrl: envStr('PUBLIC_BASE_URL', 'https://scanflow.ru'),
  projectsflowApiUrl: envStr('PROJECTSFLOW_API_URL', 'https://projectsflow.ru/api'),
  projectsflowToken: envStr('PROJECTSFLOW_AGENT_TOKEN', ''),
  // No default — install-specific. Set via UI (/#/settings → Диспетчер) or via env.
  projectsflowScanflowProjectId: envStr('PROJECTSFLOW_SCANFLOW_PROJECT_ID', ''),

  // Multi-tenant data isolation. When true, non-admin users only see/operate on
  // invoices they own (admin sees everything). Default OFF so activation is a
  // deliberate, verifiable step — toggling needs no redeploy. See
  // docs/superpowers/specs/2026-06-24-multitenant-data-isolation-design.md
  dataScopingEnabled: envBool('DATA_SCOPING_ENABLED', false),

  // Self-service registration (POST /api/auth/register + /register-email). Default
  // OFF: an open signup endpoint hands out a `user`-role API key to anyone, and with
  // data-scoping disabled that key can read/mutate every invoice on the platform.
  // Enable deliberately (invite-driven onboarding, etc.) only alongside data-scoping.
  registrationEnabled: envBool('REGISTRATION_ENABLED', false),

  // Debug
  debug: envBool('DEBUG', false),
  logLevel: envStr('LOG_LEVEL', 'info'),
  dryRun: envBool('DRY_RUN', false),
};

// Loud startup warnings for insecure defaults. console.* (not the Winston logger)
// because config is imported before the logger is set up, and importing the
// logger here would create a cycle. These are misconfigurations, not crashes —
// warn rather than hard-fail so local/dev experiments still boot.
if (config.apiKey === 'your-secret-api-key') {
  // eslint-disable-next-line no-console
  console.warn('[config] API_KEY is the default placeholder — set a real API_KEY in .env; the placeholder is publicly known.');
}
if (!config.dbPassword) {
  // eslint-disable-next-line no-console
  console.warn('[config] DB_PASSWORD is empty — set it in .env. Database backups (mysqldump) will be skipped without it.');
}
