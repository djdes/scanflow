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

  // Vendored build is @techstark/opencv-js (full OpenCV, self-contained wasm).
  // It is a UMD factory that sets the global `cv` synchronously on script
  // execution; the wasm compiles asynchronously and fires
  // `cv.onRuntimeInitialized` when ready. (This differs from the official
  // non-modularised build, which reads a pre-set global `Module`.)
  _loadOpenCv() {
    return new Promise((resolve, reject) => {
      if (typeof cv !== 'undefined' && cv.Mat) return resolve();
      const s = document.createElement('script');
      s.src = '/vendor/opencv/opencv.js';
      s.onerror = () => reject(new Error('Не удалось загрузить opencv.js'));
      s.onload = () => {
        if (typeof cv === 'undefined') {
          return reject(new Error('opencv.js загрузился, но глобальный cv не определён'));
        }
        if (cv.Mat) return resolve();
        cv.onRuntimeInitialized = () => resolve();
      };
      document.head.appendChild(s);
    });
  },
};
