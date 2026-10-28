/* global App */
// API key persists in localStorage so the user doesn't have to re-enter it
// after closing the tab (critical for mobile, where the OS regularly kills
// background tabs). Session-scoped storage was too aggressive for an internal
// back-office tool — users complained about having to log in each visit.
// Previous sessionStorage values are still read as a fallback during the
// transition period.
const App = {
  apiKey: localStorage.getItem('apiKey')
    || sessionStorage.getItem('apiKey')
    || '',
  baseUrl: '/api',
  _activeRequests: 0,

  /**
   * Escape arbitrary text for safe insertion into innerHTML.
   * Use for ANY value coming from the server — supplier names, OCR text,
   * filenames, error messages. Never bypass this for user/OCR-sourced data.
   */
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  /**
   * Top progress bar — reference-counted so concurrent requests don't
   * flicker the bar off early. Auto-wraps all fetches made via App.api().
   */
  _progressStart() {
    this._activeRequests++;
    const el = document.getElementById('top-progress');
    if (el) el.classList.add('is-active');
  },
  _progressStop() {
    this._activeRequests = Math.max(0, this._activeRequests - 1);
    if (this._activeRequests === 0) {
      const el = document.getElementById('top-progress');
      if (el) el.classList.remove('is-active');
    }
  },

  /**
   * Render skeleton rows into a tbody while real data is fetching.
   * Callers pass columns as widths (e.g. ['w-24', 'w-80', 'w-60']).
   */
  skeletonRows(tbodyId, columnWidths, rowCount = 5) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const row = `<tr class="skeleton-row">${columnWidths.map(w =>
      `<td><span class="skeleton-bar ${w}"></span></td>`
    ).join('')}</tr>`;
    tbody.innerHTML = row.repeat(rowCount);
  },

  async api(path, options = {}) {
    const headers = { 'X-API-Key': this.apiKey, ...options.headers };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    this._progressStart();
    try {
      const res = await fetch(this.baseUrl + path, { ...options, headers });
      if (res.status === 401) {
        // 401 = ключ устарел/удалён. Уходим на лендинг, там единая форма входа.
        this.logout('API-ключ не принят. Войдите ещё раз.');
        throw new Error('Unauthorized');
      }
      return res;
    } finally {
      this._progressStop();
    }
  },

  async apiJson(path, options = {}) {
    const res = await this.api(path, options);
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = body && body.error ? body.error : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  },

  navigate(hash) {
    window.location.hash = hash;
  },

  // Keep the current page visible in the left navigation.
  activateNavTab(tab) {
    const links = document.querySelectorAll(`#app-primary-nav a[data-tab="${tab}"]`);
    links.forEach((link) => {
      link.classList.add('active');
      link.setAttribute('aria-current', 'page');
    });
  },

  setNavigationOpen(open) {
    const sidebar = document.getElementById('app-sidebar');
    const toggle = document.getElementById('nav-toggle');
    const mobile = window.matchMedia('(max-width: 900px)').matches;
    const expanded = mobile && open;
    if (!expanded && sidebar?.contains(document.activeElement) && mobile) toggle?.focus();
    sidebar?.classList.toggle('is-open', expanded);
    if (sidebar) sidebar.inert = mobile && !expanded;
    toggle?.setAttribute('aria-expanded', String(expanded));
    toggle?.setAttribute('aria-label', expanded ? 'Закрыть меню' : 'Открыть меню');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (backdrop) backdrop.hidden = !expanded;
    document.body.classList.toggle('sidebar-open', expanded);
    const main = document.getElementById('app-main');
    if (main) main.inert = expanded;
    if (expanded) (sidebar?.querySelector('a[aria-current="page"]') || sidebar?.querySelector('a'))?.focus();
  },

  route() {
    if (typeof InvoicePhotoViewer !== 'undefined') InvoicePhotoViewer.close();
    const hash = (window.location.hash || '#/invoices').split('?')[0];
    if (typeof UnitCost !== 'undefined') UnitCost.stopFeed();
    if (typeof InvoiceReview !== 'undefined' && !/^#\/invoices\/\d+$/.test(hash)) InvoiceReview.leave();
    if (typeof InvoiceCard !== 'undefined') InvoiceCard.closeMenu();
    // Close the mobile nav drawer on every navigation.
    this.setNavigationOpen(false);
    // Hide all sections
    document.querySelectorAll('main > section').forEach(s => s.style.display = 'none');

    // Страницы накладных (список и карточка) — «широкие»: там таблицы на 10
    // колонок, и в общие 1200px они не влезали, хотя справа пустовало место.
    // Остальные страницы (настройки, профиль, формы) остаются узкими, иначе
    // строки формы растягиваются на весь экран и хуже читаются.
    // Ширину даёт CSS-класс, а не расчёт от 100vw: 100vw включает полосу
    // прокрутки, и блок вылезал бы за экран, добавляя горизонтальный скролл.
    const wideRoute = !hash || hash === '#/' || hash.startsWith('#/invoices') || hash === '#/queue' || hash.startsWith('#/analytics');
    document.getElementById('app-main')?.classList.toggle('main--wide', wideRoute);
    // Remove active tab
    document.querySelectorAll('nav a').forEach((a) => {
      a.classList.remove('active');
      a.removeAttribute('aria-current');
    });

    // Onboarding banner — пересчитываем на каждой навигации. JS внутри сам
    // решает показывать или скрывать в зависимости от текущего hash и состояния.
    if (window.Onboarding) {
      Onboarding.renderBanner(hash).catch(() => { /* swallow */ });
    }

    // Spotlight: если в localStorage стоит hint от wizard'а, подсветить
    // нужный элемент на целевой странице. apply() сам разберётся показывать
    // или нет (зависит от текущего hash + наличия таргета).
    if (window.OnboardingHint) {
      OnboardingHint.apply(hash);
    }

    if (hash.startsWith('#/invoices/')) {
      document.getElementById('view-invoices').style.display = 'block';
      this.activateNavTab('invoices');
      const id = parseInt(hash.split('/')[2]);
      if (!Number.isFinite(id) || id <= 0) {
        this.notify('Некорректный ID накладной', 'error');
        this.navigate('#/invoices');
        return;
      }
      Invoices.showDetail(id);
    } else if (hash === '#/invoices' || hash === '#/' || hash === '') {
      document.getElementById('view-invoices').style.display = 'block';
      this.activateNavTab('invoices');
      Invoices.showList();
    } else if (hash === '#/upload') {
      document.getElementById('view-upload').style.display = 'block';
      this.activateNavTab('upload');
      Upload.init();
    } else if (hash === '#/onboarding') {
      document.getElementById('view-onboarding').style.display = 'block';
      if (window.Onboarding) Onboarding.show();
    } else if (hash === '#/camera') {
      // Legacy bookmark — редирект на объединённую страницу /#/upload
      this.navigate('#/upload');
      return;
    } else if (hash === '#/mappings') {
      document.getElementById('view-mappings').style.display = 'block';
      this.activateNavTab('mappings');
      Mappings.load();
    } else if (hash === '#/new-items') {
      document.getElementById('view-new-items').style.display = 'block';
      this.activateNavTab('new-items');
      NewItems.load();
    } else if (hash === '#/queue') {
      document.getElementById('view-queue').style.display = 'block';
      this.activateNavTab('queue');
      Queue.load();
    } else if (hash.startsWith('#/analytics/quality')) {
      // Аналитика (п.7): качество накладных по поставщикам.
      document.getElementById('view-analytics-quality').style.display = 'block';
      this.activateNavTab('analytics-quality');
      Analytics.loadQuality();
    } else if (hash.startsWith('#/analytics/prices')) {
      // Аналитика (п.11): закупочные цены; позиция — #/analytics/prices/<guid>.
      document.getElementById('view-analytics-prices').style.display = 'block';
      this.activateNavTab('analytics-prices');
      Analytics.loadPrices(hash);
    } else if (hash === '#/suppliers') {
      document.getElementById('view-suppliers').style.display = 'block';
      this.activateNavTab('suppliers');
      Suppliers.load();
    } else if (hash === '#/learning') {
      document.getElementById('view-learning').style.display = 'block';
      this.activateNavTab('learning');
      Learning.load();
    } else if (hash.startsWith('#/sber')) {
      document.getElementById('view-sber').style.display = 'block';
      this.activateNavTab('sber');
      Sber.load();
    } else if (hash === '#/integrations-log') {
      document.getElementById('view-integrations-log').style.display = 'block';
      this.activateNavTab('integrations-log');
      IntegrationsLog.load();
    } else if (hash === '#/operations') {
      document.getElementById('view-operations').style.display = 'block';
      this.activateNavTab('operations');
      Operations.load();
    } else if (hash === '#/settings') {
      document.getElementById('view-settings').style.display = 'block';
      this.activateNavTab('settings');
      Settings.load();
    } else if (hash === '#/billing' || hash.startsWith('#/billing?')) {
      document.getElementById('view-billing').style.display = 'block';
      this.activateNavTab('billing');
      Billing.load();
    } else if (hash === '#/profile') {
      document.getElementById('view-profile').style.display = 'block';
      this.activateNavTab('profile');
      Profile.init();
    } else {
      document.getElementById('view-invoices').style.display = 'block';
      this.activateNavTab('invoices');
      Invoices.showList();
    }
  },

  // Крутит спиннер на кнопке, пока не вернётся ОТВЕТ СЕРВЕРА, а не просто до
  // конца обработчика клика. Долгие действия («Пересканировать фото» на плотной
  // накладной — 2-3 минуты) раньше никак не отзывались: _withGuard глушил
  // повторные клики, но человек не понимал, нажалось ли вообще.
  //
  // `el` — сама кнопка или что-то внутри неё (передаём `event.currentTarget`
  // из inline-обработчика). Если кнопки нет — просто выполняем работу.
  async withBusyButton(el, fn) {
    const btn = el && el.closest ? el.closest('button') : null;
    if (!btn) return fn();
    const prevHtml = btn.innerHTML;
    const prevDisabled = btn.disabled;
    const prevWidth = btn.style.minWidth;
    // Фиксируем ширину: иначе кнопка схлопнется под размер спиннера и соседние
    // кнопки в ряду прыгнут.
    btn.style.minWidth = `${Math.round(btn.getBoundingClientRect().width)}px`;
    btn.disabled = true;
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span><span class="sr-only">Выполняется…</span>';
    try {
      return await fn();
    } finally {
      // Многие действия в конце перерисовывают карточку, и эта кнопка к моменту
      // восстановления уже вне DOM — тогда операции просто уходят в никуда,
      // ошибки не будет. Восстанавливаем в любом случае: если узел жив (действие
      // упало с ошибкой), пользователь должен получить рабочую кнопку обратно.
      btn.classList.remove('is-busy');
      btn.removeAttribute('aria-busy');
      btn.innerHTML = prevHtml;
      btn.disabled = prevDisabled;
      btn.style.minWidth = prevWidth;
    }
  },

  notify(message, type = 'info') {
    const container = document.getElementById('notifications');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 4000);
  },

  // Logout — clears creds, sends user back to the landing page where the
  // unified login form lives. Optional reason is shown via ?login=1&reason=...
  // No-op kept for compatibility with the on-page "Выйти" button.
  logout(reason) {
    this.apiKey = '';
    localStorage.removeItem('apiKey');
    sessionStorage.removeItem('apiKey');
    localStorage.removeItem('adminRole');
    sessionStorage.removeItem('adminRole');
    localStorage.removeItem('superadminSession');
    // adminUsername оставляем — пригодится для prefill в форме входа.
    const params = new URLSearchParams({ login: '1' });
    if (reason) params.set('reason', reason);
    window.location.replace('/?' + params.toString());
  },

  async impersonateUser(userId) {
    try {
      const res = await this.api(`/users/${Number(userId)}/impersonate`, { method: 'POST' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload.data || !payload.data.apiKey) {
        this.notify(payload.error || 'Не удалось войти в аккаунт пользователя', 'error');
        return;
      }
      const target = payload.data;
      if (!localStorage.getItem('superadminSession')) {
        localStorage.setItem('superadminSession', JSON.stringify({
          apiKey: this.apiKey,
          username: localStorage.getItem('adminUsername') || 'admin',
          role: localStorage.getItem('adminRole') || 'admin',
        }));
      }
      this.apiKey = target.apiKey;
      localStorage.setItem('apiKey', target.apiKey);
      localStorage.setItem('adminUsername', target.username || '');
      localStorage.setItem('adminRole', target.role || 'user');
      window.location.hash = '#/invoices';
      window.location.reload();
    } catch (e) {
      this.notify('Ошибка: ' + e.message, 'error');
    }
  },

  exitImpersonation() {
    try {
      const raw = localStorage.getItem('superadminSession');
      if (!raw) return;
      const saved = JSON.parse(raw);
      localStorage.removeItem('superadminSession');
      if (saved && saved.apiKey) {
        this.apiKey = saved.apiKey;
        localStorage.setItem('apiKey', saved.apiKey);
        localStorage.setItem('adminUsername', saved.username || 'admin');
        localStorage.setItem('adminRole', saved.role || 'admin');
        window.location.hash = '#/settings';
        window.location.reload();
      }
    } catch (e) {
      localStorage.removeItem('superadminSession');
      window.location.reload();
    }
  },

  renderImpersonationBanner() {
    const existing = document.getElementById('impersonation-banner');
    if (existing) existing.remove();
    const raw = localStorage.getItem('superadminSession');
    if (!raw) return;
    let saved = null;
    try { saved = JSON.parse(raw); } catch { return; }
    if (!saved || !saved.apiKey) return;
    const main = document.getElementById('app-main');
    if (!main) return;
    const currentUsername = localStorage.getItem('adminUsername') || 'пользователь';
    const bar = document.createElement('div');
    bar.id = 'impersonation-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 16px;margin-bottom:16px;border-radius:10px;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.4);color:var(--text-primary);font-size:14px;';
    bar.innerHTML = `<span>👁 Вы просматриваете кабинет от лица аккаунта <strong>${this.esc(currentUsername)}</strong> (вход из суперадмина <strong>${this.esc(saved.username || 'admin')}</strong>)</span>`
      + `<button type="button" class="btn btn-outline btn-sm" onclick="App.exitImpersonation()">← Вернуться в суперадмин</button>`;
    main.prepend(bar);
  },

  init() {
    this.renderImpersonationBanner();
    window.addEventListener('hashchange', () => this.route());

    // The left panel becomes a dismissible drawer on phones and tablets.
    const navToggle = document.getElementById('nav-toggle');
    const sidebar = document.getElementById('app-sidebar');
    if (navToggle && sidebar) {
      navToggle.addEventListener('click', () => {
        this.setNavigationOpen(!sidebar.classList.contains('is-open'));
      });
      document.getElementById('sidebar-backdrop')?.addEventListener('click', () => this.setNavigationOpen(false));
      document.getElementById('sidebar-close')?.addEventListener('click', () => this.setNavigationOpen(false));
      sidebar.addEventListener('click', (event) => {
        if (event.target.closest('a[href]')) this.setNavigationOpen(false);
      });
      window.matchMedia('(max-width: 900px)').addEventListener('change', () => this.setNavigationOpen(false));
      document.addEventListener('keydown', (event) => {
        if (!sidebar.classList.contains('is-open')) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          this.setNavigationOpen(false);
        } else if (event.key === 'Tab') {
          const items = sidebar.querySelectorAll('a[href], button:not([disabled])');
          const first = items[0];
          const last = items[items.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      });
      this.setNavigationOpen(false);
    }

    // Fast, discoverable keyboard search on the primary work screen.
    // Slash focuses the invoice search; Escape clears it, then releases focus.
    document.addEventListener('keydown', (event) => {
      const search = document.getElementById('invoices-search');
      if (!search) return;
      const target = event.target;
      const isEditing = target instanceof HTMLElement
        && (target.matches('input, textarea, select') || target.isContentEditable);

      const hash = window.location.hash;
      const isInvoiceList = hash === '' || hash === '#/' || hash === '#/invoices';

      if (event.key === '/' && !isEditing && isInvoiceList) {
        event.preventDefault();
        search.focus();
        search.select();
      } else if (event.key === 'Escape' && document.activeElement === search) {
        if (search.value) {
          search.value = '';
          search.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          search.blur();
        }
      }
    });

    if (this.apiKey) {
      // Optimistic: render the app immediately. If the stored key is invalid
      // the very next API call will 401 and api() will redirect to /?login=1.
      const appEl = document.getElementById('app');
      if (appEl) appEl.style.display = 'block';
      if (typeof Upload !== 'undefined') Upload.init();
      if (typeof RecognitionQueue !== 'undefined') RecognitionQueue.refresh();
      this.route();
      // Onboarding gate: для новых аккаунтов без накладных и без подключённого
      // Сбера перевести на #/onboarding. У существующих пользователей с
      // данными shouldShow() сам поставит флаг «done» и больше не дёргает.
      const hash = window.location.hash || '';
      const inWizard = hash.startsWith('#/onboarding');
      const onListOrEmpty = !hash || hash === '#/' || hash === '#/invoices';
      if (window.Onboarding && !inWizard && onListOrEmpty) {
        Onboarding.shouldShow().then((show) => {
          if (show) this.navigate('#/onboarding');
        });
      }
    } else {
      // No api-key — uniformly bounce to the landing's login flow.
      window.location.replace('/?login=1');
    }
  },

  formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('ru-RU');
    } catch { return dateStr; }
  },

  // Date + time, ru-RU (DD.MM.YYYY, HH:MM). MariaDB returns "YYYY-MM-DD HH:MM:SS"
  // (dateStrings:true) — normalise the space to 'T' so Safari/iOS parses it too.
  formatDateTime(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(String(dateStr).replace(' ', 'T'));
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch { return dateStr; }
  },

  // Human-friendly elapsed time between two date strings ("42 сек", "1 мин 5 сек").
  // Returns '' when either bound is missing or the delta is negative/non-finite.
  formatDuration(fromStr, toStr) {
    if (!fromStr || !toStr) return '';
    const ms = new Date(String(toStr).replace(' ', 'T')) - new Date(String(fromStr).replace(' ', 'T'));
    if (!isFinite(ms) || ms < 0) return '';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + ' сек';
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem ? `${min} мин ${rem} сек` : `${min} мин`;
  },

  formatMoney(val) {
    if (val == null) return '—';
    return Number(val).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  // Quantity: up to 3 decimals, drop trailing zeros. Avoids IEEE-754 noise
  // like "6.300000000000001" while preserving "0.125" or "1.5".
  formatQty(val) {
    if (val == null) return '—';
    const n = Number(val);
    if (!isFinite(n)) return '—';
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 3 });
  },

  statusLabel(status) {
    const map = {
      'new': 'Новый',
      'ocr_processing': 'OCR...',
      'parsing': 'Парсинг...',
      'processed': 'Обработан',
      'sent_to_1c': 'Отправлен',
      'error': 'Ошибка',
      'waiting_ai': 'Ждёт GPT'
    };
    return map[status] || status;
  },

  statusBadge(status) {
    const cls = {
      'new': 'badge-new',
      'ocr_processing': 'badge-processing',
      'parsing': 'badge-processing',
      'waiting_ai': 'badge-processing',
      'processed': 'badge-processed',
      'sent_to_1c': 'badge-sent',
      'error': 'badge-error'
    };
    return `<span class="badge ${cls[status] || 'badge-new'}">${this.esc(this.statusLabel(status))}</span>`;
  },

  confidenceBadge(val) {
    if (val >= 0.8) return '<span class="badge badge-confidence-high">Точное</span>';
    if (val >= 0.5) return `<span class="badge badge-confidence-medium">${Math.round(val * 100)}%</span>`;
    return '<span class="badge badge-confidence-low">Не найдено</span>';
  },

  // Накладная из электронного документа ФНС (УПД/ТОРГ-12 в XML, src/xml):
  // по движку, а пока он не записан — по имени файла.
  isXmlInvoice(inv) {
    if (!inv) return false;
    if (String(inv.ocr_engine || '').startsWith('xml_')) return true;
    return String(inv.file_name || '').split(',').some(f => /\.xml$/i.test(f.trim()));
  },

  ocrEngineBadge(engine) {
    if (!engine) return '<span class="badge badge-new">—</span>';
    if (engine.startsWith('xml_')) {
      return '<span class="badge badge-processed" title="Электронный документ из ЭДО — без распознавания">XML из ЭДО</span>';
    }
    const parts = [];
    const e = engine.toLowerCase();
    if (e.includes('google_vision')) parts.push('Google Vision');
    if (e.includes('tesseract')) parts.push('Tesseract');
    if (e.includes('claude_api')) parts.push('API');
    else if (e.includes('gpt_api')) parts.push('GPT');
    else if (e.includes('claude_analyzer') || e === 'claude_cli') parts.push('MAX');
    const isMultipage = e.includes('multipage');
    const label = parts.join(' + ') + (isMultipage ? ' (multi)' : '');
    const cls = (e.includes('claude_api') || e.includes('gpt_api')) ? 'badge-sent' : e.includes('claude_analyzer') ? 'badge-processed' : 'badge-processing';
    return `<span class="badge ${cls}" title="${this.esc(engine)}">${this.esc(label)}</span>`;
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
