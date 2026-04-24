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
        this.logout();
        this.notify('API-ключ не принят. Введите его снова.', 'error');
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

  route() {
    const hash = window.location.hash || '#/invoices';
    // Hide all sections
    document.querySelectorAll('main > section').forEach(s => s.style.display = 'none');
    // Remove active tab
    document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));

    if (hash.startsWith('#/invoices/')) {
      document.getElementById('view-invoices').style.display = 'block';
      document.querySelector('nav a[data-tab="invoices"]').classList.add('active');
      const id = parseInt(hash.split('/')[2]);
      if (!Number.isFinite(id) || id <= 0) {
        this.notify('Некорректный ID накладной', 'error');
        this.navigate('#/invoices');
        return;
      }
      Invoices.showDetail(id);
    } else if (hash === '#/invoices' || hash === '#/' || hash === '') {
      document.getElementById('view-invoices').style.display = 'block';
      document.querySelector('nav a[data-tab="invoices"]').classList.add('active');
      Invoices.showList();
    } else if (hash === '#/upload') {
      document.getElementById('view-upload').style.display = 'block';
      document.querySelector('nav a[data-tab="upload"]').classList.add('active');
      Upload.init();
    } else if (hash === '#/camera') {
      document.getElementById('view-camera').style.display = 'block';
      document.querySelector('nav a[data-tab="camera"]').classList.add('active');
      Camera.init();
    } else if (hash === '#/mappings') {
      document.getElementById('view-mappings').style.display = 'block';
      document.querySelector('nav a[data-tab="mappings"]').classList.add('active');
      Mappings.load();
    } else if (hash === '#/webhook') {
      document.getElementById('view-webhook').style.display = 'block';
      document.querySelector('nav a[data-tab="webhook"]').classList.add('active');
      Webhook.load();
    } else if (hash === '#/settings') {
      document.getElementById('view-settings').style.display = 'block';
      document.querySelector('nav a[data-tab="settings"]').classList.add('active');
      Settings.load();
    } else {
      document.getElementById('view-invoices').style.display = 'block';
      document.querySelector('nav a[data-tab="invoices"]').classList.add('active');
      Invoices.showList();
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

  // Exchange admin username/password for the server's API key via /api/auth/login.
  // The API key is still the real auth mechanism — login is just a UX wrapper
  // so users don't have to paste a raw key.
  async login(username, password) {
    if (!username || !password) return;
    const errEl = document.getElementById('auth-error');
    const btn = document.getElementById('auth-btn');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch(this.baseUrl + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.apiKey) {
        if (errEl) {
          errEl.textContent = data.error || `Ошибка входа (${resp.status})`;
          errEl.hidden = false;
        }
        return;
      }
      this.apiKey = data.apiKey;
      localStorage.setItem('apiKey', data.apiKey);
      localStorage.setItem('adminUsername', username);
      sessionStorage.removeItem('apiKey'); // clear any legacy session copy
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      this.route();
    } catch (err) {
      if (errEl) {
        errEl.textContent = 'Не удалось связаться с сервером';
        errEl.hidden = false;
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  logout() {
    this.apiKey = '';
    localStorage.removeItem('apiKey');
    sessionStorage.removeItem('apiKey');
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    const pw = document.getElementById('auth-password-input');
    if (pw) pw.value = '';
    const errEl = document.getElementById('auth-error');
    if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
  },

  init() {
    window.addEventListener('hashchange', () => this.route());

    const form = document.getElementById('auth-form');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const u = document.getElementById('auth-username-input').value.trim();
        const p = document.getElementById('auth-password-input').value;
        this.login(u, p);
      });
      const savedUser = localStorage.getItem('adminUsername');
      const userInput = document.getElementById('auth-username-input');
      if (savedUser && userInput) userInput.value = savedUser;
    }

    if (this.apiKey) {
      // Optimistic: render the app immediately. If the stored key is invalid
      // the very next API call will 401 and api() will log the user out.
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      this.route();
    } else {
      const focusTarget = localStorage.getItem('adminUsername')
        ? document.getElementById('auth-password-input')
        : document.getElementById('auth-username-input');
      if (focusTarget) setTimeout(() => focusTarget.focus(), 50);
    }
  },

  formatDate(dateStr) {
    if (!dateStr) return '—';
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('ru-RU');
    } catch { return dateStr; }
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
      'error': 'Ошибка'
    };
    return map[status] || status;
  },

  statusBadge(status) {
    const cls = {
      'new': 'badge-new',
      'ocr_processing': 'badge-processing',
      'parsing': 'badge-processing',
      'processed': 'badge-processed',
      'sent_to_1c': 'badge-sent',
      'error': 'badge-error'
    };
    return `<span class="badge ${cls[status] || 'badge-new'}">${this.statusLabel(status)}</span>`;
  },

  confidenceBadge(val) {
    if (val >= 0.8) return '<span class="badge badge-confidence-high">Точное</span>';
    if (val >= 0.5) return `<span class="badge badge-confidence-medium">${Math.round(val * 100)}%</span>`;
    return '<span class="badge badge-confidence-low">Не найдено</span>';
  },

  ocrEngineBadge(engine) {
    if (!engine) return '<span class="badge badge-new">—</span>';
    const parts = [];
    const e = engine.toLowerCase();
    if (e.includes('google_vision')) parts.push('Google Vision');
    if (e.includes('tesseract')) parts.push('Tesseract');
    if (e.includes('claude_api')) parts.push('API');
    else if (e.includes('claude_analyzer') || e === 'claude_cli') parts.push('MAX');
    const isMultipage = e.includes('multipage');
    const label = parts.join(' + ') + (isMultipage ? ' (multi)' : '');
    const cls = e.includes('claude_api') ? 'badge-sent' : e.includes('claude_analyzer') ? 'badge-processed' : 'badge-processing';
    return `<span class="badge ${cls}" title="${engine}">${label}</span>`;
  }
};

document.addEventListener('DOMContentLoaded', () => App.init());
