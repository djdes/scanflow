/* global App, Upload */
// Объединённый загрузчик: камера + drag-drop + browse + IndexedDB persistence
// + per-item retry + Wake Lock + per-item progress bar.
// Все entry-points идут через addFile() — один пайплайн на все случаи.
const Upload = {
  initialized: false,
  totalUploaded: 0,
  history: [], // { id, url, name, status, progress, invoiceId?, error?, _retryAt? }
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
      captureInput.addEventListener('change', async () => {
        const f = captureInput.files[0];
        if (f) await this.addFile(f);
        captureInput.value = '';
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
      fileInput.addEventListener('change', async () => {
        const files = Array.from(fileInput.files);
        await this._addMultiple(files);
        fileInput.value = '';
      });
    }

    // Visibility — re-acquire wake lock когда вкладка снова видима
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      this._resumeRetries(false);
      if (this._hasPending()) this._acquireWakeLock();
    });
    window.addEventListener('online', () => this._resumeRetries(true));
    window.addEventListener('pageshow', () => this._resumeRetries(false));

    // Открыть БД и догрузить незавершённые
    this._dbReady = this.openDb().then(() => this.migrateLegacyDb()).then(() => this.retryPending()).catch(error => {
      console.error('Local upload queue unavailable', error);
    });
  },

  async _addMultiple(files) {
    // .xml — электронные УПД/ТОРГ-12 из ЭДО (Диадок, СБИС): разбираются без распознавания.
    const ALLOWED = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp', '.pdf', '.xml'];
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
      await this.addFile(file);
    }
  },

  // ====================  Чьё фото  ====================

  // Фото, снятое под одним входом, не уходит под другим: общий телефон, выход и
  // вход в другую компанию, смена ключа. Храним отпечаток ключа (FNV-1a), не ключ.
  ownerTag(key = App.apiKey) {
    let h = 0x811c9dc5;
    for (const ch of String(key || '')) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(36);
  },

  _foreign(owner) {
    return Boolean(owner) && owner !== this.ownerTag();
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

  dbPut(blob, name, owner = this.ownerTag()) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.add({ blob, name, createdAt: Date.now(), owner });
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error || req.error);
      tx.onabort = () => reject(tx.error || new Error('Фото не сохранено на устройстве'));
    });
  },

  dbDelete(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
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

  async memoryBlob(source) {
    // Safari/WebKit 319985: File из камеры или IndexedDB может отправиться
    // как multipart с нулевым телом. Чтение байтов в памяти работает;
    // простое new Blob([source]) всё ещё оставляет ссылку на дисковый файл.
    if (!source || typeof source.arrayBuffer !== 'function' || source.size <= 0) {
      throw new Error('Фото пустое или недоступно. Выберите его заново.');
    }
    const bytes = await source.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength !== source.size) {
      throw new Error('Не удалось прочитать фото полностью. Выберите его заново.');
    }
    return new Blob([bytes], { type: source.type || 'application/octet-stream' });
  },

  // ====================  Сжатие фото  ====================
  // Фото с телефона — 3–8 МБ (а 50 Мп — до 20), по плохой сети уходит долго.
  // Сервер всё равно уменьшает фото до 2400×3200 перед распознаванием
  // (ocrManager.preprocessImage), поэтому длинная сторона 3200 — без потерь для
  // распознавания, с запасом на повёрнутый лист. Поворот из EXIF вшивается в
  // пиксели, сам EXIF (и геометка) не уходит. Любой сбой — уходит оригинал.
  PHOTO_MAX_SIDE: 3200,
  PHOTO_QUALITY: 0.9,
  PHOTO_KEEP_BYTES: 1.5 * 1024 * 1024,

  shrinkable(type, name) {
    const ext = String(name || '').toLowerCase().split('.').pop();
    return /^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(String(type || ''))
      || ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext);
  },

  /** Размер после сжатия или null — оставить как есть (маленькое и лёгкое). */
  photoPlan({ width, height, size }) {
    if (!(width > 0) || !(height > 0)) return null;
    const scale = Math.min(1, this.PHOTO_MAX_SIDE / Math.max(width, height));
    if (scale === 1 && size <= this.PHOTO_KEEP_BYTES) return null;
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  },

  // ── Обрезка краёв листа (2026-11-17) ─────────────────────────────────────
  // Лист на тёмном столе: отрезаем фон, чтобы в 3200 px попало больше самого
  // документа. Осторожно: режем, только если лист явно светлее фона и занимает
  // 25–92% кадра, иначе (скан, лист на светлом столе, неясная картинка) — как было.
  CROP_SAMPLE: 256,

  /** Порог Оцу по гистограмме яркости 0–255. */
  otsu(lum) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < lum.length; i++) hist[lum[i]]++;
    const total = lum.length;
    let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, threshold = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; threshold = t; }
    }
    return threshold;
  },

  /**
   * Самая длинная полоса индексов, где доля светлого ≥ min. Короткие провалы (строка
   * текста, линия таблицы — до 4% длины) полосу не рвут.
   */
  _longestRun(fractions, min) {
    const maxGap = Math.max(1, Math.round(fractions.length * 0.04));
    let best = null, start = -1, lastOn = -1;
    for (let i = 0; i <= fractions.length; i++) {
      const on = i < fractions.length && fractions[i] >= min;
      if (on) {
        if (start < 0) start = i;
        lastOn = i;
        continue;
      }
      if (start >= 0 && i < fractions.length && i - lastOn <= maxGap) continue;
      if (start >= 0 && (!best || lastOn - start > best[1] - best[0])) best = [start, lastOn];
      if (start >= 0 && i - lastOn > maxGap) start = -1;
      if (i === fractions.length) break;
    }
    return best;
  },

  /**
   * Рамка листа на картинке яркости lum (w×h, 0–255) в долях кадра {x, y, w, h}
   * или null — обрезать не надо или опасно. Чистая функция, тесты — upload.test.ts.
   */
  sheetBox(lum, w, h) {
    if (!(w > 8 && h > 8) || lum.length !== w * h) return null;
    const t = this.otsu(lum);
    let bright = 0, sumB = 0, sumD = 0;
    for (let i = 0; i < lum.length; i++) { if (lum[i] > t) { bright++; sumB += lum[i]; } else sumD += lum[i]; }
    const dark = lum.length - bright;
    if (!bright || !dark) return null;
    if (sumB / bright - sumD / dark < 50) return null; // лист не отличается от фона
    const rows = new Array(h).fill(0), cols = new Array(w).fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (lum[y * w + x] > t) { rows[y]++; cols[x]++; }
    const r = this._longestRun(rows.map(v => v / w), 0.3);
    const c = this._longestRun(cols.map(v => v / h), 0.3);
    if (!r || !c) return null;
    const [y0, y1] = r, [x0, x1] = c;
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    const area = (bw * bh) / (w * h);
    if (area < 0.25 || area > 0.92) return null;
    let inside = 0, outside = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (lum[y * w + x] <= t) continue;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) inside++; else outside++;
    }
    if (inside / (bw * bh) < 0.6) return null;      // внутри рамки — не лист
    if (outside / Math.max(1, w * h - bw * bh) > 0.25) return null; // снаружи много светлого
    // Запас 3% с каждой стороны: тень у края и поля листа не теряем.
    const pad = 0.03;
    const fx0 = Math.max(0, x0 / w - pad), fy0 = Math.max(0, y0 / h - pad);
    const fx1 = Math.min(1, (x1 + 1) / w + pad), fy1 = Math.min(1, (y1 + 1) / h + pad);
    return { x: fx0, y: fy0, w: fx1 - fx0, h: fy1 - fy0 };
  },

  _cropEnabled() {
    try { return localStorage.getItem('sf-photo-crop') !== 'off'; } catch { return true; }
  },

  /** Рамка листа для уже декодированного фото (или null). */
  _detectSheet(image) {
    if (!this._cropEnabled()) return null;
    const scale = Math.min(1, this.CROP_SAMPLE / Math.max(image.width, image.height));
    const sw = Math.max(1, Math.round(image.width * scale)), sh = Math.max(1, Math.round(image.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image.source, 0, 0, sw, sh);
    const { data } = ctx.getImageData(0, 0, sw, sh);
    canvas.width = 0; canvas.height = 0;
    const lum = new Uint8Array(sw * sh);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) lum[j] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    return this.sheetBox(lum, sw, sh);
  },

  /** Сжатое берём, только если оно заметно легче: иначе зря теряем качество. */
  photoBetter(originalSize, shrunkSize) {
    return shrunkSize > 0 && shrunkSize < originalSize * 0.9;
  },

  jpegName(name) {
    const base = String(name || 'photo').replace(/\.[^./\\]+$/, '');
    return `${base || 'photo'}.jpg`;
  },

  async _decodePhoto(blob) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close && bitmap.close() };
      } catch { /* старый Safari без параметров — через <img> */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  /** { blob, name, shrunk }: сжатое фото или оригинал, если сжать нельзя или незачем. */
  async shrinkPhoto(blob, name) {
    const keep = { blob, name, shrunk: false };
    if (typeof document === 'undefined' || !this.shrinkable(blob.type, name)) return keep;
    let image = null;
    try {
      image = await this._decodePhoto(blob);
      let box = null;
      try { box = this._detectSheet(image); } catch { box = null; }
      const src = box
        ? { x: Math.round(box.x * image.width), y: Math.round(box.y * image.height), w: Math.round(box.w * image.width), h: Math.round(box.h * image.height) }
        : { x: 0, y: 0, w: image.width, h: image.height };
      const plan = this.photoPlan({ width: src.w, height: src.h, size: box ? Infinity : blob.size });
      if (!plan) return keep;
      const canvas = document.createElement('canvas');
      canvas.width = plan.width;
      canvas.height = plan.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // прозрачный PNG — на белом, а не на чёрном
      ctx.fillRect(0, 0, plan.width, plan.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image.source, src.x, src.y, src.w, src.h, 0, 0, plan.width, plan.height);
      const out = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', this.PHOTO_QUALITY));
      canvas.width = 0; canvas.height = 0; // iOS быстрее отдаёт память
      // Обрезанное берём всегда (на листе больше пикселей), просто сжатое — если заметно легче.
      if (!out || (!box && !this.photoBetter(blob.size, out.size))) return keep;
      return { blob: await this.memoryBlob(out), name: this.jpegName(name), shrunk: true, cropped: !!box };
    } catch (e) {
      console.warn('Photo shrink skipped, sending the original', e);
      return keep;
    } finally {
      if (image) image.close();
    }
  },

  async addFile(file) {
    const owner = this.ownerTag();
    let name = file.name || `photo_${Date.now()}.jpg`;
    let blob;
    try {
      blob = await this.memoryBlob(file);
    } catch (e) {
      App.notify(e.message || 'Не удалось прочитать фото. Выберите его заново.', 'error');
      return;
    }
    ({ blob, name } = await this.shrinkPhoto(blob, name));

    let dbId = null;
    try {
      if (this._dbReady) await this._dbReady;
      dbId = await this.dbPut(blob, name, owner);
    } catch (e) {
      console.error('Failed to save to IndexedDB', e);
    }

    const idx = this.history.length;
    this.history.push({
      id: dbId,
      owner,
      url: URL.createObjectURL(blob),
      name,
      status: 'queued',
      progress: 0,
      _blob: blob,
      localWarning: dbId ? null : 'Не удалось сохранить копию на устройстве. Не закрывайте вкладку до приёма сервером.',
    });
    this.renderHistory();
    this.updateCounter();
    this._acquireWakeLock();
    this._scheduleUpload(idx, blob);
  },

  async retryPending() {
    if (!this.db) return;
    let pending;
    try { pending = await this.dbGetAll(); } catch { return; }
    if (!pending.length) return;

    const knownIds = new Set(this.history.map(h => h.id).filter(Boolean));
    // Фото другого входа ждут на устройстве, пока не войдёт тот же аккаунт.
    const toRetry = pending.filter(p => !knownIds.has(p.id) && !this._foreign(p.owner));
    if (!toRetry.length) return;

    App.notify(`Дозагрузка ${toRetry.length} фото...`, 'success');

    for (const item of toRetry) {
      const idx = this.history.length;
      const url = URL.createObjectURL(item.blob);
      this.history.push({
        id: item.id,
        owner: item.owner || this.ownerTag(),
        url,
        name: item.name,
        status: 'queued',
        progress: 0,
        _blob: item.blob,
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
      if (this.history[next.idx].status === 'queued') this._scheduleUpload(next.idx, next.fileOrBlob);
    }
  },

  async doUpload(fileOrBlob, idx, dbId) {
    const entry = this.history[idx];
    const apiKey = App.apiKey;
    if (entry && this._foreign(entry.owner)) {
      // Вход сменился, пока фото ждало отправки: копия остаётся на устройстве.
      clearTimeout(entry._retryTimer);
      entry.status = 'error';
      entry.autoRetry = false;
      entry.error = 'Фото снято под другим входом. Войдите в тот аккаунт, чтобы отправить.';
      this.renderHistory();
      this.updateCounter();
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this._waitForUpload(idx, 'Нет подключения к интернету');
      return;
    }
    let blob;
    try {
      // Старые File/Blob из IndexedDB также копируем перед каждой попыткой.
      blob = await this.memoryBlob(fileOrBlob);
    } catch (e) {
      this.history[idx].status = 'error';
      this.history[idx].error = e.message || 'Не удалось прочитать фото. Выберите его заново.';
      this.renderHistory();
      this.updateCounter();
      App.notify(this.history[idx].error, 'error');
      return;
    }
    if (entry.status !== 'uploading') return;
    if (apiKey !== App.apiKey) {
      this._waitForUpload(idx, 'Вход изменился во время отправки');
      return;
    }
    return new Promise((resolve) => {
      const formData = new FormData();
      formData.append('file', blob, this.history[idx].name);

      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          this.history[idx].progress = Math.round((e.loaded / e.total) * 100);
          this.renderHistory();
        }
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText) || {}; } catch {}
        if (xhr.status >= 200 && xhr.status < 300) {
          this.history[idx].progress = 100;
          if (Number.isSafeInteger(data.job_id) && data.job_id > 0) {
            // Only this receipt proves that the server committed a durable job.
            this.totalUploaded++;
            if (dbId) this.dbDelete(dbId).catch(() => {});
            this.history[idx].jobId = data.job_id;
            this.history[idx].invoiceId = data.invoice_id || null;
            this.history[idx].status = data.queued === false ? 'ok' : 'server_queued';
            this.history[idx]._blob = null;
            App.notify('Фото сохранено на сервере. Обработка продолжится автоматически.', 'success');
            if (typeof RecognitionQueue !== 'undefined') RecognitionQueue.refresh();
          } else if (Number.isSafeInteger(data.invoice_id) && data.invoice_id > 0) {
            this.totalUploaded++;
            if (dbId) this.dbDelete(dbId).catch(() => {});
            // Sync upload (legacy path) — invoice_id уже есть.
            this.history[idx].status = 'ok';
            this.history[idx].invoiceId = data.invoice_id;
            App.notify(`Накладная #${data.invoice_id} загружена`, 'success');
          } else if (typeof data.file_name === 'string' && data.file_name) {
            // Async upload — polling до появления накладной.
            this.history[idx].status = 'processing';
            this.history[idx].fileName_serverside = data.file_name;
            App.notify(`«${this.history[idx].name}» в очереди на обработку`, 'info');
            this._pollForInvoiceId(idx, data.file_name);
          } else {
            this._waitForUpload(idx, 'Сервер не подтвердил сохранение');
          }
        } else if (xhr.status === 429) {
          const retryAfter = Math.max(1, parseInt(
            xhr.getResponseHeader('Retry-After') ||
            xhr.getResponseHeader('RateLimit-Reset') || '60', 10) || 60);
          this.history[idx].status = 'error';
          this.history[idx].error = `Слишком много загрузок подряд — отправим снова через ${retryAfter} с`;
          this.history[idx].rateLimited = true;
          this.scheduleAutoRetry(idx, retryAfter * 1000);
        } else if (xhr.status === 400 && data.code === 'upload_incomplete') {
          this._waitForUpload(idx, 'Сервер получил только часть файла');
        } else if (xhr.status >= 500 || [0, 408, 425, 499].includes(xhr.status)) {
          this._waitForUpload(idx, typeof data.error === 'string' ? data.error : `Сервер не подтвердил приём (HTTP ${xhr.status})`);
        } else {
          this.history[idx].status = 'error';
          this.history[idx].error = typeof data.error === 'string' ? data.error : `HTTP ${xhr.status}`;
          App.notify('Ошибка: ' + this.history[idx].error, 'error');
        }
        this.renderHistory();
        this.updateCounter();
        resolve();
      });
      const interrupted = (message) => {
        this._waitForUpload(idx, message);
        resolve();
      };
      xhr.addEventListener('error', () => interrupted('Ошибка сети'));
      xhr.addEventListener('abort', () => interrupted('Отправка прервалась'));
      xhr.addEventListener('timeout', () => interrupted('Сервер не подтвердил приём вовремя'));
      try {
        xhr.open('POST', App.baseUrl + '/upload');
        xhr.timeout = 90000;
        xhr.setRequestHeader('X-API-Key', apiKey);
        xhr.send(formData);
      } catch {
        interrupted('Не удалось отправить файл');
      }
    });
  },

  async _pollForInvoiceId(idx, serverFileName) {
    // Polls GET /api/invoices?file_name=X every 2s until the watcher INSERTs
    // the invoice row (status='ocr_processing'/'parsing'/'processed') or a
    // hard timeout fires. Без подтверждения оставляем фото в очереди отправки.
    const POLL_INTERVAL_MS = 2000;
    const TIMEOUT_MS = 5 * 60 * 1000; // 5 минут на multi-page scenarios
    const start = Date.now();
    while (Date.now() - start < TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const h = this.history[idx];
      if (!h || h.status !== 'processing') return; // юзер удалил/что-то ещё
      try {
        const res = await fetch(App.baseUrl + '/invoices?file_name=' + encodeURIComponent(serverFileName), {
          headers: { 'X-API-Key': App.apiKey },
        });
        if (res.ok) {
          const json = await res.json();
          const invoice = json.data?.[0];
          if (invoice) {
            // Финал: invoice появился в БД. Если status уже 'processed' —
            // показываем как ok; иначе оставляем processing с подсказкой.
            if (invoice.status === 'processed') {
              if (h.id) this.dbDelete(h.id).catch(() => {});
              this.history[idx].status = 'ok';
              this.history[idx].invoiceId = invoice.id;
              // Проверяем повышенные цены сразу при распознавании —
              // заведующая видит alert прямо на странице загрузки.
              this._checkElevatedPrices(idx, invoice.id).catch(() => { /* best-effort */ });
              this.renderHistory();
              this.updateCounter();
              App.notify(`Накладная #${invoice.id} обработана`, 'success');
              return;
            }
            if (invoice.status === 'duplicate') {
              this.history[idx].status = 'ok';
              this.history[idx].invoiceId = invoice.id;
              this.renderHistory();
              this.updateCounter();
              App.notify(`Накладная #${invoice.id} — дубликат №${invoice.duplicate_of}`, 'warn');
              return;
            }
            if (invoice.status === 'waiting_ai') {
              if (h.id) this.dbDelete(h.id).catch(() => {});
              // Фото принято, GPT сейчас недоступен — накладная распознается сама.
              this.history[idx].status = 'ok';
              this.history[idx].invoiceId = invoice.id;
              this.renderHistory();
              this.updateCounter();
              App.notify(`Накладная #${invoice.id} принята и ждёт GPT: ${invoice.error_message || 'распознается, когда он снова будет доступен'}`, 'warn');
              return;
            }
            if (invoice.status === 'error') {
              this.history[idx].status = 'error';
              this.history[idx].error = invoice.error_message || 'Не удалось распознать';
              this.renderHistory();
              this.updateCounter();
              App.notify(`«${this.history[idx].name}»: ошибка распознавания`, 'error');
              return;
            }
            // ocr_processing / parsing — продолжаем poll, но обновим статус
            this.history[idx].invoiceId = invoice.id;  // уже есть ID, можно показать
          }
        }
      } catch { /* network blip — try again */ }
    }
    const h = this.history[idx];
    if (h.status !== 'processing') return;
    if (h.invoiceId) {
      App.notify(`«${h.name}»: всё ещё обрабатывается, проверь список накладных`, 'warn');
    } else {
      this._waitForUpload(idx, 'Сервер не подтвердил приём вовремя');
    }
  },

  // Fetch the just-processed invoice detail and surface an inline alert if
  // any line is priced >10% above the usual (median) price. Triggered from
  // _pollForInvoiceId so the manager sees the warning right where they
  // dropped the photo, not just in TG/email.
  async _checkElevatedPrices(idx, invoiceId) {
    const res = await fetch(App.baseUrl + '/invoices/' + invoiceId, {
      headers: { 'X-API-Key': App.apiKey },
    });
    if (!res.ok) return;
    const body = await res.json();
    const items = body.data?.items || [];
    const flagged = items.filter(it => it.price_deviation_pct != null && it.price_deviation_pct > 10);
    if (!flagged.length) return;
    flagged.sort((a, b) => b.price_deviation_pct - a.price_deviation_pct);
    const worst = Math.round(flagged[0].price_deviation_pct);
    const top = flagged.slice(0, 3).map(f => f.mapped_name || f.original_name || '');
    const more = flagged.length > 3 ? ` и ещё ${flagged.length - 3}` : '';
    // Persist on the history entry so renderHistory can show it.
    this.history[idx].elevated = {
      count: flagged.length,
      worstPct: worst,
      names: top.join(', ') + more,
      items: flagged.map(f => ({
        name: f.mapped_name || f.original_name || '',
        price: f.price,
        median: f.median_price,
        pct: f.price_deviation_pct,
      })),
    };
    this.renderHistory();
    // Toast — short, just to draw the eye. The persistent banner is in the card.
    App.notify(
      `⚠ Повышенные цены в #${invoiceId}: ${flagged.length} ${this._plural(flagged.length, 'позиция', 'позиции', 'позиций')} (до +${worst}%)`,
      'warn',
    );
  },

  _plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  },

  async retry(idx) {
    const h = this.history[idx];
    if (!h || h.status !== 'error') return;
    clearTimeout(h._retryTimer);
    h.autoRetry = false;
    const waitMs = h.rateLimited ? Math.max(0, h._retryAt - Date.now()) : 0;
    h.status = 'queued';
    h.error = null;
    h.progress = 0;
    this.renderHistory();
    this.updateCounter();
    if (waitMs > 0) {
      App.notify(`Ждём ${Math.ceil(waitMs / 1000)}с до сброса лимита...`, 'info');
      await new Promise(r => setTimeout(r, waitMs));
    }
    if (h.status !== 'queued') return;
    h.rateLimited = false;
    if (h._blob) {
      this._acquireWakeLock();
      this._scheduleUpload(idx, h._blob);
      return;
    }
    if (h.id && this.db) {
      const item = await this.dbGetById(h.id).catch(() => null);
      if (h.status !== 'queued') return;
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
  _waitForUpload(idx, message) {
    const h = this.history[idx];
    if (h.status === 'removed') return;
    h.status = 'error';
    h.error = message;
    this.scheduleAutoRetry(idx);
    this.renderHistory();
    this.updateCounter();
  },

  _resumeRetries(online) {
    if (!App.apiKey || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    const now = Date.now();
    this.history.forEach((h, idx) => {
      if (h.status === 'error' && h.autoRetry && (h._retryAt <= now || (online && !h.rateLimited))) this.retry(idx);
    });
  },
  scheduleAutoRetry(idx, requestedDelay) {
    const h = this.history[idx];
    if (!h) return;
    clearTimeout(h._retryTimer);
    h.autoRetry = true;
    h.retryAttempts = (h.retryAttempts || 0) + 1;
    const delay = requestedDelay || Math.min(60000, 2000 * 2 ** Math.min(5, h.retryAttempts - 1));
    h._retryAt = Date.now() + delay;
    h._retryTimer = setTimeout(() => {
      if (h.status !== 'error') return;
      this.retry(idx);
    }, delay);
  },

  retryAllErrors() {
    for (let i = 0; i < this.history.length; i++) {
      if (this.history[i].status === 'error') this.retry(i);
    }
  },

  async remove(idx) {
    const h = this.history[idx];
    if (!h) return;
    clearTimeout(h._retryTimer);
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
    const uploading = visible.filter(h => h.status === 'uploading' || h.status === 'queued' || h.autoRetry).length;
    const errors = visible.filter(h => (h.status === 'error' && !h.autoRetry) || h.status === 'lost').length;
    const parts = [];
    if (this.totalUploaded > 0) parts.push(`Загружено: ${this.totalUploaded}`);
    // «Отправляются», а не «В очереди»: очередь распознавания на сервере — отдельно.
    if (uploading > 0) parts.push(`Отправляются: ${uploading}`);
    if (errors > 0) parts.push(`Ошибок: ${errors}`);
    el.textContent = parts.join(' · ');
  },

  /**
   * Состояние строки списка загрузок простыми словами: tone (wait | work | ok |
   * warn | error — цвет точки), label и необязательная причина detail.
   */
  statusView(h) {
    switch (h.status) {
      case 'queued': return { tone: 'wait', label: 'Готовится к отправке' };
      case 'uploading': {
        const pct = Math.max(0, Math.min(100, Number(h.progress) || 0));
        return { tone: 'work', label: `Отправляется · ${pct}%` };
      }
      case 'server_queued':
        if (h.serverState === 'processing') return { tone: 'work', label: 'Распознаётся…' };
        if (h.queueError) return { tone: 'warn', label: 'Не распознали с первого раза — повторим сами', detail: h.queueError };
        return { tone: 'wait', label: 'В очереди на распознавание' };
      case 'processing': return { tone: 'work', label: 'Распознаётся…' };
      case 'ok': return { tone: 'ok', label: 'Готово' };
      case 'cancelled': return { tone: 'wait', label: 'Отменено — накладную удалили' };
      case 'lost': return { tone: 'error', label: 'Файл потерян', detail: h.error || 'Файл больше не доступен' };
      default:
        return h.autoRetry
          ? { tone: 'warn', label: 'Не отправилось — отправим ещё раз сами', detail: h.error }
          : { tone: 'error', label: 'Не загрузилось', detail: h.error };
    }
  },

  /** Миниатюра строки: фото — превью, PDF и XML — значок с типом файла. */
  fileThumb(name, url) {
    const lower = String(name || '').toLowerCase();
    if (lower.endsWith('.pdf')) return '<span class="upload-row__thumb upload-row__thumb--pdf" aria-hidden="true">PDF</span>';
    if (lower.endsWith('.xml')) return '<span class="upload-row__thumb upload-row__thumb--xml" aria-hidden="true">XML</span>';
    if (url) return `<img class="upload-row__thumb" src="${App.esc(url)}" alt="">`;
    return '<span class="upload-row__thumb upload-row__thumb--photo" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg></span>';
  },

  /** Одна строка списка — общая для загрузок этой вкладки и очереди на сервере. */
  rowHtml({ thumb, name, tone, label, meta, detail, side, extra }) {
    const esc = (s) => App.esc(s);
    return `<div class="upload-row is-${tone}">
      ${thumb}
      <div class="upload-row__main">
        <div class="upload-row__name" title="${esc(name)}">${esc(name)}</div>
        <div class="upload-row__state"><span class="upload-row__dot" aria-hidden="true"></span><span>${esc(label)}</span>${meta ? `<span class="upload-row__meta">${esc(meta)}</span>` : ''}</div>
        ${detail ? `<div class="upload-row__detail">${esc(detail)}</div>` : ''}
        ${extra || ''}
      </div>
      ${side ? `<div class="upload-row__side">${side}</div>` : ''}
    </div>`;
  },

  invoiceLink(id, filled) {
    const safeId = Number(id);
    if (!Number.isSafeInteger(safeId) || safeId <= 0) return '';
    return `<a href="#/invoices/${safeId}" class="${filled ? 'btn btn-sm btn-outline' : 'upload-row__link'}">Накладная #${safeId} →</a>`;
  },

  closeButton(idx) {
    return `<button type="button" class="upload-row__close" onclick="Upload.remove(${idx})" aria-label="Убрать из списка" title="Убрать из списка"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>`;
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
      ? `<button class="btn btn-outline btn-sm upload-retry-all" onclick="Upload.retryAllErrors()">↻ Повторить все (${errorCount})</button>`
      : '';

    container.innerHTML = retryAllBtn + items.map(h => {
      const view = this.statusView(h);
      const detail = [h.localWarning, view.detail].filter(Boolean).join('. ');
      let side = '';
      let extra = '';
      if (h.status === 'uploading') {
        const pct = Math.max(0, Math.min(100, h.progress || 0));
        extra = `<div class="upload-progress-bar"><div class="upload-progress-fill" style="width:${pct}%"></div></div>`;
      } else if (h.status === 'server_queued' || h.status === 'processing') {
        side = this.invoiceLink(h.invoiceId, false);
      } else if (h.status === 'ok') {
        side = this.invoiceLink(h.invoiceId, true) + this.closeButton(h.idx);
        if (h.elevated) {
          const e = h.elevated;
          const verb = this._plural(e.count, 'позиция', 'позиции', 'позиций');
          extra = `
            <div class="upload-elevated-banner">
              <span class="upload-elevated-banner__icon">⚠</span>
              <div class="upload-elevated-banner__body">
                <strong>Повышенная цена:</strong> ${e.count} ${verb} дороже обычной (до +${e.worstPct}%).
                <div class="muted upload-elevated-banner__names">${esc(e.names)}</div>
              </div>
            </div>`;
        }
      } else if (h.status === 'cancelled') {
        side = this.closeButton(h.idx);
      } else if (h.status === 'lost') {
        side = `<button class="btn btn-sm btn-outline" onclick="Upload.remove(${h.idx})">Удалить</button>`;
      } else if (h.status !== 'queued') {
        side = `<button class="btn btn-sm btn-outline" onclick="Upload.retry(${h.idx})">↻ Повторить</button>
          <button class="btn btn-sm btn-outline" onclick="Upload.remove(${h.idx})">Удалить</button>`;
      }
      return this.rowHtml({ thumb: this.fileThumb(h.name, h.url), name: h.name, tone: view.tone, label: view.label, detail, side, extra });
    }).join('');
  },
};

window.Upload = Upload;
