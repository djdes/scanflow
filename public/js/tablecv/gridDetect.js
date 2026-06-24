/* global cv, TableCVGrid */
const TableCVDetect = {
  // Detect the cell grid in a binarised (white-on-black) image.
  // Returns cells in FULL-image pixel coords (offset by the table region).
  // opts: { lineKernelFrac=0.12, projFrac=0.2 }
  run(binary, opts) {
    opts = opts || {};
    const kFrac = opts.lineKernelFrac || 0.12;
    const projFrac = opts.projFrac || 0.2;

    // 1. Localise the table so thresholds are relative to it, not the whole
    //    page (invoices often have the table in only part of the frame).
    const region = this._tableRegion(binary);
    const roi = region ? binary.roi(region) : binary;
    const ox = region ? region.x : 0;
    const oy = region ? region.y : 0;

    // 2. Morphological line masks within the (cropped) table.
    const hLen = Math.max(15, Math.round(roi.cols * kFrac));
    const vLen = Math.max(15, Math.round(roi.rows * kFrac));
    const hMask = this._openMask(roi, hLen, true);
    const vMask = this._openMask(roi, vLen, false);

    // 3. Line coordinates (ROI-relative), then mapped to full-image coords.
    // When no region was found (borderless/edge-to-edge table) use a lower
    // projection fraction so faint lines still register.
    const effProjFrac = region ? projFrac : Math.min(projFrac, 0.12);
    const ysRoi = this._lineCoords(hMask, 'h', effProjFrac);
    const xsRoi = this._lineCoords(vMask, 'v', effProjFrac);

    // 4. Recover faint column separators when the grid looks under-segmented
    //    (fewer columns than rows suggest column lines were missed).
    let xsRoiFinal = xsRoi;
    if (xsRoi.length >= 2 && ysRoi.length >= 2 && (xsRoi.length - 1) < (ysRoi.length - 1)) {
      xsRoiFinal = this._recoverColumns(roi, xsRoi);
    }
    const xs = xsRoiFinal.map((x) => x + ox);
    const ys = ysRoi.map((y) => y + oy);

    let cells = [];
    if (xsRoiFinal.length >= 2 && ysRoi.length >= 2) {
      const R = ysRoi.length - 1, C = xsRoiFinal.length - 1;
      // Border sampling uses the ROI-coord masks, so pass ROI-coord lines.
      const vBorder = this._borderGrid(vMask, xsRoiFinal, ysRoi, R, C, 'v');
      const hBorder = this._borderGrid(hMask, xsRoiFinal, ysRoi, R, C, 'h');
      const regions = TableCVGrid.mergeCells(R, C, vBorder, hBorder);
      cells = TableCVGrid.regionsToCells(regions, xs, ys); // full-image coords
    }

    if (region) roi.delete();
    return { cells, hMask, vMask, xs, ys, region };
  },

  // Binarise + detect a single orthogonal rotation of `gray`.
  // Returns { rot, gray, binary, det } — caller owns gray/binary and
  // det.hMask/det.vMask.
  _detectRotation(gray, k, blockSize, opts) {
    const codes = [null, cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE];
    const g = new cv.Mat();
    if (k === 0) gray.copyTo(g); else cv.rotate(gray, g, codes[k]);
    const bin = new cv.Mat();
    cv.adaptiveThreshold(g, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, blockSize, 10);
    const det = this.run(bin, opts);
    return { rot: k, gray: g, binary: bin, det };
  },

  _blockSize(opts) {
    return (opts.blockSize % 2 === 1) ? opts.blockSize : (opts.blockSize || 25);
  },

  // Try the 4 orthogonal orientations (phone photos carry arbitrary EXIF
  // rotation) and keep the one with the most cells (geometry-only heuristic,
  // used for the fast preview / batch metrics). NOTE: cell count alone cannot
  // tell a correct landscape table from a sideways one when counts tie — for
  // the real run use allOrientations() + OCR-confidence selection instead.
  // Returns { rot, gray, binary, det, score }; caller owns the Mats.
  runAuto(gray, opts) {
    opts = opts || {};
    const blockSize = this._blockSize(opts);
    let best = null;
    for (let k = 0; k < 4; k++) {
      const c = this._detectRotation(gray, k, blockSize, opts);
      const score = (c.det.xs.length >= 2 && c.det.ys.length >= 2) ? c.det.cells.length : -1;
      if (!best || score > best.score) {
        if (best) { best.gray.delete(); best.binary.delete(); best.det.hMask.delete(); best.det.vMask.delete(); }
        best = { rot: c.rot, gray: c.gray, binary: c.binary, det: c.det, score };
      } else {
        c.gray.delete(); c.binary.delete(); c.det.hMask.delete(); c.det.vMask.delete();
      }
    }
    return best;
  },

  // Return every orientation that yields a usable grid, so a downstream
  // OCR-confidence probe can pick the truly readable one (fixes the case where
  // a sideways rotation ties on cell count but is wrong). Caller owns each
  // candidate's gray/binary and det.hMask/det.vMask.
  allOrientations(gray, opts) {
    opts = opts || {};
    const blockSize = this._blockSize(opts);
    const cands = [];
    for (let k = 0; k < 4; k++) {
      const c = this._detectRotation(gray, k, blockSize, opts);
      if (c.det.xs.length >= 2 && c.det.ys.length >= 2 && c.det.cells.length > 0) {
        cands.push(c);
      } else {
        c.gray.delete(); c.binary.delete(); c.det.hMask.delete(); c.det.vMask.delete();
      }
    }
    return cands;
  },

  _openMask(src, klen, horiz) {
    const m = new cv.Mat();
    const k = cv.getStructuringElement(cv.MORPH_RECT, horiz ? new cv.Size(klen, 1) : new cv.Size(1, klen));
    cv.morphologyEx(src, m, cv.MORPH_OPEN, k);
    k.delete();
    return m;
  },

  // Bounding box of the largest connected line structure = the table.
  // Returns a cv.Rect or null when no plausible table is found.
  _tableRegion(binary) {
    const hM = this._openMask(binary, Math.max(20, Math.round(binary.cols * 0.1)), true);
    const vM = this._openMask(binary, Math.max(20, Math.round(binary.rows * 0.1)), false);
    const grid = new cv.Mat();
    cv.add(hM, vM, grid);
    const ker = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15));
    const closed = new cv.Mat();
    cv.morphologyEx(grid, closed, cv.MORPH_CLOSE, ker);
    ker.delete();
    const contours = new cv.MatVector();
    const hier = new cv.Mat();
    cv.findContours(closed, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    let best = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const r = cv.boundingRect(contours.get(i));
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = r; }
    }
    hM.delete(); vM.delete(); grid.delete(); closed.delete(); contours.delete(); hier.delete();
    // Accept the largest line-structure box if it is wide enough to be a table
    // row band; reject slivers and full-frame noise.
    if (best && best.width > binary.cols * 0.25 && best.height > 24
        && best.width * best.height < binary.cols * binary.rows * 0.95) {
      // Pad a few px so border lines aren't clipped.
      const pad = 4;
      const x = Math.max(0, best.x - pad), y = Math.max(0, best.y - pad);
      return new cv.Rect(x, y, Math.min(best.width + 2 * pad, binary.cols - x), Math.min(best.height + 2 * pad, binary.rows - y));
    }
    return null;
  },

  // Project a line mask onto an axis; rows/cols whose white-pixel count exceeds
  // a fraction of the span are line positions, then cluster adjacent ones.
  // Uses cv.reduce (vectorised in WASM) instead of per-pixel JS loops — the
  // mask is 0/255, so a reduced SUM divided by 255 is the white-pixel count.
  _lineCoords(mask, dir, projFrac) {
    const acc = new cv.Mat();
    const coords = [];
    if (dir === 'h') {
      cv.reduce(mask, acc, 1, cv.REDUCE_SUM, cv.CV_32S); // rows×1 row sums
      const thresh = mask.cols * 255 * projFrac;
      const d = acc.data32S;
      for (let y = 0; y < d.length; y++) if (d[y] > thresh) coords.push(y);
    } else {
      cv.reduce(mask, acc, 0, cv.REDUCE_SUM, cv.CV_32S); // 1×cols col sums
      const thresh = mask.rows * 255 * projFrac;
      const d = acc.data32S;
      for (let x = 0; x < d.length; x++) if (d[x] > thresh) coords.push(x);
    }
    acc.delete();
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
    const data = mask.data, cols = mask.cols, rows = mask.rows;
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    let hit = 0;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + (x1 - x0) * i / steps);
      const y = Math.round(y0 + (y1 - y0) * i / steps);
      for (let d = -2; d <= 2; d++) {
        const xx = (x1 === x0) ? x + d : x;
        const yy = (y1 === y0) ? y + d : y;
        if (xx >= 0 && yy >= 0 && xx < cols && yy < rows && data[yy * cols + xx]) { hit++; break; }
      }
    }
    return hit / (steps + 1) > 0.5;
  },

  // Recover extra column boundaries from the table crop's vertical ink profile:
  // persistent low-ink columns are whitespace gutters BETWEEN text blocks, which
  // often coincide with column boundaries even when a printed rule is missing or
  // faint. NOTE: this detects gutters, not the rules themselves. Measured as a
  // conservative no-op on the current sample (recovers nothing at the 0.2 ratio);
  // kept as a safe, gated mechanism — see tools/tablecv-harness/batch.md.
  _recoverColumns(roi, xsRoi) {
    // Vertical projection of ink density via cv.reduce (handles ROI strides and
    // is far faster than per-pixel JS). Values are 255× the white-pixel count,
    // but the recovery test below is ratio-based, so the scale is irrelevant.
    const W = roi.cols;
    const acc = new cv.Mat();
    cv.reduce(roi, acc, 0, cv.REDUCE_SUM, cv.CV_32S); // 1×W column sums
    const colInk = acc.data32S;
    // Candidate separators: columns whose ink is below 20% of the local average
    // over a wide window (persistent vertical gaps).
    const win = Math.round(W * 0.04) || 1;
    const recovered = [];
    for (let x = win; x < W - win; x++) {
      let sum = 0; for (let k = x - win; k <= x + win; k++) sum += colInk[k];
      const avg = sum / (2 * win + 1);
      if (avg > 0 && colInk[x] < avg * 0.2) recovered.push(x);
    }
    acc.delete();
    return TableCVGrid.clusterCoords(xsRoi.concat(recovered), 8);
  },
};
