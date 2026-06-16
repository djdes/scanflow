# Auto-mapping: reliably find & apply catalog matches (incl. after catalog sync)

**Date:** 2026-06-09
**Status:** draft — awaiting go-ahead to implement

## Problem

Invoice items that have a clear 1C-catalog match are left **unmapped** (red dot)
and the user has to map them by hand. Reported case:

- **Invoice #133**, item **`Лист винограда (ведро)`** → `onec_guid = NULL`,
  `confidence = 0`, `mapped_name = "Лист винограда (ведро)"` (source `none`).
- The 1C catalog **does** contain a *verbatim* entry `Лист винограда (ведро)`
  (guid `5645a6a7-…`, non-folder, unit `кг`).
- `Лук зеленый` in the same invoice mapped fine (`conf 1.0`).

User expectation: *«сопоставления должны сами находиться и сопоставляться»* —
items with an obvious catalog match must be found and applied automatically, and
stay mapped as the catalog grows.

## Root cause

Mapping runs **once, at ingest** (`fileWatcher` / dispatcher → `NomenclatureMapper.map()`).
The timeline proves the gap:

| event | time |
|------|------|
| invoice #133 processed (item stored unmapped — catalog had no match yet) | `2026-06-16 10:58:58` |
| `Лист винограда (ведро)` appears in catalog (1C sync) | `2026-06-16 11:20:07` |

The item was added to the catalog **~21 min after** the invoice was processed.
`POST /api/nomenclature/sync` **invalidates the mapper cache** (so *new* uploads
benefit) but does **not re-map existing rows** — so #133 stays NULL forever.

Two secondary weaknesses make it worse:

1. **`getSuggestions()` (the inline editor dropdown) uses only Fuse**, and Fuse
   returns `(none)` even for the exact substring `Лист винограда` →
   `Лист винограда (ведро)`. So when the user opens the editor to fix it by hand,
   the correct catalog item isn't even suggested. The newer token-IDF matcher in
   `map()` would find it, but `getSuggestions()` doesn't use it.
2. **No exact-name shortcut.** Matching relies on Fuse/token scoring, which (as
   shown) can miss a *verbatim* catalog name.

The token-IDF matcher itself is **not** broken — #133 is a staleness/coverage
gap, not a scoring bug.

## Goals

- Unmapped items get mapped **automatically when the catalog gains a match**
  (the #133 scenario).
- **Verbatim / normalized-exact** catalog names always map, deterministically,
  at confidence 1.0.
- The manual editor dropdown suggests the **same** matches the auto-mapper finds
  (parity), surfacing the confident match on top.

### Non-goals

- Retro-editing items already **sent to 1C** inside 1C (we can't rewrite posted
  documents). Updating the ScanFlow row for record/visibility is a separate
  decision (see Open Questions).
- Rewriting the token-IDF scoring (it works; see `2026-06-…` mapping change).

## Proposed solution (three parts)

### Part A — Exact normalized-name catalog stage (deterministic)

In `NomenclatureMapper`, build a `Map<normalizedName, OnecRow>` at index-refresh
time (alongside the Fuse + token-IDF indexes). In `map()`, **before** token-IDF
and Fuse:

- if `normalizeName(scanned)` equals a catalog item's `normalizeName(name)` (or
  `full_name`) → return it, `confidence: 1.0`, `source: 'onec_exact'`.
- normalization reuses the existing `normalizeName` (strips `(ведро)`, measures),
  so scanned `Лист винограда (ведро)` and catalog `Лист винограда (ведро)` both
  reduce to `Лист винограда` and match.
- **Ambiguity guard:** if >1 catalog item shares the normalized name, prefer the
  non-folder one; if still >1, skip exact and fall through to scored stages (no
  arbitrary pick).

Cheap (O(1)) and removes the Fuse fragility for verbatim names.

### Part B — Re-map unmapped items after a catalog sync

After `POST /api/nomenclature/sync` (and the `DELETE` + re-sync path), trigger a
**targeted, async** re-map of currently-unmapped items:

- **Scope:** items with `onec_guid IS NULL` on invoices **not yet sent**
  (`status IN ('processed','parsing','ocr_processing')`). Sent invoices excluded
  by default (Open Q1).
- **Efficiency:** prefer a targeted pass driven by the new exact index — for each
  unmapped item, attempt `map()`; cheap because exact/learned hit first. Bound to
  a recent window (e.g. last 90 days) to cap work; **log truncation** if capped.
- **Apply:** only fill NULLs. For each newly-resolved item call
  `invoiceRepo.updateItemMapping(...)` (triggers stats recompute). Emit a summary
  log + `integration_log` event (`nomenclature / items_remapped`).
- **Non-blocking:** run fire-and-forget *after* responding to `/sync` so sync
  latency is unaffected; never throw.
- Reusable as a **one-off backfill** (script) for the existing backlog of
  unmapped items.

### Part C — `getSuggestions()` parity (editor dropdown)

Rewrite `getSuggestions()` to use the same pipeline as `map()`
(exact → learned → token-IDF → Fuse) and return ranked `{guid, name, confidence}`.
Then the inline editor shows the real catalog item on top. Optional UX: the
frontend auto-selects a suggestion with `confidence ≥ threshold` (exact/1.0) so
the user only confirms.

### Part D — strip parentheses from the created (unmatched) name

When nothing matches, the item's 1C-bound name comes from `cleanItemName()`
(`src/mapping/nameCleaner.ts`). For #133 it produced **`Лист винограда (ведро)`**
— the `(ведро)` was left in, so 1C would create a Номенклатура *with brackets*.

Root cause: `cleanItemName` strips a **bare trailing** packaging word
(`TRAIL_PACK_RE` ends with `$`), but `(ведро)` carries a leading `(` and a
trailing `)`, so the regex never matches it. (The matcher's `normalizeName`
*does* strip all `(...)` groups — `cleanItemName` simply lacks that step.)

Fix: in `cleanItemName`, add a parenthetical-group strip inside the
fixed-point loop, e.g. `s = s.replace(/\s*\([^)]*\)\s*/g, ' ')`, so
`Лист винограда (ведро)` → `Лист винограда`. Keep it idempotent and keep the
"never destroy the name" fallback.

- **Decision (Open Q5):** strip **all** `(...)` groups (matches `normalizeName`
  and the user's «скобки не должны попадать в название»), or preserve a
  parenthesised fat-percent like `(3,2%)`? Recommend strip-all for parity;
  percent in parens is rare and usually written bare (`3,2%`).
- Note: once Part A lands, `Лист винограда (ведро)` will normally **match** the
  existing catalog entry (both normalize to `Лист винограда`) and won't create a
  new name at all — but `cleanItemName` must still be clean for genuinely-new
  items.

## Files (anticipated)

- `src/mapping/nomenclatureMapper.ts` — exact index + `map()` stage A +
  `getSuggestions()` rewrite.
- `src/api/routes/nomenclature.ts` — post-sync async re-map trigger.
- `src/database/repositories/invoiceRepo.ts` — `listUnmappedItems({withinDays, includeSent})` helper.
- `src/mapping/remapUnmapped.ts` (new) — shared backfill routine (route + script).
- `src/scripts/backfill-unmapped.ts` (new) — one-off for the current backlog.
- `public/js/invoices.js` (or item-editor module) — optional auto-select top suggestion.
- `tests/` — see Test plan.

## Edge cases / safety

- **Never override** an item that already has `onec_guid` (manual or auto) — fill
  NULLs only.
- **Respect manual mappings** — a user-confirmed mapping is authoritative.
- **Ambiguous exact name** (duplicate normalized names) → skip exact, fall back.
- **Learned mappings** keep top precedence (stage 1) — unchanged.
- **Auto-apply policy:** exact (1.0) and high-confidence token-IDF apply
  automatically; medium-confidence stays a *suggestion* only (Open Q2).
- **Performance:** backfill bounded + async + capped with logged truncation.

## Open questions (need your call before implementing)

1. **Re-map scope:** only un-sent invoices (default), or also update the ScanFlow
   row for `sent_to_1c` items (for record, even though 1C won't change)? Window:
   all-time, or last N days?
2. **Auto-apply threshold:** apply exact (1.0) automatically — agreed. Also
   auto-apply token-IDF matches ≥ X (e.g. 0.8), or only *suggest* them?
3. **Trigger(s):** re-map on every catalog sync (recommended) + a manual
   «Сопоставить заново» button + a one-off backfill for the current backlog —
   which of these do you want?
4. **Editor UX:** auto-select the top confident suggestion, or just surface it?

## Decisions (2026-06-09, from user)

- **Part B (re-map existing on sync): DROPPED.** Re-mapping already-loaded items
  is *not wanted* — fixes apply at ingest only. #133 stays as-is (fix by hand via
  the editor suggestion).
- **Part A: YES** — exact normalized-name match, `source 'onec_exact'`, conf 1.0,
  auto-applied at ingest.
- **Q2 auto-apply threshold: exact (1.0) + token-IDF ≥ 0.8 auto-apply** at ingest.
  token-IDF in [0.5, 0.8) is NOT auto-applied (item stays unmapped) but remains a
  suggestion in the editor. (Raises `map()`'s token bar from 0.5 → 0.8. Trade-off:
  a few #94-style medium matches become editor suggestions instead of silent
  auto-maps — acceptable per user.)
- **Part C reframed → client-side Q4.** The inline editor dropdown is the
  CLIENT `OnecCatalog.search()` (not the server `getSuggestions`), and it already
  finds matches. So: for an item left unmapped, the editor **auto-selects the top
  `OnecCatalog` match when confident** (exact / high score) so the user only
  confirms. No server `getSuggestions` rewrite.
- **Part D: YES** — `cleanItemName` strips all `(...)` groups.

## Test plan (TDD, at implementation time)

- `map()` exact normalized match → conf 1.0, incl. `(ведро)` stripping
  (`Лист винограда (ведро)` → catalog entry).
- duplicate normalized names → no exact pick (falls back).
- post-sync backfill: seed unmapped item → sync catalog adding the match →
  item becomes mapped; already-mapped and manual items untouched; sent_to_1c per
  Q1 decision.
- `getSuggestions('Лист винограда (ведро)')` → exact catalog item ranked first.
- backfill is bounded and idempotent (re-run maps nothing new).
- `cleanItemName('Лист винограда (ведро)')` → `Лист винограда` (no brackets);
  idempotent; mid-name parens also stripped; never returns empty.
