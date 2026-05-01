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

    // Mark as uploading so the user sees immediate feedback (status pill changes,
    // Retry/Delete buttons disappear). Then either replay from IndexedDB or surface
    // a "lost" state if the blob is gone.
    h.status = 'uploading';
    h.error = null;
    this.renderHistory();
    this.updateCounter();

    if (App && App.notify) App.notify('Повторяем загрузку…', 'info');

    const giveUp = (msg) => {
      h.status = 'lost';
      h.error = msg;
      this.renderHistory();
      this.updateCounter();
    };

    if (h.id && this.db) {
      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const req = tx.objectStore(this.STORE_NAME).get(h.id);
      req.onsuccess = () => {
        if (req.result?.blob) {
          this.doUpload(req.result.blob, idx, h.id);
        } else {
          giveUp('Фото утеряно, сделайте заново');
        }
      };
      req.onerror = () => giveUp('Не удалось прочитать фото из браузера');
    } else {
      giveUp('Фото утеряно, сделайте заново');
    }
  },

  // Removes an item from the visible list AND from IndexedDB. Used for both
  // failed uploads (user wants to dismiss the error) and successful ones
  // (user wants to clear the screen). Server-side invoice is NOT touched —
  // the dashboard has its own delete button for that.
  async remove(idx) {
    const h = this.history[idx];
    if (!h) return;
    // Mark removed so renderHistory drops it. We don't splice the array
    // because indexes are baked into onclick handlers.
    h.status = 'removed';
    if (h.url) {
      try { URL.revokeObjectURL(h.url); } catch {}
    }
    if (h.id && this.db) {
      try { await this.dbDelete(h.id); } catch {}
    }
    this.renderHistory();
    this.updateCounter();
  },

  // --- UI ---

  updateCounter() {
    const el = document.getElementById('camera-counter');
    const visible = this.history.filter(h => h.status !== 'removed');
    const uploading = visible.filter(h => h.status === 'uploading').length;
    const errors = visible.filter(h => h.status === 'error' || h.status === 'lost').length;
    const parts = [];
    if (this.totalUploaded > 0) parts.push(`Загружено: ${this.totalUploaded}`);
    if (uploading > 0) parts.push(`В очереди: ${uploading}`);
    if (errors > 0) parts.push(`Ошибок: ${errors}`);
    el.textContent = parts.join(' · ');
  },

  renderHistory() {
    const container = document.getElementById('camera-history');

    const esc = (s) => (window.App ? App.esc(s) : String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));

    // Build with index baked in so dismissed items don't shift indexes
    // for surviving rows (we never splice the array).
    const items = this.history
      .map((h, i) => ({ ...h, idx: i }))
      .filter(h => h.status !== 'removed')
      .reverse();

    if (items.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = items.map(h => {
      let statusHtml = '';
      let actionsHtml = '';

      if (h.status === 'uploading') {
        statusHtml = '<span class="camera-status camera-status-loading">Загрузка…</span>';
      } else if (h.status === 'ok') {
        const id = Number(h.invoiceId);
        const safeId = Number.isFinite(id) ? id : 0;
        statusHtml = `<a href="#/invoices/${safeId}" class="camera-status camera-status-ok">Накладная #${safeId}</a>`;
        actionsHtml = `<button class="btn btn-sm btn-outline camera-action-btn" onclick="Camera.remove(${h.idx})">Убрать</button>`;
      } else if (h.status === 'lost') {
        statusHtml = `<span class="camera-status camera-status-error">Фото утеряно</span>`;
        const errMsg = esc(h.error || 'Файл больше не доступен в браузере');
        statusHtml += `<div class="camera-error-detail">${errMsg}. Сделайте фото заново.</div>`;
        actionsHtml = `<button class="btn btn-sm btn-outline camera-action-btn" onclick="Camera.remove(${h.idx})">Удалить</button>`;
      } else {
        // status === 'error'
        statusHtml = `<span class="camera-status camera-status-error">Ошибка загрузки</span>`;
        if (h.error) {
          statusHtml += `<div class="camera-error-detail">${esc(h.error)}</div>`;
        }
        actionsHtml = `
          <button class="btn btn-sm btn-primary camera-action-btn" onclick="Camera.retry(${h.idx})">Повторить</button>
          <button class="btn btn-sm btn-outline camera-action-btn" onclick="Camera.remove(${h.idx})">Удалить</button>
        `;
      }

      // h.url is a blob: URL we created ourselves (URL.createObjectURL), but still escape defensively.
      return `<div class="camera-history-item">
        <img src="${esc(h.url)}" alt="">
        <div class="camera-history-info">
          <div class="camera-history-name">${esc(h.name)}</div>
          ${statusHtml}
          ${actionsHtml ? `<div class="camera-actions">${actionsHtml}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }
};
