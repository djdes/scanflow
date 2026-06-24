/* global cv, ort */
// Learned whole-image orientation classifier (PaddleClas PP-LCNet_x1_0_doc_ori,
// 4 classes 0/90/180/270) running in-browser via onnxruntime-web. Replaces the
// fragile OCR-confidence orientation guess. The class→rotation mapping is
// calibrated empirically (see CLASS_TO_APPLY) against photos of known orientation.
const TableCVOrient = {
  _session: null,
  _ortPromise: null,

  // class index → number of 90° CW rotations (cv.ROTATE steps) to APPLY to make
  // the image upright. Calibrated on labelled photos; see orient-test harness.
  CLASS_TO_APPLY: [0, 3, 2, 1], // doc_ori predicts current rotation 0/90/180/270 (CW); correct by the complement

  async ensure(onProgress) {
    if (this._session) return;
    if (!this._ortPromise) {
      this._ortPromise = (async () => {
        onProgress && onProgress('Загрузка onnxruntime-web…');
        await this._loadScript('/vendor/ort/ort.wasm.min.js', () => typeof ort !== 'undefined');
        ort.env.wasm.wasmPaths = '/vendor/ort/';
        ort.env.wasm.numThreads = 1; // single-thread: no SharedArrayBuffer / COOP-COEP needed
        onProgress && onProgress('Загрузка модели ориентации…');
        this._session = await ort.InferenceSession.create('/vendor/models/doc_ori.onnx', { executionProviders: ['wasm'] });
      })().catch((e) => { this._ortPromise = null; throw e; });
    }
    return this._ortPromise;
  },

  _loadScript(src, ready) {
    return new Promise((resolve, reject) => {
      if (ready && ready()) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Не удалось загрузить ' + src));
      document.head.appendChild(s);
    });
  },

  // Run the classifier on the COLOR source image (RGBA from cv.imread, or any
  // Mat — gray is accepted but colour is markedly more accurate). Preprocessing
  // matches PaddleClas PP-LCNet: resize short side to 256, centre-crop 224,
  // ImageNet-normalise, RGB, NCHW. (Calibrated empirically: colour + 256/crop
  // beats gray + direct-224, fixing the 0↔180 confusion on text-rich pages.)
  // Returns { classIdx, degrees, applyRot, probs } where applyRot is the number
  // of 90° CW rotations to make the document upright.
  async classify(srcMat) {
    const crop = this._crop224(srcMat);
    const data = crop.data; // RGBRGB… uint8, length 224*224*3
    const N = 224 * 224;
    const f = new Float32Array(3 * N);
    const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
    for (let i = 0; i < N; i++) {
      f[i] = ((data[i * 3] / 255) - mean[0]) / std[0];
      f[N + i] = ((data[i * 3 + 1] / 255) - mean[1]) / std[1];
      f[2 * N + i] = ((data[i * 3 + 2] / 255) - mean[2]) / std[2];
    }
    crop.delete();
    const tensor = new ort.Tensor('float32', f, [1, 3, 224, 224]);
    const feeds = {};
    feeds[this._session.inputNames[0]] = tensor;
    const out = await this._session.run(feeds);
    const logits = Array.from(out[this._session.outputNames[0]].data);
    let argmax = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[argmax]) argmax = i;
    const probs = this._softmax(logits);
    return {
      classIdx: argmax,
      degrees: [0, 90, 180, 270][argmax],
      applyRot: this.CLASS_TO_APPLY[argmax],
      probs,
      // margin between the chosen class and its 180° sibling — low margin means
      // the up/down flip is uncertain (common on sparse table pages).
      flipMargin: Math.abs(probs[argmax] - probs[(argmax + 2) % 4]),
    };
  },

  // RGB, short-side→256, centre-crop 224. Returns an 8U RGB 224×224 Mat.
  _crop224(srcMat) {
    const rgb = new cv.Mat();
    if (srcMat.channels() === 4) cv.cvtColor(srcMat, rgb, cv.COLOR_RGBA2RGB);
    else if (srcMat.channels() === 1) cv.cvtColor(srcMat, rgb, cv.COLOR_GRAY2RGB);
    else srcMat.copyTo(rgb);
    const s = 256 / Math.min(rgb.rows, rgb.cols);
    const rs = new cv.Mat();
    cv.resize(rgb, rs, new cv.Size(Math.round(rgb.cols * s), Math.round(rgb.rows * s)), 0, 0, cv.INTER_AREA);
    rgb.delete();
    const x = Math.max(0, Math.floor((rs.cols - 224) / 2));
    const y = Math.max(0, Math.floor((rs.rows - 224) / 2));
    const roi = rs.roi(new cv.Rect(x, y, Math.min(224, rs.cols), Math.min(224, rs.rows)));
    const c = new cv.Mat();
    roi.copyTo(c);
    roi.delete(); rs.delete();
    if (c.cols !== 224 || c.rows !== 224) {
      const t = new cv.Mat();
      cv.resize(c, t, new cv.Size(224, 224), 0, 0, cv.INTER_AREA);
      c.delete();
      return t;
    }
    return c;
  },

  _softmax(a) {
    const m = Math.max.apply(null, a);
    const e = a.map((v) => Math.exp(v - m));
    const s = e.reduce((x, y) => x + y, 0);
    return e.map((v) => +(v / s).toFixed(3));
  },
};
