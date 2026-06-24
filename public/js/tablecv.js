/* global App, cv, TableCVExport */
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

  async _run() {
    const progress = document.getElementById('tablecv-progress');
    try {
      progress.hidden = false; progress.value = 5;
      await TableCVLoader.ensure((m) => this._status(m));
      const opts = {
        maxSide: 2000,
        blockSize: parseInt(document.getElementById('tablecv-block').value, 10),
      };
      this._pre = TableCVPre.run(this.state.img, opts);
      const layer = document.getElementById('tablecv-layer').value;
      if (layer === 'binary') cv.imshow('tablecv-canvas', this._pre.binary);
      else cv.imshow('tablecv-canvas', this._pre.gray);

      const det = TableCVDetect.run(this._pre.binary, {
        lineLenPct: parseInt(document.getElementById('tablecv-linelen').value, 10),
      });
      this.state.cells = det.cells;

      if (layer === 'lines') {
        const merged = new cv.Mat();
        cv.add(det.hMask, det.vMask, merged);
        cv.imshow('tablecv-canvas', merged);
        merged.delete();
      } else if (layer !== 'binary') {
        TableCVOverlay.draw('tablecv-canvas', this._pre.gray, det.cells, -1);
      }
      this._status('Найдено ячеек: ' + det.cells.length);

      det.hMask.delete(); det.vMask.delete();

      const geomOnly = document.getElementById('tablecv-geom-only').checked;
      if (!geomOnly && det.cells.length) {
        const progress = document.getElementById('tablecv-progress');
        progress.hidden = false;
        await TableCVOcr.run(this._pre.gray, this.state.cells, (done, total) => {
          progress.value = Math.round(done / total * 100);
          this._status('OCR ячеек: ' + done + '/' + total);
        });
        progress.hidden = true;
        TableCVOverlay.draw('tablecv-canvas', this._pre.gray, this.state.cells, -1);
        this._renderResults();
      }

      progress.value = 100;
    } catch (err) {
      this._status(err.message, true);
    } finally {
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
      const json = TableCVExport.cellsToJSON(this.state.cells, {
        count: this.state.cells.length,
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
