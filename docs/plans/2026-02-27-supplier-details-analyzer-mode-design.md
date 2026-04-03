# Supplier Banking Details + Analyzer Mode Switch

**Date:** 2026-02-27
**Status:** Approved

---

## Problem

1. Invoice parser does not extract supplier banking details (INN, BIK, accounts, address) from "Schet na oplatu" documents.
2. Claude CLI fails when launched from within another Claude Code session (nested session error).
3. No way to switch between free (CLI) and paid (API) analysis modes.

## Design

### Invoice Type Detection & Supplier Details

Two invoice categories with different data extraction:

**"Schet na oplatu" (payment invoice):**
- `invoice_type`: "счет_на_оплату"
- `supplier_inn` - INN
- `supplier_bik` - BIK
- `supplier_account` - settlement account (расчетный счет)
- `supplier_corr_account` - correspondent account (корр. счет)
- `supplier_address` - address
- Buyer data (ООО "БФС") is always ignored

**"Schet-faktura" / TORG-12 / UPD:**
- `invoice_type`: "торг_12" | "упд" | "счет_фактура"
- `supplier_inn` - only INN (if found)
- No banking details

### Analyzer Mode Switch

Two modes stored in DB (`analyzer_config` table), switchable from Settings UI:

| Feature | Google Vision + CLI (default) | Claude API |
|---------|-------------------------------|------------|
| OCR | Google Vision API | Claude vision (built-in) |
| Analysis | Claude CLI (MAX subscription) | Claude API (Anthropic SDK) |
| Cost | Free | ~$0.01/invoice |
| Image | NOT sent to Claude | Sent directly as base64 |
| Accuracy | 100% with Claude analyzer | 100% (native vision) |

**Claude API mode:** Image is sent directly to Anthropic API as base64. Claude performs both OCR and structuring in a single request. No Google Vision needed.

**Google Vision + CLI mode:** Current hybrid approach. Google Vision extracts text, Claude CLI structures it.

### Database Changes

New columns in `invoices`:
```sql
ALTER TABLE invoices ADD COLUMN invoice_type TEXT;
ALTER TABLE invoices ADD COLUMN supplier_inn TEXT;
ALTER TABLE invoices ADD COLUMN supplier_bik TEXT;
ALTER TABLE invoices ADD COLUMN supplier_account TEXT;
ALTER TABLE invoices ADD COLUMN supplier_corr_account TEXT;
ALTER TABLE invoices ADD COLUMN supplier_address TEXT;
```

New table `analyzer_config`:
```sql
CREATE TABLE analyzer_config (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'hybrid',  -- 'hybrid' | 'claude_api'
  anthropic_api_key TEXT
);
```

### New Files

- `src/ocr/claudeApiAnalyzer.ts` - Anthropic SDK integration, sends base64 image, returns ParsedInvoiceData with supplier details

### Modified Files

- `src/ocr/types.ts` - Add supplier fields to ParsedInvoiceData
- `src/ocr/claudeTextAnalyzer.ts` - Update prompt to extract supplier details
- `src/ocr/ocrManager.ts` - Route to API or CLI based on config
- `src/database/migrations.ts` - New columns + table
- `src/database/repositories/invoiceRepo.ts` - Save/return supplier fields
- `src/api/routes/invoices.ts` - Return supplier fields in API
- `src/api/routes/settings.ts` - New route for analyzer config CRUD
- `src/integration/webhook.ts` - Include supplier details in payload
- `public/js/invoices.js` - Show supplier details in invoice card
- `public/js/settings.js` - New settings page with mode toggle
- `public/index.html` - Add Settings nav item
- `public/css/style.css` - Settings page styles
- `.env` - Add ANTHROPIC_API_KEY
- `src/config.ts` - Add anthropicApiKey

### UI

**Invoice detail page:** New "Реквизиты поставщика" block showing INN, BIK, accounts, address (conditional on invoice_type).

**Settings page (new):**
- Radio toggle: "Google Vision + Claude CLI" / "Claude API"
- API key input field (shown when Claude API selected)
- Save button
- Current mode indicator
