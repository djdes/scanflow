/* global App, Camera */
const Camera = {
  initialized: false,
  totalUploaded: 0,
  history: [], // { url, name, file, status, invoiceId?, error? }

  init() {
    if (this.initialized) return;
    this.initialized = true;

    const btn = document.getElementById('btn-camera-capture');
    const fileInput = document.getElementById('camera-file-input');

    btn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      fileInput.value = '';
      this.queueUpload(file);
    });
  },

  // Add photo to history and start background upload (non-blocking)
  queueUpload(file) {
    const idx = this.history.length;
    const previewUrl = URL.createObjectURL(file);
    this.history.push({
      url: previewUrl,
      name: file.name || `photo_${idx + 1}.jpg`,
      file,
      status: 'uploading',
    });
    this.renderHistory();
    this.updateCounter();

    // Fire and forget — don't await, camera stays ready
    this.doUpload(file, idx);
  },

  async doUpload(file, idx) {
    try {
      const formData = new FormData();
      formData.append('file', file, this.history[idx].name);

      const res = await fetch(App.baseUrl + '/upload', {
        method: 'POST',
        headers: { 'X-API-Key': App.apiKey },
        body: formData,
      });

      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        this.totalUploaded++;
        this.history[idx].status = 'ok';
        this.history[idx].invoiceId = data.invoice_id;
        App.notify(`Накладная #${data.invoice_id} загружена`, 'success');
      } else {
        this.history[idx].status = 'error';
        this.history[idx].error = data.error || `HTTP ${res.status}`;
        App.notify('Ошибка: ' + this.history[idx].error, 'error');
      }
    } catch (err) {
      this.history[idx].status = 'error';
      this.history[idx].error = err.message;
      App.notify('Ошибка сети: ' + err.message, 'error');
    }
    this.updateCounter();
    this.renderHistory();
  },

  updateCounter() {
    const el = document.getElementById('camera-counter');
    const uploading = this.history.filter(h => h.status === 'uploading').length;
    const parts = [];
    if (this.totalUploaded > 0) parts.push(`Загружено: ${this.totalUploaded}`);
    if (uploading > 0) parts.push(`В очереди: ${uploading}`);
    el.textContent = parts.join(' · ');
  },

  retry(idx) {
    const h = this.history[idx];
    if (!h || !h.file || h.status !== 'error') return;
    h.status = 'uploading';
    h.error = null;
    this.renderHistory();
    this.updateCounter();
    this.doUpload(h.file, idx);
  },

  renderHistory() {
    const container = document.getElementById('camera-history');
    if (this.history.length === 0) {
      container.innerHTML = '';
      return;
    }

    const items = this.history.map((h, i) => ({ ...h, idx: i })).reverse();
    container.innerHTML = items.map(h => {
      let statusHtml = '';
      if (h.status === 'uploading') {
        statusHtml = '<span class="camera-status camera-status-loading">Загрузка...</span>';
      } else if (h.status === 'ok') {
        statusHtml = `<a href="#/invoices/${h.invoiceId}" class="camera-status camera-status-ok">Накладная #${h.invoiceId}</a>`;
      } else {
        statusHtml = `<span class="camera-status camera-status-error" title="${h.error || ''}">Ошибка</span>
          <button class="btn btn-sm btn-outline" onclick="Camera.retry(${h.idx})" style="margin-left:8px">Повторить</button>`;
      }
      return `<div class="camera-history-item">
        <img src="${h.url}" alt="">
        <div class="camera-history-info">
          <div class="camera-history-name">${h.name}</div>
          ${statusHtml}
        </div>
      </div>`;
    }).join('');
  }
};
