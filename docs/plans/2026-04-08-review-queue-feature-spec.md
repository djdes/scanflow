# Review Queue Feature Spec

## Product Goal

Create a single operator-focused screen that answers one question:

"What needs my attention right now?"

## Core UI

The new page should contain:

### 1. Summary Cards

- Needs review
- Unmapped items
- Errors
- Stuck in processing
- Waiting for 1C

Each card should show:

- count
- short description
- click to filter the table below

### 2. Queue Table

Recommended columns:

- ID
- file name
- supplier
- invoice number
- created at
- issue type
- status
- short reason
- quick action

### 3. Quick Filters

- today
- last 3 days
- supplier
- status
- issue type

Day 1 may ship only issue-type filtering if needed.

## Bucket Definitions

### `error`

Invoices with `status = error`

### `stuck`

Invoices in `ocr_processing` or `parsing` older than a configured threshold, for example 10 or 15 minutes.

### `unmapped`

Invoices containing one or more items where:

- `mapped_name` is empty
- or `onec_guid` is empty
- or mapping confidence is below threshold

### `pending_1c`

Invoices approved for 1C but not yet confirmed as sent.

### `needs_review`

Union bucket. Start simple:

- all `error`
- all `stuck`
- all `unmapped`
- optionally invoices missing critical header fields

## Suggested API Shape

### `GET /api/invoices/queue/summary`

Returns:

```json
{
  "data": {
    "needs_review": 12,
    "unmapped": 7,
    "error": 3,
    "stuck": 2,
    "pending_1c": 9
  }
}
```

### `GET /api/invoices/queue?bucket=unmapped&limit=50&offset=0`

Returns a lightweight list, not the full invoice detail.

## UX Rules

- Clicking a summary card switches the active bucket.
- Clicking a row opens invoice detail.
- The queue should feel faster than the main invoice list.
- Explanations must be short and operational, not technical.

Examples of row reasons:

- `2 unmapped items`
- `processing > 15 min`
- `webhook send failed`
- `missing invoice number`

## Out Of Scope For Version 1

- full analytics dashboards
- cross-user assignments
- comments
- keyboard power mode
- duplicate clustering AI

## Version 2 Extensions

- assign invoice to operator
- mark as reviewed
- comments
- bulk actions
- saved queue presets
- duplicate review bucket

## Acceptance Criteria

- an operator can open one page and immediately understand today's backlog
- problematic invoices are not hidden inside the generic list
- each queue row leads directly to the corrective action
- the queue uses backend filtering instead of loading everything into the browser

