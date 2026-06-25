# TableCV — intersection-grid cell detection (every cell + coordinates)

**Date:** 2026-06-25
**Goal:** Detect EVERY cell of a (fully-ruled) invoice table with exact pixel coordinates, client-side. Replace the brittle 1-D projection line detection with a reconnection + intersection-node grid that recovers faint/broken column rules and resolves the header.
**Scope:** Step 1 from the analysis (robust classical CV, no new models). ONNX structure (SLANet/TATR) remains a later option for borderless tables.
**Constraint:** client-only (opencv.js), no server, builds on the existing auto-orientation (ONNX classifier) which already fixes rotation upstream.

## Why the current detector misses cells
`gridDetect.run` projects line masks (count white px per row/col) and thresholds. Faint/broken vertical rules fall below the projection threshold → columns merge; curved paper smears projections; no use of line intersections; the multi-row header isn't resolved.

The table IS fully ruled, so exact coordinates are achievable if line detection is made robust.

## Approach (three additive improvements to gridDetect)

### 1. Line-mask reconnection
Per direction: `MORPH_OPEN` with a long directional kernel (isolate the rule) **then `MORPH_CLOSE`** with a shorter directional kernel to bridge gaps from faint/broken printing. This alone recovers most missed vertical rules so the projection catches them.

### 2. Intersection-node grid (primary coordinate source)
- `nodes = hMask AND vMask` → connected components → centroids = grid nodes (true crossing points).
- Cluster node X centroids → column lines `xs`; node Y centroids → row lines `ys`.
- This is robust where a rule is faint mid-span but its crossings are visible. Merge these node-derived coords with the projection-derived coords (union + re-cluster via `clusterCoords`) so we get the union of evidence.

### 3. Cell construction with spans (reuse existing)
For the `xs × ys` grid: sample each internal border segment in the (reconnected) masks; `mergeCells` (union-find) joins cells across absent borders → merged/header cells with spans. `regionsToCells` → canonical `{row,col,rowSpan,colSpan,x,y,w,h,text}`. Coordinates are in the oriented working image (export already records `coordSpace`/`scale`).

## Modules
- `public/js/tablecv/gridDetect.js` — modify: add `_lineMask` (open+close), `_intersectionNodes(hMask,vMask)` → `{xs,ys}`, and fold node coords into `run`. Keep `_tableRegion`, `_borderGrid`, `_segmentHasLine`, `mergeCells`, `regionsToCells`.
- `public/js/tablecv/gridCore.js` — possibly add a small pure helper for merging/clustering two coordinate lists (unit-testable).
- No controller change (run signature stays `{cells,hMask,vMask,xs,ys,region}`).

## Testing
- **Pure unit (vitest):** coordinate merge/cluster helper (two lists → deduped sorted grid).
- **Browser (harness + Playwright):** on `data/_debug-nakladnaya.JPG` and the data/processed batch — measure detected cols/rows vs expected (_debug ≈ 16 cols × ~17 rows), and visually verify the overlay covers every cell incl. header and right-most columns. Iterate thresholds (close-kernel size, node-cluster tolerance) against the batch; no regression on photos that already worked.
- Self-check loop: run → screenshot → assess coverage → tune → repeat until cells align to the real grid.

## Risks / fallback
- Over-segmentation from noise crossings (text serifs) → guard node clustering by minimum component size + cluster tolerance.
- Curved paper still smears even reconnected lines → a perspective dewarp (find table quad → warpPerspective) is a possible add-on if reconnection+nodes aren't enough (kept out of v1 unless needed).
- If classical still can't resolve the nested header, that part is the ONNX-structure case (Step 2), out of scope here.

## Out of scope
ONNX structure models (SLANet/TATR), server-side recognition, OCR changes.
