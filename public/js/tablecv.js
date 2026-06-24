/* global App */
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
};
