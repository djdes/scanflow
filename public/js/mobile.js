/* global MobileCore, Upload, RecognitionQueue */
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
    window.addEventListener('appinstalled', () => { this.installEvent = null; this.renderInstall(); });
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
    }
    // Глубина внутри приложения — в history.state: переживает перезагрузку и
    // системную кнопку «Назад», в отличие от счётчика в памяти.
    const state = history.state;
    if (state && typeof state.m === 'number') this.depth = state.m;
    else history.replaceState({ m: 0 }, '');
    this.renderOnline();
    if (App.apiKey) this.startUploads();
    this.route();
  },

  // ── Навигация ──────────────────────────────────────────────────────────
  route() {
    clearTimeout(this.pollTimer);
    this.revokePhotos();
    if (!App.apiKey) return this.show('login');
    const hash = location.hash || '#/';
    let m;
    if ((m = /^#\/inv\/(\d+)$/.exec(hash))) return this.showInvoice(Number(m[1]));
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
    for (const id of ['login', 'home', 'list', 'invoice']) this.$(`screen-${id}`).hidden = id !== name;
    this.$('m-back').hidden = name === 'login' || name === 'home';
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
    if (!App.apiKey || document.hidden) return;
    if (this.screen === 'home') this.loadHome();
    else if (this.screen === 'list') this.loadList(true);
    else if (this.screen === 'invoice' && this.invoice) this.loadInvoice(this.invoice.id);
  },

  schedulePoll(ms = 8000) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => this.refresh(), ms);
  },

  onClick(e) {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'camera') { this.closeShot(); this.$('m-camera-input').click(); }
    else if (action === 'gallery') this.$('m-gallery-input').click();
    else if (action === 'files') this.$('m-files-input').click();
    else if (action === 'shot-done') this.closeShot();
    else if (action === 'more') this.toggleMore(el);
    else if (action === 'install') this.install();
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
    if (open && panel.id === 'm-home-more') { this.renderInstall(); this.checkApk(); }
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
    this.$('m-shot').hidden = true;
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

  async onPicked(input, fromCamera) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    if (fromCamera) {
      // «Фото принято» — только если фото прочиталось и встало в очередь;
      // пустой файл (WebKit 319985) addFile отклоняет со своим сообщением.
      const before = Upload.history.length;
      await Upload.addFile(files[0]);
      if (Upload.history.length > before) this.$('m-shot').hidden = false;
    } else {
      // Пропущенные (формат, размер) _addMultiple называет сам — не затираем.
      const before = Upload.history.length;
      await Upload._addMultiple(files);
      const added = Upload.history.length - before;
      if (added === files.length) this.toast(`Добавлено: ${added} ${MobileCore.plural(added, 'файл', 'файла', 'файлов')}.`, 'green');
    }
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

  cardHtml(inv) {
    const state = MobileCore.invoiceState(inv);
    const meta = [inv.invoice_number ? `№ ${inv.invoice_number}` : '', MobileCore.formatShortDate(inv.invoice_date || inv.created_at)]
      .filter(Boolean).join(' · ');
    return `<a class="m-card" href="#/inv/${Number(inv.id)}">
      <span class="m-card__name">${App.esc(inv.supplier || 'Поставщик не прочитан')}</span>
      <span class="m-card__sum">${App.esc(MobileCore.formatMoney(inv.total_sum))}</span>
      <span class="m-pill m-pill--${state.tone}">${App.esc(state.label)}</span>
      <span class="m-card__meta">${App.esc(meta)}</span>
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
        <span class="m-pill m-pill--${state.tone} m-pill--big">${App.esc(state.label)}</span>
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
    const kind = this.installKind();
    this.$('m-install').hidden = kind === 'installed';
    if (kind === 'installed') this.$('m-install-help').hidden = true;
  },

  async install() {
    const help = this.$('m-install-help');
    if (this.installEvent) {
      this.installEvent.prompt();
      await this.installEvent.userChoice.catch(() => null);
      this.installEvent = null;
      this.renderInstall();
      return;
    }
    const kind = this.installKind();
    help.innerHTML = {
      ios: '<ol><li>Нажмите <b>Поделиться</b> <span aria-hidden="true">⬆︎</span> внизу экрана.</li><li>Выберите <b>На экран «Домой»</b>.</li></ol>',
      android: '<ol><li>Откройте меню браузера <b>⋮</b>.</li><li>Выберите <b>Установить приложение</b>.</li></ol>',
      other: '<p>Откройте <b>scanflow.ru/m</b> на телефоне.</p>',
    }[kind] || '';
    help.hidden = !help.innerHTML;
  },

  async checkApk() {
    const link = this.$('m-apk');
    if (this.installKind() !== 'android' || this._apkChecked) return;
    this._apkChecked = true;
    try {
      const res = await fetch('/downloads/scanflow.apk', { method: 'HEAD' });
      link.hidden = !res.ok;
    } catch { link.hidden = true; }
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
