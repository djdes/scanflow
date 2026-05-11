/* ============================================================
   ScanFlow Landing — Interactions & Animations
   ============================================================ */

(function () {
  'use strict';

  // ========== Scroll Animations ==========

  const animElements = document.querySelectorAll('[data-animate]');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );

  animElements.forEach((el) => observer.observe(el));

  // ========== Header Scroll ==========

  const header = document.getElementById('site-header');
  let lastScroll = 0;

  window.addEventListener('scroll', () => {
    const scrollY = window.scrollY;
    if (scrollY > 40) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
    lastScroll = scrollY;
  }, { passive: true });

  // ========== Mobile Menu ==========

  const menuBtn = document.getElementById('mobile-menu-btn');
  const mainNav = document.getElementById('main-nav');
  const headerActions = document.querySelector('.header-actions');
  // Remember the actions' original parent + position so we can put it back
  // when the menu closes (or when viewport widens to desktop).
  const actionsHome = headerActions ? headerActions.parentElement : null;
  const actionsAnchor = headerActions ? headerActions.nextElementSibling : null;

  function moveActionsIntoNav() {
    if (!headerActions || !mainNav) return;
    if (headerActions.parentElement !== mainNav) mainNav.appendChild(headerActions);
  }
  function moveActionsBackToHeader() {
    if (!headerActions || !actionsHome) return;
    if (headerActions.parentElement !== actionsHome) {
      if (actionsAnchor && actionsAnchor.parentElement === actionsHome) {
        actionsHome.insertBefore(headerActions, actionsAnchor);
      } else {
        actionsHome.appendChild(headerActions);
      }
    }
  }

  function closeMobileMenu() {
    mainNav.classList.remove('open');
    if (menuBtn) menuBtn.classList.remove('active');
    moveActionsBackToHeader();
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      const opening = !mainNav.classList.contains('open');
      mainNav.classList.toggle('open');
      menuBtn.classList.toggle('active');
      if (opening) {
        moveActionsIntoNav();
      } else {
        moveActionsBackToHeader();
      }
    });

    // Close on any link tap inside the menu (nav links + action buttons)
    mainNav.addEventListener('click', (e) => {
      if (e.target.closest('a')) closeMobileMenu();
    });

    // If user resizes back to desktop while menu is open, restore layout.
    window.addEventListener('resize', () => {
      if (window.innerWidth > 768 && mainNav.classList.contains('open')) {
        closeMobileMenu();
      }
    });
  }

  // ========== Magnetic CTA ==========
  // Subtle cursor-follow on .btn-magnetic — translates the button toward the
  // pointer by ~12% of the offset from center. Disabled when the user prefers
  // reduced motion.
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced) {
    document.querySelectorAll('.btn-magnetic').forEach((btn) => {
      btn.addEventListener('mousemove', (e) => {
        const r = btn.getBoundingClientRect();
        const dx = (e.clientX - r.left - r.width / 2) * 0.18;
        const dy = (e.clientY - r.top - r.height / 2) * 0.28;
        btn.style.transform = `translate(${dx}px, ${dy}px)`;
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.transform = '';
      });
    });
  }

  // ========== FAQ Accordion ==========
  document.querySelectorAll('.faq-item').forEach((item) => {
    const trigger = item.querySelector('.faq-question');
    if (!trigger) return;
    trigger.addEventListener('click', () => {
      const expanded = item.classList.toggle('open');
      trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });
  });

  // ========== Counter Animation ==========

  function animateCounters() {
    const counters = document.querySelectorAll('[data-count]');
    counters.forEach((el) => {
      const target = parseFloat(el.dataset.count);
      const isFloat = target % 1 !== 0;
      const duration = 2000;
      const startTime = performance.now();

      function tick(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // easeOutExpo
        const eased = progress === 1 ? 1 : 1 - Math.pow(2, -10 * progress);
        const current = eased * target;

        if (isFloat) {
          el.textContent = current.toFixed(1);
        } else {
          el.textContent = Math.floor(current).toLocaleString('ru-RU');
        }

        if (progress < 1) {
          requestAnimationFrame(tick);
        }
      }

      requestAnimationFrame(tick);
    });
  }

  // Observe hero stats to trigger counter
  const heroStats = document.querySelector('.hero-stats');
  if (heroStats) {
    const statsObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          animateCounters();
          statsObserver.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    statsObserver.observe(heroStats);
  }

  // ========== Mindmap SVG Lines ==========

  function drawMindmapLines() {
    const svg = document.querySelector('.mindmap-lines');
    const container = document.querySelector('.mindmap');
    if (!svg || !container) return;

    const center = container.querySelector('[data-mm="center"]');
    const outputs = container.querySelectorAll('.mm-node--output');
    if (!center || !outputs.length) return;

    const containerRect = container.getBoundingClientRect();

    function getCenter(el) {
      const rect = el.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top + rect.height / 2 - containerRect.top,
      };
    }

    // Build SVG content
    let svgContent = `<defs>
      <linearGradient id="mm-line-grad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#3b82f6" stop-opacity="0.6"/>
        <stop offset="100%" stop-color="#06d6a0" stop-opacity="0.6"/>
      </linearGradient>
    </defs>`;

    const cPt = getCenter(center);

    outputs.forEach((node, i) => {
      const nPt = getCenter(node);
      const delay = 0.5 + i * 0.2;
      svgContent += `<line x1="${cPt.x}" y1="${cPt.y}" x2="${nPt.x}" y2="${nPt.y}"
        style="animation-delay:${delay}s" />`;
    });

    svg.innerHTML = svgContent;
  }

  // Draw after layout
  window.addEventListener('load', () => {
    setTimeout(drawMindmapLines, 300);
  });

  window.addEventListener('resize', () => {
    clearTimeout(window._mmResize);
    window._mmResize = setTimeout(drawMindmapLines, 200);
  });

  // ========== Demo Upload ==========

  const dropzone = document.getElementById('demo-dropzone');
  const fileInput = document.getElementById('demo-file-input');
  const btnUpload = document.getElementById('btn-upload');
  const idleState = document.getElementById('dropzone-idle');
  const processingState = document.getElementById('dropzone-processing');
  const stageText = document.getElementById('processing-stage');
  const resultEmpty = document.getElementById('result-empty');
  const resultData = document.getElementById('result-data');
  const resultFields = document.getElementById('result-fields');
  const resultItems = document.getElementById('result-items');
  const resultTotal = document.getElementById('result-total');
  const resultType = document.getElementById('result-type');

  if (dropzone && fileInput) {
    // Click to upload
    btnUpload.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    dropzone.addEventListener('click', () => {
      fileInput.click();
    });

    // Drag & drop
    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      if (files.length > 0) handleDemoUpload(files[0]);
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        handleDemoUpload(fileInput.files[0]);
      }
    });
  }

  function handleDemoUpload(file) {
    // Validate file type
    const validTypes = ['image/jpeg', 'image/png', 'image/bmp', 'image/tiff', 'image/webp'];
    if (!validTypes.includes(file.type)) {
      alert('Поддерживаются только изображения: JPG, PNG, BMP, TIFF, WEBP');
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      alert('Файл слишком большой. Максимум 20 МБ');
      return;
    }

    // Show processing
    idleState.style.display = 'none';
    processingState.style.display = 'flex';
    resultEmpty.style.display = 'flex';
    resultData.style.display = 'none';

    // Simulated processing stages
    const stages = [
      { text: 'Загрузка файла', delay: 500 },
      { text: 'Google Vision OCR', delay: 1200 },
      { text: 'Claude AI анализ', delay: 2000 },
      { text: 'Извлечение данных', delay: 1000 },
      { text: 'Готово!', delay: 500 },
    ];

    let delay = 0;
    stages.forEach((stage) => {
      delay += stage.delay;
      setTimeout(() => {
        stageText.textContent = stage.text;
      }, delay);
    });

    // Try real API call or fall back to mock
    const totalDelay = stages.reduce((s, st) => s + st.delay, 0);

    // Attempt real upload to /api/upload (demo endpoint)
    tryRealUpload(file).then((data) => {
      setTimeout(() => showResult(data), Math.max(0, totalDelay - 2000));
    }).catch(() => {
      // Fallback to mock result
      setTimeout(() => showResult(getMockResult(file.name)), totalDelay);
    });
  }

  async function tryRealUpload(file) {
    const formData = new FormData();
    formData.append('file', file);

    const resp = await fetch('/api/upload?demo=1', {
      method: 'POST',
      body: formData,
    });

    if (!resp.ok) throw new Error('API unavailable');
    return resp.json();
  }

  function getMockResult(fileName) {
    return {
      invoice_type: 'ТОРГ-12',
      invoice_number: 'ТРГ-2026/0412',
      invoice_date: '12.04.2026',
      supplier: 'ООО "Продукт Плюс"',
      supplier_inn: '7712345678',
      items: [
        { name: 'Молоко 3.2% 1л "Домик в деревне"', qty: 24, unit: 'шт', price: 89.90, total: 2157.60 },
        { name: 'Хлеб белый нарезной', qty: 15, unit: 'шт', price: 52.00, total: 780.00 },
        { name: 'Масло сливочное 82.5% 200г', qty: 10, unit: 'шт', price: 189.50, total: 1895.00 },
        { name: 'Сметана 20% 400г', qty: 12, unit: 'шт', price: 78.00, total: 936.00 },
      ],
      total_sum: 5768.60,
      vat_sum: 576.86,
    };
  }

  function showResult(data) {
    // Reset processing
    idleState.style.display = 'flex';
    processingState.style.display = 'none';
    resultEmpty.style.display = 'none';
    resultData.style.display = 'block';

    resultType.textContent = data.invoice_type || 'Накладная';

    // Fields
    resultFields.innerHTML = '';
    const fields = [
      { label: 'Номер', value: data.invoice_number },
      { label: 'Дата', value: data.invoice_date },
      { label: 'Поставщик', value: data.supplier },
      { label: 'ИНН', value: data.supplier_inn },
    ];

    fields.forEach((f) => {
      if (!f.value) return;
      const div = document.createElement('div');
      div.className = 'result-field';
      div.innerHTML = `<span class="result-field-label">${f.label}</span>
                        <span class="result-field-value">${f.value}</span>`;
      resultFields.appendChild(div);
    });

    // Items
    resultItems.innerHTML = '';
    const items = data.items || [];
    items.forEach((item) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${item.name || item.original_name || '—'}</td>
                      <td>${item.qty || item.quantity || ''} ${item.unit || ''}</td>
                      <td>${formatNum(item.price)} ₽</td>
                      <td>${formatNum(item.total)} ₽</td>`;
      resultItems.appendChild(tr);
    });

    // Total
    const total = data.total_sum || items.reduce((s, i) => s + (i.total || 0), 0);
    const vat = data.vat_sum;
    resultTotal.innerHTML = `<span>Итого: <strong>${formatNum(total)} ₽</strong>${vat ? ` (НДС: ${formatNum(vat)} ₽)` : ''}</span>`;
  }

  function formatNum(n) {
    if (n == null) return '—';
    return Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ========== Auth Form ==========

  const authForm = document.getElementById('auth-form');
  const authToggle = document.getElementById('auth-toggle-link');
  const authSubmit = document.getElementById('auth-submit');

  if (authToggle) {
    let isLogin = false;
    authToggle.addEventListener('click', (e) => {
      e.preventDefault();
      isLogin = !isLogin;
      authSubmit.textContent = isLogin ? 'Войти' : 'Создать аккаунт';
      authToggle.textContent = isLogin ? 'Зарегистрироваться' : 'Войти';
      authToggle.closest('.auth-toggle').firstChild.textContent =
        isLogin ? 'Нет аккаунта? ' : 'Уже есть аккаунт? ';
    });
  }

  if (authForm) {
    authForm.addEventListener('submit', (e) => {
      e.preventDefault();
      // Placeholder — will be connected to real auth later
      const email = document.getElementById('auth-email').value;
      if (!email) return;
      alert('Регистрация пока недоступна. Скоро подключим!');
    });
  }

  // ========== Smooth scroll for anchor links ==========

  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      // Bare "#" is used by interactive triggers (login button, toggles) —
      // don't try to scroll to it (querySelector('#') throws SyntaxError).
      if (!href || href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ========== Auth State (logged-in awareness across landing) ==========

  // Read once at startup, then re-read on storage events / after login.
  // Source of truth: localStorage.apiKey (same key the dashboard writes).
  function readApiKey() {
    return localStorage.getItem('apiKey') || '';
  }

  // Toggle every element marked with data-auth-state="in" / "out"
  // — hide the "wrong" ones, show the right ones. Also fills the username
  // hello-pill on the bottom CTA if present.
  function applyAuthState() {
    const authed = !!readApiKey();
    document.querySelectorAll('[data-auth-state]').forEach((el) => {
      const want = el.getAttribute('data-auth-state');
      const show = (want === 'in' && authed) || (want === 'out' && !authed);
      el.hidden = !show;
    });
    const userEl = document.getElementById('auth-cta-username');
    if (userEl) {
      const name = localStorage.getItem('adminUsername') || 'администратор';
      userEl.textContent = name;
    }
  }

  applyAuthState();

  // Cross-tab sync: if другой таб разлогинился — отрази здесь же.
  window.addEventListener('storage', (e) => {
    if (e.key === 'apiKey' || e.key === 'adminUsername') applyAuthState();
  });

  // Bottom CTA "Войти в кабинет" (logged-out variant) opens the modal.
  // The "Открыть кабинет" link is a plain anchor — no JS needed.
  const ctaLoginBtn = document.getElementById('auth-cta-login');
  if (ctaLoginBtn) {
    ctaLoginBtn.addEventListener('click', () => openLogin());
  }

  // Logout from the bottom CTA — clears creds and re-renders the CTA card.
  const ctaLogoutBtn = document.getElementById('auth-cta-logout');
  if (ctaLogoutBtn) {
    ctaLogoutBtn.addEventListener('click', () => {
      localStorage.removeItem('apiKey');
      localStorage.removeItem('adminUsername');
      applyAuthState();
    });
  }

  // ========== Login Modal ==========

  const loginModal = document.getElementById('login-modal');
  const loginOpenBtn = document.getElementById('btn-login-open');
  const loginForm = document.getElementById('login-form');
  const loginUsername = document.getElementById('login-username');
  const loginPassword = document.getElementById('login-password');
  const loginSubmit = document.getElementById('login-submit');
  const loginError = document.getElementById('login-error');

  function openLogin() {
    if (!loginModal) return;
    loginModal.classList.add('open');
    loginModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('login-open');
    const savedUser = localStorage.getItem('adminUsername');
    if (savedUser && loginUsername) loginUsername.value = savedUser;
    setTimeout(() => {
      const target = (loginUsername && !loginUsername.value) ? loginUsername : loginPassword;
      if (target) target.focus();
    }, 50);
    if (loginError) {
      loginError.hidden = true;
      loginError.textContent = '';
    }
  }

  function closeLogin() {
    if (!loginModal) return;
    loginModal.classList.remove('open');
    loginModal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('login-open');
  }

  if (loginOpenBtn) {
    loginOpenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openLogin();
    });
  }

  // Dashboard redirects un-authed users here with ?login=1 — auto-open модалку
  // и очистим query чтобы перезагрузка не дёргала её снова. Если пришли с
  // причиной (например «ключ устарел») — покажем её в модалке как hint.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === '1' && !readApiKey()) {
      const reason = params.get('reason');
      params.delete('login');
      params.delete('reason');
      const qs = params.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      setTimeout(() => {
        openLogin();
        if (reason && loginError) {
          loginError.textContent = reason;
          loginError.hidden = false;
        }
      }, 100);
    }
  } catch { /* URL API edge cases, не критично */ }

  // Close on backdrop / close-button / hint-link click
  document.querySelectorAll('[data-close-login]').forEach((el) => {
    el.addEventListener('click', (e) => {
      // Allow anchor-based hint link (#pricing) to scroll after closing
      closeLogin();
      if (el.tagName !== 'A') e.preventDefault();
    });
  });

  // Escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && loginModal && loginModal.classList.contains('open')) {
      closeLogin();
    }
  });

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = (loginUsername.value || '').trim();
      const password = loginPassword.value || '';
      if (!username || !password) return;

      loginSubmit.disabled = true;
      loginSubmit.textContent = 'Проверяем…';
      loginError.hidden = true;

      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401) {
          loginError.textContent = data.error || 'Неверный логин или пароль.';
          loginError.hidden = false;
          return;
        }
        if (!resp.ok || !data.apiKey) {
          loginError.textContent = data.error || `Сервер вернул ошибку (${resp.status}).`;
          loginError.hidden = false;
          return;
        }
        localStorage.setItem('apiKey', data.apiKey);
        localStorage.setItem('adminUsername', username);
        applyAuthState();
        window.location.href = '/app.html';
      } catch (err) {
        loginError.textContent = 'Не удалось связаться с сервером. Проверьте интернет.';
        loginError.hidden = false;
      } finally {
        loginSubmit.disabled = false;
        loginSubmit.textContent = 'Войти';
      }
    });
  }

  // ========== Theme Switcher (segmented pill: Светлая · По времени дня · Тёмная) ==========
  // Storage key 'sf-theme' holds one of: 'light' | 'dark' | 'auto' (or absent = auto).
  // Anti-FOUC script in <head> reads the same key before paint.
  (function setupThemeSwitcher() {
    const KEY = 'sf-theme';
    const root = document.documentElement;
    const switcher = document.getElementById('theme-switcher');
    if (!switcher) return;
    const opts = Array.from(switcher.querySelectorAll('.theme-opt'));
    if (opts.length === 0) return;

    function readMode() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
        // Legacy {value, ts} payload from earlier builds — migrate once.
        if (raw && raw.charAt(0) === '{') {
          const saved = JSON.parse(raw);
          if (saved && (saved.value === 'light' || saved.value === 'dark')) {
            localStorage.setItem(KEY, saved.value);
            return saved.value;
          }
        }
      } catch (_) { /* ignore */ }
      return 'auto';
    }

    function resolveAuto() {
      const h = new Date().getHours();
      if (h >= 7 && h < 19) return 'light';
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
      return 'dark';
    }

    function applyMode(mode) {
      const resolved = (mode === 'auto') ? resolveAuto() : mode;
      root.setAttribute('data-theme', resolved);
      root.setAttribute('data-theme-mode', mode);
      switcher.setAttribute('data-mode', mode);
      opts.forEach((btn) => {
        btn.setAttribute('aria-checked', btn.dataset.mode === mode ? 'true' : 'false');
        btn.tabIndex = (btn.dataset.mode === mode) ? 0 : -1;
      });
    }

    function setMode(mode) {
      try {
        if (mode === 'auto') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, mode);
      } catch (_) { /* private mode — best effort */ }
      applyMode(mode);
    }

    opts.forEach((btn) => {
      btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // ArrowLeft/ArrowRight cycles through segments, focuses the new one, applies its mode.
    switcher.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const currentIdx = opts.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const delta = e.key === 'ArrowLeft' ? -1 : 1;
      const nextIdx = (currentIdx + delta + opts.length) % opts.length;
      const next = opts[nextIdx];
      setMode(next.dataset.mode);
      next.focus();
    });

    // Initial state — reflects whatever the anti-FOUC script applied.
    applyMode(readMode());

    // Re-evaluate auto theme every 60s. Same as previous build.
    setInterval(() => {
      if (readMode() === 'auto') applyMode('auto');
    }, 60 * 1000);
  })();

  // ========== LLM Mapping Demo (interactive before/after) ==========

  (function initMappingDemo() {
    const demo = document.getElementById('mapping-demo');
    if (!demo) return;
    const cta = document.getElementById('mapping-cta');
    const counterEl = document.getElementById('mapping-counter-num');
    const rows = Array.from(demo.querySelectorAll('.mapping-demo__row:not(.mapping-demo__row--head)'));
    const total = rows.length;
    const initiallyMatched = rows.filter((r) => r.dataset.matched === '1').length;

    let animating = false;

    function reset() {
      demo.classList.remove('is-matched', 'is-running');
      rows.forEach((r, i) => {
        // первая строка стартует уже сопоставленной — это нормально, fuzzy сработал.
        // 0-я row (index) — это первая позиция; ее матч-статус определяется data-matched в HTML.
        // Здесь восстанавливаем оригинальное состояние.
        const original = r.getAttribute('data-original-matched') ?? r.dataset.matched;
        r.dataset.matched = original;
      });
      counterEl.textContent = String(initiallyMatched);
      const label = cta.querySelector('.mapping-demo__cta-label');
      if (label) label.textContent = 'LLM-маппинг';
    }

    // Сохраняем исходное значение data-matched чтобы можно было сбросить демо после реплея.
    rows.forEach((r) => r.setAttribute('data-original-matched', r.dataset.matched));

    function runDemo() {
      if (animating) return;
      animating = true;

      // Если уже сопоставлено — это replay: сбрасываем, ждём один кадр, запускаем заново.
      if (demo.classList.contains('is-matched')) {
        reset();
        // Force reflow so the transitions replay cleanly.
        void demo.offsetWidth;
      }

      demo.classList.add('is-running');

      // Стадия 1: «обращение к LLM» — 700 мс показываем спиннер
      setTimeout(() => {
        demo.classList.remove('is-running');
        demo.classList.add('is-matched');

        // Стадия 2: строки переключаются последовательно (волной), счётчик растёт
        const stagger = 120;
        let matched = initiallyMatched;
        counterEl.textContent = String(matched);

        rows.forEach((r) => {
          if (r.dataset.matched === '1') return; // уже было сопоставлено
          setTimeout(() => {
            r.dataset.matched = '1';
            matched += 1;
            counterEl.textContent = String(matched);
          }, matched * stagger - initiallyMatched * stagger);
        });

        // По завершении: смена надписи кнопки + разблокировка
        setTimeout(() => {
          const label = cta.querySelector('.mapping-demo__cta-label');
          if (label) label.textContent = 'Сопоставлено · повторить';
          animating = false;
        }, (total - initiallyMatched) * stagger + 400);
      }, 700);
    }

    cta.addEventListener('click', runDemo);

    // Авто-запуск один раз когда блок попадает во вьюпорт — чтобы пользователь
    // увидел «магию» без необходимости куда-то жать. Запоминаем что уже играли,
    // чтобы скролл туда-сюда не дёргал заново.
    let autoplayed = false;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || autoplayed) return;
        autoplayed = true;
        io.unobserve(entry.target);
        // Дать секцию рассмотреть в исходном виде, потом запустить.
        setTimeout(runDemo, 900);
      });
    }, { threshold: 0.35 });
    io.observe(demo);
  })();

})();
