# ScanFlow Operations Suite

## Goal

Turn the existing OCR pipeline, mappings, 1C pull workflow, Sber draft creation,
notifications and supplier directory into one controlled operating loop. The
release covers the ten requested capabilities without replacing the proven OCR
or integration paths.

## Product surface

A new `#/operations` workspace contains five compact tabs:

1. **Control centre** — autopilot state, quality gates, exception queue and
   pending approvals.
2. **Payments** — Sber reconciliation and approval decisions.
3. **Suppliers** — scorecards and payment-term-aware expense forecast.
4. **Channels** — Telegram and email-webhook document intake.
5. **Assistant** — text or browser voice input for common operational questions.

The screen is useful on desktop and mobile and reuses the existing SPA, auth,
cards and notification patterns.

## Capability mapping

### 1. Autopilot 2.0

Existing `auto_send_1c` and `auto_send_sber` switches remain the action flags.
Before either action, a shared quality gate checks:

- processed status and no duplicate marker;
- invoice number, date, supplier, positive total and at least one item;
- item-to-total mismatch;
- all items mapped when configured;
- minimum item mapping confidence;
- maximum automatic amount;
- verified supplier when configured.

The gate returns explicit reasons. Rejected invoices stay visible in the
exception centre and are never silently auto-sent.

### 2. Telegram and email intake

- Telegram intake registers a Bot API webhook for the current user's existing
  bot. Only the configured chat is accepted. Photos and image documents are
  downloaded into the normal inbox and processed with `source=telegram`.
- Email intake exposes a generated high-entropy webhook address for a mail
  forwarder. Multipart image attachments enter the same pipeline with
  `source=email`.
- Only SHA-256 hashes of channel secrets are stored. Tokens are returned once.
  Endpoints are rate-limited and enforce the normal 20 MB image limit.

### 3. Extended duplicate protection

The detector keeps SHA-256 file protection and the existing exact business-key
match. It additionally scores near duplicates using normalized invoice number,
supplier identity, date, total tolerance, banking requisites and line-item
composition. The invoice stores score and evidence for an honest UI message.

### 4. Supplier-aware nomenclature learning

Manual corrections are stored both in the global mapping table and in a new
supplier-specific table. Mapping lookup checks the supplier override first,
then the current learned/exact/token/fuzzy pipeline. This handles the same scan
phrase meaning different products for different suppliers without weakening
global mappings.

### 5. Payment approval workflow

Users can request approval for a 1C hand-off or Sber draft. Admins approve or
reject from the operations centre. Approval is auditable. Approved 1C requests
mark the invoice for the existing 1C pull; approved Sber requests trigger the
existing authenticated Sber endpoint through the local API.

### 6. Sber reconciliation

The payments view joins invoices and `sber_payments`, classifies each row as
matched, amount mismatch, failed, pending, missing or overdue, and provides
summary totals. No bank transaction is invented: reconciliation is limited to
the Sber payment records ScanFlow actually owns.

### 7. Supplier scorecards

Scores use existing evidence: invoice count, OCR/error rate, duplicates,
item-total mismatches, elevated prices, payment coverage and overdue payments.
The API returns the component metrics as well as a 0–100 score.

### 8. Expense forecast

Forecast buckets are 7, 30 and 90 days. Outstanding invoices use the supplier's
payment terms (default 7 days). Historical monthly run-rate is shown separately
so forecast and actual obligations are not conflated.

### 9. Exception centre

Exceptions are computed from source-of-truth data rather than copied to a
second mutable queue: OCR errors, duplicates, mismatches, unmapped or
low-confidence items, elevated prices, missing verified supplier and pending
approvals. Links lead to the affected invoice.

### 10. Operational assistant

The assistant supports safe read-only intents over pre-aggregated data: unpaid
invoices, exceptions, suppliers, forecast, payment status and help. Browser
speech recognition supplies optional voice input. Unknown questions receive a
capability-oriented response; the assistant never executes arbitrary SQL or
mutations.

## Data model

Migration 45 adds:

- autopilot quality columns to `analyzer_config`;
- duplicate evidence columns to `invoices`;
- `payment_terms_days` to `suppliers`;
- `approval_requests`;
- `inbound_channels`;
- `supplier_nomenclature_mappings`.

All DDL is additive and idempotent. Existing flags default to their current
values, and new quality gates default to conservative settings.

## Security and tenancy

- Platform-global automation settings remain admin-only.
- Invoice queries use the same owner scoping semantics as the invoices API.
- Approval decisions are admin-only; creation is authenticated.
- Public inbound endpoints authenticate high-entropy hashed secrets and never
  accept an API key in query parameters.
- Assistant responses are computed from allow-listed aggregate queries.

## Failure behaviour

- Intake acknowledges Telegram quickly and processes files asynchronously.
- Channel failures are logged without exposing bot tokens or webhook secrets.
- Autopilot failures never change a successful OCR result into an error.
- Approval execution records the decision even if the downstream integration
  fails and returns an actionable execution error.
