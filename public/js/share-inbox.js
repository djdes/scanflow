// «Поделиться → ScanFlow» на Android (правило 48, docs/mobile-app.md).
// Service worker (sw.js, через importScripts) кладёт присланные файлы сюда,
// приложение /m/ забирает их после входа и отправляет обычным загрузчиком
// (upload.js: сжатие, метка входа, повторы). У запроса «Поделиться» нет ключа
// API, поэтому сервер принять файлы сам не может — они ждут на устройстве.
const ShareInbox = {
  DB: 'scanflow_share',
  STORE: 'files',

  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(this.STORE, { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },

  async _tx(mode, work) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, mode);
        let result;
        Promise.resolve(work(tx.objectStore(this.STORE), (value) => { result = value; })).catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Файлы не сохранены на устройстве'));
      });
    } finally {
      db.close();
    }
  },

  /** Сохранить присланные файлы; возвращает, сколько сохранено. */
  put(files) {
    return this._tx('readwrite', (store, done) => {
      for (const file of files) store.add({ blob: file, name: file.name || '', type: file.type || '', at: Date.now() });
      done(files.length);
    });
  },

  /** Все ждущие файлы: [{ id, blob, name, type, at }]. */
  list() {
    return this._tx('readonly', (store, done) => {
      const req = store.getAll();
      req.onsuccess = () => done(req.result || []);
    });
  },

  remove(ids) {
    return this._tx('readwrite', (store, done) => { ids.forEach(id => store.delete(id)); done(ids.length); });
  },

  clear() {
    return this._tx('readwrite', (store, done) => { store.clear(); done(true); });
  },
};

self.ShareInbox = ShareInbox;
