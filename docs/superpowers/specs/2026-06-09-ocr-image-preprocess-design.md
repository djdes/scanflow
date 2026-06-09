# Pre-OCR image enhancement (Phase 1)

**Date:** 2026-06-09
**Status:** approved + A/B-validated

## Problem

Recognition of dense / faint invoice rows is unreliable. The trigger case:
invoice #99 (17-0331874), row 17 "Майонез Московский Провансаль классический
67% ведро 4,8кг" — the model misread the package format and, in repeated local
runs on the ORIGINAL image, also got the **quantity / price / total wrong**
(qty 1 or 12 instead of 4, price null, total 3688/659 instead of 3658).

Root cause: the Claude image API downscales large scans (~1.15 MP / ≤1568px long
edge), so a 12 MP ТОРГ-12's fine print degrades. A prompt can't fix unreadable
pixels (an earlier prompt-only change did not help in testing).

## Decision (from brainstorming)

- **Phase 1 = simple, single-image server-side enhancement** (contrast + sharpen,
  guarded margin-trim). One image, both OCR modes, low risk. Escalate to tiling
  (Phase 2) only if Phase 1 proves insufficient.
- **No auto-orient (.rotate()).** The current pipeline serves raw (upright)
  pixels; applying a misleading EXIF tag could rotate a correct image sideways.
- **Validate with an A/B test before deploying** ("only if it helps").

## Architecture

### `src/ocr/imagePreprocess.ts` — `preprocessInvoiceImage(input: Buffer|string): Promise<Buffer>`

Sharp pipeline, conservative and **never-throwing** (returns the original bytes
on any failure — preprocessing must not break OCR):
1. **Guarded trim** of uniform margins (`.trim({threshold:20})`) — accepted only
   if it keeps ≥50% of area, removes <99%, and doesn't distort aspect ratio
   (>0.6 deviation). Otherwise the untrimmed image is used. (On a photo with a
   busy background this typically no-ops — fine.)
2. `.normalise()` — contrast stretch (faint/thin text gets crisper).
3. `.sharpen()` — edge contrast.
4. `.jpeg({quality:90})`.
Degenerate output (<1000 bytes) → fall back to original.

### Wiring (DRY, three OCR-input points)

- **Dispatcher (prod)** — `GET /api/dispatcher/photo/:invoiceId` serves
  `preprocessInvoiceImage(file)` bytes instead of the raw stream. A JPEG
  magic-byte sniff (`FF D8`) picks the Content-Type, so a fallback-to-original
  (webp/png) keeps its own type. **Only the OCR session sees the enhanced image;
  the user-facing photo (`/api/invoices/:id/photos/...`) is unchanged.**
- **claude_api** — a shared `encodeImageForApi(path)` helper preprocesses + base64s
  + picks media type, used by `analyzeImageWithClaudeApi` (single) and
  `analyzeMultipleImagesWithClaudeApi` (multi-page). (Bonus: bmp/tiff inputs now
  normalise to JPEG, which the Anthropic API accepts.)
- **hybrid** (Google Vision) path is untouched (legacy).

## A/B evidence (claude-sonnet-4-6, #99 photo, 3 pairs)

| Pair | ORIGINAL (qty/price/total) | PROCESSED |
|---|---|---|
| 1 | 1 / null / 3688 ✗ | **4 / 914.5 / 3658** ✓ |
| 2 | 12 / null / 3688 ✗ (+ row confusion) | **4 / 914.5 / 3658** ✓ |
| 3 | 1 / 659.64 / 659.64 ✗ | **4 / 914.5 / 3658** ✓; name read "67% 5л/4.8кг" |

PROCESSED was correct on qty/price/total in **3/3** runs; ORIGINAL wrong in
**3/3**. (Trim did not fire — the win is contrast/sharpen, not cropping.) The
exact фасовка weight is still inconsistent ("5л" vs "4.8кг") — a secondary nicety,
out of scope for Phase 1.

## Error handling / edge cases

- `preprocessInvoiceImage` never throws; any sharp error → original bytes.
- Trim guard prevents cropping into the document.
- Dispatcher endpoint sniffs JPEG magic for Content-Type; `res.send(buffer)`
  (buffers ~3 MB in memory — acceptable, once per task).
- Orientation unchanged vs today (no rotate).

## Testing

- `npx tsc --noEmit` + `npm test` (no failures).
- A/B above (sonnet). Post-deploy: re-recognize #99 on prod (opus, dispatcher),
  confirm the майонез row and site health.

## Out of scope (Phase 2, only if needed)

- Tiling / multi-call + merge for true resolution gain.
- Crop-to-table detection (beyond uniform-margin trim).
- Auto-orientation handling.
