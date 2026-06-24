/* global cv, Tesseract, TableCVOcrClean */
const TableCVOcr = {
  // Pick the upright orientation among candidates, then OCR its cells.
  // candidates: [{ gray: cv.Mat, cells, region: cv.Rect|null }, ...]
  // The table-region crop of each candidate is OCR'd once; the candidate with
  // the highest Tesseract confidence wins (text upside-down scores far lower).
  // Returns { index, gray, cells, region, confidence }. Does NOT delete any
  // candidate Mats — the caller owns them.
  async runOriented(candidates, onProgress) {
    const worker = await Tesseract.createWorker(['rus', 'eng'], 1, {
      workerPath: '/vendor/tesseract/worker.min.js',
      corePath: '/vendor/tesseract/tesseract-core.wasm.js',
      langPath: '/vendor/tesseract',
      gzip: true,
    });
    try {
      let best = null;
      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const probeRect = cand.region
          ? { x: cand.region.x, y: cand.region.y, w: cand.region.width, h: cand.region.height }
          : { x: 0, y: 0, w: cand.gray.cols, h: cand.gray.rows };
        const url = this._cropToDataUrl(cand.gray, probeRect);
        const { data } = await worker.recognize(url);
        if (!best || data.confidence > best.confidence) best = { index: i, confidence: data.confidence };
        onProgress && onProgress(0, 1, 'orient-probe ' + (i + 1) + '/' + candidates.length);
      }
      const win = candidates[best.index];
      for (let i = 0; i < win.cells.length; i++) {
        const url = this._cropToDataUrl(win.gray, win.cells[i]);
        const { data } = await worker.recognize(url);
        win.cells[i].confidence = data.confidence;
        win.cells[i].text = TableCVOcrClean.cleanCellText(data.text, data.confidence);
        onProgress && onProgress(i + 1, win.cells.length);
      }
      // Column-aware numeric normalisation.
      const byCol = {};
      win.cells.forEach((c) => { (byCol[c.col] = byCol[c.col] || []).push(c); });
      Object.values(byCol).forEach((col) => {
        if (TableCVOcrClean.isLikelyNumericColumn(col.map((c) => c.text))) {
          col.forEach((c) => { c.text = TableCVOcrClean.normalizeNumeric(c.text); });
        }
      });
      return { index: best.index, gray: win.gray, cells: win.cells, region: win.region, confidence: best.confidence };
    } finally {
      await worker.terminate();
    }
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
