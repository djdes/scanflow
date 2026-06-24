# TableCV — ONNX orientation classifier (deep-dive results)

**Date:** 2026-06-25 (autonomous overnight session)
**Branch:** `tablecv-onnx-orientation` (NOT merged, NOT deployed — awaiting user review)
**Status:** orientation problem solved + validated end-to-end on the user's real photo; structure under-segmentation improved; deeper structure recognition (SLANet) deferred.

## Problem (from user testing on real ТОРГ-12 photos)
The classical pipeline picked the wrong rotation **axis** on EXIF-rotated phone photos, so a landscape invoice was processed sideways → only a narrow band of columns was detected ("не распознаёт всю таблицу"). The previous OCR-confidence orientation guess was near-random on sparse table pages.

## What was built
Driven by the deep-research report ([2026-06-24 plan](../plans/2026-06-24-tablecv-improvements.md) + research findings): replace the heuristic orientation guess with a **learned whole-image orientation classifier running in-browser via ONNX**.

- **Vendored, client-side, no server:**
  - `onnxruntime-web` 1.27.0 WASM build (single-thread, no COOP/COEP): `public/vendor/ort/` (`ort.wasm.min.js`, `ort-wasm-simd-threaded.wasm` ~13.5 MB, `.mjs`).
  - `PP-LCNet_x1_0_doc_ori` ONNX (4-class 0/90/180/270, 6.5 MB): `public/vendor/models/doc_ori.onnx` (from GreatV/oar-ocr v0.3.0 release; PaddleClas model).
- **`public/js/tablecv/orient.js`** — `TableCVOrient.classify(colorMat)`: preprocess = RGB, resize short-side→256, centre-crop 224, ImageNet normalise, NCHW; argmax→`applyRot` (90° CW steps to upright). Calibrated empirically: **colour + 256/crop beats gray + direct-224** (the latter confused 0↔180). `CLASS_TO_APPLY=[0,3,2,1]`.
- **`public/js/tablecv.js` `_run`** — orientation now comes from the classifier (axis **and** flip), trusted directly as a single candidate; falls back to the old 4-way OCR scan only if the model fails to load or its orientation yields no grid. Removes the unreliable 2-candidate OCR flip-probe.
- **`projFrac` 0.2 → 0.1** in detection: thin row rules in dense invoices span <20% of the cropped width once binarised, so 0.2 merged ~3 data rows into one band. 0.1 recovers them.

## Results (validated end-to-end in the real #/tablecv tab, via Playwright)
On the user's photo `data/_debug-nakladnaya.JPG` (ТОРГ-12, 17-0363655, EXIF-rotated):
- Orientation: **upright** (applyRot=3 / landscape) — was sideways.
- Grid: cols≈19, rows≈20, 49 cells (was 21 cells / 11×6, only the right columns).
- OCR: readable Russian — item names (Бекон Варено-Копчёный Дымов Буженаль 116756, Масло Подсолнечное Smart Chef, Квас Бочковой Sweet Life, Горошек Зелёный, Лапша Удон, Масло Кунжутное Dunkan, Изюм Малаяр, Молоко…), article codes, units, prices, sums, VAT.

Classifier accuracy (controlled 4-rotation test): **text-rich pages 4/4 correct, high confidence**; sparse table pages get the axis right always and the flip usually right (lower confidence, but argmax beats the old OCR coin-flip). No batch regression from projFrac 0.1 (cell counts stayed sane on the 5-photo check).

## Deploy checklist (when the user approves)
1. Merge `tablecv-onnx-orientation` → `main`, push (GitHub Actions auto-deploys).
2. Vendored assets add ~20 MB to the repo/rsync (ort wasm 13.5 MB + doc_ori 6.5 MB) — confirm prod disk/rsync OK.
3. **Verify the prod Express static server serves `.mjs` as `text/javascript`** (browser refuses dynamic `import()` otherwise) and `.onnx` as a fetchable binary. Modern express/`send` does `.mjs`→JS by default; confirm on prod. (The harness server needed an explicit `.mjs` MIME entry.)
4. No server code / DB / migration changes; `src/` untouched.

## Remaining / deferred (next round)
- **Structure recognition** is still coarse: the multi-line ТОРГ-12 header merges into one cell, and column count is slightly over-segmented (~19 vs 16). The data rows are captured but cell boundaries aren't exact. The research-recommended fix is a learned **SLANet (image→HTML) ONNX** model — a separate, larger spike (procure SLANet ONNX, decode in JS). This is the path to "excellent" structure on borderless tables.
- Orientation confidence on sparse tables is low (argmax still reliable); could be hardened with a text-region crop or small ensemble.
- The "Мин. длина линии (%)" UI slider is currently inert (detOpts hardcodes `lineKernelFrac`/`projFrac`) — wire it to `projFrac` or remove.
- OCR speed unchanged (~1–2 s/cell sequential).

## Test harness
`tools/tablecv-harness/` — `serve.js` (static, `/vendor` alias, `.mjs` MIME, public fallback), `selftest.html` (full pipeline), `orient-test.html` (orientation only). Run: `node tools/tablecv-harness/serve.js . <port>`; drive via Playwright. Deterministic single-run `evaluate` blocks were used for clean measurement (app.html manual runs race if triggered twice; `page.goto` to the same hash URL does not reload — use a cache-bust query).
