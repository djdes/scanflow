# TableCV harness — batch metrics

## How to run

```bash
# from repo root, background:
node tools/tablecv-harness/serve.js . 8125
```

Then drive with Playwright:
- Geometry only (fast batch): `…/selftest.html?img=/data/processed/<file>&geom=1`
- Full pipeline (geometry + OCR + orientation): `…/selftest.html?img=/data/processed/<file>`

The server roots at the repo and aliases `/vendor/*` → `public/vendor/*` so the
modules' absolute asset paths resolve while `/data/*` photos are also served.

Fast pattern: navigate once to load opencv (9.9 MB), then run one `browser_evaluate`
loop over the file list calling `TableCVPre.run` → `TableCVDetect.runAuto` (geometry)
so opencv stays in memory.

## Sample set (10 photos from data/processed)

## Baseline — geometry (2026-06-24, before improvement tasks)

Params: maxSide 2000, blockSize 25, lineKernelFrac 0.12, projFrac 0.2.

| file | table found | rot | cells | cols | rows | region | note |
|------|:-----------:|:---:|------:|-----:|-----:|:------:|------|
| upload-1782204930225-139938.JPG | Y | 1 | 41 | 15 | 6 | Y | ТОРГ-12 p2, good grid; data row under-segments |
| upload-1776777779894-83832.jpg | Y | 2 | 63 | 4 | 17 | Y | portrait; columns under-detected (cols=4) |
| upload-1777034208075-466024.jpg | **N** | 0 | 0 | 0 | 9 | Y | horizontals only, no vertical lines → 0 cells |
| upload-1777464306383-87116.jpg | Y | 0 | 59 | 8 | 10 | Y | |
| upload-1778235182265-80780.jpg | Y | 0 | 114 | 6 | 21 | Y | many rows; cols low |
| upload-1779279091104-130252.jpg | Y | 0 | 100 | 8 | 13 | Y | |
| upload-1780918572327-57561.jpeg | Y | 1 | 31 | 17 | 4 | Y | wide table, good cols |
| upload-1781595256425-292003.jpg | Y | 0 | 6 | 9 | 1 | **N** | no region → whole-frame fallback; only 1 row |
| upload-1782138201443-519061.jpg | Y | 1 | 33 | 10 | 4 | Y | |
| upload-1782200821283-779834.JPG | Y | 2 | 20 | 11 | 10 | Y | heavy cell merging (20 ≪ 11×10) |

**Baseline: table found 9/10 (90%).**

### Known weaknesses to address
- 466024: vertical lines not detected in any orientation → the Task 4/5 column
  recovery + adaptive thresholds should target this.
- 83832, 80780: column count suspiciously low (under-segmentation) → Task 4.
- 779834: heavy merging (few cells vs cols×rows) → Task 4 / border sensitivity.
- 292003: no table region (whole-frame fallback) → Task 5 region acceptance.

### OCR baseline (spot check)
Full pipeline on upload-1782204930225-139938.JPG (earlier run): orientation
auto-corrected (conf 64 vs 35 upside-down); OCR readable — headers, units,
numbers, and the item description recognised; some empty cells emitted noise
(`EEE`, `Far`) and a few numeric cells had junk (`© 961,21`). Tasks 2–3 target this.

## After Tasks 4–5 (column recovery + region-adaptive thresholds), geometry

| file | found before | found after | cells (after) | cols | rows | note |
|------|:---:|:---:|---:|---:|---:|------|
| 139938 | Y | Y | 41 | 15 | 6 | unchanged (well-segmented) |
| 83832  | Y | Y | 63 | 4 | 17 | recovery triggered, found no extra cols |
| 466024 | N | **N** | 0 | 0 | 9 | still fails: horizontals only, no vertical rules in any orientation |
| 87116  | Y | Y | 59 | 8 | 10 | unchanged |
| 80780  | Y | Y | 114 | 6 | 21 | unchanged |
| 130252 | Y | Y | 100 | 8 | 13 | unchanged |
| 57561  | Y | Y | 31 | 17 | 4 | unchanged |
| 292003 | Y | Y | 4 | 22 | 9 | whole-frame fallback (no region); lower projFrac now finds more lines |
| 519061 | Y | Y | 33 | 10 | 4 | unchanged |
| 779834 | Y | Y | 20 | 11 | 10 | unchanged |

**After Tasks 4–5: table found 9/10 (90%) — meets the ≥80% gate, no regressions.**

Honest assessment: Tasks 4–5 added conservative robustness mechanisms with NO regression
but NO measurable improvement on this 10-photo sample (column recovery recovered nothing
at the 0.2 density ratio; the region/threshold relaxation changed 292003's line counts but
not the found-count). The clear wins this round are Task 2 (OCR noise filter) and Task 3
(numeric normalisation), both browser-validated, plus this measurement harness.

### Residual failure to carry forward
- 466024: only horizontal rules detected, no vertical lines in any rotation → either the
  table genuinely lacks vertical rules or they are far below the morphology threshold.
  Needs a different approach (e.g. text-column-gap segmentation independent of ruled lines),
  out of scope for this round.

## Task 6 — real #/tablecv tab verification (2026-06-24)

The Express app's HTTP did not respond in this sandbox (TCP open, body closed), so the
real SPA was served via the harness server (public/ fallback) and driven with Playwright
(apiKey seeded in localStorage to pass App.init; the tab makes no API calls). Verified on
upload-1782204930225-139938.JPG:
- nav shows "TableCV BETA", route #/tablecv renders the section, nav tab active ✓
- all controls present (file, pick, run, layer select, geom-only, block/linelen sliders, output, export) ✓
- file upload + "Распознать" → status "Найдено ячеек: 41 (поворот 90°)", canvas 2000×1500 (auto-oriented) ✓
- re-run: no new console errors → no opencv "Mat already deleted" / leak across runs ✓
- only console errors are expected /api/invoices/stats and /api/sber/status 404s (static server, not auth 401, no redirect)
No controller defects found; no code change in Task 6. Full OCR-in-tab uses the same
runOriented path validated via the harness in Task 2.

## Final-review deviations recorded (2026-06-24)
- **Column recovery (`_recoverColumns`) is currently inert** on the sample (no columns
  recovered at the 0.2 ratio) and detects whitespace gutters, not faint rules. Kept as a
  gated, no-regression mechanism; carry to a future round together with the 466024
  no-vertical-rules case (both point at proper text-column-gap segmentation).
- **`confidence` is exported in JSON but NOT shown in the results UI.** The plan's
  "show confidence in results" intent was descoped this round; the noise filter is still
  reflected (filtered cells render empty). `cellsToHTMLTable` renders text only.

## Intersection-grid detection (2026-06-25)
Reconnection (open+close) + intersection nodes (H∩V centroids) unioned with projection coords.

On `_debug-nakladnaya` (classifier orientation, projFrac 0.1): cells 49→60, grid now sits on the
real table lines full-width, all ~15 data rows separated (visual confirm). cols ~19 (real ~16 —
slight over-segmentation in/near the nested header).

Batch (runAuto geometry, projFrac 0.1, new code): no regression, no cell blowup.
| file | cells cols×rows |
|------|----------------|
| 139938 | 42c 15×6 |
| 87116  | 55c 8×12 |
| 80780  | 116c 21×6 |
| 130252 | 101c 8×13 |
| 57561  | 45c 17×4 |
| 779834 | 34c 15×12 |
| 466024 | **9c 5×16** (was 0 — recovered by reconnection+nodes) |

Residual: the multi-row ТОРГ-12 header still doesn't resolve into exact nested cells, and column
count is slightly over (~19 vs 16). That nested-header case is the ONNX-structure (SLANet) path.
