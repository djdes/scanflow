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
