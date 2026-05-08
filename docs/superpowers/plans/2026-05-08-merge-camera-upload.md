# Merge Camera + Upload Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Объединить `/#/camera` и `/#/upload` в одну страницу `/#/upload` с кнопкой «Сфотографировать» сверху, drag-drop файлами ниже, и единой логикой надёжной асинхронной загрузки (IndexedDB persist, per-item retry, Wake Lock, прогресс-бар через XHR).

**Architecture:** Полное переписывание `public/js/upload.js` — берём IndexedDB-логику и список из `camera.js`, добавляем XHR с upload.onprogress, Wake Lock API, throttle до 3 параллельных. Удаляем `camera.js` и view-camera секцию. SPA-роут `/#/camera` редиректит на `/#/upload` для legacy-bookmarks.

**Tech Stack:** Vanilla JS (frontend), IndexedDB API, XMLHttpRequest, Wake Lock API. Backend `POST /api/upload` не трогаем.

**Spec:** [`docs/superpowers/specs/2026-05-08-merge-camera-upload-design.md`](../specs/2026-05-08-merge-camera-upload-design.md)

**Baseline:** 27 test files / 266 tests passing on `main` (commit `f6c5f52`). Эти тесты — backend; frontend без юнит-тестов, проверка через manual smoke.

---

## File Structure

**Изменяются (modified files):**

- `public/js/upload.js` — **полностью переписывается** (один модуль `Upload` со всеми функциями: addFile / doUpload / retry / wakeLock / dbPut / dbGetAll / dbDelete / renderHistory)
- `public/app.html` — удаляется секция `view-camera`; секция `view-upload` переписывается под новый DOM; убирается `<script src="/js/camera.js">`
- `public/js/app.js` — в `route()` убирается case `'#/camera'` показывающий `view-camera`, заменяется редиректом на `'#/upload'`
- `public/css/style.css` — добавляются стили для `.upload-dropzone`, `.upload-progress-bar`, `.upload-progress-fill`, `.upload-history-item`, `.upload-status-*`, `.upload-wakelock-notice`, `.upload-camera-block`

**Удаляются (deleted files):**

- `public/js/camera.js`

**Не трогаются:**
- `public/camera.html` (standalone мобилка через LAN)
- `src/api/routes/upload.ts` (бэкенд)
- любые другие модули

---

## Task 0: Setup — стэшинг чужих правок и базовая верификация

**Files:** none (только git operations)

- [ ] **Step 1: Проверить git status**

```powershell
cd C:/www/ScanFlow
git status --short
```

Если есть незакоммиченные правки (кроме нашей spec`a, который уже закоммичен), застэшить:

```powershell
git stash push -u -m "WIP pre-merge-camera-upload"
```

- [ ] **Step 2: Проверить текущую ветку и tip**

```powershell
git log --oneline -3
```

Expected: топ-коммит — `docs(spec): merge camera + upload pages into one`. Под ним прошлые fix-коммиты.

- [ ] **Step 3: Запустить baseline тесты**

```powershell
npx vitest run
```

Expected: `Test Files 27 passed (27) | Tests 266 passed (266)`. Если упало — расследовать прежде чем стартовать.

---

## Task 1: Переписать `public/js/upload.js`

**Files:**
- Modify: `public/js/upload.js` (полностью)

- [ ] **Step 1: Переписать файл целиком**

Заменить ВЕСЬ контент `public/js/upload.js` на:

```javascript
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
  _pendingQueue: [], // idx, для FIFO когда _activeUploads >= MAX_PARALLEL
  _wakeLock: null,
  _wakeLockSupported: typeof navigator !== 'undefined' && 'wakeLock' in navigator,

  // ====================  INIT  ====================

  init() {
    if (this.initialized) return;
    this.initialized = true;

    // Кнопка "Сфотографировать"
    const btnCapture = document.getElementById('btn-capture');
    const captureInput = document.getElementById('capture-input');
    btnCapture.addEventListener('click', () => captureInput.click());
    captureInput.addEventListener('change', () => {
      const f = captureInput.files[0];
      captureInput.value = '';
      if (f) this.addFile(f);
    });

    // Drag-drop зона + кнопка browse
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const btnBrowse = document.getElementById('btn-browse');

    btnBrowse.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
    dropZone.addEventListener('click', (e) => {
      // Не триггерить file picker при клике по самой кнопке browse
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

  // Перенос pending-записей из старой scanflow_camera (если она есть после миграции имени)
  async migrateLegacyDb() {
    return new Promise((resolve) => {
      let legacyDb = null;
      const open = indexedDB.open(this.LEGACY_DB_NAME);
      open.onupgradeneeded = (e) => {
        // Старая база ещё не существовала — отменим upgrade и удалим
        e.target.transaction.abort();
      };
      open.onsuccess = async () => {
        legacyDb = open.result;
        if (!legacyDb.objectStoreNames.contains(this.STORE_NAME)) {
          legacyDb.close();
          indexedDB.deleteDatabase(this.LEGACY_DB_NAME);
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
            indexedDB.deleteDatabase(this.LEGACY_DB_NAME);
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
        // Если ещё есть pending — повторно захватим при visible
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
      // Сбрасываем delay уже отработали выше — теперь просто перезапускаем
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
        // error
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
```

- [ ] **Step 2: Manual smoke (не делать пока не Task 6 — там общий чек)**

Файл написан, но HTML ещё не обновлён, страница работать не будет. Не запускаем dev пока не Task 6.

- [ ] **Step 3: TypeScript check (на всякий — frontend без TS, но `tsc --noEmit` бэкенда не должен сломаться)**

```powershell
npx tsc --noEmit
```

Expected: 0 ошибок.

---

## Task 2: Обновить `public/app.html`

**Files:**
- Modify: `public/app.html`

- [ ] **Step 1: Найти и заменить секцию view-upload**

Найти блок `<section id="view-upload">...</section>` (с строки ~178). Заменить ЦЕЛИКОМ на:

```html
<!-- Upload Section -->
<section id="view-upload">
  <h2>Загрузить накладные</h2>

  <div class="upload-camera-block">
    <button class="btn btn-primary btn-large" id="btn-capture">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
        <path d="M2 5a1 1 0 011-1h2l1-1.5h4L11 4h2a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <circle cx="8" cy="8.5" r="2.5" stroke="currentColor" stroke-width="1.5"/>
      </svg>
      Сфотографировать
    </button>
    <input type="file" id="capture-input" accept="image/*" capture="environment" hidden>
  </div>

  <div id="drop-zone" class="upload-dropzone">
    <p>Перетащите файлы сюда<br>или <button type="button" class="btn btn-outline btn-sm" id="btn-browse">выберите</button></p>
    <p class="muted">jpg, png, bmp, tiff, webp · до 20 МБ · можно сразу несколько</p>
    <input type="file" id="file-input" accept=".jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp" multiple hidden>
  </div>

  <div id="upload-wakelock-notice" class="upload-wakelock-notice" hidden></div>
  <div id="upload-counter" class="upload-counter"></div>
  <div id="upload-history"></div>
</section>
```

- [ ] **Step 2: Удалить секцию view-camera**

Найти блок `<section id="view-camera">...</section>` (с строки ~244 до закрытия). Удалить ВЕСЬ блок включая открывающий `<section>` и закрывающий `</section>`.

- [ ] **Step 3: Удалить `<script src="/js/camera.js"></script>`**

В нижней части файла (около строки ~714) есть тэг подключения camera.js. Удалить эту строку.

- [ ] **Step 4: Verify HTML structure**

```powershell
# Проверить что view-camera точно удалён, view-upload новый
grep -c "view-camera" public/app.html
# Expected: 0
grep -c "btn-capture" public/app.html
# Expected: 1
grep -c "camera.js" public/app.html
# Expected: 0
```

(На Windows PowerShell: `Select-String -Path public/app.html -Pattern "view-camera"` и т.д.)

---

## Task 3: Обновить роутер `public/js/app.js`

**Files:**
- Modify: `public/js/app.js`

- [ ] **Step 1: Найти case для `#/camera`**

В функции `route()` (около строки 122) найти:

```javascript
} else if (hash === '#/camera') {
  document.getElementById('view-camera').style.display = 'block';
  document.querySelector('nav a[data-tab="camera"]').classList.add('active');
  Camera.init();
```

- [ ] **Step 2: Заменить блок camera на редирект**

Заменить найденный блок на:

```javascript
} else if (hash === '#/camera') {
  // Legacy bookmark — редирект на объединённую страницу
  this.navigate('#/upload');
  return;
```

(`return` — чтобы не пытаться искать nav-link `data-tab="camera"`, которого больше нет.)

---

## Task 4: Удалить `public/js/camera.js`

**Files:**
- Delete: `public/js/camera.js`

- [ ] **Step 1: Удалить файл**

```powershell
git rm public/js/camera.js
```

- [ ] **Step 2: Verify reference removed**

```powershell
# Camera.js не должен ни откуда импортироваться
grep -rn "camera.js" public/ src/
# Expected: 0 hits (или только camera.html который standalone — это другой файл)
```

(Если найдёт `public/camera.html` — это OK, мы его не трогаем.)

---

## Task 5: Стили в `public/css/style.css`

**Files:**
- Modify: `public/css/style.css`

- [ ] **Step 1: Найти существующие camera-стили и удалить**

Найти секцию (если есть) с классами `.camera-history-*`, `.camera-status-*`, `.camera-action-btn` и т.д. — это стили старой `view-camera`. Если такие есть в style.css — удалить их (они больше нигде не используются).

```powershell
grep -n "camera-history\|camera-status\|camera-action" public/css/style.css | head -20
```

Если что-то найдено — удалить эти CSS-блоки.

- [ ] **Step 2: Добавить новые стили в конец `public/css/style.css`**

```css
/* === Upload page (merged camera + file upload) === */
.upload-camera-block {
  margin-bottom: 16px;
}
.btn-large {
  padding: 14px 24px;
  font-size: 16px;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.upload-dropzone {
  border: 2px dashed var(--border, rgba(0,0,0,0.15));
  border-radius: 12px;
  padding: 32px;
  text-align: center;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  margin-bottom: 16px;
}
.upload-dropzone:hover,
.upload-dropzone.dragover {
  border-color: var(--accent, #2563eb);
  background: var(--accent-bg, rgba(37,99,235,0.04));
}
.upload-dropzone p { margin: 4px 0; }

.upload-wakelock-notice {
  padding: 10px 14px;
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 13px;
  line-height: 1.5;
}
.upload-wakelock-active {
  background: rgba(16,185,129,0.08);
  border: 1px solid rgba(16,185,129,0.3);
  color: rgb(6,95,70);
}
.upload-wakelock-warn {
  background: rgba(245,158,11,0.08);
  border: 1px solid rgba(245,158,11,0.3);
  color: rgb(146,64,14);
}

.upload-counter {
  font-size: 13px;
  color: var(--muted, #6b7280);
  margin-bottom: 12px;
}

.upload-history-item {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border, rgba(0,0,0,0.08));
  border-radius: 8px;
  margin-bottom: 8px;
  background: var(--card-bg, #fff);
}
.upload-history-item img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 6px;
  flex-shrink: 0;
}
.upload-history-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.upload-history-name {
  font-weight: 500;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.upload-status {
  display: inline-block;
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
}
.upload-status-queued { background: rgba(0,0,0,0.06); color: var(--muted, #6b7280); }
.upload-status-loading { background: rgba(37,99,235,0.1); color: rgb(29,78,216); }
.upload-status-ok { background: rgba(16,185,129,0.12); color: rgb(6,95,70); text-decoration: none; }
.upload-status-ok:hover { text-decoration: underline; }
.upload-status-error { background: rgba(220,38,38,0.1); color: rgb(153,27,27); }

.upload-error-detail {
  font-size: 12px;
  color: var(--muted, #6b7280);
  margin-top: 2px;
}

.upload-progress-bar {
  height: 4px;
  width: 100%;
  background: rgba(0,0,0,0.08);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 4px;
}
.upload-progress-fill {
  height: 100%;
  background: var(--accent, #2563eb);
  transition: width 0.15s ease-out;
}

.upload-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
  flex-wrap: wrap;
}
.upload-actions .btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
```

---

## Task 6: Verify + smoke + commit + push

**Files:** все файлы из предыдущих задач

- [ ] **Step 1: TypeScript check**

```powershell
cd C:/www/ScanFlow
npx tsc --noEmit
```

Expected: 0 ошибок.

- [ ] **Step 2: Backend tests**

```powershell
npx vitest run
```

Expected: `Test Files 27 passed (27) | Tests 266 passed (266)` (frontend изменения не должны затронуть backend тесты).

- [ ] **Step 3: Запустить dev-сервер**

```powershell
npm run dev
```

В фоне. Должно стартовать на :8899.

- [ ] **Step 4: Manual smoke в браузере http://localhost:8899**

Чек-лист:
- Login as `admin / Desdes123`.
- Открыть `/#/upload` → видим: «Сфотографировать» сверху, drop-zone снизу.
- Кликнуть «Сфотографировать» → откроется file picker (на десктопе).
- Выбрать 1 jpg → видим item в списке, прогресс-бар бежит, потом `Накладная #N`.
- Drag-drop 3 файла → видим всех трёх в очереди, не более 3 одновременно `uploading`.
- Wake Lock плашка показалась → исчезла после готовности.
- Открыть `/#/camera` → редирект на `/#/upload` (URL меняется в hash).
- Открыть DevTools → Application → IndexedDB → видим базу `scanflow_upload`.

- [ ] **Step 5: Manual smoke ошибочного сценария**

В DevTools → Network → Throttling → Offline.
Drag-drop файл → upload падает → status=error, кнопка «↻ Повторить».
Включить интернет (Online) → жмём «↻ Повторить» → грузится.

- [ ] **Step 6: Stop dev server, commit**

Убить dev-server (Ctrl+C в терминале где он крутится).

```powershell
git add public/js/upload.js public/app.html public/js/app.js public/css/style.css
git rm public/js/camera.js  # если ещё не сделано в Task 4 шаге 1
git status --short
```

Expected status:
```
M  public/app.html
M  public/css/style.css
M  public/js/app.js
M  public/js/upload.js
D  public/js/camera.js
```

- [ ] **Step 7: Commit**

```powershell
git commit -m "feat(ui): merge /#/camera and /#/upload into one page

- public/js/upload.js полностью переписан: один Upload модуль с IndexedDB
  persistence, per-item retry, MAX_PARALLEL=3, Wake Lock API, XHR прогресс-бар
  на каждый файл, обработка HTTP 429 c уважением RateLimit-Reset.
- Все entry-points (камера, drag-drop, browse, restoreFromIndexedDB) идут
  через единственную функцию Upload.addFile().
- /#/camera SPA-роут редиректит на /#/upload.
- public/js/camera.js удалён.
- view-camera секция HTML удалена.
- Standalone /camera (мобилка через LAN) не трогается.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 8: Push в main → авто-деплой через GHA**

```powershell
git push origin main
```

- [ ] **Step 9: Дождаться GHA-деплой**

```powershell
until gh run list --repo djdes/scanflow --branch main --limit 1 2>&1 | head -1 | awk '{print $1}' | grep -q completed; do sleep 8; done
gh run list --repo djdes/scanflow --branch main --limit 1
```

Expected: `completed success`. Время ~50s.

- [ ] **Step 10: Production smoke**

Открыть https://scanflow.ru/#/upload и пройти Step 4 чек-лист (без offline-теста — на проде не имитируем).

- [ ] **Step 11: Restore stash if existed**

```powershell
git stash list
# Если в Task 0 что-то стэшили — вернуть
git stash pop
```

---

## Self-Review Checklist (run after writing the plan)

- [x] **Spec coverage:** все секции spec'а покрыты задачами:
  - «Один пайплайн» → Task 1 (Upload.addFile единый entry)
  - Wake Lock + плашка → Task 1 (_acquireWakeLock/_releaseWakeLock/_renderWakeLockNotice) + Task 5 (CSS)
  - Прогресс-бар per item → Task 1 (XHR upload.onprogress) + Task 5 (CSS)
  - Throttle MAX_PARALLEL=3 → Task 1 (_scheduleUpload + _drainQueue)
  - 429 RateLimit-Reset → Task 1 (doUpload xhr.status === 429)
  - IndexedDB + retryPending → Task 1
  - Migration scanflow_camera → scanflow_upload → Task 1 (migrateLegacyDb)
  - DOM новая разметка → Task 2
  - View-camera удаление → Task 2
  - /#/camera редирект → Task 3
  - Camera.js удаление → Task 4
  - CSS → Task 5
  - Smoke → Task 6
- [x] **Placeholder scan:** все шаги имеют конкретный код или конкретные команды; нет TBD/TODO.
- [x] **Type consistency:** идентификаторы DOM (`btn-capture`, `capture-input`, `drop-zone`, `file-input`, `btn-browse`, `upload-wakelock-notice`, `upload-counter`, `upload-history`) одинаковы в Task 1 (JS), Task 2 (HTML) и Task 5 (CSS).
- [x] **Не забыл:** старые camera-стили из CSS (если есть) — Task 5 Step 1 проверяет.

---

## Execution

После написания этого плана пользователь сказал «всё реализовывай ничего не спрашивай» — выбран **inline execution** в текущей сессии без двух-этапных code-review субагентами. Перехожу к выполнению задач.
