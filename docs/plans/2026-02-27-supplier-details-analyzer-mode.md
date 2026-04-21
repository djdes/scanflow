# Supplier Banking Details + Analyzer Mode Switch — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract supplier banking details (INN, BIK, accounts, address) from payment invoices and add a switchable Claude API mode that sends images directly to Anthropic API (no Google Vision needed).

**Architecture:** Two analyzer modes stored in DB: "hybrid" (Google Vision OCR + Claude CLI text analysis, free via MAX) and "claude_api" (image sent directly to Anthropic API as base64, paid). Supplier banking details extracted by both analyzers. New Settings page in frontend for mode switching.

**Tech Stack:** `@anthropic-ai/sdk` for Claude API, existing Express/SQLite/vanilla JS stack.

---

### Task 1: Install Anthropic SDK

**Files:**
- Modify: `package.json`

**Step 1: Install the package**

Run: `npm install @anthropic-ai/sdk`
Expected: Package added to dependencies

**Step 2: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @anthropic-ai/sdk dependency"
```

---

### Task 2: Update ParsedInvoiceData types

**Files:**
- Modify: `src/ocr/types.ts`

**Step 1: Add supplier detail fields to ParsedInvoiceData**

Replace the current `ParsedInvoiceData` interface (lines 18-24) with:

```typescript
export interface ParsedInvoiceData {
  invoice_number?: string;
  invoice_date?: string;
  invoice_type?: 'счет_на_оплату' | 'торг_12' | 'упд' | 'счет_фактура';
  supplier?: string;
  supplier_inn?: string;
  supplier_bik?: string;
  supplier_account?: string;
  supplier_corr_account?: string;
  supplier_address?: string;
  total_sum?: number;
  items: ParsedInvoiceItem[];
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors (existing code assigns subsets of these fields, all new fields are optional)

**Step 3: Commit**

```bash
git add src/ocr/types.ts
git commit -m "feat: add supplier banking fields to ParsedInvoiceData"
```

---

### Task 3: Database migration — new columns + analyzer_config table

**Files:**
- Modify: `src/database/migrations.ts`

**Step 1: Add migration for new columns and table**

After the existing `db.exec(...)` block (line 60), add:

```typescript
  // Migration v2: supplier details + analyzer config
  const hasInvoiceType = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('invoices') WHERE name = 'invoice_type'"
  ).get() as { cnt: number };

  if (hasInvoiceType.cnt === 0) {
    db.exec(`
      ALTER TABLE invoices ADD COLUMN invoice_type TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_inn TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_bik TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_account TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_corr_account TEXT;
      ALTER TABLE invoices ADD COLUMN supplier_address TEXT;
    `);
    logger.info('Migration v2: added supplier detail columns');
  }

  const hasAnalyzerConfig = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='analyzer_config'"
  ).get() as { cnt: number };

  if (hasAnalyzerConfig.cnt === 0) {
    db.exec(`
      CREATE TABLE analyzer_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL DEFAULT 'hybrid',
        anthropic_api_key TEXT
      );
      INSERT INTO analyzer_config (id, mode) VALUES (1, 'hybrid');
    `);
    logger.info('Migration v2: created analyzer_config table');
  }
```

**Step 2: Verify server restarts without errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/database/migrations.ts
git commit -m "feat: migration v2 — supplier details columns + analyzer_config table"
```

---

### Task 4: Update invoiceRepo — save and return supplier fields

**Files:**
- Modify: `src/database/repositories/invoiceRepo.ts`

**Step 1: Add supplier fields to Invoice interface**

Add these fields to the `Invoice` interface (after line 12 `total_sum`):

```typescript
  invoice_type: string | null;
  supplier_inn: string | null;
  supplier_bik: string | null;
  supplier_account: string | null;
  supplier_corr_account: string | null;
  supplier_address: string | null;
```

**Step 2: Add supplier fields to CreateInvoiceData**

Add these optional fields to `CreateInvoiceData` (after line 38 `supplier`):

```typescript
  invoice_type?: string;
  supplier_inn?: string;
  supplier_bik?: string;
  supplier_account?: string;
  supplier_corr_account?: string;
  supplier_address?: string;
```

**Step 3: Update the `create` method INSERT statement**

Update the `create` method (lines 54-71) to include new fields in both the SQL and the run params:

```sql
INSERT INTO invoices (file_name, file_path, invoice_number, invoice_date, supplier, total_sum, raw_text, ocr_engine, invoice_type, supplier_inn, supplier_bik, supplier_account, supplier_corr_account, supplier_address)
VALUES (@file_name, @file_path, @invoice_number, @invoice_date, @supplier, @total_sum, @raw_text, @ocr_engine, @invoice_type, @supplier_inn, @supplier_bik, @supplier_account, @supplier_corr_account, @supplier_address)
```

Add to the run params object:
```typescript
invoice_type: data.invoice_type ?? null,
supplier_inn: data.supplier_inn ?? null,
supplier_bik: data.supplier_bik ?? null,
supplier_account: data.supplier_account ?? null,
supplier_corr_account: data.supplier_corr_account ?? null,
supplier_address: data.supplier_address ?? null,
```

**Step 4: Update `updateInvoiceData` method**

Add handling for the new fields in the `updateInvoiceData` method (after line 111):

```typescript
if (data.invoice_type !== undefined) { fields.push('invoice_type = @invoice_type'); values.invoice_type = data.invoice_type; }
if (data.supplier_inn !== undefined) { fields.push('supplier_inn = @supplier_inn'); values.supplier_inn = data.supplier_inn; }
if (data.supplier_bik !== undefined) { fields.push('supplier_bik = @supplier_bik'); values.supplier_bik = data.supplier_bik; }
if (data.supplier_account !== undefined) { fields.push('supplier_account = @supplier_account'); values.supplier_account = data.supplier_account; }
if (data.supplier_corr_account !== undefined) { fields.push('supplier_corr_account = @supplier_corr_account'); values.supplier_corr_account = data.supplier_corr_account; }
if (data.supplier_address !== undefined) { fields.push('supplier_address = @supplier_address'); values.supplier_address = data.supplier_address; }
```

**Step 5: Add `getAnalyzerConfig` and `updateAnalyzerConfig` methods**

Add at the end of `invoiceRepo` object (before closing `};`):

```typescript
  getAnalyzerConfig(): { mode: string; anthropic_api_key: string | null } {
    const db = getDb();
    const row = db.prepare('SELECT mode, anthropic_api_key FROM analyzer_config WHERE id = 1').get() as
      { mode: string; anthropic_api_key: string | null } | undefined;
    return row ?? { mode: 'hybrid', anthropic_api_key: null };
  },

  updateAnalyzerConfig(mode: string, anthropicApiKey?: string | null): void {
    const db = getDb();
    db.prepare('UPDATE analyzer_config SET mode = ?, anthropic_api_key = ? WHERE id = 1')
      .run(mode, anthropicApiKey ?? null);
  },
```

**Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 7: Commit**

```bash
git add src/database/repositories/invoiceRepo.ts
git commit -m "feat: invoiceRepo — supplier detail fields + analyzer config methods"
```

---

### Task 5: Update Claude text analyzer prompt for supplier details

**Files:**
- Modify: `src/ocr/claudeTextAnalyzer.ts`

**Step 1: Update CLAUDE_ANALYSIS_PROMPT constant**

Replace `CLAUDE_ANALYSIS_PROMPT` (lines 21-33) with:

```typescript
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

Формат ответа:
{"invoice_type":"тип документа","invoice_number":"номер или null","invoice_date":"YYYY-MM-DD или null","supplier":"название поставщика или null","supplier_inn":"ИНН поставщика или null","supplier_bik":"БИК банка или null","supplier_account":"расчетный счет или null","supplier_corr_account":"корр. счет или null","supplier_address":"адрес поставщика или null","total_sum":число или null,"items":[{"name":"название товара","quantity":число или null,"unit":"кг/шт/л/уп или null","price":число или null,"total":число или null}]}

OCR-ТЕКСТ ДЛЯ АНАЛИЗА:
`;
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/ocr/claudeTextAnalyzer.ts
git commit -m "feat: update Claude CLI prompt for supplier banking details"
```

---

### Task 6: Create Claude API analyzer

**Files:**
- Create: `src/ocr/claudeApiAnalyzer.ts`

**Step 1: Write the Claude API analyzer module**

```typescript
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import { ParsedInvoiceData } from './types';
import { logger } from '../utils/logger';

export interface ApiAnalyzerResult {
  success: boolean;
  data?: ParsedInvoiceData;
  rawText?: string;
  error?: string;
}

const CLAUDE_API_PROMPT = `Ты эксперт по распознаванию накладных. Проанализируй это изображение накладной и извлеки структурированные данные.

ВАЖНО:
- Верни ТОЛЬКО валидный JSON без пояснений и markdown
- Названия товаров указывай ТОЧНО как на изображении
- Если поле не найдено, используй null
- Для чисел используй точку как десятичный разделитель (30.60, не 30,60)
- Определи тип документа: "счет_на_оплату", "торг_12", "упд" или "счет_фактура"
- Данные покупателя (ООО "БФС") НЕ нужны — извлекай только данные ПОСТАВЩИКА
- Для "счет_на_оплату": извлеки ИНН, БИК, расчетный счет, корр. счет и адрес поставщика
- Для остальных типов: извлеки только ИНН поставщика (если есть)

Формат ответа:
{"invoice_type":"тип документа","invoice_number":"номер или null","invoice_date":"YYYY-MM-DD или null","supplier":"название поставщика или null","supplier_inn":"ИНН поставщика или null","supplier_bik":"БИК банка или null","supplier_account":"расчетный счет или null","supplier_corr_account":"корр. счет или null","supplier_address":"адрес поставщика или null","total_sum":число или null,"items":[{"name":"название товара","quantity":число или null,"unit":"кг/шт/л/уп или null","price":число или null,"total":число или null}]}`;

function getMediaType(imagePath: string): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  const ext = path.extname(imagePath).toLowerCase();
  const map: Record<string, 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/png', // BMP will be converted by sharp before reaching here
    '.tiff': 'image/png',
  };
  return map[ext] || 'image/jpeg';
}

export async function analyzeImageWithClaudeApi(
  imagePath: string,
  apiKey: string,
): Promise<ApiAnalyzerResult> {
  if (!apiKey) {
    return { success: false, error: 'Anthropic API key not configured' };
  }

  logger.info('Claude API Analyzer: starting image analysis', { imagePath });

  try {
    const imageBuffer = fs.readFileSync(imagePath);
    const base64Image = imageBuffer.toString('base64');
    const mediaType = getMediaType(imagePath);

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: CLAUDE_API_PROMPT,
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return { success: false, error: 'Claude API: no text in response' };
    }

    const text = textBlock.text.trim();
    logger.info('Claude API Analyzer: response received', { length: text.length });

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'Claude API: no JSON found in response', rawText: text };
    }

    const parsed = JSON.parse(jsonMatch[0]) as ParsedInvoiceData;
    if (!parsed.items) {
      parsed.items = [];
    }

    logger.info('Claude API Analyzer: successfully parsed data', {
      invoiceNumber: parsed.invoice_number,
      supplier: parsed.supplier,
      invoiceType: parsed.invoice_type,
      itemsCount: parsed.items.length,
    });

    return { success: true, data: parsed, rawText: text };
  } catch (err) {
    const msg = (err as Error).message;
    logger.error('Claude API Analyzer: error', { error: msg });
    return { success: false, error: `Claude API error: ${msg}` };
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/ocr/claudeApiAnalyzer.ts
git commit -m "feat: add Claude API analyzer — direct image analysis via Anthropic SDK"
```

---

### Task 7: Update ocrManager — add Claude API mode

**Files:**
- Modify: `src/ocr/ocrManager.ts`

**Step 1: Add import and new method**

Add import at top (after line 5):

```typescript
import { analyzeImageWithClaudeApi } from './claudeApiAnalyzer';
import { invoiceRepo } from '../database/repositories/invoiceRepo';
```

Add new method to `OcrManager` class (after `recognizeHybrid`, before closing `}`):

```typescript
  /**
   * Claude API mode: отправляет изображение напрямую в Anthropic API.
   * Claude сам делает OCR + структуризацию в одном запросе.
   * Google Vision не используется.
   */
  async recognizeWithClaudeApi(imagePath: string): Promise<OcrResult> {
    const analyzerConfig = invoiceRepo.getAnalyzerConfig();
    const apiKey = analyzerConfig.anthropic_api_key;

    if (!apiKey) {
      throw new Error('Anthropic API key not configured. Set it in Settings.');
    }

    // Preprocess image
    const processedPath = await this.preprocessImage(imagePath);

    try {
      const result = await analyzeImageWithClaudeApi(processedPath, apiKey);

      if (result.success && result.data) {
        return {
          text: result.rawText || JSON.stringify(result.data, null, 2),
          engine: 'claude_api',
          structured: result.data,
        };
      }

      throw new Error(result.error || 'Claude API analysis failed');
    } finally {
      // Clean up temp file
      if (processedPath !== imagePath) {
        try { fs.unlinkSync(processedPath); } catch { /* ignore */ }
      }
    }
  }
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/ocr/ocrManager.ts
git commit -m "feat: ocrManager — add recognizeWithClaudeApi method"
```

---

### Task 8: Update fileWatcher — route to correct analyzer mode

**Files:**
- Modify: `src/watcher/fileWatcher.ts`

**Step 1: Add import and update processFile method**

Add import (after line 9):

```typescript
import { invoiceRepo as invoiceRepoForConfig } from '../database/repositories/invoiceRepo';
```

Wait — `invoiceRepo` is already imported. So just use it directly.

Replace the OCR section in `processFile` (lines 96-103) with:

```typescript
      let ocrResult;
      if (forceEngine) {
        ocrResult = await this.ocrManager.recognizeWithEngine(filePath, forceEngine);
      } else {
        // Check analyzer mode from DB config
        const analyzerConfig = invoiceRepo.getAnalyzerConfig();

        if (analyzerConfig.mode === 'claude_api') {
          // Claude API mode: send image directly to Anthropic API
          ocrResult = await this.ocrManager.recognizeWithClaudeApi(filePath);
        } else if (config.useClaudeAnalyzer) {
          // Hybrid mode: Google Vision OCR + Claude CLI text analysis
          ocrResult = await this.ocrManager.recognizeHybrid(filePath, true);
        } else {
          // Fallback: Google Vision only + regex parser
          ocrResult = await this.ocrManager.recognize(filePath);
        }
      }
```

**Step 2: Update the `updateInvoiceData` call to include supplier fields**

Replace the `updateInvoiceData` call in the non-merged branch (lines 151-158) with:

```typescript
        invoiceRepo.updateInvoiceData(invoice.id, {
          invoice_number: parsed.invoice_number,
          invoice_date: parsed.invoice_date,
          supplier: parsed.supplier,
          total_sum: parsed.total_sum,
          invoice_type: parsed.invoice_type,
          supplier_inn: parsed.supplier_inn,
          supplier_bik: parsed.supplier_bik,
          supplier_account: parsed.supplier_account,
          supplier_corr_account: parsed.supplier_corr_account,
          supplier_address: parsed.supplier_address,
        });
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/watcher/fileWatcher.ts
git commit -m "feat: fileWatcher — route to Claude API or hybrid mode based on config"
```

---

### Task 9: Add settings API route

**Files:**
- Create: `src/api/routes/settings.ts`
- Modify: `src/api/server.ts`

**Step 1: Create settings route**

```typescript
import { Router, Request, Response } from 'express';
import { invoiceRepo } from '../../database/repositories/invoiceRepo';
import { logger } from '../../utils/logger';

const router = Router();

// GET /api/settings/analyzer — get current analyzer config
router.get('/analyzer', (_req: Request, res: Response) => {
  try {
    const config = invoiceRepo.getAnalyzerConfig();
    res.json({
      data: {
        mode: config.mode,
        has_api_key: !!config.anthropic_api_key,
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// PUT /api/settings/analyzer — update analyzer config
router.put('/analyzer', (req: Request, res: Response) => {
  try {
    const { mode, anthropic_api_key } = req.body;

    if (!mode || !['hybrid', 'claude_api'].includes(mode)) {
      res.status(400).json({ error: 'Invalid mode. Must be "hybrid" or "claude_api"' });
      return;
    }

    if (mode === 'claude_api' && !anthropic_api_key) {
      // Check if there's already a key stored
      const current = invoiceRepo.getAnalyzerConfig();
      if (!current.anthropic_api_key) {
        res.status(400).json({ error: 'Anthropic API key is required for Claude API mode' });
        return;
      }
      // Keep existing key, just switch mode
      invoiceRepo.updateAnalyzerConfig(mode);
    } else {
      invoiceRepo.updateAnalyzerConfig(mode, anthropic_api_key);
    }

    logger.info('Analyzer config updated', { mode });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
```

**Step 2: Register route in server.ts**

Add import (after line 10):
```typescript
import settingsRouter from './routes/settings';
```

Add route (after line 38):
```typescript
  app.use('/api/settings', apiKeyAuth, settingsRouter);
```

**Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git add src/api/routes/settings.ts src/api/server.ts
git commit -m "feat: add /api/settings/analyzer endpoint for mode switching"
```

---

### Task 10: Update webhook payload with supplier details

**Files:**
- Modify: `src/integration/webhook.ts`

**Step 1: Add supplier fields to webhook payload**

In the `sendToWebhook` function, update the payload object (lines 31-44) to include:

```typescript
  const payload = {
    invoice_id: invoice.id,
    invoice_number: invoice.invoice_number,
    invoice_date: invoice.invoice_date,
    invoice_type: invoice.invoice_type,
    supplier: invoice.supplier,
    supplier_inn: invoice.supplier_inn,
    supplier_bik: invoice.supplier_bik,
    supplier_account: invoice.supplier_account,
    supplier_corr_account: invoice.supplier_corr_account,
    supplier_address: invoice.supplier_address,
    total_sum: invoice.total_sum,
    items: invoice.items.map(item => ({
      name: item.original_name,
      mapped_name: item.mapped_name,
      quantity: item.quantity,
      unit: item.unit,
      price: item.price,
      total: item.total,
    })),
  };
```

**Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/integration/webhook.ts
git commit -m "feat: include supplier banking details in webhook payload"
```

---

### Task 11: Frontend — Settings page

**Files:**
- Create: `public/js/settings.js`
- Modify: `public/index.html`

**Step 1: Create settings.js**

```javascript
/* global App, Settings */
const Settings = {
  loaded: false,

  async load() {
    if (this.loaded) return;
    try {
      const { data } = await App.apiJson('/settings/analyzer');
      if (data) {
        const modeRadio = document.querySelector(`input[name="analyzer-mode"][value="${data.mode}"]`);
        if (modeRadio) modeRadio.checked = true;
        this.toggleApiKeyField(data.mode);
        if (data.has_api_key) {
          document.getElementById('api-key-status').textContent = 'API-ключ сохранён';
          document.getElementById('api-key-status').style.color = 'var(--green)';
        }
      }
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load settings', e);
    }

    document.querySelectorAll('input[name="analyzer-mode"]').forEach(radio => {
      radio.addEventListener('change', () => this.toggleApiKeyField(radio.value));
    });
  },

  toggleApiKeyField(mode) {
    const apiKeyGroup = document.getElementById('api-key-group');
    apiKeyGroup.style.display = mode === 'claude_api' ? 'block' : 'none';
  },

  async save() {
    const mode = document.querySelector('input[name="analyzer-mode"]:checked')?.value;
    if (!mode) return;

    const body = { mode };
    const apiKeyInput = document.getElementById('settings-api-key');
    if (mode === 'claude_api' && apiKeyInput.value.trim()) {
      body.anthropic_api_key = apiKeyInput.value.trim();
    }

    try {
      const res = await App.api('/settings/analyzer', { method: 'PUT', body });
      if (res.ok) {
        App.notify('Настройки анализатора сохранены', 'success');
        document.getElementById('api-key-status').textContent = mode === 'claude_api' ? 'API-ключ сохранён' : '';
        apiKeyInput.value = '';
      } else {
        const data = await res.json();
        App.notify(data.error || 'Ошибка сохранения', 'error');
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  }
};
```

**Step 2: Add Settings section and nav link to index.html**

Add nav link (after line 35, the webhook nav link):
```html
        <a href="#/settings" data-tab="settings">Настройки</a>
```

Add settings section (after the webhook section closing `</section>`, before `</main>`):
```html
    <!-- Settings Section -->
    <section id="view-settings">
      <h2 style="margin-bottom:20px">Настройки анализатора</h2>
      <div class="card">
        <div class="form-group">
          <label>Режим распознавания</label>
          <div class="radio-group">
            <label class="radio-label">
              <input type="radio" name="analyzer-mode" value="hybrid" checked>
              <div>
                <strong>Google Vision + Claude CLI</strong>
                <div class="radio-desc">Бесплатно (MAX подписка). Google Vision для OCR, Claude CLI для структуризации текста.</div>
              </div>
            </label>
            <label class="radio-label">
              <input type="radio" name="analyzer-mode" value="claude_api">
              <div>
                <strong>Claude API (Anthropic)</strong>
                <div class="radio-desc">Платно (~$0.01/накладная). Изображение отправляется напрямую в Claude API. Понимает таблицы без Google Vision.</div>
              </div>
            </label>
          </div>
        </div>
        <div class="form-group" id="api-key-group" style="display:none">
          <label>API-ключ Anthropic</label>
          <input type="password" id="settings-api-key" placeholder="sk-ant-api03-...">
          <div id="api-key-status" class="field-hint"></div>
        </div>
        <div style="margin-top:24px">
          <button class="btn btn-primary" onclick="Settings.save()">Сохранить</button>
        </div>
      </div>
    </section>
```

Add script tag (after line 184):
```html
<script src="/js/settings.js"></script>
```

**Step 3: Commit**

```bash
git add public/js/settings.js public/index.html
git commit -m "feat: add Settings page with analyzer mode toggle"
```

---

### Task 12: Frontend — route settings page + CSS

**Files:**
- Modify: `public/js/app.js`
- Modify: `public/css/style.css`

**Step 1: Add settings route to app.js**

Add in the `route()` method (after the webhook `else if` block, around line 56):

```javascript
    } else if (hash === '#/settings') {
      document.getElementById('view-settings').style.display = 'block';
      document.querySelector('nav a[data-tab="settings"]').classList.add('active');
      Settings.load();
```

**Step 2: Add radio and settings styles to style.css**

Append to end of `style.css`:

```css
/* Radio group */
.radio-group { display: flex; flex-direction: column; gap: 12px; }
.radio-label { display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; transition: border-color 0.2s; }
.radio-label:has(input:checked) { border-color: var(--primary); background: #f0f7ff; }
.radio-label input[type="radio"] { margin-top: 4px; }
.radio-desc { font-size: 13px; color: var(--grey); margin-top: 4px; }
.field-hint { font-size: 12px; color: var(--grey); margin-top: 4px; }
```

**Step 3: Commit**

```bash
git add public/js/app.js public/css/style.css
git commit -m "feat: settings route + radio group CSS styles"
```

---

### Task 13: Frontend — show supplier details in invoice card

**Files:**
- Modify: `public/js/invoices.js`

**Step 1: Add supplier details block to showDetail method**

In the `showDetail` method, after the header `innerHTML` assignment (after line 166), add:

```javascript
      // Supplier details (banking)
      const supplierBlock = document.getElementById('invoice-supplier-details');
      if (data.supplier_inn || data.supplier_bik || data.supplier_account) {
        let html = '<div class="invoice-header">';
        if (data.invoice_type) {
          html += `<div class="invoice-field"><div class="field-label">Тип документа</div><div class="field-value">${data.invoice_type}</div></div>`;
        }
        if (data.supplier_inn) {
          html += `<div class="invoice-field"><div class="field-label">ИНН</div><div class="field-value">${data.supplier_inn}</div></div>`;
        }
        if (data.supplier_bik) {
          html += `<div class="invoice-field"><div class="field-label">БИК</div><div class="field-value">${data.supplier_bik}</div></div>`;
        }
        if (data.supplier_account) {
          html += `<div class="invoice-field"><div class="field-label">Расч. счёт</div><div class="field-value">${data.supplier_account}</div></div>`;
        }
        if (data.supplier_corr_account) {
          html += `<div class="invoice-field"><div class="field-label">Корр. счёт</div><div class="field-value">${data.supplier_corr_account}</div></div>`;
        }
        if (data.supplier_address) {
          html += `<div class="invoice-field"><div class="field-label">Адрес</div><div class="field-value">${data.supplier_address}</div></div>`;
        }
        html += '</div>';
        supplierBlock.innerHTML = html;
        supplierBlock.style.display = 'block';
      } else {
        supplierBlock.style.display = 'none';
      }
```

**Step 2: Add the supplier details container to index.html**

In `public/index.html`, after the first card in invoice-detail (after line 74, after the actions div), add:

```html
        <div class="card" id="invoice-supplier-details" style="display:none">
          <h3 style="margin-bottom:12px">Реквизиты поставщика</h3>
        </div>
```

**Step 3: Commit**

```bash
git add public/js/invoices.js public/index.html
git commit -m "feat: show supplier banking details in invoice detail view"
```

---

### Task 14: Update .env with API key + config

**Files:**
- Modify: `.env`
- Modify: `src/config.ts`

**Step 1: Add ANTHROPIC_API_KEY to .env**

Add after `CLAUDE_CODE_GIT_BASH_PATH` line:

```env
# Anthropic API (для режима Claude API)
ANTHROPIC_API_KEY=sk-ant-api03-...  # put real key only in .env on the server, never commit
```

**Step 2: Add to config.ts**

Add after `useClaudeAnalyzer` line:

```typescript
  anthropicApiKey: envStr('ANTHROPIC_API_KEY', ''),
```

**Step 3: Seed the API key into analyzer_config on startup**

In `src/database/migrations.ts`, after the `INSERT INTO analyzer_config` block, add logic to seed from .env if table was just created and env var is set. Actually, the simpler approach: let the settings API handle this. The .env key is just a fallback.

In `src/ocr/ocrManager.ts` `recognizeWithClaudeApi` method, update to fallback to config:

```typescript
  async recognizeWithClaudeApi(imagePath: string): Promise<OcrResult> {
    const analyzerConfig = invoiceRepo.getAnalyzerConfig();
    const apiKey = analyzerConfig.anthropic_api_key || config.anthropicApiKey;
    ...
  }
```

Add config import if not already there. `config` is already imported.

**Step 4: Commit**

```bash
git add .env src/config.ts src/ocr/ocrManager.ts
git commit -m "feat: add ANTHROPIC_API_KEY to config with .env fallback"
```

---

### Task 15: Verify end-to-end

**Step 1: Restart dev server and verify no errors**

Run: `npm run dev`
Expected: Server starts on port 3002 without errors

**Step 2: Test settings API**

```bash
curl -H "X-API-Key: your-secret-api-key" http://localhost:3002/api/settings/analyzer
```
Expected: `{"data":{"mode":"hybrid","has_api_key":false}}`

**Step 3: Test switching to Claude API mode**

```bash
curl -X PUT -H "Content-Type: application/json" -H "X-API-Key: your-secret-api-key" \
  -d '{"mode":"claude_api","anthropic_api_key":"sk-ant-api03-..."}' \
  http://localhost:3002/api/settings/analyzer
```
Expected: `{"success":true}`

**Step 4: Open dashboard and verify Settings page**

Open: `http://localhost:3002/#/settings`
Expected: Radio buttons for mode, API key field appears when Claude API selected

**Step 5: Drop a test image into inbox and verify processing**

Copy a test invoice image to `data/inbox/`. Check logs for Claude API analyzer output.

**Step 6: Verify supplier details appear in invoice detail**

Open the processed invoice in dashboard. If it's a "Счет на оплату", banking details should be visible.

**Step 7: Final commit**

```bash
git add -A
git commit -m "feat: supplier banking details + Claude API analyzer mode - complete"
```
