# Tomorrow Product Plan - Review Queue First

> Tomorrow's feature work should begin here.

## Goal

Turn the dashboard from a generic invoice list into an operator workspace by adding a dedicated review queue.

## Why This First

This feature gives the best product ROI because it solves several real workflow problems at once:

- operators can see what needs attention immediately
- errors stop being hidden inside the main list
- stuck documents become visible
- later features like bulk actions and saved filters can build on the same data model

## Scope For Day 1

Build the first version of a new page: `#/queue`

It should include these buckets:

- needs review
- unmapped items
- error
- stuck processing
- waiting for 1C

Day 1 does not need perfect analytics or deep actions. The first version should already make the backlog visible and clickable.

## User Stories

- As an operator, I open the dashboard and instantly see what blocks processing.
- As an operator, I can jump straight to invoices that need manual work.
- As an operator, I can separate OCR errors from mapping issues from send issues.
- As an operator, I can focus on the highest-priority bucket first.

## Files Likely In Scope

- `public/index.html`
- `public/js/app.js`
- `public/js/invoices.js`
- `public/css/style.css`
- `src/api/routes/invoices.ts`
- `src/database/repositories/invoiceRepo.ts`

## Tasks

### 1. Add Queue Route And Page Shell

- [ ] Add nav item for `#/queue`
- [ ] Add a new page section with:
  - summary cards
  - bucket tabs or chips
  - result table

Done when:

- the app has a dedicated queue page and it opens from navigation

### 2. Add Queue Summary API

- [ ] Add an endpoint that returns counts for:
  - `error`
  - `ocr_processing` older than threshold
  - invoices with low-confidence or unmapped items
  - approved but not sent
  - optional possible duplicates

Done when:

- the frontend can render summary counters without client-side heavy logic

### 3. Add Queue List API

- [ ] Add an endpoint like `/api/invoices/queue?bucket=...`
- [ ] Return only the fields needed for the queue table
- [ ] Support at least:
  - `needs_review`
  - `unmapped`
  - `error`
  - `stuck`
  - `pending_1c`

Done when:

- clicking a bucket loads matching invoices from the backend

### 4. Define "Needs Review" Clearly

- [ ] Start with a practical rule:
  - invoice has unmapped items
  - or status is `error`
  - or OCR/parse state is stale
  - or not enough structured fields are present
- [ ] Keep the rule simple and document it in code comments

Done when:

- the bucket is deterministic and understandable

### 5. Add Quick Actions

- [ ] Each queue row should allow at least:
  - open invoice
  - reprocess if error
  - send to 1C if ready
- [ ] Day 1 can keep actions minimal

Done when:

- queue rows are actionable, not just informative

## Nice-To-Have If Time Remains

- keyboard shortcut to open the first queue item
- colored priority badges
- remember selected bucket in URL
- small "why this is here" explanation per row

## Verification

- [ ] `npm run build`
- [ ] queue page renders
- [ ] counters load
- [ ] each bucket returns data
- [ ] clicking a row opens invoice detail
- [ ] list performance remains acceptable

## What To Do Next After This

Immediately after the queue page ships, the next product feature should be:

1. saved filters and fast search

That combination will make the system feel much more like a real operations tool.

