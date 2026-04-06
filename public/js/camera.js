/* global App, Camera */
const Camera = {
  initialized: false,
  totalUploaded: 0,
  history: [], // { id, url, name, status, invoiceId?, error? }
  db: null,
  DB_NAME: 'scanflow_camera',
  STORE_NAME: 'pending_photos',

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
      this.capturePhoto(file);
    });

    // Open IndexedDB, then retry any pending uploads from previous sessions
    this.openDb().then(() => this.retryPending());
  },

  // --- IndexedDB ---

  openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(this.STORE_NAME, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => { console.error('IndexedDB error', req.error); reject(req.error); };
    });
  },

  dbPut(blob, name) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.add({ blob, name, createdAt: Date.now() });
      req.onsuccess = () => resolve(req.result); // returns auto-incremented id
      req.onerror = () => reject(req.error);
    });
  },

  dbDelete(id) {
    return new Promise((resolve) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
    });
  },

  dbGetAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const req = tx.objectStore(this.STORE_NAME).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  // --- Capture & Upload ---

  async capturePhoto(file) {
    const name = file.name || `photo_${Date.now()}.jpg`;

    // 1. Save to IndexedDB FIRST (survives screen off / tab kill)
    let dbId;
    try {
      const blob = await file.arrayBuffer().then(b => new Blob([b], { type: file.type || 'image/jpeg' }));
      dbId = await this.dbPut(blob, name);
    } catch (e) {
      console.error('Failed to save to IndexedDB', e);
      // Still try to upload directly
    }

    // 2. Add to visible history
    const idx = this.history.length;
    this.history.push({
      id: dbId,
      url: URL.createObjectURL(file),
      name,
      status: 'uploading',
    });
    this.renderHistory();
    this.updateCounter();

    // 3. Upload in background
    this.doUpload(file, idx, dbId);
  },

  async retryPending() {
    if (!this.db) return;
    let pending;
    try { pending = await this.dbGetAll(); } catch { return; }
    if (!pending.length) return;

    // Filter out items already in current history (avoid duplicates)
    const knownIds = new Set(this.history.map(h => h.id).filter(Boolean));
    const toRetry = pending.filter(p => !knownIds.has(p.id));
    if (!toRetry.length) return;

    App.notify(`Дозагрузка ${toRetry.length} фото...`, 'success');

    for (const item of toRetry) {
      const idx = this.history.length;
      const blob = item.blob;
      const url = URL.createObjectURL(blob);
      this.history.push({
        id: item.id,
        url,
        name: item.name,
        status: 'uploading',
      });
      this.renderHistory();
      this.updateCounter();
      this.doUpload(blob, idx, item.id);
    }
  },

  async doUpload(fileOrBlob, idx, dbId) {
    try {
      const formData = new FormData();
      formData.append('file', fileOrBlob, this.history[idx].name);

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
        // Remove from IndexedDB — delivered successfully
        if (dbId) this.dbDelete(dbId).catch(() => {});
      } else {
        this.history[idx].status = 'error';
        this.history[idx].error = data.error || `HTTP ${res.status}`;
        App.notify('Ошибка: ' + this.history[idx].error, 'error');
        // Keep in IndexedDB — will retry on next page load
      }
    } catch (err) {
      this.history[idx].status = 'error';
      this.history[idx].error = err.message;
      App.notify('Ошибка сети: ' + err.message, 'error');
      // Keep in IndexedDB — will retry on next page load
    }
    this.updateCounter();
    this.renderHistory();
  },

  retry(idx) {
    const h = this.history[idx];
    if (!h || h.status !== 'error') return;

    // Try to get blob from IndexedDB if file is gone from memory
    h.status = 'uploading';
    h.error = null;
    this.renderHistory();
    this.updateCounter();

    if (h.id && this.db) {
      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const req = tx.objectStore(this.STORE_NAME).get(h.id);
      req.onsuccess = () => {
        if (req.result?.blob) {
          this.doUpload(req.result.blob, idx, h.id);
        } else {
          h.status = 'error';
          h.error = 'Фото утеряно, сделайте заново';
          this.renderHistory();
        }
      };
      req.onerror = () => {
        h.status = 'error';
        h.error = 'Не удалось прочитать фото';
        this.renderHistory();
      };
    } else {
      h.status = 'error';
      h.error = 'Фото утеряно, сделайте заново';
      this.renderHistory();
    }
  },

  // --- UI ---

  updateCounter() {
    const el = document.getElementById('camera-counter');
    const uploading = this.history.filter(h => h.status === 'uploading').length;
    const errors = this.history.filter(h => h.status === 'error').length;
    const parts = [];
    if (this.totalUploaded > 0) parts.push(`Загружено: ${this.totalUploaded}`);
    if (uploading > 0) parts.push(`В очереди: ${uploading}`);
    if (errors > 0) parts.push(`Ошибок: ${errors}`);
    el.textContent = parts.join(' · ');
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
