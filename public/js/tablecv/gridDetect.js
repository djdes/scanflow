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
