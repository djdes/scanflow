# TableCV Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TableCV beta robust across many real invoice photos, raise OCR accuracy (drop noise, normalise numbers), and verify/finish the actual `#/tablecv` app tab end-to-end in a browser.

**Architecture:** Builds on the working client-side pipeline (preprocess → `runAuto` detect with table-crop → `runOriented` OCR). Adds (1) a committed, reusable browser test harness + batch runner for measurement, (2) pure, unit-tested OCR post-processing (noise filter + numeric normalisation) wired into the OCR path, (3) detection robustness fixes validated against the batch, and (4) real-tab integration verified via Playwright.

**Tech Stack:** Vanilla JS (no build step), @techstark/opencv-js (WASM), tesseract.js 5 (rus+eng), vitest for pure logic, Playwright (already available via MCP) for browser validation, a tiny node static server for serving `public/` during tests.

## Global Constraints

- **No build step for client.** Page modules are global objects loaded via `<script>`; pure-core files are dual browser-global + CJS (`if (typeof module !== 'undefined' && module.exports) { module.exports = X; }`) so vitest can require them.
- **No server changes.** Do not touch `src/`, server routes, or `package.json` deps. Server-side OCR fallback is explicitly OUT of scope.
- **Vendored CV assets stay committed** in `public/vendor/`; opencv.js is `@techstark/opencv-js` (full build, no `cv.findNonZero`).
- **Canonical Cell shape:** `{ row, col, rowSpan, colSpan, x, y, w, h, text }`. This plan adds `confidence` (number, 0–100) to each cell — additive, do not remove existing fields.
- **Coordinates are in the deskewed, auto-oriented WORKING image** (the export meta already records `coordSpace`/`scale`).
- **Branch:** work continues on `code-review-hardening` (TableCV is unmerged). Do not merge to `main`.
- **Tests:** `npx vitest run tests/tablecv/` for pure logic. CV/OCR/DOM changes are validated in a real browser via the harness from Task 1 — `node --check` is necessary but NOT sufficient.
- **Temp test artifacts** (copied photos, screenshots, the static server) live under the scratchpad or are git-ignored; never commit invoice photos from `data/`.
- **Commit trailer:** every commit ends with a blank line then `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility | Status |
|------|----------------|--------|
| `public/js/tablecv/ocrClean.js` | PURE: `cleanCellText`, `normalizeNumeric`, `isLikelyNumericColumn`. Noise filter + number normalisation. | new |
| `public/js/tablecv/cellOcr.js` | Store per-cell `confidence`; apply `ocrClean`; per-cell PSM. | modify |
| `public/js/tablecv/gridDetect.js` | Robustness: recover faint internal column lines (row under-segmentation), region-size-adaptive thresholds. | modify |
| `public/js/tablecv.js` | Show confidence/filtering in results; ensure controller path matches harness. | modify |
| `tests/tablecv/ocrClean.test.ts` | vitest for the pure OCR post-processing. | new |
| `tools/tablecv-harness/selftest.html` | Reusable standalone page: image via `?img=`, runs pipeline, exposes `window.__result`. | new |
| `tools/tablecv-harness/serve.js` | Tiny static server rooting at repo (serves `public/` + a chosen photo). | new |
| `tools/tablecv-harness/batch.md` | How to run the batch + the chosen sample-photo list and latest metrics. | new |

---

## Task 1: Reusable browser test harness + batch metrics

**Why first:** Every later robustness/accuracy claim must be measured on real photos, not asserted. This task builds the measurement tool and a baseline.

**Files:**
- Create: `tools/tablecv-harness/selftest.html`
- Create: `tools/tablecv-harness/serve.js`
- Create: `tools/tablecv-harness/batch.md`

**Interfaces:**
- Produces: a page at `/tools/tablecv-harness/selftest.html?img=<url>` that runs the full pipeline and sets `window.__result = { rot, pickedIndex, confidence, cellCount, region, working, cells:[{r,col,rs,cs,text,conf}] }` and `window.__phase` (`'done'|'error'`), `window.__error`.
- Produces: `serve.js` — `node tools/tablecv-harness/serve.js <root> <port>` static server with correct MIME for `.wasm`/`.gz` (no Content-Encoding on `.gz`).

- [ ] **Step 1: Write the static server**

`tools/tablecv-harness/serve.js`:

```js
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(process.argv[2] || '.');
const PORT = parseInt(process.argv[3] || '8123', 10);
const TYPES = { '.html':'text/html;charset=utf-8', '.js':'text/javascript;charset=utf-8',
  '.json':'application/json', '.wasm':'application/wasm', '.gz':'application/octet-stream',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.css':'text/css' };
http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control':'no-store' });
    fs.createReadStream(f).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => console.log('serve ' + ROOT + ' :' + PORT));
```

- [ ] **Step 2: Write the harness page**

`tools/tablecv-harness/selftest.html` — loads the real modules from `/public/js/tablecv/*`, reads `?img=`, runs `TableCVPre.run` → `TableCVDetect.runAuto` → build 180° sibling → `TableCVOcr.runOriented`, draws overlay, and publishes results:

```html
<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>TableCV harness</title></head>
<body><div id="status">init</div><canvas id="tablecv-canvas"></canvas><pre id="dump"></pre>
<script src="/public/js/tablecv/gridCore.js"></script>
<script src="/public/js/tablecv/export.js"></script>
<script src="/public/js/tablecv/ocrClean.js"></script>
<script src="/public/js/tablecv/loader.js"></script>
<script src="/public/js/tablecv/preprocess.js"></script>
<script src="/public/js/tablecv/gridDetect.js"></script>
<script src="/public/js/tablecv/cellOcr.js"></script>
<script src="/public/js/tablecv/overlay.js"></script>
<script>
/* global cv, TableCVLoader, TableCVPre, TableCVDetect, TableCVOverlay, TableCVOcr */
const S = m => { document.getElementById('status').textContent = m; };
const qp = new URLSearchParams(location.search);
const IMG = qp.get('img');
window.__phase='start'; window.__result=null; window.__error=null;
const loadImage = src => new Promise((res,rej)=>{const i=new Image();i.onload=()=>res(i);i.onerror=rej;i.src=src;});
(async () => {
  try {
    await TableCVLoader.ensure(S);
    const img = await loadImage(IMG + (IMG.includes('?')?'&':'?') + Date.now());
    const pre = TableCVPre.run(img, { maxSide: 2000, blockSize: 25 });
    const best = TableCVDetect.runAuto(pre.gray, { blockSize:25, lineKernelFrac:0.12, projFrac:0.2 });
    pre.gray.delete(); pre.binary.delete();
    TableCVOverlay.draw('tablecv-canvas', best.gray, best.det.cells, -1);
    best.det.hMask.delete(); best.det.vMask.delete();
    const g180 = new cv.Mat(); cv.rotate(best.gray, g180, cv.ROTATE_180);
    const bin180 = new cv.Mat();
    cv.adaptiveThreshold(g180, bin180, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 25, 10);
    const det180 = TableCVDetect.run(bin180, { lineKernelFrac:0.12, projFrac:0.2 });
    det180.hMask.delete(); det180.vMask.delete(); bin180.delete();
    const picked = await TableCVOcr.runOriented([
      { gray: best.gray, cells: best.det.cells, region: best.det.region },
      { gray: g180, cells: det180.cells, region: det180.region },
    ], (d,t,m)=>S(m||('OCR '+d+'/'+t)));
    TableCVOverlay.draw('tablecv-canvas', picked.gray, picked.cells, -1);
    window.__result = { rot: best.rot, pickedIndex: picked.index, confidence: Math.round(picked.confidence),
      cellCount: picked.cells.length, region: best.det.region && {x:best.det.region.x,y:best.det.region.y,w:best.det.region.width,h:best.det.region.height},
      working: [picked.gray.cols, picked.gray.rows],
      cells: picked.cells.map(c=>({r:c.row,col:c.col,rs:c.rowSpan,cs:c.colSpan,text:c.text,conf:Math.round(c.confidence||0)})) };
    document.getElementById('dump').textContent = JSON.stringify(window.__result.cells.filter(c=>c.text).map(c=>c.text),null,1);
    best.gray.delete(); best.binary.delete(); g180.delete();
    window.__phase='done'; S('DONE cells='+picked.cells.length);
  } catch(e){ window.__error=String(e&&e.stack||e); window.__phase='error'; S('ERROR: '+(e&&e.message||e)); }
})();
</script></body></html>
```

- [ ] **Step 3: Pick a sample set and capture the baseline**

Choose 10 invoice photos spanning orientations/quality from `data/processed/`. List them in `tools/tablecv-harness/batch.md`. Start the server (`node tools/tablecv-harness/serve.js . 8123`, run from repo root, in the background), then for each photo drive Playwright:
- `browser_navigate` to `http://127.0.0.1:8123/tools/tablecv-harness/selftest.html?img=/data/processed/<file>`
- poll `window.__phase` until `done`/`error` (wait up to 180s — OCR is slow)
- record `window.__result` (cellCount, rot, confidence) and save a screenshot per photo.

Write the baseline table (file, cells, rot, confidence, "table found? Y/N", subjective overlay quality) into `tools/tablecv-harness/batch.md`. This is the yardstick every later task is measured against.

- [ ] **Step 4: Commit**

```bash
git add tools/tablecv-harness/
git commit -m "test(tablecv): reusable browser harness + batch baseline metrics

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Per-cell OCR confidence + pure OCR clean-up

**Files:**
- Create: `public/js/tablecv/ocrClean.js`
- Create: `tests/tablecv/ocrClean.test.ts`
- Modify: `public/js/tablecv/cellOcr.js`

**Interfaces:**
- Produces (`ocrClean.js`, dual export as `TableCVOcrClean`):
  - `cleanCellText(text: string, confidence: number, opts?: {minConf?: number}): string` — returns `''` when `confidence < minConf` (default 45) OR the text has no letters/digits; otherwise returns the text with collapsed internal whitespace and trimmed ends.
  - `normalizeNumeric(text: string): string` — if the text is "numeric-ish" (≥60% of non-space chars are digits/`.,-`), fix common OCR confusions in that context: `O/o/О/о→0`, `l/I→1`, drop stray leading non-alphanumeric junk (e.g. `© 961,21`→`961,21`), normalise decimal separators to `,` and group spaces; otherwise return text unchanged.
  - `isLikelyNumericColumn(texts: string[]): boolean` — true when ≥60% of non-empty entries are numeric-ish.
- Consumes (`cellOcr.js`): the above; each cell gains `confidence` (number).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tablecv/ocrClean.test.ts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const oc = require('../../public/js/tablecv/ocrClean.js');

describe('cleanCellText', () => {
  it('drops low-confidence text', () => {
    expect(oc.cleanCellText('меш.', 20, { minConf: 45 })).toBe('');
  });
  it('drops pure punctuation/noise', () => {
    expect(oc.cleanCellText('—', 90)).toBe('');
    expect(oc.cleanCellText('EEE', 90)).toBe('EEE'); // has letters → kept
  });
  it('collapses whitespace and keeps good text', () => {
    expect(oc.cleanCellText('2 047,21', 80)).toBe('2 047,21');
    expect(oc.cleanCellText('  a\n b ', 80)).toBe('a b');
  });
});

describe('normalizeNumeric', () => {
  it('strips leading junk from a numeric cell', () => {
    expect(oc.normalizeNumeric('© 961,21')).toBe('961,21');
  });
  it('fixes O/l confusions in numeric context', () => {
    expect(oc.normalizeNumeric('1O,l55')).toBe('10,155');
  });
  it('leaves non-numeric text alone', () => {
    expect(oc.normalizeNumeric('Полотенца бумажные')).toBe('Полотенца бумажные');
  });
});

describe('isLikelyNumericColumn', () => {
  it('detects a numeric column', () => {
    expect(oc.isLikelyNumericColumn(['2 047,21', '450,39', '', '124,399'])).toBe(true);
  });
  it('rejects a text column', () => {
    expect(oc.isLikelyNumericColumn(['наименование', 'структура', 'код'])).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tablecv/ocrClean.test.ts`
Expected: FAIL — cannot find module `ocrClean.js`.

- [ ] **Step 3: Implement `ocrClean.js`**

```js
// public/js/tablecv/ocrClean.js
var TableCVOcrClean = (typeof window !== 'undefined' ? (window.TableCVOcrClean = {}) : {});
(function (g) {
  const hasAlnum = (s) => /[\p{L}\p{N}]/u.test(s);
  const numericish = (s) => {
    const t = s.replace(/\s/g, '');
    if (!t) return false;
    const digits = (t.match(/[0-9.,\-]/g) || []).length;
    return digits / t.length >= 0.6;
  };

  g.cleanCellText = function (text, confidence, opts) {
    const minConf = (opts && opts.minConf != null) ? opts.minConf : 45;
    if (typeof confidence === 'number' && confidence < minConf) return '';
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!hasAlnum(t)) return '';
    return t;
  };

  g.normalizeNumeric = function (text) {
    const t = String(text || '');
    if (!numericish(t)) return t;
    let s = t
      .replace(/[OoОо]/g, '0')
      .replace(/[lI]/g, '1')
      .replace(/^[^\d\-]+/, '')   // strip leading junk before first digit/minus
      .replace(/[^\d\-]+$/, '')   // strip trailing junk
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  };

  g.isLikelyNumericColumn = function (texts) {
    const nonEmpty = (texts || []).filter((t) => t && t.trim());
    if (nonEmpty.length === 0) return false;
    const num = nonEmpty.filter(numericish).length;
    return num / nonEmpty.length >= 0.6;
  };
})(TableCVOcrClean);
if (typeof module !== 'undefined' && module.exports) { module.exports = TableCVOcrClean; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tablecv/ocrClean.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Store confidence + apply clean-up in `cellOcr.js`**

NOTE: `TableCVOcr.run` is dead code — only `runOriented` is called (by the controller and the harness; verified via grep). **Delete the `run` method** as part of this step rather than maintaining a second copy of the OCR loop. All edits below target `runOriented` only.

In `runOriented`, replace the per-cell assignment

```js
        win.cells[i].text = (data.text || '').trim();
```

with:

```js
        win.cells[i].confidence = data.confidence;
        win.cells[i].text = TableCVOcrClean.cleanCellText(data.text, data.confidence);
```

Add `TableCVOcrClean` to the `/* global ... */` comment. Include `<script src="/js/tablecv/ocrClean.js">` in `public/app.html` BEFORE `cellOcr.js`.

- [ ] **Step 6: Browser-validate with the harness**

Re-run 3 photos from the Task 1 batch. Confirm: empty/sparse cells no longer emit noise like `EEE`/`Far` (now `''`), real text/numbers preserved. Record before/after cell-with-text counts in `batch.md`.

- [ ] **Step 7: Commit**

```bash
git add public/js/tablecv/ocrClean.js tests/tablecv/ocrClean.test.ts public/js/tablecv/cellOcr.js public/app.html
git commit -m "feat(tablecv): per-cell OCR confidence + noise filter

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Numeric normalisation for numeric columns

**Files:**
- Modify: `public/js/tablecv/cellOcr.js`

**Interfaces:**
- Consumes: `TableCVOcrClean.isLikelyNumericColumn`, `normalizeNumeric` from Task 2.
- After per-cell OCR completes, group cells by `col`; for columns where `isLikelyNumericColumn(texts)` is true, run `normalizeNumeric` on each cell's text in that column.

- [ ] **Step 1: Implement the post-pass in `cellOcr.js`**

In `runOriented`, after the per-cell OCR loop, before `return`:

```js
      // Column-aware numeric normalisation.
      const byCol = {};
      win.cells.forEach((c) => { (byCol[c.col] = byCol[c.col] || []).push(c); });
      Object.values(byCol).forEach((col) => {
        if (TableCVOcrClean.isLikelyNumericColumn(col.map((c) => c.text))) {
          col.forEach((c) => { c.text = TableCVOcrClean.normalizeNumeric(c.text); });
        }
      });
```

- [ ] **Step 2: Browser-validate with the harness**

Re-run the same 3 photos. Confirm numeric cells like `© 961,21` → `961,21`, `1O,l55` → `10,155`, and that text columns (names) are untouched. Record examples in `batch.md`.

- [ ] **Step 3: Commit**

```bash
git add public/js/tablecv/cellOcr.js
git commit -m "feat(tablecv): column-aware numeric normalisation of OCR output

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Recover faint internal column lines (row under-segmentation)

**Problem (observed):** in the data band the faint vertical column rules are missed, so the whole row merges into one wide cell. The morphology open with a fixed kernel/threshold drops them.

**Files:**
- Modify: `public/js/tablecv/gridDetect.js`

**Interfaces:**
- No signature change to `run`. Internally, after computing `xsRoi`/`ysRoi`, if a base ROW is much taller than the median row AND spans the full column width, attempt a second, more sensitive vertical-line pass restricted to that row band to recover missing `xs`. Merge any recovered x-coordinates into `xsRoi` (re-cluster) before building borders.

- [ ] **Step 1: Add a sensitive second vertical pass in `gridDetect.js`**

Add a helper and call it inside `run` after the initial `xsRoi`/`ysRoi`:

```js
  // Recover faint column separators using the column-projection profile of the
  // table crop: local minima of the per-column white-density (gaps between
  // text blocks) are likely column rules even when the printed line is faint.
  _recoverColumns(roi, xsRoi) {
    // Vertical projection of ink density.
    const W = roi.cols, H = roi.rows;
    const colInk = new Array(W).fill(0);
    for (let x = 0; x < W; x++) { let c = 0; for (let y = 0; y < H; y++) if (roi.ucharPtr(y, x)[0]) c++; colInk[x] = c; }
    // Candidate separators: columns whose ink is below 20% of the local average
    // over a wide window (persistent vertical gaps).
    const win = Math.round(W * 0.04) || 1;
    const recovered = [];
    for (let x = win; x < W - win; x++) {
      let sum = 0; for (let k = x - win; k <= x + win; k++) sum += colInk[k];
      const avg = sum / (2 * win + 1);
      if (avg > 0 && colInk[x] < avg * 0.2) recovered.push(x);
    }
    return TableCVGrid.clusterCoords(xsRoi.concat(recovered), 8);
  },
```

Then in `run`, replace `const xs = xsRoi.map(...)` block with: only run recovery when the grid looks under-segmented (few columns relative to rows):

```js
    let xsRoiFinal = xsRoi;
    if (xsRoi.length >= 2 && ysRoi.length >= 2 && (xsRoi.length - 1) < (ysRoi.length - 1)) {
      xsRoiFinal = this._recoverColumns(roi, xsRoi);
    }
    const xs = xsRoiFinal.map((x) => x + ox);
    const ys = ysRoi.map((y) => y + oy);
```

and use `xsRoiFinal` in the `_borderGrid` calls (ROI coords).

- [ ] **Step 2: Browser-validate with the harness**

Re-run the ТОРГ-12 photo (the one with the merged data row) plus 2 others. Confirm the data row now splits into per-column cells (cell count rises, the wide merged cell shrinks) WITHOUT spurious extra columns on already-good tables. Record column counts before/after in `batch.md`. If recovery adds noise on good tables, tighten the `0.2` ratio and re-test (note the final value).

- [ ] **Step 3: Commit**

```bash
git add public/js/tablecv/gridDetect.js
git commit -m "feat(tablecv): recover faint column rules via projection profile

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Threshold robustness across invoices

**Files:**
- Modify: `public/js/tablecv/gridDetect.js`

**Interfaces:**
- `_tableRegion` and `run` get region-size-aware guards so a table occupying very little (or almost all) of the frame still works. No public signature change.

- [ ] **Step 1: Make region acceptance + projection adaptive**

In `_tableRegion`, relax/clarify the plausibility test and prefer the largest contour that is both wide and reasonably tall relative to its own content (not the page):

```js
    // Accept the largest line-structure box if it is wide enough to be a table
    // row band; reject slivers and full-frame noise.
    if (best && best.width > binary.cols * 0.25 && best.height > 24
        && best.width * best.height < binary.cols * binary.rows * 0.95) {
      const pad = 4;
      const x = Math.max(0, best.x - pad), y = Math.max(0, best.y - pad);
      return new cv.Rect(x, y, Math.min(best.width + 2 * pad, binary.cols - x), Math.min(best.height + 2 * pad, binary.rows - y));
    }
    return null;
```

In `run`, when no region is found, fall back to detecting on the whole frame with a LOWER projection fraction (so a borderless/edge-to-edge table still yields lines):

```js
    const effProjFrac = region ? projFrac : Math.min(projFrac, 0.12);
```

and use `effProjFrac` in the `_lineCoords` calls.

- [ ] **Step 2: Re-run the FULL batch (all 10 photos) via the harness**

Compare against the Task 1 baseline table. Required outcome: table found on ≥80% of the sample (record the exact count), and no regression (a photo that worked before must still work). Update `batch.md` with the new metrics column. For any photo that still fails, note the failure mode (no lines / wrong region / OCR) — these feed a future round, do not silently ignore.

- [ ] **Step 3: Commit**

```bash
git add public/js/tablecv/gridDetect.js tools/tablecv-harness/batch.md
git commit -m "feat(tablecv): region-adaptive thresholds for robustness across invoices

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verify & finish the real #/tablecv tab

**Why:** all validation so far uses the standalone harness. The actual app tab (`tablecv.js` controller, served by the running app behind auth) has never been driven in a browser.

**Files:**
- Modify: `public/js/tablecv.js` (only if integration reveals a defect)
- Modify: `tools/tablecv-harness/batch.md` (record the verification)

- [ ] **Step 1: Launch the app and log in**

Start the app (`npm run dev`, port 8899) in the background. With Playwright: navigate to the app, perform login (use the dev admin credentials — reset with `npm run reset-admin-password` if needed; the API key lands in `localStorage` as `apiKey`). Then navigate to `#/tablecv`.

- [ ] **Step 2: Drive the real tab**

Use Playwright to: click "Выбрать фото" and set the file input to a sample photo (`browser_file_upload`), click "Распознать", and wait. Confirm:
- progress advances, then the overlay + results table render;
- the results table reflects the noise filter (no junk rows) and numeric normalisation;
- "Скопировать JSON" produces `{meta:{coordSpace,scale,...}, cells:[...]}`;
- hovering a cell highlights it;
- the debug layers ("Бинаризация"/"Маски линий") and the "Только геометрия" toggle work;
- re-running on a second photo does not error or leak (no opencv "Mat already deleted" console errors).

- [ ] **Step 3: Fix any integration defects**

If a defect appears (e.g. a control ID mismatch, a Mat cleanup gap, the debug layer showing the wrong orientation), fix it in `tablecv.js`, re-run Step 2. Keep changes minimal and within the controller.

- [ ] **Step 4: Record the verification + commit**

Write the verified checklist + a screenshot reference into `tools/tablecv-harness/batch.md`. Commit any controller fix:

```bash
git add public/js/tablecv.js tools/tablecv-harness/batch.md
git commit -m "fix(tablecv): verify and finish the #/tablecv app tab end-to-end

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Robustness across invoices → Task 1 (measurement), Task 4 (under-segmentation), Task 5 (adaptive thresholds + full-batch gate). ✓
- OCR accuracy → Task 2 (confidence + noise filter, unit-tested), Task 3 (numeric normalisation). ✓
- Integration into the real tab → Task 6 (Playwright drive + fixes). ✓
- Speed → explicitly OUT of scope (deselected). Noted in Task 6 that OCR is slow; not addressed here.

**Placeholder scan:** All code steps contain full code; harness/server/tests are complete. No TBD.

**Type consistency:** `cleanCellText(text, confidence, opts)`, `normalizeNumeric(text)`, `isLikelyNumericColumn(texts)` are defined in Task 2 and consumed with the same signatures in Tasks 2/3. `confidence` is added to the Cell shape in Task 2 and read in Task 2/3/harness. `runOriented`/`run` keep their existing signatures.

**Measurement honesty:** Tasks 4 and 5 require before/after metrics in `batch.md` and forbid silent regressions; Task 5 sets an explicit ≥80%-found gate and requires noting residual failures rather than hiding them.

**Limitations called out:** OCR speed unaddressed (out of scope); thresholds remain heuristic (Task 5 reduces but does not eliminate this — residual failures are logged for a future round); server-side OCR fallback deliberately excluded.
