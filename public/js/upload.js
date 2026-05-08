/* global App, Upload */
// Объединённый загрузчик: камера + drag-drop + browse + IndexedDB persistence
// + per-item retry + Wake Lock + per-item progress bar.
// Все entry-points идут через addFile() — один пайплайн на все случаи.
const Upload = {
  initialized: false,
  totalUploaded: 0,
  history: [], // { id, url, name, status, progress, invoiceId?, error?, _retryAfterMs? }
  db: null,
  DB_NAME: 'scanflow_upload',
  STORE_NAME: 'pending_photos',
  LEGACY_DB_NAME: 'scanflow_camera',  // для миграции после переименования
  MAX_PARALLEL: 3,
  _activeUploads: 0,
  _pendingQueue: [], // { idx, fileOrBlob }, для FIFO когда _activeUploads >= MAX_PARALLEL
  _wakeLock: null,
  _wakeLockSupported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,

  // ====================  INIT  ====================

  init() {
    if (this.initialized) return;
    this.initialized = true;

    // Кнопка "Сфотографировать"
    const btnCapture = document.getElementById('btn-capture');
    const captureInput = document.getElementById('capture-input');
    if (btnCapture && captureInput) {
      btnCapture.addEventListener('click', () => captureInput.click());
      captureInput.addEventListener('change', () => {
        const f = captureInput.files[0];
        captureInput.value = '';
        if (f) this.addFile(f);
      });
    }

    // Drag-drop зона + кнопка browse
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const btnBrowse = document.getElementById('btn-browse');

    if (btnBrowse && fileInput) {
      btnBrowse.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
      });
    }
    if (dropZone && fileInput) {
      dropZone.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        fileInput.click();
      });
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
      dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
      });
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        this._addMultiple(files);
      });
      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files);
        fileInput.value = '';
        this._addMultiple(files);
      });
    }

    // Visibility — re-acquire wake lock когда вкладка снова видима
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this._hasPending()) {
        this._acquireWakeLock();
      }
    });

    // Открыть БД и догрузить незавершённые
    this.openDb().then(() => this.migrateLegacyDb()).then(() => this.retryPending());
  },

  _addMultiple(files) {
    const ALLOWED = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp'];
    for (const file of files) {
      const ext = '.' + (file.name || '').split('.').pop().toLowerCase();
      if (!ALLOWED.includes(ext)) {
        App.notify(`Пропущен: ${file.name} (формат не поддерживается)`, 'error');
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        App.notify(`Пропущен: ${file.name} (>20 МБ)`, 'error');
        continue;
      }
      this.addFile(file);
    }
  },

  // ====================  IndexedDB  ====================

  openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(this.STORE_NAME, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => { this.db = req.result; resolve(); };
      req.onerror = () => { console.error('IndexedDB open error', req.error); reject(req.error); };
    });
  },

  // Перенос pending-записей из старой scanflow_camera (если она ещё существует)
  migrateLegacyDb() {
    return new Promise((resolve) => {
      const open = indexedDB.open(this.LEGACY_DB_NAME);
      open.onupgradeneeded = (e) => {
        // Старой базы не существовало — отменяем upgrade и считаем что мигрировать нечего
        try { e.target.transaction.abort(); } catch {}
      };
      open.onsuccess = async () => {
        const legacyDb = open.result;
        if (!legacyDb.objectStoreNames.contains(this.STORE_NAME)) {
          legacyDb.close();
          try { indexedDB.deleteDatabase(this.LEGACY_DB_NAME); } catch {}
          resolve();
          return;
        }
        try {
          const tx = legacyDb.transaction(this.STORE_NAME, 'readonly');
          const store = tx.objectStore(this.STORE_NAME);
          const getAll = store.getAll();
          getAll.onsuccess = async () => {
            const items = getAll.result || [];
            for (const item of items) {
              try { await this.dbPut(item.blob, item.name); } catch {}
            }
            legacyDb.close();
            try { indexedDB.deleteDatabase(this.LEGACY_DB_NAME); } catch {}
            resolve();
          };
          getAll.onerror = () => { try { legacyDb.close(); } catch {} resolve(); };
        } catch {
          try { legacyDb.close(); } catch {}
          resolve();
        }
      };
      open.onerror = () => resolve();
      open.onblocked = () => resolve();
    });
  },

  dbPut(blob, name) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.add({ blob, name, createdAt: Date.now() });
      req.onsuccess = () => resolve(req.result);
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

  dbGetById(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readonly');
      const req = tx.objectStore(this.STORE_NAME).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  // ====================  Wake Lock  ====================

  async _acquireWakeLock() {
    if (!this._wakeLockSupported) {
      this._renderWakeLockNotice();
      return;
    }
    if (this._wakeLock) return;
    try {
      this._wakeLock = await navigator.wakeLock.request('screen');
      this._wakeLock.addEventListener('release', () => {
        this._wakeLock = null;
      });
    } catch (e) {
      console.warn('WakeLock failed:', e);
    }
    this._renderWakeLockNotice();
  },

  _releaseWakeLock() {
    if (this._wakeLock) {
      try { this._wakeLock.release(); } catch {}
      this._wakeLock = null;
    }
    this._renderWakeLockNotice();
  },

  _hasPending() {
    return this.history.some(h => h.status === 'uploading' || h.status === 'queued');
  },

  _renderWakeLockNotice() {
    const el = document.getElementById('upload-wakelock-notice');
    if (!el) return;
    if (!this._hasPending()) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'upload-wakelock-notice';
      return;
    }
    el.hidden = false;
    if (this._wakeLockSupported && this._wakeLock) {
      el.className = 'upload-wakelock-notice upload-wakelock-active';
      el.textContent = '🔒 Экран не будет гаснуть пока идёт загрузка. Не закрывай вкладку.';
    } else {
      el.className = 'upload-wakelock-notice upload-wakelock-warn';
      el.textContent = '⚠️ Не блокируй экран и не закрывай вкладку — загрузка прервётся. Если что — фото сохранены и догрузятся при следующем открытии.';
    }
  },

  // ====================  Add File / Upload  ====================

  async addFile(file) {
    const name = file.name || `photo_${Date.now()}.jpg`;

    let dbId = null;
    try {
      const blob = file instanceof Blob
        ? file
        : new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
      dbId = await this.dbPut(blob, name);
    } catch (e) {
      console.error('Failed to save to IndexedDB', e);
    }

    const idx = this.history.length;
    this.history.push({
      id: dbId,
      url: URL.createObjectURL(file),
      name,
      status: 'queued',
      progress: 0,
    });
    this.renderHistory();
    this.updateCounter();
    this._acquireWakeLock();
    this._scheduleUpload(idx, file);
  },

  async retryPending() {
    if (!this.db) return;
    let pending;
    try { pending = await this.dbGetAll(); } catch { return; }
    if (!pending.length) return;

    const knownIds = new Set(this.history.map(h => h.id).filter(Boolean));
    const toRetry = pending.filter(p => !knownIds.has(p.id));
    if (!toRetry.length) return;

    App.notify(`Дозагрузка ${toRetry.length} фото...`, 'success');

    for (const item of toRetry) {
      const idx = this.history.length;
      const url = URL.createObjectURL(item.blob);
      this.history.push({
        id: item.id,
        url,
        name: item.name,
        status: 'queued',
        progress: 0,
      });
      this.renderHistory();
      this.updateCounter();
      this._acquireWakeLock();
      this._scheduleUpload(idx, item.blob);
    }
  },

  _scheduleUpload(idx, fileOrBlob) {
    if (this._activeUploads >= this.MAX_PARALLEL) {
      this._pendingQueue.push({ idx, fileOrBlob });
      return;
    }
    this._activeUploads++;
    this.history[idx].status = 'uploading';
    this.renderHistory();
    this.doUpload(fileOrBlob, idx, this.history[idx].id).finally(() => {
      this._activeUploads--;
      this._drainQueue();
      if (!this._hasPending()) this._releaseWakeLock();
      else this._renderWakeLockNotice();
    });
  },

  _drainQueue() {
    while (this._activeUploads < this.MAX_PARALLEL && this._pendingQueue.length > 0) {
      const next = this._pendingQueue.shift();
      this._activeUploads++;
      this.history[next.idx].status = 'uploading';
      this.renderHistory();
      this.doUpload(next.fileOrBlob, next.idx, this.history[next.idx].id).finally(() => {
        this._activeUploads--;
        this._drainQueue();
        if (!this._hasPending()) this._releaseWakeLock();
        else this._renderWakeLockNotice();
      });
    }
  },

  doUpload(fileOrBlob, idx, dbId) {
    return new Promise((resolve) => {
      const formData = new FormData();
      formData.append('file', fileOrBlob, this.history[idx].name);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          this.history[idx].progress = Math.round((e.loaded / e.total) * 100);
          this.renderHistory();
        }
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          this.totalUploaded++;
          this.history[idx].status = 'ok';
          this.history[idx].invoiceId = data.invoice_id;
          this.history[idx].progress = 100;
          App.notify(`Накладная #${data.invoice_id} загружена`, 'success');
          if (dbId) this.dbDelete(dbId).catch(() => {});
        } else if (xhr.status === 429) {
          const retryAfter = parseInt(
            xhr.getResponseHeader('RateLimit-Reset') ||
            xhr.getResponseHeader('Retry-After') || '60', 10);
          this.history[idx].status = 'error';
          this.history[idx].error = `Слишком много загрузок, подожди ${retryAfter}с`;
          this.history[idx]._retryAfterMs = Math.max(1, retryAfter) * 1000;
          App.notify(this.history[idx].error, 'error');
        } else {
          this.history[idx].status = 'error';
          this.history[idx].error = data.error || `HTTP ${xhr.status}`;
          App.notify('Ошибка: ' + this.history[idx].error, 'error');
        }
        this.renderHistory();
        this.updateCounter();
        resolve();
      });
      xhr.addEventListener('error', () => {
        this.history[idx].status = 'error';
        this.history[idx].error = 'Ошибка сети';
        this.renderHistory();
        this.updateCounter();
        App.notify('Ошибка сети', 'error');
        resolve();
      });
      xhr.open('POST', App.baseUrl + '/upload');
      xhr.setRequestHeader('X-API-Key', App.apiKey);
      xhr.send(formData);
    });
  },

  async retry(idx) {
    const h = this.history[idx];
    if (!h || h.status !== 'error') return;
    const waitMs = h._retryAfterMs || 0;
    h.status = 'queued';
    h.error = null;
    h._retryAfterMs = null;
    h.progress = 0;
    this.renderHistory();
    this.updateCounter();
    if (waitMs > 0) {
      App.notify(`Ждём ${Math.ceil(waitMs / 1000)}с до сброса лимита...`, 'info');
      await new Promise(r => setTimeout(r, waitMs));
    }
    if (h.id && this.db) {
      const item = await this.dbGetById(h.id).catch(() => null);
      if (item?.blob) {
        this._acquireWakeLock();
        this._scheduleUpload(idx, item.blob);
        return;
      }
    }
    h.status = 'lost';
    h.error = 'Файл утерян, сделайте/выберите снова';
    this.renderHistory();
    this.updateCounter();
  },

  async retryAllErrors() {
    let maxWaitMs = 0;
    let count = 0;
    for (let i = 0; i < this.history.length; i++) {
      const h = this.history[i];
      if (h.status !== 'error') continue;
      if (h._retryAfterMs && h._retryAfterMs > maxWaitMs) maxWaitMs = h._retryAfterMs;
      count++;
    }
    if (count === 0) return;
    if (maxWaitMs > 0) {
      App.notify(`Ждём ${Math.ceil(maxWaitMs / 1000)}с до сброса лимита...`, 'info');
      await new Promise(r => setTimeout(r, maxWaitMs));
    }
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i].status !== 'error') continue;
      this.history[i]._retryAfterMs = null;
      this.retry(i);
    }
  },

  async remove(idx) {
    const h = this.history[idx];
    if (!h) return;
    h.status = 'removed';
    if (h.url) { try { URL.revokeObjectURL(h.url); } catch {} }
    if (h.id && this.db) { try { await this.dbDelete(h.id); } catch {} }
    this.renderHistory();
    this.updateCounter();
  },

  // ====================  UI  ====================

  updateCounter() {
    const el = document.getElementById('upload-counter');
    if (!el) return;
    const visible = this.history.filter(h => h.status !== 'removed');
    const uploading = visible.filter(h => h.status === 'uploading' || h.status === 'queued').length;
    const errors = visible.filter(h => h.status === 'error' || h.status === 'lost').length;
    const parts = [];
    if (this.totalUploaded > 0) parts.push(`Загружено: ${this.totalUploaded}`);
    if (uploading > 0) parts.push(`В очереди: ${uploading}`);
    if (errors > 0) parts.push(`Ошибок: ${errors}`);
    el.textContent = parts.join(' · ');
  },

  renderHistory() {
    const container = document.getElementById('upload-history');
    if (!container) return;
    const esc = (s) => App.esc(s);

    const items = this.history
      .map((h, i) => ({ ...h, idx: i }))
      .filter(h => h.status !== 'removed')
      .reverse();

    if (items.length === 0) {
      container.innerHTML = '';
      return;
    }

    const errorCount = this.history.filter(h => h.status === 'error').length;
    const retryAllBtn = errorCount > 1
      ? `<button class="btn btn-outline btn-sm" onclick="Upload.retryAllErrors()" style="margin-bottom:12px">↻ Повторить все (${errorCount})</button>`
      : '';

    container.innerHTML = retryAllBtn + items.map(h => {
      let statusHtml = '';
      let actionsHtml = '';
      if (h.status === 'queued') {
        statusHtml = '<span class="upload-status upload-status-queued">В очереди…</span>';
      } else if (h.status === 'uploading') {
        const pct = Math.max(0, Math.min(100, h.progress || 0));
        statusHtml = `
          <span class="upload-status upload-status-loading">Загрузка ${pct}%…</span>
          <div class="upload-progress-bar"><div class="upload-progress-fill" style="width:${pct}%"></div></div>
        `;
      } else if (h.status === 'ok') {
        const id = Number(h.invoiceId);
        const safeId = Number.isFinite(id) ? id : 0;
        statusHtml = `<a href="#/invoices/${safeId}" class="upload-status upload-status-ok">Накладная #${safeId}</a>`;
        actionsHtml = `<button class="btn btn-sm btn-outline" onclick="Upload.remove(${h.idx})">Убрать</button>`;
      } else if (h.status === 'lost') {
        statusHtml = `<span class="upload-status upload-status-error">Фото утеряно</span>
          <div class="upload-error-detail">${esc(h.error || 'Файл больше не доступен')}.</div>`;
        actionsHtml = `<button class="btn btn-sm btn-outline" onclick="Upload.remove(${h.idx})">Удалить</button>`;
      } else {
        statusHtml = `<span class="upload-status upload-status-error">Ошибка</span>`;
        if (h.error) statusHtml += `<div class="upload-error-detail">${esc(h.error)}</div>`;
        actionsHtml = `
          <button class="btn btn-sm btn-primary" onclick="Upload.retry(${h.idx})">↻ Повторить</button>
          <button class="btn btn-sm btn-outline" onclick="Upload.remove(${h.idx})">Удалить</button>
        `;
      }
      return `<div class="upload-history-item">
        <img src="${esc(h.url)}" alt="">
        <div class="upload-history-info">
          <div class="upload-history-name">${esc(h.name)}</div>
          ${statusHtml}
          ${actionsHtml ? `<div class="upload-actions">${actionsHtml}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  },
};

window.Upload = Upload;
