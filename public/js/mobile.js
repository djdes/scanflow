/* global MobileCore, Upload, RecognitionQueue, ShareInbox */
// Мобильное приложение /m/ (спек docs/superpowers/specs/2026-11-06-mobile-app-design.md).
// Экраны: вход, главная, список, накладная. Отправку фото не пишем заново —
// это upload.js кабинета (очередь в IndexedDB, повторы, обход WebKit 319985);
// здесь только своя отрисовка полосы отправки.

// Прослойка: upload.js и recognition-queue.js ждут глобальный App кабинета.
const App = {
  apiKey: localStorage.getItem('apiKey') || '',
  baseUrl: '/api',

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  async api(path, options = {}) {
    const headers = { 'X-API-Key': this.apiKey, ...options.headers };
    let body = options.body;
    if (body && typeof body === 'object' && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(body);
    }
    const res = await fetch(this.baseUrl + path, { ...options, headers, body });
    // 401 — ключ больше не действует; 403 «приостановлен» — аккаунт заблокирован
    // (auth.ts). В обоих случаях работать дальше нельзя — на экран входа.
    let signOut = res.status === 401 ? 'Войдите ещё раз.' : null;
    if (res.status === 403) {
      const reason = await res.clone().json().then(b => String(b.error || ''), () => '');
      if (/приостановлен/i.test(reason)) signOut = reason;
    }
    if (signOut) {
      Mobile.signedOut(signOut);
      const err = new Error(signOut);
      err.status = 401;
      throw err;
    }
    return res;
  },

  async apiJson(path, options = {}) {
    const res = await this.api(path, options);
    let body = null;
    try { body = await res.json(); } catch { /* не JSON */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  },

  // Об успехах и сетевых сбоях отправки говорит полоса сверху — всплывашки
  // остаются только для того, что нужно прочитать (формат, размер, цены).
  notify(message, type = 'info') {
    if (type !== 'error' && type !== 'warn') return;
    if (message === 'Ошибка сети') return;
    Mobile.toast(message, type === 'error' ? 'red' : 'amber');
  },

  formatDateTime(value) {
    const d = new Date(String(value || '').replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? String(value || '') : d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  },
};

const Mobile = {
  PAGE: 20,
  screen: null,
  list: { view: 'all', items: [], total: 0, loading: false },
  stats: null,
  invoice: null,
  photoUrls: [],
  installEvent: null,
  pollTimer: null,
  okCount: 0,
  depth: 0,

  $(id) { return document.getElementById(id); },

  start() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvent = e;
      this.renderInstall();
    });
    window.addEventListener('appinstalled', () => { this.installEvent = null; this.closeInstall(false); this.renderInstall(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!this.$('m-install-sheet').hidden) this.closeInstall(true);
      for (const id of ['m-view', 'm-tips']) this.$(id).hidden = true;
    });
    // Нажатие мимо листа настроек или советов закрывает его.
    for (const id of ['m-view', 'm-tips']) {
      this.$(id).addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.hidden = true; });
    }
    window.addEventListener('hashchange', () => this.onHashChange());
    window.addEventListener('online', () => { this.renderOnline(); this.refresh(); });
    window.addEventListener('offline', () => this.renderOnline());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.refresh(); });
    document.addEventListener('click', (e) => this.onClick(e));

    this.$('m-login-form').addEventListener('submit', (e) => { e.preventDefault(); this.login(); });
    this.$('m-back').addEventListener('click', () => this.back());
    this.$('m-camera-input').addEventListener('change', (e) => this.onPicked(e.target, true));
    this.$('m-gallery-input').addEventListener('change', (e) => this.onPicked(e.target, false));
    this.$('m-files-input').addEventListener('change', (e) => this.onPicked(e.target, false));

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/m/' }).catch(() => { /* без кеша тоже работает */ });
      // Нажали на уведомление, а приложение уже открыто — показать накладную.
      navigator.serviceWorker.addEventListener('message', (e) => {
        const hash = e.data && e.data.type === 'open' ? String(e.data.hash || '#/') : null;
        if (hash && /^#\/[\w/?=&-]*$/.test(hash) && hash !== location.hash) location.hash = hash;
      });
    }
    this.initPullToRefresh();
    // Глубина внутри приложения — в history.state: переживает перезагрузку и
    // системную кнопку «Назад», в отличие от счётчика в памяти.
    const state = history.state;
    if (state && typeof state.m === 'number') this.depth = state.m;
    else history.replaceState({ m: 0 }, '');
    this.renderOnline();
    if (App.apiKey) { this.startUploads(); this.syncPush(); }
    this.route();
  },

  // ── Навигация ──────────────────────────────────────────────────────────
  route() {
    clearTimeout(this.pollTimer);
    this.revokePhotos();
    const hash = location.hash || '#/';
    const share = /^#\/share(?:\?n=(\d+))?$/.exec(hash);
    if (!App.apiKey) {
      // Прислали файлы через «Поделиться», а вход не выполнен: они ждут на
      // устройстве и уйдут сразу после входа (route() вызовется снова).
      this.$('m-login-note').hidden = !share;
      return this.show('login');
    }
    this.$('m-login-note').hidden = true;
    let m;
    if (share) return this.takeShared(Number(share[1] || 0));
    if ((m = /^#\/inv\/(\d+)$/.exec(hash))) { this.closeNotifications(`inv-${m[1]}`); return this.showInvoice(Number(m[1])); }
    if ((m = /^#\/list\/(all|attention|ready)$/.exec(hash))) return this.showList(m[1]);
    this.showHome(hash === '#/camera');
  },

  show(name) {
    // Новый экран — снова только основное: раскрытое «Ещё» сворачиваем.
    if (this.screen !== name) {
      document.querySelectorAll('.m-more-toggle[aria-expanded="true"]').forEach(btn => {
        btn.setAttribute('aria-expanded', 'false');
        this.$(btn.getAttribute('aria-controls')).hidden = true;
      });
    }
    this.screen = name;
    if (name !== 'home') this.$('m-install-sheet').hidden = true;
    for (const id of ['login', 'home', 'list', 'invoice']) this.$(`screen-${id}`).hidden = id !== name;
    this.$('m-back').hidden = name === 'login' || name === 'home';
    document.querySelector('.m-aa').hidden = name === 'login';
    window.scrollTo(0, 0);
  },

  onHashChange() {
    const state = history.state;
    if (state && typeof state.m === 'number') {
      this.depth = state.m;            // вернулись к записи, где уже были
    } else {
      if (!this.replacing) this.depth += 1;   // новый шаг внутри приложения
      this.replacing = false;
      history.replaceState({ m: this.depth }, '');
    }
    this.route();
  },

  // Перейти, не добавляя шаг в историю.
  replaceHash(hash) {
    this.replacing = true;
    location.replace(hash);
  },

  back() {
    // В установленном приложении на iPhone кнопки «Назад» у системы нет.
    // Шаг назад — только по своей истории; открыли сразу экран — к родителю.
    if (this.depth > 0) { history.back(); return; }
    this.replaceHash(this.screen === 'invoice' ? `#/list/${this.list.view}` : '#/');
  },

  refresh() {
    if (!App.apiKey || document.hidden) return Promise.resolve();
    if (this.screen === 'home') return this.loadHome();
    if (this.screen === 'list') return this.loadList(true);
    if (this.screen === 'invoice' && this.invoice) return this.loadInvoice(this.invoice.id);
    return Promise.resolve();
  },

  // «Потяните вниз — обновить»: в установленном приложении у браузера своего
  // жеста нет. В обычной вкладке работает жест браузера — свой не нужен.
  initPullToRefresh() {
    if (!this.isStandalone()) return;
    document.documentElement.classList.add('m-standalone');
    const ptr = this.$('m-ptr');
    const READY = 64;
    let startY = null, pull = 0;
    const reset = () => { ptr.hidden = true; ptr.classList.remove('is-ready', 'is-loading'); ptr.style.transform = ''; };
    const blocked = () => !['home', 'list', 'invoice'].includes(this.screen)
      || document.querySelector('.m-sheet:not([hidden])') || window.scrollY > 0;
    window.addEventListener('touchstart', (e) => {
      startY = e.touches.length === 1 && !blocked() ? e.touches[0].clientY : null;
      pull = 0;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (startY == null) return;
      pull = Math.min(Math.max(0, (e.touches[0].clientY - startY) * 0.5), 96);
      if (pull < 8) { reset(); return; }
      ptr.hidden = false;
      ptr.classList.toggle('is-ready', pull >= READY);
      ptr.style.transform = `translate(-50%, ${pull}px) rotate(${pull * 4}deg)`;
    }, { passive: true });
    window.addEventListener('touchend', () => {
      if (startY == null) return;
      startY = null;
      if (pull < READY) { reset(); return; }
      ptr.classList.add('is-loading');
      ptr.style.transform = `translate(-50%, ${READY}px)`;
      if (navigator.vibrate) navigator.vibrate(15);
      const done = Promise.resolve(this.refresh()).catch(() => null);
      Promise.all([done, new Promise(r => setTimeout(r, 600))]).then(reset);
    });
  },

  schedulePoll(ms = 8000) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.refresh(), ms);
  },

  onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'camera') this.camera();
    else if (action === 'tips') this.openSheet('m-tips');
    else if (action === 'tips-ok') { this.markTipsSeen(); this.camera(); }
    else if (action === 'quality-retake') { this.pendingPhoto = null; this.camera(); }
    else if (action === 'quality-send') this.sendAnyway();
    else if (action === 'push') this.togglePush();
    else if (action === 'push-offer') { this.$('m-shot-push').hidden = true; this.enablePush(); }
    else if (action === 'view') this.openView();
    else if (action === 'view-done') this.$('m-view').hidden = true;
    else if (action === 'text-size') this.setTextSize(el.dataset.size);
    else if (action === 'contrast') this.setContrast(document.documentElement.dataset.contrast !== 'high');
    else if (action === 'gallery') this.$('m-gallery-input').click();
    else if (action === 'files') this.$('m-files-input').click();
    else if (action === 'shot-done') this.closeShot();
    else if (action === 'more') this.toggleMore(el);
    else if (action === 'install') this.install();
    else if (action === 'install-now') this.installNow();
    else if (action === 'install-later') this.closeInstall(true);
    else if (action === 'logout') this.logout();
    else if (action === 'list-more') this.loadList(false);
    else if (action === 'send') this.send(Number(el.dataset.id), el);
    else if (action === 'send-all') this.sendAll(el);
    else if (action === 'retry-uploads') Upload.retryAllErrors();
    else if (action === 'dismiss-uploads') this.dismissFailedUploads();
    else if (action === 'photos') this.loadPhotos(Number(el.dataset.id), el);
  },

  toggleMore(button) {
    const panel = this.$(button.getAttribute('aria-controls'));
    const open = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open && panel.id === 'm-home-more') { this.renderInstall(); this.checkApk(); this.renderPush(); }
  },

  // ── Вход и выход ───────────────────────────────────────────────────────
  async login() {
    const user = this.$('m-login-user').value.trim();
    const pass = this.$('m-login-pass').value;
    const error = this.$('m-login-error');
    const button = this.$('m-login-submit');
    error.hidden = true;
    if (!user || !pass) { error.textContent = 'Введите логин и пароль.'; error.hidden = false; return; }
    button.disabled = true;
    button.textContent = 'Входим…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.apiKey) throw new Error(data.error || 'Неверный логин или пароль.');
      App.apiKey = data.apiKey;
      localStorage.setItem('apiKey', data.apiKey);
      localStorage.setItem('adminUsername', data.username || user);
      if (data.role) localStorage.setItem('adminRole', data.role);
      this.$('m-login-pass').value = '';
      this.startUploads();
      // Повторный вход без перезагрузки: догрузить фото этого входа и снова
      // следить за очередью сервера (после 401 её опрос остановился).
      Upload.retryPending();
      RecognitionQueue.refresh();
      this.syncPush();
      this.route();
    } catch (err) {
      error.textContent = navigator.onLine ? err.message : 'Нет интернета.';
      error.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Войти';
    }
  },

  signedOut(message) {
    App.apiKey = '';
    ['apiKey', 'adminRole', 'superadminSession'].forEach(k => localStorage.removeItem(k));
    // Данные прежнего входа не должны мелькнуть у следующего.
    clearTimeout(this.pollTimer);
    this.revokePhotos();
    this.invoice = null;
    this.invoiceHtmlShown = null;
    this.stats = null;
    this.list = { view: 'all', items: [], total: 0, loading: false };
    for (const id of ['m-recent', 'm-list', 'm-invoice']) this.$(id).innerHTML = '';
    this.renderCounts();
    document.querySelectorAll('.m-sheet').forEach(el => { el.hidden = true; });
    this.pendingPhoto = null;
    // Ключ уже не действует — сервер не спросить; подписку снимаем на телефоне,
    // и сервер удалит её при следующей отправке (410).
    this.dropPush(false);
    this.show('login');
    if (message) { const el = this.$('m-login-error'); el.textContent = message; el.hidden = false; }
  },

  async logout() {
    const warning = MobileCore.logoutWarning(Upload.history);
    if (warning && !confirm(warning)) return;
    // Неотправленные фото удаляем: иначе они уйдут под ключом следующего входа —
    // возможно, в другую компанию.
    try {
      await Upload._dbReady;
      if (Upload.db) for (const item of await Upload.dbGetAll()) await Upload.dbDelete(item.id);
    } catch { /* очереди на устройстве нет — удалять нечего */ }
    try { await ShareInbox.clear(); } catch { /* присланных файлов нет */ }
    // Уведомления этого входа телефону больше не нужны (общий телефон).
    await this.dropPush(true);
    ['apiKey', 'adminRole', 'superadminSession'].forEach(k => localStorage.removeItem(k));
    location.replace('/m/');
  },

  // ── Фото ───────────────────────────────────────────────────────────────
  startUploads() {
    if (Upload.initialized) return;
    // Полоса отправки вместо списка фото кабинета.
    Upload.renderHistory = () => this.renderUploadBar();
    Upload.updateCounter = () => {};
    Upload._renderWakeLockNotice = () => {};
    Upload.init();
    RecognitionQueue.render = () => this.renderUploadBar();
    RecognitionQueue.refresh();
  },

  /** Открыть камеру. Первый раз — сначала три совета (кнопка в них снова зовёт камеру). */
  camera() {
    for (const id of ['m-shot', 'm-quality', 'm-tips']) this.$(id).hidden = true;
    let seen = false;
    try { seen = localStorage.getItem('sf-tips-seen') === '1'; } catch { seen = true; }
    if (!seen) { this.openSheet('m-tips'); return; }
    this.$('m-camera-input').click();
  },

  markTipsSeen() {
    try { localStorage.setItem('sf-tips-seen', '1'); } catch { /* приватный режим */ }
  },

  openSheet(id) {
    this.$('m-install-sheet').hidden = true;
    this.$(id).hidden = false;
  },

  async onPicked(input, fromCamera) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    if (fromCamera) {
      // Байты — сразу в память (WebKit 319985: File из камеры может «опустеть»).
      let photo = files[0];
      try { photo = new File([await Upload.memoryBlob(files[0])], files[0].name || `photo_${Date.now()}.jpg`, { type: files[0].type || 'image/jpeg' }); } catch { /* addFile скажет сам */ }
      const issue = await this.photoIssueOf(photo);
      if (issue) { this.showQuality(issue, photo); return; }
      await this.acceptPhoto(photo);
    } else {
      // Пропущенные (формат, размер) _addMultiple называет сам — не затираем.
      const before = Upload.history.length;
      await Upload._addMultiple(files);
      const added = Upload.history.length - before;
      if (added === files.length) this.toast(`Добавлено: ${added} ${MobileCore.plural(added, 'файл', 'файла', 'файлов')}.`, 'green');
    }
  },

  async acceptPhoto(photo) {
    // «Фото принято» — только если фото прочиталось и встало в очередь;
    // пустой файл (WebKit 319985) addFile отклоняет со своим сообщением.
    const before = Upload.history.length;
    await Upload.addFile(photo);
    if (Upload.history.length > before) this.showAccepted('Фото принято', true);
  },

  /** Тёмный или мутный снимок: 'dark' / 'blurry' / null. Любой сбой — не мешаем. */
  async photoIssueOf(file) {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type || '') || typeof document === 'undefined') return null;
    const check = (async () => {
      const image = await Upload._decodePhoto(file);
      try {
        const scale = Math.min(1, 640 / Math.max(image.width, image.height));
        const w = Math.max(3, Math.round(image.width * scale));
        const h = Math.max(3, Math.round(image.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(image.source, 0, 0, w, h);
        const px = ctx.getImageData(0, 0, w, h).data;
        canvas.width = 0; canvas.height = 0;
        const gray = new Uint8ClampedArray(w * h);
        for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
        return MobileCore.photoIssue(MobileCore.photoStats(gray, w, h));
      } finally {
        image.close();
      }
    })().catch(() => null);
    return Promise.race([check, new Promise(r => setTimeout(() => r(null), 2500))]);
  },

  showQuality(issue, photo) {
    this.pendingPhoto = photo;
    const text = {
      dark: ['Фото тёмное', 'Включите свет и снимите ещё раз.', '☾'],
      blurry: ['Фото нечёткое', 'Держите телефон ровно и снимите ещё раз.', '≈'],
    }[issue];
    this.$('m-quality-title').textContent = text[0];
    this.$('m-quality-text').textContent = text[1];
    this.$('m-quality-icon').textContent = text[2];
    this.openSheet('m-quality');
  },

  async sendAnyway() {
    const photo = this.pendingPhoto;
    this.pendingPhoto = null;
    this.$('m-quality').hidden = true;
    if (photo) await this.acceptPhoto(photo);
  },

  /** Лист «принято»: после снимка — с кнопкой «Ещё страница», после «Поделиться» — без неё. */
  showAccepted(title, morePages) {
    this.$('m-install-sheet').hidden = true;
    this.$('m-shot-title').textContent = title;
    this.$('m-shot-text').textContent = 'Прочитаем сами.';
    this.$('m-shot-more').hidden = !morePages;
    this.$('m-shot-push').hidden = !this.offerPushNow();
    this.$('m-shot').hidden = false;
    if (navigator.vibrate) navigator.vibrate(30);
  },

  // «Поделиться → ScanFlow» на Android: service worker сложил файлы в ShareInbox
  // и открыл #/share?n=N. Забираем их в обычный загрузчик (сжатие, метка входа,
  // повторы) и убираем из ShareInbox, когда они уже в его очереди.
  async takeShared(sentCount) {
    history.replaceState({ m: this.depth }, '', '#/');   // «Назад» не вернёт к приёму
    this.showHome(false);
    let items = [];
    try { items = await ShareInbox.list(); } catch { /* хранилище недоступно */ }
    if (!items.length) {
      if (!sentCount) this.toast('Не получилось принять файлы. Добавьте их через «Ещё → Из галереи».', 'amber');
      return;
    }
    const files = items.map(it => new File([it.blob], MobileCore.sharedFileName(it.name, it.type), { type: it.type || it.blob.type || '' }));
    const before = Upload.history.length;
    await Upload._addMultiple(files);
    try { await ShareInbox.remove(items.map(it => it.id)); } catch { /* уберём в следующий раз */ }
    const added = Upload.history.length - before;
    if (added) this.showAccepted(`Принято: ${added} ${MobileCore.plural(added, 'файл', 'файла', 'файлов')}`, false);
  },

  closeShot() {
    this.$('m-shot').hidden = true;
    if (this.screen === 'home') this.loadHome();
  },

  renderUploadBar() {
    const bar = this.$('m-upload-bar');
    const queue = RecognitionQueue.data;
    const summary = MobileCore.uploadSummary(Upload.history, navigator.onLine,
      queue ? queue.total : 0, !(queue && queue.ai && queue.ai.available === false));
    bar.hidden = !summary;
    if (summary) {
      const button = summary.retry ? '<button type="button" class="m-bar__retry" data-action="retry-uploads">Повторить</button>'
        : summary.dismiss ? '<button type="button" class="m-bar__retry" data-action="dismiss-uploads">Убрать</button>' : '';
      bar.className = `m-bar m-bar--${summary.tone}`;
      bar.innerHTML = `<span>${App.esc(summary.text)}</span>${button}`;
    }
    // Сервер дочитал фото — показать новую накладную в списках.
    const ok = Upload.history.filter(h => h.status === 'ok').length;
    if (ok > this.okCount) { this.okCount = ok; this.refresh(); }
  },

  // Окончательные ошибки (плохой файл, потерянное фото) сами не повторятся —
  // убрать их из полосы. Фото другого входа остаётся на устройстве и уйдёт,
  // когда войдёт тот аккаунт.
  dismissFailedUploads() {
    Upload.history.forEach((h, idx) => {
      if (h.status === 'lost' || (h.status === 'error' && !h.autoRetry)) {
        if (Upload._foreign(h.owner)) { h.status = 'removed'; return; }
        Upload.remove(idx);
      }
    });
    this.renderUploadBar();
  },

  renderOnline() {
    this.$('m-offline').hidden = navigator.onLine;
    if (Upload.initialized) this.renderUploadBar();
  },

  // ── Главная ────────────────────────────────────────────────────────────
  showHome(flashCamera) {
    this.show('home');
    const who = localStorage.getItem('adminUsername');
    this.$('m-whoami').textContent = who ? `Вы вошли как ${who}` : '';
    if (flashCamera) {
      const btn = this.$('m-camera-btn');
      btn.classList.add('is-flash');
      btn.focus();
      setTimeout(() => btn.classList.remove('is-flash'), 1600);
    }
    this.loadHome();
    this.maybeOfferInstall();
  },

  async loadHome() {
    const recent = this.$('m-recent');
    if (!recent.innerHTML) recent.innerHTML = '<p class="m-empty">Загружаем…</p>';
    try {
      const [stats, list] = await Promise.all([
        App.apiJson('/invoices/stats'),
        App.apiJson('/invoices?limit=5'),
      ]);
      if (this.screen !== 'home') return;
      this.stats = stats.data.workflow || {};
      this.renderCounts();
      this.setBadge(this.stats.attention);
      const items = list.data || [];
      recent.innerHTML = items.length
        ? items.map(inv => this.cardHtml(inv)).join('')
        : '<p class="m-empty">Накладных пока нет. Снимите первую.</p>';
      if (items.some(inv => MobileCore.isReading(inv))) this.schedulePoll();
    } catch (err) {
      if (err.status === 401 || this.screen !== 'home') return;
      recent.innerHTML = `<p class="m-empty">${navigator.onLine ? 'Не загрузилось.' : 'Нет интернета.'}</p>`;
      this.schedulePoll(15000);
    }
  },

  renderCounts() {
    const s = this.stats || {};
    this.$('m-count-attention').textContent = s.attention ?? '–';
    this.$('m-count-ready').textContent = s.ready ?? '–';
    this.$('m-seg-attention').textContent = s.attention ? String(s.attention) : '';
    this.$('m-seg-ready').textContent = s.ready ? String(s.ready) : '';
  },

  // Значки статусов (MobileCore.TONE_ICON): статус читается и без цвета.
  ICONS: {
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    send: '<path d="M5 12h13M13 6l6 6-6 6"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.4v.2"/>',
    cross: '<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6M15 9l-6 6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  },

  pillHtml(state, big = false) {
    const icon = state.icon && this.ICONS[state.icon]
      ? `<svg class="m-pill__icon" viewBox="0 0 24 24" aria-hidden="true">${this.ICONS[state.icon]}</svg>` : '';
    return `<span class="m-pill m-pill--${state.tone}${big ? ' m-pill--big' : ''}">${icon}${App.esc(state.label)}</span>`;
  },

  cardHtml(inv) {
    const state = MobileCore.invoiceState(inv);
    const meta = [inv.invoice_number ? `№ ${inv.invoice_number}` : '', MobileCore.relativeDay(inv.invoice_date || inv.created_at)]
      .filter(Boolean).join(' · ');
    return `<a class="m-card m-card--${state.tone}" href="#/inv/${Number(inv.id)}">
      <span class="m-card__name">${App.esc(inv.supplier || 'Поставщик не прочитан')}</span>
      <span class="m-card__row">
        ${this.pillHtml(state)}
        <span class="m-card__sum">${App.esc(MobileCore.formatMoney(inv.total_sum))}</span>
      </span>
      ${meta ? `<span class="m-card__meta">${App.esc(meta)}</span>` : ''}
    </a>`;
  },

  // ── Список ─────────────────────────────────────────────────────────────
  showList(view) {
    const changed = this.list.view !== view || this.screen !== 'list';
    this.show('list');
    this.list.view = view;
    document.querySelectorAll('.m-seg__item').forEach(a => {
      const active = a.dataset.view === view;
      a.classList.toggle('is-active', active);
      a.setAttribute('aria-selected', String(active));
    });
    if (changed) { this.$('m-list').innerHTML = '<p class="m-empty">Загружаем…</p>'; this.$('m-send-all').hidden = true; }
    this.loadList(true);
  },

  async loadList(reset) {
    if (this.list.loading) return;
    this.list.loading = true;
    const view = this.list.view;
    const offset = reset ? 0 : this.list.items.length;
    const more = this.$('m-list-more');
    try {
      const [list, stats] = await Promise.all([
        App.apiJson(`/invoices?limit=${this.PAGE}&offset=${offset}${view === 'all' ? '' : `&view=${view}`}`),
        reset ? App.apiJson('/invoices/stats') : Promise.resolve(null),
      ]);
      if (this.screen !== 'list' || this.list.view !== view) return;
      if (stats) { this.stats = stats.data.workflow || {}; this.renderCounts(); }
      this.list.items = reset ? (list.data || []) : this.list.items.concat(list.data || []);
      this.list.total = Number(list.total) || this.list.items.length;
      const empty = { all: 'Накладных пока нет. Снимите первую.', attention: 'Проверять нечего ✓', ready: 'Готовых к отправке нет.' }[view];
      this.$('m-list').innerHTML = this.list.items.length ? this.list.items.map(inv => this.cardHtml(inv)).join('') : `<p class="m-empty">${empty}</p>`;
      more.hidden = this.list.items.length >= this.list.total;
      const sendAll = this.$('m-send-all');
      sendAll.hidden = !(view === 'ready' && this.list.total > 1);
      sendAll.textContent = `Отправить все в 1С (${this.list.total})`;
      this.$('m-fab').hidden = !sendAll.hidden;
      if (this.list.items.some(inv => MobileCore.isReading(inv))) this.schedulePoll();
    } catch (err) {
      if (err.status !== 401 && this.screen === 'list') {
        this.$('m-list').innerHTML = `<p class="m-empty">${navigator.onLine ? 'Не загрузилось.' : 'Нет интернета.'}</p>`;
      }
    } finally {
      this.list.loading = false;
    }
  },

  async sendAll(button) {
    const n = this.list.total;
    if (!confirm(`Отправить в 1С ${n} ${MobileCore.plural(n, 'накладную', 'накладные', 'накладных')}?`)) return;
    button.disabled = true;
    try {
      const list = await App.apiJson('/invoices?view=ready&limit=500');
      const ids = (list.data || []).map(inv => Number(inv.id));
      if (!ids.length) return;
      const { data } = await App.apiJson('/invoices/send-1c-batch', { method: 'POST', body: { ids } });
      const skipped = (data.skipped || []).length;
      this.toast(`Отправлено: ${data.sent}.${skipped ? ` Не отправлено: ${skipped} — откройте их.` : ''}`, skipped ? 'amber' : 'green');
    } catch (err) {
      if (err.status !== 401) this.toast(err.message, 'red');
    } finally {
      button.disabled = false;
      this.loadList(true);
    }
  },

  // ── Накладная ──────────────────────────────────────────────────────────
  showInvoice(id) {
    if (!this.invoice || this.invoice.id !== id) {
      this.invoice = { id };
      this.invoiceHtmlShown = null;
      this.$('m-invoice').innerHTML = '<p class="m-empty">Загружаем…</p>';
    }
    this.show('invoice');
    this.loadInvoice(id);
  },

  async loadInvoice(id) {
    try {
      const { data } = await App.apiJson(`/invoices/${id}`);
      if (this.screen !== 'invoice' || !this.invoice || this.invoice.id !== id) return;
      // Пока накладная читается, экран обновляется сам; если ничего не
      // поменялось — не перерисовываем, чтобы не закрыть фото и товары.
      const html = this.invoiceHtml(data, false);
      if (html !== this.invoiceHtmlShown) {
        const wasOpen = this.$('m-inv-more-btn')?.getAttribute('aria-expanded') === 'true';
        this.revokePhotos();
        this.$('m-invoice').innerHTML = this.invoiceHtml(data, wasOpen);
        this.invoiceHtmlShown = html;
      }
      this.invoice = data;
      if (MobileCore.isReading(data)) this.schedulePoll(5000);
    } catch (err) {
      if (err.status === 401) return;
      if (err.status === 404 && err.body && err.body.merged_into) { this.replaceHash(`#/inv/${Number(err.body.merged_into)}`); return; }
      this.$('m-invoice').innerHTML = `<p class="m-empty">${err.status === 404 ? 'Накладная не найдена.' : navigator.onLine ? 'Не загрузилось.' : 'Нет интернета.'}</p>`;
    }
  },

  invoiceHtml(inv, moreOpen) {
    const state = MobileCore.invoiceState(inv);
    const id = Number(inv.id);
    const full = `/app.html#/invoices/${id}`;
    const date = MobileCore.formatDate(inv.invoice_date);
    const meta = [inv.invoice_number ? `№ ${inv.invoice_number}` : '', date ? `от ${date}` : ''].filter(Boolean).join(' ');
    const main = {
      send: `<button type="button" class="m-btn m-btn--primary" data-action="send" data-id="${id}">Отправить в 1С</button>`,
      review: `<a class="m-btn m-btn--primary" href="${full}">Открыть и проверить</a>`,
      retake: '<button type="button" class="m-btn m-btn--primary" data-action="camera">Переснять</button>',
    }[state.action] || '';
    const items = inv.items || [];
    const itemsHtml = items.map(it => `<li class="m-item">
        <span class="m-item__name">${App.esc(it.mapped_name || it.original_name || '—')}</span>
        <span class="m-item__qty">${App.esc(this.qty(it.quantity))} ${App.esc(it.unit || '')}</span>
        <span class="m-item__sum">${App.esc(MobileCore.formatMoney(it.total))}</span>
      </li>`).join('');
    return `
      <div class="m-status m-status--${state.tone}">
        ${this.pillHtml(state, true)}
        ${state.hint ? `<p class="m-status__hint">${App.esc(state.hint)}</p>` : ''}
      </div>
      <h1 class="m-inv__supplier">${App.esc(inv.supplier || 'Поставщик не прочитан')}</h1>
      <p class="m-inv__sum">${App.esc(MobileCore.formatMoney(inv.total_sum))}</p>
      ${meta ? `<p class="m-inv__meta">${App.esc(meta)}</p>` : ''}
      ${main}
      <button type="button" class="m-btn m-btn--ghost m-more-toggle" id="m-inv-more-btn" data-action="more" aria-expanded="${moreOpen ? 'true' : 'false'}" aria-controls="m-inv-more">
        Ещё
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </button>
      <div class="m-more" id="m-inv-more"${moreOpen ? '' : ' hidden'}>
        <details class="m-details">
          <summary class="m-more__item">Товары (${items.length})</summary>
          ${items.length ? `<ul class="m-items">${itemsHtml}</ul>` : '<p class="m-empty">Товаров нет.</p>'}
        </details>
        <button type="button" class="m-more__item" data-action="photos" data-id="${id}">Фото</button>
        <div class="m-photos" id="m-photos"></div>
        <a class="m-more__item" href="${full}">Открыть полностью</a>
      </div>`;
  },

  qty(value) {
    const n = Number(value);
    return value == null || !Number.isFinite(n) ? '—' : n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  },

  async send(id, button) {
    button.disabled = true;
    button.textContent = 'Отправляем…';
    let result;
    try {
      const res = await App.api(`/invoices/${id}/send`, { method: 'POST' });
      const body = await res.json().catch(() => null);
      result = MobileCore.sendResultText(res.status, body);
    } catch (err) {
      if (err.status === 401) return;
      result = { ok: false, text: navigator.onLine ? 'Не получилось. Попробуйте ещё раз.' : 'Нет интернета.' };
    }
    this.toast(result.text, result.ok ? 'green' : 'red');
    if (result.ok && navigator.vibrate) navigator.vibrate(30);
    this.loadInvoice(id);
  },

  async loadPhotos(id, button) {
    const host = this.$('m-photos');
    if (host.childElementCount) { host.innerHTML = ''; this.revokePhotos(); return; }
    button.disabled = true;
    try {
      const { data } = await App.apiJson(`/invoices/${id}/photos`);
      const images = (data || []).filter(p => p.kind === 'image' && p.exists);
      if (!images.length) { host.innerHTML = '<p class="m-empty">Фото нет. Откройте полностью.</p>'; return; }
      for (const photo of images) {
        const res = await App.api(`/invoices/${id}/photos/${encodeURIComponent(photo.filename)}`);
        if (!res.ok) continue;
        const url = URL.createObjectURL(await res.blob());
        this.photoUrls.push(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Лист накладной';
        img.className = 'm-photo';
        host.appendChild(img);
      }
    } catch (err) {
      if (err.status !== 401) host.innerHTML = '<p class="m-empty">Не загрузилось.</p>';
    } finally {
      button.disabled = false;
    }
  },

  revokePhotos() {
    this.photoUrls.forEach(url => URL.revokeObjectURL(url));
    this.photoUrls = [];
  },

  // ── Установка ──────────────────────────────────────────────────────────
  isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
      || navigator.standalone === true
      || document.referrer.startsWith('android-app://');
  },

  installKind() {
    return MobileCore.installHint(navigator.userAgent, this.isStandalone(), navigator.maxTouchPoints || 0);
  },

  renderInstall() {
    this.$('m-install').hidden = this.installKind() === 'installed';
    // Окно установки появилось или пропало, пока открыта подсказка, — обновить её.
    if (!this.$('m-install-sheet').hidden) this.openInstall();
  },

  installVariantNow() {
    return MobileCore.installVariant(navigator.userAgent, this.isStandalone(),
      navigator.maxTouchPoints || 0, Boolean(this.installEvent));
  },

  // Подсказка снизу сама — на главной, через пару секунд после входа, раз за
  // запуск; «Не сейчас» прячет её на 14 дней (MobileCore.installDue).
  maybeOfferInstall() {
    if (this.installOffered || !this.installVariantNow()) return;
    let dismissed = null;
    try { dismissed = localStorage.getItem('sf-install-dismissed'); } catch { /* приватный режим */ }
    if (!MobileCore.installDue(dismissed)) return;
    this.installOffered = true;
    clearTimeout(this._installTimer);
    this._installTimer = setTimeout(() => {
      if (this.screen === 'home' && this.$('m-shot').hidden) this.openInstall();
    }, 2500);
  },

  async install() {
    if (this.installEvent) return this.installNow();
    if (!this.installVariantNow()) { this.toast('Откройте scanflow.ru/m на телефоне.', 'blue'); return; }
    this.openInstall();
  },

  openInstall() {
    const variant = this.installVariantNow();
    if (!variant) return this.closeInstall(false);
    const glyph = {
      share: '<span class="m-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M8 10H6.5A2.5 2.5 0 0 0 4 12.5v6A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-6a2.5 2.5 0 0 0-2.5-2.5H16"/></svg></span>',
      add: '<span class="m-glyph" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg></span>',
      menu: '<span class="m-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" class="m-glyph--dots"><circle cx="12" cy="5.5" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.5" r="1.7"/></svg></span>',
      more: '<span class="m-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" class="m-glyph--dots"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg></span>',
    };
    const step = (n, text, note = '') => `<li><span class="m-steps__n">${n}</span><span>${text}${note ? `<small>${note}</small>` : ''}</span></li>`;
    const later = '<button type="button" class="m-install__later" data-action="install-later">Не сейчас</button>';
    const gotIt = '<button type="button" class="m-btn m-btn--ghost" data-action="install-later">Понятно</button>';
    const apk = this.apkAvailable ? '<a class="m-btn m-btn--ghost" href="/downloads/scanflow.apk" download>Скачать APK</a>' : '';
    this.$('m-install-body').innerHTML = {
      'ios-safari': `<ol class="m-steps">${step(1, `Нажмите ${glyph.share} «Поделиться»`, 'внизу экрана или в меню «⋯»')}${step(2, `Выберите ${glyph.add} «На экран Домой»`)}</ol>${gotIt}`,
      'ios-other': `<ol class="m-steps">${step(1, `Нажмите ${glyph.share} «Поделиться»`, 'в строке адреса')}${step(2, `Выберите ${glyph.add} «На экран Домой»`)}</ol>${gotIt}`,
      'ios-inapp': `<ol class="m-steps">${step(1, `Откройте страницу в Safari`, `меню ${glyph.more} → «Открыть в Safari»`)}${step(2, `Там: ${glyph.share} → ${glyph.add} «На экран Домой»`)}</ol>${gotIt}`,
      'android-prompt': `<button type="button" class="m-btn m-btn--primary" data-action="install-now">Установить</button>${later}`,
      'android-menu': `<ol class="m-steps">${step(1, `Откройте меню ${glyph.menu} браузера`)}${step(2, '«Установить приложение»', 'или «Добавить на главный экран»')}</ol>${apk}${later}`,
    }[variant];
    // У <svg> нет свойства hidden — меняем сам атрибут.
    this.$('m-install-arrow').toggleAttribute('hidden', variant !== 'ios-safari');
    this.$('m-install-sheet').hidden = false;
    if (variant === 'android-menu') this.checkApk().then(() => {
      if (this.apkAvailable && !this.$('m-install-sheet').hidden && !this.$('m-install-body').querySelector('[download]')) this.openInstall();
    });
  },

  closeInstall(remember) {
    this.$('m-install-sheet').hidden = true;
    if (remember) { try { localStorage.setItem('sf-install-dismissed', String(Date.now())); } catch { /* приватный режим */ } }
  },

  async installNow() {
    const prompt = this.installEvent;
    if (!prompt) return this.openInstall();
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    this.installEvent = null;
    this.closeInstall(!(choice && choice.outcome === 'accepted'));
    if (choice && choice.outcome === 'accepted') this.toast('Готово. Значок появится на экране.', 'green');
    this.renderInstall();
  },

  async checkApk() {
    if (this.installKind() !== 'android' || this._apkCheck) return this._apkCheck;
    this._apkCheck = fetch('/downloads/scanflow.apk', { method: 'HEAD' })
      .then(res => res.ok, () => false)
      .then(ok => { this.apkAvailable = ok; this.$('m-apk').hidden = !ok; });
    return this._apkCheck;
  },

  // ── Уведомления (Web Push) ─────────────────────────────────────────────
  // Сервер: /api/push/*, тексты — src/notifications/pushMessages.ts. Показ и
  // нажатие — public/sw.js. Подписка — устройства: вошли другим аккаунтом —
  // уведомления идут ему (pushRepo.upsert), «Выйти» снимает подписку.
  pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  },

  async pushSubscription() {
    if (!this.pushSupported()) return null;
    const reg = await navigator.serviceWorker.getRegistration('/m/');
    return reg ? reg.pushManager.getSubscription().catch(() => null) : null;
  },

  async pushStateNow() {
    const sub = await this.pushSubscription().catch(() => null);
    return MobileCore.pushState({
      supported: this.pushSupported(),
      ios: this.installKind() === 'ios',
      standalone: this.isStandalone(),
      permission: 'Notification' in window ? Notification.permission : 'default',
      subscribed: Boolean(sub),
    });
  },

  async renderPush() {
    const state = await this.pushStateNow();
    const item = this.$('m-push-item');
    item.hidden = state === 'unsupported';
    item.setAttribute('aria-checked', String(state === 'on'));
    item.dataset.state = state;
    this.$('m-push-state').textContent = { denied: 'Запрещены', 'install-first': 'После установки' }[state] || '';
  },

  // Состояние берём из уже нарисованного пункта, без ожидания: iPhone даёт
  // спросить разрешение только сразу в ответ на нажатие.
  async togglePush() {
    const state = this.$('m-push-item').dataset.state || 'off';
    if (state === 'on') {
      await this.dropPush(true);
      this.toast('Уведомления выключены.', 'blue');
    } else if (state === 'off') {
      await this.enablePush();
    } else if (state === 'denied') {
      this.toast('Уведомления запрещены. Разрешите их в настройках телефона.', 'amber');
    } else if (state === 'install-first') {
      this.toast('Сначала поставьте ScanFlow на экран «Домой».', 'blue');
      this.install();
    }
    this.renderPush();
  },

  async applicationServerKey() {
    const { data } = await App.apiJson('/push/key');
    const key = String((data && data.publicKey) || '');
    const pad = '='.repeat((4 - (key.length % 4)) % 4);
    const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  },

  sameKey(a, b) {
    if (!a || !b) return false;
    const x = new Uint8Array(a), y = new Uint8Array(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  },

  /** Включить: разрешение → подписка браузера → сервер. Только по нажатию человека. */
  async enablePush() {
    try { localStorage.setItem('sf-push-asked', String(Date.now())); } catch { /* приватный режим */ }
    if (!this.pushSupported()) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        this.toast(permission === 'denied' ? 'Уведомления запрещены. Разрешите их в настройках телефона.' : 'Уведомления не включены.', 'amber');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const key = await this.applicationServerKey();
      let sub = await reg.pushManager.getSubscription();
      if (sub && !this.sameKey(sub.options && sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      try {
        await App.apiJson('/push/subscribe', { method: 'POST', body: sub.toJSON() });
      } catch (err) {
        // Сервер подписку не принял — на телефоне её тоже не оставляем, иначе
        // переключатель показывал бы «вкл», а уведомления не приходили бы.
        await sub.unsubscribe().catch(() => {});
        throw err;
      }
      this.toast('Уведомления включены ✓', 'green');
    } catch (err) {
      if (err.status === 401) return;
      const text = err.body && err.body.code === 'endpoint_not_allowed' ? 'В этом браузере уведомления не работают. Откройте в Chrome или Safari.'
        : navigator.onLine ? 'Не получилось включить уведомления.' : 'Нет интернета.';
      this.toast(text, 'red');
    } finally {
      this.renderPush();
    }
  },

  /** Снять подписку телефона; withServer — и на сервере (ключ ещё действует). */
  async dropPush(withServer) {
    try {
      const sub = await this.pushSubscription();
      if (!sub) return;
      if (withServer && App.apiKey) await App.apiJson('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => null);
      await sub.unsubscribe();
    } catch { /* подписки нет — снимать нечего */ }
  },

  /**
   * После входа и при запуске: подписка телефона уже есть — напомнить о ней
   * серверу (вошли другим аккаунтом, сменился ключ сервера, сервер удалил её).
   */
  async syncPush() {
    try {
      if (!this.pushSupported() || Notification.permission !== 'granted') return;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      const key = await this.applicationServerKey();
      if (!this.sameKey(sub.options && sub.options.applicationServerKey, key)) {
        await sub.unsubscribe().catch(() => {});
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await App.apiJson('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    } catch { /* в следующий раз */ }
  },

  /** Предложить уведомления в листе «Фото принято»: только если можно включить и не чаще раза в 7 дней. */
  offerPushNow() {
    if (!this.pushSupported() || Notification.permission !== 'default') return false;
    let asked = null;
    try { asked = localStorage.getItem('sf-push-asked'); } catch { return false; }
    if (!MobileCore.due(asked, 7)) return false;
    try { localStorage.setItem('sf-push-asked', String(Date.now())); } catch { /* приватный режим */ }
    return true;
  },

  closeNotifications(tag) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistration('/m/')
      .then(reg => reg && reg.getNotifications({ tag }))
      .then(list => (list || []).forEach(n => n.close()))
      .catch(() => {});
  },

  setBadge(count) {
    try {
      const n = Number(count) || 0;
      if (n > 0 && navigator.setAppBadge) navigator.setAppBadge(n).catch(() => {});
      else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
    } catch { /* значок не поддерживается */ }
  },

  // ── Размер текста и контраст ───────────────────────────────────────────
  openView() {
    this.renderView();
    this.openSheet('m-view');
  },

  renderView() {
    const root = document.documentElement;
    const size = root.dataset.text || 'm';
    document.querySelectorAll('.m-size').forEach(b => b.setAttribute('aria-checked', String(b.dataset.size === size)));
    this.$('m-contrast').setAttribute('aria-checked', String(root.dataset.contrast === 'high'));
  },

  setTextSize(size) {
    const root = document.documentElement;
    if (size === 'l' || size === 'xl') root.dataset.text = size; else delete root.dataset.text;
    try { localStorage.setItem('sf-text', size === 'l' || size === 'xl' ? size : 'm'); } catch { /* приватный режим */ }
    this.renderView();
  },

  setContrast(high) {
    const root = document.documentElement;
    if (high) root.dataset.contrast = 'high'; else delete root.dataset.contrast;
    try { localStorage.setItem('sf-contrast', high ? 'high' : 'normal'); } catch { /* приватный режим */ }
    this.renderView();
  },

  // ── Сообщения ──────────────────────────────────────────────────────────
  toast(text, tone = 'blue') {
    const el = this.$('m-toast');
    el.className = `m-toast m-toast--${tone}`;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  },
};

window.App = App;
window.Mobile = Mobile;
