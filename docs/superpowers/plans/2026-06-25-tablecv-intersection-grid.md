# TableCV Intersection-Grid Implementation Plan

> Execute task-by-task. Pure logic is TDD (vitest); the OpenCV/browser stages are validated in a real browser via the harness + Playwright (self-check loop), since they need the cv WASM runtime.

**Goal:** Detect every cell of a fully-ruled invoice table with exact coordinates by reconnecting broken line rules and using intersection nodes, replacing the brittle 1-D projection.

**Constraints:** client-only (opencv.js); `gridDetect.run` keeps its return shape `{cells,hMask,vMask,xs,ys,region}`; no controller/OCR/server changes; no regression on photos that already worked (batch check).

---

## Task 1: pure coordinate-merge helper (TDD)
**Files:** `public/js/tablecv/gridCore.js` (add `mergeCoords`), `tests/tablecv/gridCore.test.ts` (add cases).
- `mergeCoords(a: number[], b: number[], tol: number): number[]` — concatenate two coordinate lists and collapse values within `tol` to one (reuse `clusterCoords` semantics), sorted ascending. Used to union projection-derived and node-derived line positions.
- Tests: `mergeCoords([10,300],[12,150,305],8)` → `[11,150,302]`-ish (cluster means, sorted); empty lists; identical lists dedupe.
- RED (fail: not a function) → implement (`clusterCoords(a.concat(b), tol)`) → GREEN → commit.

## Task 2: line-mask reconnection in gridDetect
**Files:** `public/js/tablecv/gridDetect.js`.
- Add `_lineMask(src, klen, horiz)`: `MORPH_OPEN` with directional kernel `klen` (as `_openMask` now), THEN `MORPH_CLOSE` with a shorter directional kernel (~`max(5, klen/4)`) to bridge gaps in faint/broken rules. Returns the reconnected mask.
- In `run`, replace the two `_openMask` calls with `_lineMask`. Keep `_tableRegion`/`_openMask` (region still uses open).
- Verify (browser harness): on `_debug` the vertical rules now survive → cols rises toward ~16. `node --check`.

## Task 3: intersection-node grid folded into run
**Files:** `public/js/tablecv/gridDetect.js`.
- Add `_intersectionNodes(hMask, vMask)`: `cv.bitwise_and` → `findContours` → for each component above a min-area, take centroid; collect node X and Y centroids; return `{ nodeXs: clusterCoords(xCentroids, tol), nodeYs: clusterCoords(yCentroids, tol) }` (ROI coords).
- In `run`: compute projection coords `xsRoi/ysRoi` (from reconnected masks) AND node coords; combine with `TableCVGrid.mergeCoords(xsRoi, nodeXs, 8)` and same for ys, before building borders/cells. Guard: only fold nodes when ≥ a few nodes found (else projection only).
- Delete the intersection Mats. Map final xs/ys to full coords (+region offset) as today.
- Verify (browser harness): cols/rows match the real grid on `_debug` (≈16×17) without spurious columns.

## Task 4: batch validation + threshold tuning (self-check loop)
**Files:** none (or small constant tweaks in gridDetect).
- Via harness + Playwright: run geometry on `_debug` + the 10-photo batch. Record cols×rows and visually confirm overlay covers every cell incl. header + right columns. Tune close-kernel size, node min-area, cluster tol. Require: `_debug` resolves to the real column count and no batch regression (photos that worked still work; cell counts not exploding into noise). Log results in `tools/tablecv-harness/batch.md`.
- Run full `npm test` (pure suites green).

## Task 5: end-to-end confirm in the real tab + document
- One clean run through `app.html#/tablecv` (cache-bust URL, single trigger) on `_debug`: confirm overlay + results table cover every cell; no Mat-leak console errors.
- Update the design doc / batch.md with final metrics and any residual (e.g., nested header). Commit. Leave deploy decision to the user.

## Self-Review
- Coverage: reconnection (T2) + nodes (T3) target the missed-column root cause; pure merge is unit-tested (T1); browser validation + tuning (T4); real-tab confirm (T5).
- No placeholder steps; each task independently verifiable.
- Type consistency: `mergeCoords(a,b,tol)`, `_lineMask(src,klen,horiz)`, `_intersectionNodes(hMask,vMask)→{nodeXs,nodeYs}` used consistently.
