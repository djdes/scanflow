# Task 3 Report: Sibling Banner + One-Click Merge

**Status:** DONE
**Date:** 2026-06-22

## Files Changed

- `public/app.html` — added `<div id="invoice-sibling-banner" style="display:none"></div>` directly above `<div class="card" id="invoice-tab-items">` (line 161)
- `public/js/invoices.js` — two insertions (see below)

## Syntax Check

```
node --check public/js/invoices.js → exit 0 (no output)
```

## Exact Insertion Points

### 1. `public/app.html` — banner container

Inserted at line 161, directly above `<div class="card" id="invoice-tab-items">`:

```html
        <div id="invoice-sibling-banner" style="display:none"></div>
        <div class="card" id="invoice-tab-items">
```

### 2. `public/js/invoices.js` — banner render block inside `showDetail`

Inserted after the `if (data.duplicate_of) { … return; }` block (the `return;` is at line 287, the banner block starts at line 290) and before `const unmappedCount = …` (line 319 after insertion).

Surrounding lines (pre-insertion):
```
        return;           // line 287 — end of duplicate_of early-return
      }                   // line 288

      const unmappedCount = ...  // was line 290, now line 319
```

After insertion, lines 290–318 contain the `sibs` banner block verbatim from the plan.

### 3. `public/js/invoices.js` — `mergeSibling` method

Inserted after `addPages`'s closing `},` (line 908) and before `async remap(id, forceAll)` (line 939 after insertion).

Surrounding lines:
```
    input.click();     // addPages body
  },                   // line 908 — addPages closing

  async mergeSibling(currentId, siblingId, sentWarning) {  // line 914 — new method
    ...
  },                   // line 937

  async remap(id, forceAll) {   // line 939 — existing next method
```

## Referenced Symbols Verification

All symbols used in the new code exist in `invoices.js` (87 matches):
- `App.formatMoney` — used in banner template
- `App.navigate` — used after merge success
- `App.api` — used for POST to merge-into endpoint
- `App.notify` — used for success/error toasts
- `this._withGuard` — used to deduplicate concurrent calls
- `this.showDetail` — used to reload after merge

`App.statusBadge` was listed in the task description but is NOT used in the verbatim plan code — the plan's banner uses `s.status === 'sent_to_1c'` directly. Not an issue.

## Object Literal Structure

`mergeSibling` is placed as a sibling method between `addPages` (ends with `},`) and `remap` (starts with `async remap`), preserving the correct comma-separated object-literal structure. `node --check` confirms no structural errors.
