/* global App, cv, TableCVExport, TableCVLoader, TableCVPre, TableCVDetect, TableCVOverlay, TableCVOcr, TableCVOrient */
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

    document.getElementById('tablecv-run').onclick = () => this._run();
  },

  _cleanupPre() {
    if (this._pre) {
      this._pre.gray && this._pre.gray.delete && this._pre.gray.delete();
      this._pre.binary && this._pre.binary.delete && this._pre.binary.delete();
      this._pre = null;
    }
  },

  async _run() {
    const progress = document.getElementById('tablecv-progress');
    // Idempotent Mat freeing: del() never double-deletes, and Mats added to
    // `freed` (the ones we hand to this._pre) are protected from the finally
    // backstop.
    const freed = new WeakSet();
    const del = (m) => { if (m && !freed.has(m)) { try { m.delete(); } catch (e) { /* already gone */ } freed.add(m); } };
    let cands = null;
    let keptGray = null;
    try {
      if (!this.state.img) { this._status('Сначала выберите фото', true); return; }
      this._cleanupPre();

      progress.hidden = false; progress.value = 5;
      await TableCVLoader.ensure((m) => this._status(m));

      const rawBlock = parseInt(document.getElementById('tablecv-block').value, 10);
      const blockSize = (rawBlock % 2 === 1) ? rawBlock : rawBlock + 1; // adaptiveThreshold needs odd
      const detOpts = { blockSize, lineKernelFrac: 0.12, projFrac: 0.2 };
      const layer = document.getElementById('tablecv-layer').value;

      const pre = TableCVPre.run(this.state.img, { maxSide: 2000, blockSize });
      const scale = pre.scale;

      // Orientation: a learned whole-image classifier (ONNX) gives the full
      // upright rotation (axis AND up/down flip). It is far more reliable than
      // the old OCR-confidence guess, especially on sparse table pages where OCR
      // confidence is near-random — so we TRUST the classifier's orientation
      // directly rather than re-deciding the flip by OCR. If the model is
      // unavailable, or its orientation yields no table, fall back to scanning
      // all 4 rotations and letting OCR pick the readable one.
      let rots = [0, 1, 2, 3];
      let classifierOk = false;
      try {
        await TableCVOrient.ensure((m) => this._status(m));
        const src = cv.imread(this.state.img);
        const cls = await TableCVOrient.classify(src);
        del(src);
        rots = [cls.applyRot];
        classifierOk = true;
      } catch (e) {
        rots = [0, 1, 2, 3];
      }

      const detectRots = (list) => {
        const acc = [];
        for (const k of list) {
          const c = TableCVDetect._detectRotation(pre.gray, k, blockSize, detOpts);
          if (c.det.xs.length >= 2 && c.det.ys.length >= 2 && c.det.cells.length > 0) acc.push(c);
          else { del(c.gray); del(c.binary); del(c.det.hMask); del(c.det.vMask); }
        }
        return acc;
      };
      cands = detectRots(rots);
      // Classifier orientation found no grid → fall back to a full 4-way scan.
      if (classifierOk && !cands.length) cands = detectRots([0, 1, 2, 3]);
      del(pre.gray); del(pre.binary);

      if (!cands.length) {
        this._status('Таблица не найдена — на фото нет уверенной сетки линий. Попробуйте более ровное/контрастное фото.', true);
        return;
      }

      // Geometry-best candidate drives the fast preview and the debug layers.
      let gbest = cands[0];
      for (const c of cands) if (c.det.cells.length > gbest.det.cells.length) gbest = c;

      if (layer === 'binary') {
        cv.imshow('tablecv-canvas', gbest.binary);
      } else if (layer === 'lines') {
        const merged = new cv.Mat();
        cv.add(gbest.det.hMask, gbest.det.vMask, merged);
        cv.imshow('tablecv-canvas', merged);
        merged.delete();
      } else {
        TableCVOverlay.draw('tablecv-canvas', gbest.gray, gbest.det.cells, -1);
      }

      // Masks are only needed for the debug layers above.
      cands.forEach((c) => { del(c.det.hMask); del(c.det.vMask); });
      this.state.cells = gbest.det.cells;

      const geomOnly = document.getElementById('tablecv-geom-only').checked;
      if (geomOnly) {
        keptGray = gbest.gray;
        freed.add(gbest.gray); freed.add(gbest.binary); // hand to _pre; protect
        this._pre = { gray: gbest.gray, binary: gbest.binary, scale };
        cands.forEach((c) => { if (c !== gbest) { del(c.gray); del(c.binary); } });
        this._status('Найдено ячеек: ' + gbest.det.cells.length + ' (поворот ' + (gbest.rot * 90) + '°, геометрия)');
        progress.value = 100;
        return;
      }

      // Full run: choose the READABLE orientation among all candidates by OCR
      // confidence — a sideways rotation ties on cell count but reads as noise,
      // so geometry alone can't pick it. Then OCR every cell of the winner.
      const ocrCands = cands.map((c) => ({ gray: c.gray, cells: c.det.cells, region: c.det.region }));
      const picked = await TableCVOcr.runOriented(ocrCands, (done, total, msg) => {
        progress.value = msg ? 5 : Math.round(done / total * 100);
        this._status(msg || ('OCR ячеек: ' + done + '/' + total));
      });

      keptGray = picked.gray;
      freed.add(picked.gray); // winner handed to _pre; protect from cleanup
      this._pre = { gray: picked.gray, binary: null, scale };
      this.state.cells = picked.cells;
      cands.forEach((c) => { del(c.gray); del(c.binary); }); // winner gray protected

      TableCVOverlay.draw('tablecv-canvas', picked.gray, picked.cells, -1);
      this._renderResults();
      const pr = cands[picked.index] ? (cands[picked.index].rot * 90) : 0;
      this._status('Готово: ' + picked.cells.length + ' ячеек (поворот ' + pr + '°)');
      progress.value = 100;
    } catch (err) {
      this._status(err.message, true);
    } finally {
      // Backstop: free every candidate Mat that wasn't already released; the
      // winner gray (and geom-only binary) are in `freed`, so they survive.
      if (cands) cands.forEach((c) => {
        del(c.det && c.det.hMask); del(c.det && c.det.vMask);
        del(c.gray); del(c.binary);
      });
      setTimeout(() => { progress.hidden = true; progress.value = 0; }, 800);
    }
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

  _renderResults() {
    const out = document.getElementById('tablecv-output');
    out.hidden = false;
    document.getElementById('tablecv-table-wrap').innerHTML =
      TableCVExport.cellsToHTMLTable(this.state.cells);

    document.getElementById('tablecv-export').onclick = () => {
      // Cell x/y/w/h are in the deskewed WORKING-image pixel space (the photo
      // is downscaled by `scale` and deskewed before detection). We surface
      // `scale` and the working dimensions so a consumer can relate the boxes
      // back to the original photo if needed.
      const json = TableCVExport.cellsToJSON(this.state.cells, {
        count: this.state.cells.length,
        coordSpace: 'deskewed-working-image',
        scale: this._pre ? this._pre.scale : null,
        workingWidth: this._pre && this._pre.gray ? this._pre.gray.cols : null,
        workingHeight: this._pre && this._pre.gray ? this._pre.gray.rows : null,
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
};
