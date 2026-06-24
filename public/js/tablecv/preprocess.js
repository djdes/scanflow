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

    // Deskew: estimate dominant skew from near-horizontal ruling lines.
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

  // Estimate page skew from the long near-horizontal ruling lines via
  // probabilistic Hough. (The @techstark opencv.js build does not expose
  // cv.findNonZero, so the minAreaRect-on-points approach isn't available.)
  // Returns the median angle in degrees of segments within ±15° of horizontal.
  _estimateSkew(gray) {
    const edges = new cv.Mat();
    cv.Canny(gray, edges, 50, 150, 3, false);
    const lines = new cv.Mat();
    const minLen = Math.max(60, Math.round(gray.cols * 0.3));
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 100, minLen, 10);
    const angles = [];
    for (let i = 0; i < lines.rows; i++) {
      const x1 = lines.data32S[i * 4], y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2], y2 = lines.data32S[i * 4 + 3];
      const deg = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (Math.abs(deg) < 15) angles.push(deg);
    }
    edges.delete(); lines.delete();
    if (angles.length === 0) return 0;
    angles.sort((a, b) => a - b);
    return angles[Math.floor(angles.length / 2)];
  },
};
