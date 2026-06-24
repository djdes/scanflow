# TableCV beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a beta tab to ScanFlow's SPA that, fully in the browser, finds the goods table on an invoice photo with OpenCV, reconstructs its cell grid (including merged cells), OCRs each cell, and visualizes the result over the photo.

**Architecture:** All processing is client-side. Pure geometry (line clustering, merged-cell reconstruction, export) lives in framework-free modules that are unit-tested with vitest. OpenCV (`opencv.js` WASM) and Tesseract (`tesseract.js`) are thin adapters around that core, vendored into `public/vendor/` and lazy-loaded only when the tab opens. No server routes, no migrations, no server dependencies.

**Tech Stack:** Vanilla JS (global-object page modules, no build step), `opencv.js` 4.10.0 (WASM), `tesseract.js` 5.x (rus+eng), vitest for the pure core, `<canvas>` for visualization.

## Global Constraints

- **No build step for client.** Page modules are global objects (`const TableCV = {...}`), included via `<script>` in `public/app.html`, dispatched from `App.route()` in `public/js/app.js`. Match this pattern exactly.
- **Pure-core files must be both browser globals and CJS-requireable** so vitest can test them without a browser. Each pure file ends with: `if (typeof module !== 'undefined' && module.exports) { module.exports = <GlobalName>; }` and assigns its global via `var <GlobalName> = (typeof window !== 'undefined' ? (window.<GlobalName> = {}) : {});` then attaches functions.
- **No server changes.** Do not touch `src/`, `package.json` dependencies (vitest is already present), or `src/database/migrations.ts`.
- **Vendored CV assets are committed.** Production is behind an HTTP proxy and cannot reach CDNs at runtime; `public/vendor/` is not gitignored — verify before committing.
- **Lazy-load CV.** `opencv.js` (~9 MB) and tesseract assets must NOT load on any page other than `#/tablecv`, and only on first open.
- **Tests:** `npm test` runs `vitest run`. New tests live under `tests/tablecv/`.
- **Cell object shape (canonical, used everywhere):** `{ row, col, rowSpan, colSpan, x, y, w, h, text }` where `x,y,w,h` are pixel coordinates in the deskewed working image, `row/col` are 0-based base-grid indices of the top-left base cell, `text` is OCR output (empty string until OCR runs).
- **Commit trailer:** every commit message ends with a blank line then `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `public/js/tablecv/gridCore.js` | PURE: `clusterCoords`, `mergeCells`, `regionsToCells`. No DOM, no opencv. |
| `public/js/tablecv/export.js` | PURE: `cellsToJSON`, `cellsToHTMLTable`. No DOM APIs (returns strings). |
| `public/js/tablecv/loader.js` | Lazy-injects vendored `opencv.js` + `tesseract.js`; resolves when ready. |
| `public/js/tablecv/preprocess.js` | OpenCV adapter: image → downscale → gray → adaptive threshold → deskew/perspective. |
| `public/js/tablecv/gridDetect.js` | OpenCV adapter: line masks → coords → border sampling → calls gridCore → pixel cells. |
| `public/js/tablecv/cellOcr.js` | Tesseract adapter: cell crops → text, concurrency-limited, progress callback. |
| `public/js/tablecv/overlay.js` | Canvas drawing: photo + cell rects + indices + text + hover highlight. |
| `public/js/tablecv.js` | `TableCV` controller: upload, run pipeline, debug knobs, error handling, results panel. |
| `public/app.html` | New `<section id="view-tablecv">`, nav link (beta badge), `<script>` includes. |
| `public/js/app.js` | New `#/tablecv` route branch in `App.route()`. |
| `public/vendor/opencv/opencv.js` | Vendored OpenCV WASM glue (committed). |
| `public/vendor/tesseract/*` | Vendored tesseract.js dist + `rus.traineddata.gz` + `eng.traineddata.gz` (committed). |
| `tests/tablecv/gridCore.test.ts` | vitest for gridCore pure functions. |
| `tests/tablecv/export.test.ts` | vitest for export pure functions. |

---

## Task 1: gridCore pure functions

**Files:**
- Create: `public/js/tablecv/gridCore.js`
- Test: `tests/tablecv/gridCore.test.ts`

**Interfaces:**
- Produces:
  - `clusterCoords(values: number[], tol: number): number[]` — sorts ascending, groups values whose gap to the running cluster mean is ≤ `tol`, returns the rounded mean of each cluster, sorted.
  - `mergeCells(R: number, C: number, vBorder: boolean[][], hBorder: boolean[][]): {r0,c0,r1,c1}[]` — base grid is `R` rows × `C` cols. `vBorder[r][c]` (c in 1..C-1) = a vertical line separates base cells (r,c-1) and (r,c). `hBorder[r][c]` (r in 1..R-1) = a horizontal line separates (r-1,c) and (r,c). Adjacent base cells with NO separating border join one component. Returns each component's inclusive base-index bounding box.
  - `regionsToCells(regions: {r0,c0,r1,c1}[], xs: number[], ys: number[]): Cell[]` — maps each region to a pixel cell. `xs` length = C+1, `ys` length = R+1. Returns canonical Cell objects with `text: ''`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tablecv/gridCore.test.ts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const grid = require('../../public/js/tablecv/gridCore.js');

describe('clusterCoords', () => {
  it('groups near values and returns cluster means sorted', () => {
    expect(grid.clusterCoords([10, 12, 11, 50, 51], 5)).toEqual([11, 50]);
  });
  it('keeps far-apart values separate', () => {
    expect(grid.clusterCoords([0, 100, 200], 5)).toEqual([0, 100, 200]);
  });
  it('handles empty input', () => {
    expect(grid.clusterCoords([], 5)).toEqual([]);
  });
});

describe('mergeCells', () => {
  const allV = (R: number, C: number) =>
    Array.from({ length: R }, () => Array.from({ length: C }, () => true));
  const allH = (R: number, C: number) =>
    Array.from({ length: R }, () => Array.from({ length: C }, () => true));

  it('full borders → every base cell is its own region', () => {
    const regions = grid.mergeCells(2, 2, allV(2, 2), allH(2, 2));
    expect(regions).toHaveLength(4);
  });

  it('missing vertical border merges two cells horizontally', () => {
    const v = allV(2, 2);
    v[1][1] = false; // no border between (1,0) and (1,1)
    const regions = grid.mergeCells(2, 2, v, allH(2, 2));
    expect(regions).toHaveLength(3);
    expect(regions).toContainEqual({ r0: 1, c0: 0, r1: 1, c1: 1 });
  });

  it('missing horizontal border merges two cells vertically', () => {
    const h = allH(2, 2);
    h[1][0] = false; // no border between (0,0) and (1,0)
    const regions = grid.mergeCells(2, 2, allV(2, 2), h);
    expect(regions).toHaveLength(3);
    expect(regions).toContainEqual({ r0: 0, c0: 0, r1: 1, c1: 0 });
  });
});

describe('regionsToCells', () => {
  it('maps a region to a pixel cell with spans', () => {
    const xs = [0, 100, 300];
    const ys = [0, 50, 90];
    const cells = grid.regionsToCells([{ r0: 1, c0: 0, r1: 1, c1: 1 }], xs, ys);
    expect(cells).toEqual([
      { row: 1, col: 0, rowSpan: 1, colSpan: 2, x: 0, y: 50, w: 300, h: 40, text: '' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tablecv/gridCore.test.ts`
Expected: FAIL — cannot find module `gridCore.js`.

- [ ] **Step 3: Write the implementation**

```js
// public/js/tablecv/gridCore.js
var TableCVGrid = (typeof window !== 'undefined' ? (window.TableCVGrid = {}) : {});

(function (g) {
  g.clusterCoords = function (values, tol) {
    if (!values || values.length === 0) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const clusters = [];
    let bucket = [sorted[0]];
    let mean = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - mean <= tol) {
        bucket.push(sorted[i]);
        mean = bucket.reduce((s, v) => s + v, 0) / bucket.length;
      } else {
        clusters.push(Math.round(mean));
        bucket = [sorted[i]];
        mean = sorted[i];
      }
    }
    clusters.push(Math.round(mean));
    return clusters;
  };

  // Union-find over base cells; edge exists where the separating border is absent.
  g.mergeCells = function (R, C, vBorder, hBorder) {
    const parent = new Array(R * C);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const idx = (r, c) => r * C + c;

    for (let r = 0; r < R; r++) {
      for (let c = 1; c < C; c++) {
        if (!vBorder[r][c]) union(idx(r, c - 1), idx(r, c));
      }
    }
    for (let r = 1; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (!hBorder[r][c]) union(idx(r - 1, c), idx(r, c));
      }
    }

    const boxes = {};
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const root = find(idx(r, c));
        const b = boxes[root];
        if (!b) boxes[root] = { r0: r, c0: c, r1: r, c1: c };
        else {
          b.r0 = Math.min(b.r0, r); b.c0 = Math.min(b.c0, c);
          b.r1 = Math.max(b.r1, r); b.c1 = Math.max(b.c1, c);
        }
      }
    }
    return Object.values(boxes);
  };

  g.regionsToCells = function (regions, xs, ys) {
    return regions.map((rg) => {
      const x = xs[rg.c0];
      const y = ys[rg.r0];
      const w = xs[rg.c1 + 1] - x;
      const h = ys[rg.r1 + 1] - y;
      return {
        row: rg.r0, col: rg.c0,
        rowSpan: rg.r1 - rg.r0 + 1, colSpan: rg.c1 - rg.c0 + 1,
        x, y, w, h, text: '',
      };
    });
  };
})(TableCVGrid);

if (typeof module !== 'undefined' && module.exports) { module.exports = TableCVGrid; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tablecv/gridCore.test.ts`
Expected: PASS (all 9 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/tablecv/gridCore.js tests/tablecv/gridCore.test.ts
git commit -m "feat(tablecv): pure grid-reconstruction core (clusterCoords, mergeCells)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: export pure functions

**Files:**
- Create: `public/js/tablecv/export.js`
- Test: `tests/tablecv/export.test.ts`

**Interfaces:**
- Consumes: canonical Cell objects from Task 1 (`regionsToCells`).
- Produces:
  - `cellsToJSON(cells: Cell[], meta?: object): string` — pretty JSON `{ meta, cells }`.
  - `cellsToHTMLTable(cells: Cell[]): string` — `<table>` HTML honoring `row/col/rowSpan/colSpan`; cells placed by `row` then `col`; `colspan`/`rowspan` attrs emitted only when > 1; text HTML-escaped.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/tablecv/export.test.ts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const xp = require('../../public/js/tablecv/export.js');

const cells = [
  { row: 0, col: 0, rowSpan: 1, colSpan: 1, x: 0, y: 0, w: 10, h: 10, text: 'A' },
  { row: 0, col: 1, rowSpan: 1, colSpan: 2, x: 10, y: 0, w: 20, h: 10, text: 'B&C' },
];

describe('cellsToJSON', () => {
  it('wraps cells and meta', () => {
    const s = xp.cellsToJSON(cells, { rows: 1 });
    const o = JSON.parse(s);
    expect(o.meta).toEqual({ rows: 1 });
    expect(o.cells).toHaveLength(2);
  });
});

describe('cellsToHTMLTable', () => {
  it('emits colspan only when > 1 and escapes text', () => {
    const html = xp.cellsToHTMLTable(cells);
    expect(html).toContain('<td>A</td>');
    expect(html).toContain('colspan="2"');
    expect(html).toContain('B&amp;C');
    expect(html).not.toContain('rowspan=');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tablecv/export.test.ts`
Expected: FAIL — cannot find module `export.js`.

- [ ] **Step 3: Write the implementation**

```js
// public/js/tablecv/export.js
var TableCVExport = (typeof window !== 'undefined' ? (window.TableCVExport = {}) : {});

(function (g) {
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  g.cellsToJSON = function (cells, meta) {
    return JSON.stringify({ meta: meta || {}, cells: cells }, null, 2);
  };

  g.cellsToHTMLTable = function (cells) {
    const byRow = {};
    let maxRow = 0;
    cells.forEach((c) => {
      (byRow[c.row] = byRow[c.row] || []).push(c);
      if (c.row > maxRow) maxRow = c.row;
    });
    let html = '<table class="tablecv-result">';
    for (let r = 0; r <= maxRow; r++) {
      const row = (byRow[r] || []).slice().sort((a, b) => a.col - b.col);
      if (row.length === 0) continue;
      html += '<tr>';
      row.forEach((c) => {
        const cs = c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '';
        const rs = c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '';
        html += `<td${cs}${rs}>${esc(c.text)}</td>`;
      });
      html += '</tr>';
    }
    return html + '</table>';
  };
})(TableCVExport);

if (typeof module !== 'undefined' && module.exports) { module.exports = TableCVExport; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/tablecv/export.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add public/js/tablecv/export.js tests/tablecv/export.test.ts
git commit -m "feat(tablecv): pure JSON/HTML export of detected cells

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Scaffold the beta tab (upload + raw photo on canvas)

**Files:**
- Create: `public/js/tablecv.js`
- Modify: `public/app.html` (add nav link, `<section id="view-tablecv">`, `<script>` includes)
- Modify: `public/js/app.js` (add `#/tablecv` route branch)

**Interfaces:**
- Produces: global `TableCV` with `init()` (called by router) and `state` holding the loaded `HTMLImageElement`.

- [ ] **Step 1: Add the nav link in `public/app.html`**

Insert after the settings link (the `<a href="#/settings" ...>` block ends near line 60). Add:

```html
        <a href="#/tablecv" data-tab="tablecv">
          TableCV <span class="badge-beta">beta</span>
        </a>
```

And add this minimal style inside the existing `<style>` block (or `<head>`):

```html
<style>
  .badge-beta {
    font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
    background: #ffe9a8; color: #7a5b00; border-radius: 4px;
    padding: 1px 5px; margin-left: 4px; vertical-align: middle;
  }
</style>
```

- [ ] **Step 2: Add the section markup in `public/app.html`**

Insert a new `<section>` next to the other `view-*` sections (e.g. after `<section id="view-suppliers">...</section>`):

```html
    <section id="view-tablecv" style="display:none">
      <div class="page-head">
        <h1>TableCV <span class="badge-beta">beta</span></h1>
        <p class="muted">Распознавание ячеек таблицы по фото — целиком в браузере (OpenCV + Tesseract). Фото не отправляется на сервер.</p>
      </div>

      <div class="tablecv-controls">
        <input type="file" id="tablecv-file" accept="image/*" hidden>
        <button class="btn btn-primary" id="tablecv-pick">Выбрать фото</button>
        <button class="btn" id="tablecv-run" disabled>Распознать</button>
        <label><input type="checkbox" id="tablecv-geom-only"> Только геометрия (без OCR)</label>
        <select id="tablecv-layer" title="Отладочный слой">
          <option value="result">Результат</option>
          <option value="binary">Бинаризация</option>
          <option value="lines">Маски линий</option>
        </select>
      </div>

      <div class="tablecv-knobs">
        <label>Блок threshold: <input type="range" id="tablecv-block" min="11" max="51" step="2" value="25"><span id="tablecv-block-val">25</span></label>
        <label>Мин. длина линии (%): <input type="range" id="tablecv-linelen" min="10" max="80" step="5" value="40"><span id="tablecv-linelen-val">40</span></label>
      </div>

      <div id="tablecv-status" class="muted"></div>
      <progress id="tablecv-progress" max="100" value="0" hidden></progress>
      <canvas id="tablecv-canvas" style="max-width:100%; border:1px solid #ddd;"></canvas>

      <div class="tablecv-output" hidden id="tablecv-output">
        <div id="tablecv-table-wrap"></div>
        <button class="btn btn-sm" id="tablecv-export">Скопировать JSON</button>
      </div>
    </section>
```

- [ ] **Step 3: Add `<script>` includes at the bottom of `public/app.html`**

After the existing `/js/*.js` script tags (after `/js/onboarding-hint.js`), add — pure cores and controller only; the heavy vendor libs are lazy-loaded by `loader.js` in Task 4:

```html
<script src="/js/tablecv/gridCore.js"></script>
<script src="/js/tablecv/export.js"></script>
<script src="/js/tablecv/loader.js"></script>
<script src="/js/tablecv/preprocess.js"></script>
<script src="/js/tablecv/gridDetect.js"></script>
<script src="/js/tablecv/cellOcr.js"></script>
<script src="/js/tablecv/overlay.js"></script>
<script src="/js/tablecv.js"></script>
```

(Files referenced before their tasks create them will 404 harmlessly until those tasks land; create empty stub files now if the browser console noise is undesirable — `echo "" > public/js/tablecv/loader.js` etc. Optional.)

- [ ] **Step 4: Add the route branch in `public/js/app.js`**

In `App.route()`, add before the final `else` (after the `#/profile` branch at line ~180):

```js
    } else if (hash === '#/tablecv') {
      document.getElementById('view-tablecv').style.display = 'block';
      this.activateNavTab('tablecv');
      TableCV.init();
```

- [ ] **Step 5: Write the controller scaffold `public/js/tablecv.js`**

```js
/* global App */
const TableCV = {
  state: { img: null, cells: [], inited: false },

  init() {
    if (this.state.inited) { this._syncRunBtn(); return; }
    this.state.inited = true;
    this._bindUi();
  },

  _bindUi() {
    const file = document.getElementById('tablecv-file');
    const pick = document.getElementById('tablecv-pick');
    pick.onclick = () => file.click();
    file.onchange = () => this._loadFile(file.files[0]);

    document.getElementById('tablecv-block').oninput = (e) =>
      document.getElementById('tablecv-block-val').textContent = e.target.value;
    document.getElementById('tablecv-linelen').oninput = (e) =>
      document.getElementById('tablecv-linelen-val').textContent = e.target.value;
  },

  _loadFile(f) {
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      this.state.img = img;
      this._drawRaw();
      this._syncRunBtn();
      this._status('Фото загружено: ' + img.naturalWidth + '×' + img.naturalHeight);
    };
    img.onerror = () => this._status('Не удалось загрузить изображение', true);
    img.src = URL.createObjectURL(f);
  },

  _drawRaw() {
    const canvas = document.getElementById('tablecv-canvas');
    const img = this.state.img;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);
  },

  _syncRunBtn() {
    document.getElementById('tablecv-run').disabled = !this.state.img;
  },

  _status(msg, isError) {
    const el = document.getElementById('tablecv-status');
    el.textContent = msg;
    el.style.color = isError ? '#c0392b' : '';
  },
};
```

- [ ] **Step 6: Manual verification**

Run: `npm run dev` then open `http://localhost:8899/app.html#/tablecv` (log in first if redirected).
Expected:
- The "TableCV beta" nav link appears and is highlighted on this route.
- Clicking "Выбрать фото" and picking `data/` sample photo draws the photo on the canvas.
- Status shows the pixel dimensions; "Распознать" becomes enabled.

- [ ] **Step 7: Commit**

```bash
git add public/app.html public/js/app.js public/js/tablecv.js
git commit -m "feat(tablecv): scaffold beta tab with photo upload + canvas

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Vendor CV libraries + lazy loader

**Files:**
- Create: `public/vendor/opencv/opencv.js` (downloaded)
- Create: `public/vendor/tesseract/tesseract.min.js`, `worker.min.js`, `tesseract-core.wasm.js`, `tesseract-core.wasm`, `rus.traineddata.gz`, `eng.traineddata.gz` (downloaded)
- Create: `public/js/tablecv/loader.js`
- Modify: `public/js/tablecv.js` (load CV on first run)

**Interfaces:**
- Produces: global `TableCVLoader.ensure(onProgress): Promise<void>` — injects `opencv.js`, waits for `cv` runtime init and for `Tesseract` global; resolves once both are ready. Idempotent (a second call returns the same resolved promise).

- [ ] **Step 1: Download and vendor the assets**

Run (from repo root):

```bash
mkdir -p public/vendor/opencv public/vendor/tesseract
curl -L -o public/vendor/opencv/opencv.js https://docs.opencv.org/4.10.0/opencv.js
curl -L -o public/vendor/tesseract/tesseract.min.js https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js
curl -L -o public/vendor/tesseract/worker.min.js https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/worker.min.js
curl -L -o public/vendor/tesseract/tesseract-core.wasm.js https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js
curl -L -o public/vendor/tesseract/tesseract-core.wasm https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm
curl -L -o public/vendor/tesseract/rus.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/rus@1.0.0/4.0.0_best_int/rus.traineddata.gz
curl -L -o public/vendor/tesseract/eng.traineddata.gz https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz
```

Verify sizes are non-trivial: `ls -lh public/vendor/opencv public/vendor/tesseract` (opencv.js ~9 MB, each traineddata ~1–15 MB).

- [ ] **Step 2: Confirm `public/vendor/` is not gitignored**

Run: `git check-ignore public/vendor/opencv/opencv.js; echo "exit=$?"`
Expected: `exit=1` (NOT ignored). If it prints a path (exit=0), stop and add a `!public/vendor/` negation to `.gitignore` before continuing.

- [ ] **Step 3: Write the loader `public/js/tablecv/loader.js`**

```js
/* global cv, Tesseract */
const TableCVLoader = {
  _promise: null,

  ensure(onProgress) {
    if (this._promise) return this._promise;
    this._promise = (async () => {
      onProgress && onProgress('Загрузка Tesseract…');
      await this._loadScript('/vendor/tesseract/tesseract.min.js', () => typeof Tesseract !== 'undefined');
      onProgress && onProgress('Загрузка OpenCV (~9 МБ)…');
      await this._loadOpenCv();
      onProgress && onProgress('Библиотеки готовы');
    })().catch((err) => { this._promise = null; throw err; });
    return this._promise;
  },

  _loadScript(src, readyCheck) {
    return new Promise((resolve, reject) => {
      if (readyCheck && readyCheck()) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
  },

  _loadOpenCv() {
    return new Promise((resolve, reject) => {
      if (typeof cv !== 'undefined' && cv.Mat) return resolve();
      window.Module = {
        onRuntimeInitialized: () => resolve(),
      };
      const s = document.createElement('script');
      s.src = '/vendor/opencv/opencv.js';
      s.onerror = () => reject(new Error('Не удалось загрузить opencv.js'));
      document.head.appendChild(s);
    });
  },
};
```

- [ ] **Step 4: Wire lazy-load into the run button in `public/js/tablecv.js`**

In `_bindUi()`, add:

```js
    document.getElementById('tablecv-run').onclick = () => this._run();
```

Add the method:

```js
  async _run() {
    const progress = document.getElementById('tablecv-progress');
    try {
      progress.hidden = false; progress.value = 5;
      await TableCVLoader.ensure((m) => this._status(m));
      progress.value = 100;
      this._status('Готово к обработке (пайплайн появится в следующих задачах)');
    } catch (err) {
      this._status(err.message, true);
    } finally {
      setTimeout(() => { progress.hidden = true; progress.value = 0; }, 800);
    }
  },
```

- [ ] **Step 5: Manual verification**

Open `#/tablecv`, pick a photo, click "Распознать".
Expected:
- Status cycles "Загрузка Tesseract…" → "Загрузка OpenCV…" → "Библиотеки готовы".
- In DevTools console: `typeof cv` is `object` and `typeof Tesseract` is `function`.
- Reload another page (e.g. `#/invoices`) WITHOUT visiting TableCV — confirm in Network tab that `opencv.js` is NOT requested.

- [ ] **Step 6: Commit**

```bash
git add public/vendor public/js/tablecv/loader.js public/js/tablecv.js
git commit -m "feat(tablecv): vendor opencv.js + tesseract.js with lazy loader

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Preprocess (downscale, grayscale, threshold, deskew)

**Files:**
- Create: `public/js/tablecv/preprocess.js`
- Modify: `public/js/tablecv.js` (call preprocess; wire debug layer = "binary")

**Interfaces:**
- Consumes: `HTMLImageElement`, knob values (block size, line-length %).
- Produces: global `TableCVPre.run(img, opts): { gray: cv.Mat, binary: cv.Mat, scale: number }` — `gray`/`binary` are deskewed working-size single-channel Mats; `scale` = workingSize / originalSize (to map coords back). Caller owns `.delete()` on the returned Mats. `opts = { maxSide: number, blockSize: number }`.

- [ ] **Step 1: Write `public/js/tablecv/preprocess.js`**

```js
/* global cv */
const TableCVPre = {
  run(img, opts) {
    const maxSide = opts.maxSide || 2000;
    const blockSize = (opts.blockSize % 2 === 1) ? opts.blockSize : opts.blockSize + 1;

    const src = cv.imread(img); // RGBA
    const longest = Math.max(src.cols, src.rows);
    const scale = longest > maxSide ? maxSide / longest : 1;

    const work = new cv.Mat();
    const dsize = new cv.Size(Math.round(src.cols * scale), Math.round(src.rows * scale));
    cv.resize(src, work, dsize, 0, 0, cv.INTER_AREA);
    src.delete();

    const gray = new cv.Mat();
    cv.cvtColor(work, gray, cv.COLOR_RGBA2GRAY);
    work.delete();

    // Deskew: estimate dominant skew from the binarized text/lines via minAreaRect.
    const angle = this._estimateSkew(gray);
    if (Math.abs(angle) > 0.3 && Math.abs(angle) < 15) {
      const center = new cv.Point(gray.cols / 2, gray.rows / 2);
      const M = cv.getRotationMatrix2D(center, angle, 1);
      const rotated = new cv.Mat();
      cv.warpAffine(gray, rotated, M, new cv.Size(gray.cols, gray.rows),
        cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
      M.delete(); gray.delete();
      return this._finish(rotated, blockSize, scale);
    }
    return this._finish(gray, blockSize, scale);
  },

  _finish(gray, blockSize, scale) {
    const binary = new cv.Mat();
    // Invert: lines/text become white (255) so morphology can grow them.
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C,
      cv.THRESH_BINARY_INV, blockSize, 10);
    return { gray, binary, scale };
  },

  _estimateSkew(gray) {
    const bin = new cv.Mat();
    cv.threshold(gray, bin, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
    const pts = new cv.Mat();
    cv.findNonZero(bin, pts);
    let angle = 0;
    if (pts.rows > 0) {
      const rect = cv.minAreaRect(pts);
      angle = rect.angle;
      if (angle < -45) angle += 90;
    }
    bin.delete(); pts.delete();
    return angle;
  },
};
```

- [ ] **Step 2: Wire debug "binary" layer in `public/js/tablecv.js`**

Replace the placeholder body of `_run()` after `ensure(...)` with:

```js
      const opts = {
        maxSide: 2000,
        blockSize: parseInt(document.getElementById('tablecv-block').value, 10),
      };
      this._pre = TableCVPre.run(this.state.img, opts);
      const layer = document.getElementById('tablecv-layer').value;
      if (layer === 'binary') cv.imshow('tablecv-canvas', this._pre.binary);
      else cv.imshow('tablecv-canvas', this._pre.gray);
      this._status('Предобработка готова (scale ' + this._pre.scale.toFixed(3) + ')');
```

Add `/* global cv */` to the top comment of `tablecv.js`.

- [ ] **Step 3: Manual verification**

Open `#/tablecv`, pick the sample photo, set debug layer to "Бинаризация", click "Распознать".
Expected:
- Canvas shows a deskewed, high-contrast black/white image where the table lines and text are white on black.
- The table border lines are visibly continuous (not heavily broken). If badly broken, adjust the "Блок threshold" slider and re-run — confirm the slider changes the result.

- [ ] **Step 4: Commit**

```bash
git add public/js/tablecv/preprocess.js public/js/tablecv.js
git commit -m "feat(tablecv): preprocess (downscale, deskew, adaptive threshold)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Grid detection (lines → cells) + overlay

**Files:**
- Create: `public/js/tablecv/gridDetect.js`
- Create: `public/js/tablecv/overlay.js`
- Modify: `public/js/tablecv.js` (run detection, draw overlay, "lines" debug layer)

**Interfaces:**
- Consumes: `{ gray, binary, scale }` from Task 5; `TableCVGrid` from Task 1.
- Produces:
  - `TableCVDetect.run(binary, opts): { cells: Cell[], hMask: cv.Mat, vMask: cv.Mat, xs: number[], ys: number[] }` — cells in working-image pixel coords (text:''). `opts = { lineLenPct: number }`. Caller owns `.delete()` of `hMask`/`vMask`.
  - `TableCVOverlay.draw(canvasId, baseMat, cells, hoverIndex): void` — renders `baseMat` (gray) then cell rects + index labels; if `hoverIndex` set, fills that cell translucently.

- [ ] **Step 1: Write `public/js/tablecv/gridDetect.js`**

```js
/* global cv, TableCVGrid */
const TableCVDetect = {
  run(binary, opts) {
    const lineLenPct = (opts.lineLenPct || 40) / 100;
    const hLen = Math.max(10, Math.round(binary.cols * lineLenPct));
    const vLen = Math.max(10, Math.round(binary.rows * lineLenPct));

    const hMask = new cv.Mat();
    const hKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(hLen, 1));
    cv.morphologyEx(binary, hMask, cv.MORPH_OPEN, hKernel);
    hKernel.delete();

    const vMask = new cv.Mat();
    const vKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(1, vLen));
    cv.morphologyEx(binary, vMask, cv.MORPH_OPEN, vKernel);
    vKernel.delete();

    const ys = this._lineCoords(hMask, 'h');
    const xs = this._lineCoords(vMask, 'v');

    let cells = [];
    if (xs.length >= 2 && ys.length >= 2) {
      const R = ys.length - 1, C = xs.length - 1;
      const vBorder = this._borderGrid(vMask, xs, ys, R, C, 'v');
      const hBorder = this._borderGrid(hMask, xs, ys, R, C, 'h');
      const regions = TableCVGrid.mergeCells(R, C, vBorder, hBorder);
      cells = TableCVGrid.regionsToCells(regions, xs, ys);
    }
    return { cells, hMask, vMask, xs, ys };
  },

  // Project a line mask onto an axis; rows/cols whose white-pixel count exceeds
  // a fraction of the span are line positions, then cluster adjacent ones.
  _lineCoords(mask, dir) {
    const coords = [];
    if (dir === 'h') {
      const thresh = mask.cols * 0.3;
      for (let y = 0; y < mask.rows; y++) {
        let count = 0;
        for (let x = 0; x < mask.cols; x++) if (mask.ucharPtr(y, x)[0]) count++;
        if (count > thresh) coords.push(y);
      }
    } else {
      const thresh = mask.rows * 0.3;
      for (let x = 0; x < mask.cols; x++) {
        let count = 0;
        for (let y = 0; y < mask.rows; y++) if (mask.ucharPtr(y, x)[0]) count++;
        if (count > thresh) coords.push(x);
      }
    }
    return TableCVGrid.clusterCoords(coords, 8);
  },

  // For each internal border segment, is a line actually present along it?
  _borderGrid(mask, xs, ys, R, C, dir) {
    const grid = [];
    for (let r = 0; r < R; r++) {
      grid[r] = [];
      for (let c = 0; c < C; c++) {
        grid[r][c] = (dir === 'v')
          ? (c === 0 ? true : this._segmentHasLine(mask, xs[c], ys[r], xs[c], ys[r + 1]))
          : (r === 0 ? true : this._segmentHasLine(mask, xs[c], ys[r], xs[c + 1], ys[r]));
      }
    }
    return grid;
  },

  _segmentHasLine(mask, x0, y0, x1, y1) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    let hit = 0;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + (x1 - x0) * i / steps);
      const y = Math.round(y0 + (y1 - y0) * i / steps);
      for (let d = -2; d <= 2; d++) {
        const xx = (x1 === x0) ? x + d : x;
        const yy = (y1 === y0) ? y + d : y;
        if (xx >= 0 && yy >= 0 && xx < mask.cols && yy < mask.rows && mask.ucharPtr(yy, xx)[0]) { hit++; break; }
      }
    }
    return hit / (steps + 1) > 0.5;
  },
};
```

- [ ] **Step 2: Write `public/js/tablecv/overlay.js`**

```js
/* global cv */
const TableCVOverlay = {
  draw(canvasId, baseMat, cells, hoverIndex) {
    cv.imshow(canvasId, baseMat);
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2;
    ctx.font = '14px sans-serif';
    cells.forEach((c, i) => {
      ctx.strokeStyle = (i === hoverIndex) ? '#e74c3c' : '#2ecc71';
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      if (i === hoverIndex) {
        ctx.fillStyle = 'rgba(231,76,60,0.18)';
        ctx.fillRect(c.x, c.y, c.w, c.h);
      }
      ctx.fillStyle = '#2ecc71';
      ctx.fillText(String(i), c.x + 2, c.y + 14);
    });
  },
};
```

- [ ] **Step 3: Wire detection + overlay into `_run()` in `public/js/tablecv.js`**

After the preprocess block, append:

```js
      const det = TableCVDetect.run(this._pre.binary, {
        lineLenPct: parseInt(document.getElementById('tablecv-linelen').value, 10),
      });
      this.state.cells = det.cells;

      if (layer === 'lines') {
        const merged = new cv.Mat();
        cv.add(det.hMask, det.vMask, merged);
        cv.imshow('tablecv-canvas', merged);
        merged.delete();
      } else if (layer !== 'binary') {
        TableCVOverlay.draw('tablecv-canvas', this._pre.gray, det.cells, -1);
      }
      this._status('Найдено ячеек: ' + det.cells.length);

      det.hMask.delete(); det.vMask.delete();
```

- [ ] **Step 4: Manual verification**

Open `#/tablecv`, pick the sample photo, layer "Результат", click "Распознать".
Expected:
- Green rectangles outline the table cells; the count in status is in the right ballpark for the sample (the goods table has ~12 columns × ~12 rows of base cells).
- Merged cells (e.g. "Итого", "В том числе НДС") are single wide rectangles, not split.
- Switch layer to "Маски линий" and re-run: horizontal and vertical table rules show as clean white lines.

- [ ] **Step 5: Commit**

```bash
git add public/js/tablecv/gridDetect.js public/js/tablecv/overlay.js public/js/tablecv.js
git commit -m "feat(tablecv): detect grid lines, reconstruct cells, overlay on canvas

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Per-cell OCR + results panel + export

**Files:**
- Create: `public/js/tablecv/cellOcr.js`
- Modify: `public/js/tablecv.js` (run OCR unless geom-only, render HTML table, hover highlight, JSON copy)

**Interfaces:**
- Consumes: `{ gray }` from Task 5, cells from Task 6, `Tesseract` global, `TableCVExport` from Task 2.
- Produces: `TableCVOcr.run(grayMat, cells, onProgress): Promise<Cell[]>` — returns the same cells with `.text` filled; `onProgress(done, total)` called per cell. Concurrency limited to 1 worker (tesseract worker is single-threaded per instance) processing sequentially.

- [ ] **Step 1: Write `public/js/tablecv/cellOcr.js`**

```js
/* global cv, Tesseract */
const TableCVOcr = {
  async run(grayMat, cells, onProgress) {
    const worker = await Tesseract.createWorker(['rus', 'eng'], 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract/tesseract-core.wasm.js',
      langPath: '/vendor/tesseract',
      gzip: true,
    });
    try {
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const dataUrl = this._cropToDataUrl(grayMat, c);
        const { data } = await worker.recognize(dataUrl);
        c.text = (data.text || '').trim();
        onProgress && onProgress(i + 1, cells.length);
      }
    } finally {
      await worker.terminate();
    }
    return cells;
  },

  _cropToDataUrl(grayMat, cell) {
    const pad = 2;
    const x = Math.max(0, cell.x + pad), y = Math.max(0, cell.y + pad);
    const w = Math.max(1, Math.min(cell.w - 2 * pad, grayMat.cols - x));
    const h = Math.max(1, Math.min(cell.h - 2 * pad, grayMat.rows - y));
    const roi = grayMat.roi(new cv.Rect(x, y, w, h));
    const tmp = document.createElement('canvas');
    cv.imshow(tmp, roi);
    roi.delete();
    return tmp.toDataURL('image/png');
  },
};
```

- [ ] **Step 2: Wire OCR + results into `_run()` in `public/js/tablecv.js`**

After the detection block (and after deleting masks), append:

```js
      const geomOnly = document.getElementById('tablecv-geom-only').checked;
      if (!geomOnly && det.cells.length) {
        const progress = document.getElementById('tablecv-progress');
        progress.hidden = false;
        await TableCVOcr.run(this._pre.gray, this.state.cells, (done, total) => {
          progress.value = Math.round(done / total * 100);
          this._status('OCR ячеек: ' + done + '/' + total);
        });
        progress.hidden = true;
        TableCVOverlay.draw('tablecv-canvas', this._pre.gray, this.state.cells, -1);
        this._renderResults();
      }
```

Add the results renderer + hover wiring + JSON copy:

```js
  _renderResults() {
    const out = document.getElementById('tablecv-output');
    out.hidden = false;
    document.getElementById('tablecv-table-wrap').innerHTML =
      TableCVExport.cellsToHTMLTable(this.state.cells);

    document.getElementById('tablecv-export').onclick = () => {
      const json = TableCVExport.cellsToJSON(this.state.cells, {
        count: this.state.cells.length,
      });
      navigator.clipboard.writeText(json).then(
        () => this._status('JSON скопирован в буфер'),
        () => this._status('Не удалось скопировать', true)
      );
    };

    const canvas = document.getElementById('tablecv-canvas');
    canvas.onmousemove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      const mx = (e.clientX - rect.left) * sx, my = (e.clientY - rect.top) * sy;
      const idx = this.state.cells.findIndex(c =>
        mx >= c.x && mx <= c.x + c.w && my >= c.y && my <= c.y + c.h);
      TableCVOverlay.draw('tablecv-canvas', this._pre.gray, this.state.cells, idx);
    };
  },
```

Also add `TableCVExport` to the `/* global ... */` comment.

- [ ] **Step 3: Manual verification**

Open `#/tablecv`, pick the sample photo, leave "Только геометрия" unchecked, click "Распознать".
Expected:
- Progress bar advances "OCR ячеек: n/total".
- A reconstructed HTML table appears below the canvas with recognized text (artikuls like `ПОС29946`, quantities, sums are mostly correct; some Russian text cells may be imperfect — acceptable for beta).
- Hovering a cell on the canvas highlights it red.
- "Скопировать JSON" puts `{ meta, cells }` on the clipboard (paste into an editor to confirm).

- [ ] **Step 4: Commit**

```bash
git add public/js/tablecv/cellOcr.js public/js/tablecv.js
git commit -m "feat(tablecv): per-cell OCR, results table, hover highlight, JSON export

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Error handling + Mat lifecycle cleanup

**Files:**
- Modify: `public/js/tablecv.js`

**Interfaces:**
- No new exports. Hardens `_run()`: empty-result messaging, Mat cleanup between runs, guard against running with no image.

- [ ] **Step 1: Add cleanup + guards in `public/js/tablecv.js`**

Add a cleanup helper and call it at the start of `_run()` (before preprocess) so repeated runs don't leak Mats:

```js
  _cleanupPre() {
    if (this._pre) {
      this._pre.gray && this._pre.gray.delete && this._pre.gray.delete();
      this._pre.binary && this._pre.binary.delete && this._pre.binary.delete();
      this._pre = null;
    }
  },
```

At the top of `_run()` body (inside `try`, before preprocess):

```js
      if (!this.state.img) { this._status('Сначала выберите фото', true); return; }
      this._cleanupPre();
```

After detection, when no cells were found, surface a helpful message and show the line masks so the user sees why:

```js
      if (det.cells.length === 0) {
        const merged = new cv.Mat();
        cv.add(det.hMask, det.vMask, merged);
        cv.imshow('tablecv-canvas', merged);
        merged.delete();
        this._status('Таблица не найдена — на фото нет уверенной сетки линий. Попробуйте более ровное/контрастное фото или уменьшите «мин. длину линии».', true);
        det.hMask.delete(); det.vMask.delete();
        return;
      }
```

(Place this guard immediately after `TableCVDetect.run(...)` and before the layer-rendering block; remove the now-duplicated mask `.delete()` at the end of the success path is unnecessary — keep a single delete path. Ensure `hMask`/`vMask` are deleted exactly once on every branch.)

- [ ] **Step 2: Manual verification**

- Run with a non-table photo (or a blank image): expect the "Таблица не найдена…" message and the line-mask view, no crash.
- Run the sample photo twice in a row: expect no console errors and stable memory (no opencv "Mat already deleted" errors).
- Click "Распознать" is disabled before a photo is chosen; choosing one enables it.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including `tests/tablecv/gridCore.test.ts` and `tests/tablecv/export.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add public/js/tablecv.js
git commit -m "feat(tablecv): error handling for empty results + Mat lifecycle cleanup

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- beta tab in SPA → Task 3 (nav, section, route). ✓
- classic OpenCV line morphology → Task 6. ✓
- opencv.js WASM in browser, lazy-loaded, vendored → Task 4. ✓
- geometry + OCR of cell text → Task 6 (geometry) + Task 7 (OCR). ✓
- table-only scope → only the ruled table is detected; header/footer untouched. ✓
- algorithm C (line coords + border presence + merge) → Task 1 (`mergeCells`) + Task 6 (`_borderGrid`). ✓
- merged cells handled → Task 1 union-find + Task 6 border sampling. ✓
- modules with clean boundaries → file structure table matches spec section 3. ✓
- debug knobs (threshold block, line length, layer toggle) → Task 3 markup + Task 5/6 wiring. ✓
- error handling (no table, load failure, big image, slow OCR) → Task 4 (load failure), Task 5 (downscale cap), Task 7 (progress/geom-only), Task 8 (no table). ✓
- testing: gridDetect core as pure unit tests + visual check → Task 1 + Task 2 (vitest), manual steps throughout. ✓
- no server changes → enforced in Global Constraints; no task touches `src/`. ✓

**Placeholder scan:** No TBD/TODO; every code step contains full code. ✓

**Type consistency:** Cell shape `{row,col,rowSpan,colSpan,x,y,w,h,text}` is used identically in Task 1 (`regionsToCells`), Task 2 (export), Task 6 (overlay), Task 7 (OCR). `TableCVGrid`, `TableCVExport`, `TableCVLoader`, `TableCVPre`, `TableCVDetect`, `TableCVOverlay`, `TableCVOcr` globals are defined once and consumed by name consistently. `mergeCells(R,C,vBorder,hBorder)` signature matches between Task 1 definition and Task 6 call. ✓

**Note on automated coverage:** Only the pure cores (gridCore, export) are unit-tested; OpenCV/Tesseract/DOM layers rely on the manual verification steps in each task, because the project has no headless-browser test harness. This is called out so the limited automated coverage is not mistaken for full coverage.
