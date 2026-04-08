# Site Feature Roadmap - 2026-04-07

> This document focuses on product functionality and operator experience, not low-level security/performance fixes. For the technical hardening roadmap, see the other 2026-04-07 audit plans in this folder.

## What The Site Already Does Well

The site already covers the main operational loop:

- invoice list
- invoice detail with items, photos, OCR text
- upload
- mobile camera capture
- nomenclature mapping
- webhook/1C settings
- analyzer settings

That means the next stage is not "add random pages". The next stage is to make the operator workflow faster, safer, and easier to control under real volume.

## Main Product Gap

Right now the dashboard is functional, but it still behaves more like an admin panel than an operations workspace.

The biggest missing layer is:

- a clear attention center for exceptions
- fast operator review tools
- better visibility into what blocks sending to 1C
- easier work with duplicates, suspicious OCR, and supplier-specific patterns

## Most Important Features To Add

## Priority A - Highest Business Value

### 1. Attention Center / Review Queue

What it is:

- a dedicated page with buckets like:
  - needs review
  - OCR low confidence
  - unmapped items
  - webhook/1C send failed
  - stuck in processing
  - possible duplicates

Why it matters:

- today the operator has to infer problems from the generic invoice list
- this feature turns the site into a real daily workspace

Expected effect:

- faster issue resolution
- fewer forgotten invoices
- less time spent filtering manually

### 2. Saved Filters And Fast Search

What it is:

- global search by invoice number, supplier, file name, amount
- quick filters by status, date, supplier, OCR engine, needs review
- saved views like:
  - today's errors
  - waiting for 1C
  - supplier X unmapped items

Why it matters:

- the current list becomes hard to use as data grows
- operators repeat the same filter patterns every day

Expected effect:

- much faster navigation
- lower cognitive load

### 3. Bulk Actions

What it is:

- select many invoices and:
  - send to 1C
  - approve
  - reprocess
  - mark as reviewed
  - export

Why it matters:

- without bulk actions, every operational spike becomes painful

Expected effect:

- large productivity gain for repetitive work

### 4. Inline Review Of Header Fields

What it is:

- editable invoice number, date, supplier, totals, VAT, supplier requisites directly in detail view
- low-confidence fields visually highlighted
- one-click "confirmed" marker per field or per document

Why it matters:

- today item mapping is visible, but document-level verification can still be clumsy

Expected effect:

- fewer wrong documents going to 1C
- much cleaner human-in-the-loop flow

### 5. Duplicate And Multi-Page Control

What it is:

- show possible duplicates
- show related pages/documents
- allow manual merge/split
- explain why the system thinks documents are related

Why it matters:

- invoice ingestion always accumulates edge cases around duplicates and multi-page docs

Expected effect:

- lower cleanup cost
- fewer accidental duplicate entries in 1C

## Priority B - Very Important Next Layer

### 6. Supplier Workspace

What it is:

- supplier profile page with:
  - recent invoices
  - usual mappings
  - bank details
  - error history
  - duplicate OCR names for the same goods

Why it matters:

- many problems repeat per supplier, not randomly

### 7. Delivery Center For 1C/Webhook

What it is:

- delivery history:
  - sent
  - failed
  - retries
  - last response
  - payload preview

Why it matters:

- operators need to know whether the problem is OCR, mapping, or transport

### 8. Activity Log / Audit Trail

What it is:

- who changed what
- when an invoice was edited, approved, reprocessed, or sent
- comments and internal notes

Why it matters:

- once multiple people touch the dashboard, silent changes become dangerous

### 9. Notifications And SLA Alerts

What it is:

- visible alerts for:
  - invoices stuck too long
  - rising error rate
  - webhook failures
  - too many unmapped items

Why it matters:

- prevents invisible backlog growth

### 10. Mobile Capture Session Assistant

What it is:

- capture multiple pages in one session
- page ordering hints
- blur/quality warning
- "same invoice?" confirmation during capture

Why it matters:

- better input quality upstream reduces downstream operator pain

## Recommended Product Order

### Phase 1

- Attention Center / Review Queue
- Saved Filters And Fast Search
- Bulk Actions

### Phase 2

- Inline Review Of Header Fields
- Duplicate And Multi-Page Control
- Delivery Center

### Phase 3

- Supplier Workspace
- Activity Log
- Notifications
- Mobile Capture Assistant

## What I Would Start With Tomorrow

If only one product feature starts tomorrow, it should be:

1. Attention Center / Review Queue

If two can start:

1. Attention Center / Review Queue
2. Saved Filters And Fast Search

This pair gives the fastest user-visible value and naturally prepares the project for bulk actions later.

## Success Metrics

After these product improvements, the most useful metrics to watch are:

- median time from upload to operator-ready state
- median time from "needs review" to "sent to 1C"
- count of invoices stuck in `ocr_processing`
- count of invoices with unmapped items
- count of duplicate/manual merge cases
- operator clicks per invoice

