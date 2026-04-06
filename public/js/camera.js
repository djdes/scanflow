/* global App, Camera */
const Camera = {
  initialized: false,
  totalUploaded: 0,
  queue: [],    // { file, url, name } — photos waiting to be sent
  history: [],  // { url, name, status, invoiceId?, error? }

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
      this.addToQueue(file);
    });
  },

  addToQueue(file) {
    const url = URL.createObjectURL(file);
    const name = file.name || `photo_${this.queue.length + 1}.jpg`;
    this.queue.push({ file, url, name });
    this.renderQueue();
  },

  removeFromQueue(idx) {
    URL.revokeObjectURL(this.queue[idx].url);
    this.queue.splice(idx, 1);
    this.renderQueue();
  },

  renderQueue() {
    const container = document.getElementById('camera-queue');
    const sendBtn = document.getElementById('btn-camera-send');
    const badge = document.getElementById('camera-queue-badge');

    if (this.queue.length === 0) {
      container.innerHTML = '';
      sendBtn.style.display = 'none';
      return;
    }

    sendBtn.style.display = 'flex';
    badge.textContent = `(${this.queue.length})`;

    container.innerHTML = this.queue.map((q, i) => `
      <div class="camera-queue-item">
        <img src="${q.url}" alt="">
        <div class="camera-queue-info">
          <span>${q.name}</span>
          <button class="btn btn-sm btn-danger" onclick="Camera.removeFromQueue(${i})">x</button>
        </div>
      </div>
    `).join('');
  },

  async sendAll() {
    if (this.queue.length === 0) return;

    const sendBtn = document.getElementById('btn-camera-send');
    const captureBtn = document.getElementById('btn-camera-capture');
    sendBtn.disabled = true;
    captureBtn.disabled = true;

    const items = [...this.queue];
    this.queue = [];
    this.renderQueue();

    // Move all to history as "uploading"
    const startIdx = this.history.length;
    for (const item of items) {
      this.history.push({
        url: item.url,
        name: item.name,
        file: item.file,
        status: 'uploading',
      });
    }
    this.renderHistory();

    // Upload sequentially (server processes one at a time anyway)
    for (let i = 0; i < items.length; i++) {
      const histIdx = startIdx + i;
      try {
        const formData = new FormData();
        formData.append('file', items[i].file, items[i].name);

        const res = await fetch(App.baseUrl + '/upload', {
          method: 'POST',
          headers: { 'X-API-Key': App.apiKey },
          body: formData,
        });

        const data = await res.json().catch(() => ({}));

        if (res.ok) {
          this.totalUploaded++;
          this.history[histIdx].status = 'ok';
          this.history[histIdx].invoiceId = data.invoice_id;
        } else {
          this.history[histIdx].status = 'error';
          this.history[histIdx].error = data.error || `HTTP ${res.status}`;
        }
      } catch (err) {
        this.history[histIdx].status = 'error';
        this.history[histIdx].error = err.message;
      }
      this.renderHistory();
    }

    const ok = items.length - this.history.slice(startIdx).filter(h => h.status === 'error').length;
    if (ok > 0) App.notify(`Загружено ${ok} из ${items.length} фото`, 'success');
    if (ok < items.length) App.notify(`Ошибок: ${items.length - ok}`, 'error');

    sendBtn.disabled = false;
    captureBtn.disabled = false;
    this.updateCounter();
  },

  updateCounter() {
    const el = document.getElementById('camera-counter');
    if (this.totalUploaded > 0) {
      el.textContent = `Загружено за сессию: ${this.totalUploaded}`;
    } else {
      el.textContent = '';
    }
  },

  renderHistory() {
    const container = document.getElementById('camera-history');
    if (this.history.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = this.history.slice().reverse().map(h => {
      let statusHtml = '';
      if (h.status === 'uploading') {
        statusHtml = '<span class="camera-status camera-status-loading">Загрузка...</span>';
      } else if (h.status === 'ok') {
        statusHtml = `<a href="#/invoices/${h.invoiceId}" class="camera-status camera-status-ok">Накладная #${h.invoiceId}</a>`;
      } else {
        statusHtml = `<span class="camera-status camera-status-error" title="${h.error || ''}">Ошибка</span>`;
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
