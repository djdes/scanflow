/* global App */
const App = {
  apiKey: localStorage.getItem('apiKey') || '',
  baseUrl: '/api',

  async api(path, options = {}) {
    const headers = { 'X-API-Key': this.apiKey, ...options.headers };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(this.baseUrl + path, { ...options, headers });
    if (res.status === 401) {
      this.logout();
      throw new Error('Unauthorized');
    }
    return res;
  },

  async apiJson(path, options = {}) {
    const res = await this.api(path, options);
    return res.json();
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
      Invoices.showDetail(id);
    } else if (hash === '#/invoices' || hash === '#/' || hash === '') {
      document.getElementById('view-invoices').style.display = 'block';
      document.querySelector('nav a[data-tab="invoices"]').classList.add('active');
      Invoices.showList();
    } else if (hash === '#/upload') {
      document.getElementById('view-upload').style.display = 'block';
      document.querySelector('nav a[data-tab="upload"]').classList.add('active');
      Upload.init();
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

  async login(key) {
    if (!key) return;
    this.apiKey = key;
    localStorage.setItem('apiKey', key);
    try {
      const res = await this.api('/invoices/stats');
      if (!res.ok) { this.logout(); return; }
      document.getElementById('auth-screen').style.display = 'none';
      document.getElementById('app').style.display = 'block';
      this.route();
    } catch {
      this.logout();
      this.notify('API-ключ не принят', 'error');
    }
  },

  logout() {
    this.apiKey = '';
    localStorage.removeItem('apiKey');
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    document.getElementById('auth-key-input').value = '';
  },

  init() {
    window.addEventListener('hashchange', () => this.route());
    if (this.apiKey) {
      this.api('/invoices/stats').then(r => {
        if (r.ok) {
          document.getElementById('auth-screen').style.display = 'none';
          document.getElementById('app').style.display = 'block';
          this.route();
        } else {
          this.logout();
        }
      }).catch(() => this.logout());
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
