/* global App, cv, TableCVExport, TableCVLoader, TableCVPre, TableCVDetect, TableCVOverlay, TableCVOcr */
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
    let det = null;
    let best = null;
    let maskesDeleted = false;
    try {
      if (!this.state.img) { this._status('Сначала выберите фото', true); return; }
      this._cleanupPre();

      progress.hidden = false; progress.value = 5;
      await TableCVLoader.ensure((m) => this._status(m));

      const blockSize = parseInt(document.getElementById('tablecv-block').value, 10);
      const detOpts = { blockSize, lineKernelFrac: 0.12, projFrac: 0.2 };
      const layer = document.getElementById('tablecv-layer').value;

      // Preprocess (downscale + deskew), then auto-orient: runAuto tries the 4
      // orthogonal rotations (phone EXIF) and localises the table, returning the
      // orientation with the best grid.
      const pre = TableCVPre.run(this.state.img, { maxSide: 2000, blockSize });
      const scale = pre.scale;
      best = TableCVDetect.runAuto(pre.gray, detOpts);
      pre.gray.delete(); pre.binary.delete();
      det = best.det; // for the finally-block mask backstop

      // Hold the oriented gray/binary for hover redraw + debug layers.
      this._pre = { gray: best.gray, binary: best.binary, scale };

      if (layer === 'binary') {
        cv.imshow('tablecv-canvas', best.binary);
      } else if (layer === 'lines') {
        const merged = new cv.Mat();
        cv.add(best.det.hMask, best.det.vMask, merged);
        cv.imshow('tablecv-canvas', merged);
        merged.delete();
      }

      if (best.det.cells.length === 0) {
        if (layer !== 'binary' && layer !== 'lines') {
          const merged = new cv.Mat();
          cv.add(best.det.hMask, best.det.vMask, merged);
          cv.imshow('tablecv-canvas', merged);
          merged.delete();
        }
        this._status('Таблица не найдена — на фото нет уверенной сетки линий. Попробуйте более ровное/контрастное фото.', true);
        best.det.hMask.delete(); best.det.vMask.delete();
        maskesDeleted = true;
        return;
      }

      best.det.hMask.delete(); best.det.vMask.delete();
      maskesDeleted = true;

      this.state.cells = best.det.cells;
      if (layer !== 'binary' && layer !== 'lines') {
        TableCVOverlay.draw('tablecv-canvas', best.gray, best.det.cells, -1);
      }
      this._status('Найдено ячеек: ' + best.det.cells.length + ' (поворот ' + (best.rot * 90) + '°)');

      const geomOnly = document.getElementById('tablecv-geom-only').checked;
      if (geomOnly) { progress.value = 100; return; }

      // OCR + orientation disambiguation: geometry can't tell upright from
      // upside-down (both give the same grid), so OCR the table crop of the
      // chosen orientation vs its 180° sibling and keep the higher-confidence
      // reading, then OCR every cell of the winner.
      const g180 = new cv.Mat();
      cv.rotate(best.gray, g180, cv.ROTATE_180);
      const bin180 = new cv.Mat();
      const bs = (blockSize % 2 === 1) ? blockSize : blockSize + 1;
      cv.adaptiveThreshold(g180, bin180, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, bs, 10);
      const det180 = TableCVDetect.run(bin180, detOpts);
      det180.hMask.delete(); det180.vMask.delete(); bin180.delete();

      const candidates = [
        { gray: best.gray, cells: best.det.cells, region: best.det.region },
        { gray: g180, cells: det180.cells, region: det180.region },
      ];
      const picked = await TableCVOcr.runOriented(candidates, (done, total, msg) => {
        progress.value = msg ? 5 : Math.round(done / total * 100);
        this._status(msg || ('OCR ячеек: ' + done + '/' + total));
      });

      // Keep the winning gray for hover/results; free the loser.
      if (picked.index === 0) {
        g180.delete();
      } else {
        best.gray.delete();
        this._pre.gray = picked.gray;
      }
      this.state.cells = picked.cells;
      TableCVOverlay.draw('tablecv-canvas', picked.gray, picked.cells, -1);
      this._renderResults();
      progress.value = 100;
    } catch (err) {
      this._status(err.message, true);
    } finally {
      if (det && !maskesDeleted) {
        det.hMask && det.hMask.delete && det.hMask.delete();
        det.vMask && det.vMask.delete && det.vMask.delete();
      }
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
