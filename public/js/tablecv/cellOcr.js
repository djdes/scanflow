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
