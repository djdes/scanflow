# Business control and 1C onboarding

## Goal

Complete the operational loop that starts with document recognition and ends
with a verified 1C document and a reconciled payment. The release extends the
existing Operations Suite instead of creating parallel queues or replacing the
working 1C pull protocol.

## Existing capabilities being extended

ScanFlow already has a 1C nomenclature endpoint and external-processing source,
individual approvals, supplier terms, a 7/30/90 expense forecast, supplier
scores, exception detection and reconciliation against payments created by
ScanFlow in SberBusiness. Those paths remain compatible.

The missing product layer is: bulk exception handling, root-cause aggregation,
imported bank transactions, an editable payment calendar, automatic supplier
verification, result callbacks from 1C, batch approvals, correction learning,
additional document types, management exports and secure setup of another 1C
database.

## Product surface

The existing `#/operations` workspace gains four focused sections:

1. **Exceptions** supports selection and bulk approval, duplicate release and
   supplier verification. A root-cause panel groups problems by reason,
   supplier and document type.
2. **Payments** accepts a bank CSV, reconciles incoming/outgoing transactions
   with invoices, and exposes an editable due date, priority and hold reason.
   Calendar totals show daily and cumulative funding demand.
3. **Reports** contains monthly spend, document mix, supplier risk and exception
   summaries, with CSV export and a print-friendly view.
4. **1C connection** is an admin wizard. It creates a named, revocable,
   single-purpose token, shows a deterministic setup sequence, exposes current
   catalog/poll health and provides a handler source template without embedding
   a platform administrator API key.

## Backend and data model

Migration 46 is additive and idempotent:

- invoice payment plan and 1C result columns;
- `batch_id` on approval requests;
- supplier verification metadata and change-risk text;
- imported `bank_statement_entries` with a tenant owner and unique operation
  fingerprint;
- `ocr_corrections` for exact, supplier-aware correction memory;
- `onec_connections` containing only SHA-256 token hashes and a visible prefix.

Bank CSV import accepts semicolon/comma/tab separated files and common Russian
bank headings. Entries are deduplicated by external identifier or normalized
content hash. Matching is explainable: amount, supplier INN, invoice number in
payment purpose and date proximity contribute to the score. A transaction is
never marked paid below the confidence threshold.

Payment dates default to invoice date plus supplier terms, but an explicit
invoice due date wins. A hold removes the invoice from immediate funding demand
without deleting the obligation.

## 1C protocol

The new exchange router is intentionally narrow. A connection token can only:

- export/replace the nomenclature catalog;
- read approved pending invoices and their photos;
- report `created`, `posted`, `rejected` or `error` with the 1C reference;
- read and clear the catalog-sync request flag.

It cannot access users, settings, other tenants, payments or arbitrary API
routes. The clear-catalog operation is scoped to the connection owner. Tokens
are displayed once, stored only as hashes, revocable, and never written to logs.
The legacy administrator-key API remains available for existing deployed
handlers during migration.

## Correction learning and document types

Manual edits of stable header fields are recorded per supplier. On later scans,
an exact normalized value receives the learned replacement before persistence.
Existing nomenclature learning remains the primary line-item name mechanism.

The OCR contract adds acts, cash receipts, advance reports and a safe `other`
fallback while preserving the four existing Russian accounting document types.

## Security, tenancy and failure behaviour

- Every invoice and bank query follows the existing owner scope.
- Bulk mutation endpoints validate access to every selected invoice and cap a
  request at 100 records.
- Supplier verification is admin-only and records data differences rather than
  silently overwriting manually maintained bank requisites.
- CSV content is parsed in memory with a 5 MB limit; no spreadsheet formula is
  evaluated.
- A failed bulk item is returned as an item-level result and does not roll back
  successful independent items.
- Existing 1C handlers continue to work; new handlers use scoped tokens.
