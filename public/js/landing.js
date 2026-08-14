/* ============================================================
   ScanFlow Landing — Interactions & Animations
   ============================================================ */

(function () {
  'use strict';

  // ========== Спасение старых ссылок из бота ==========
  // Уведомления долго рассылали ссылки вида scanflow.ru/#/invoices/704 — то
  // есть на КОРЕНЬ, где лежит лендинг, а не на кабинет (/app.html). Такие
  // сообщения уже разошлись по чатам и почте, и переписать их нельзя.
  // Поэтому здесь: пришли на лендинг с хеш-маршрутом кабинета — молча
  // переправляем в кабинет, сохраняя маршрут.
  //
  // Только маршруты вида «#/что-то»: якоря лендинга (#try, #pricing) не
  // трогаем, иначе сломается навигация по самой странице.
  // replace(), а не assign() — чтобы кнопка «назад» не возвращала сюда же
  // и не устраивала петлю.
  (function rescueAppHashRoutes() {
    var hash = window.location.hash || '';
    if (/^#\/[A-Za-z0-9]/.test(hash)) {
      window.location.replace('/app.html' + hash);
    }
  })();

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
    if (menuBtn) {
      menuBtn.classList.remove('active');
      menuBtn.setAttribute('aria-expanded', 'false');
    }
    moveActionsBackToHeader();
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      const opening = !mainNav.classList.contains('open');
      mainNav.classList.toggle('open');
      menuBtn.classList.toggle('active');
      menuBtn.setAttribute('aria-expanded', opening ? 'true' : 'false');
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

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && mainNav.classList.contains('open')) {
        closeMobileMenu();
        menuBtn.focus();
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

  // ========== Pipeline-flow connector lines ==========
  // Рисуем 4 кривые: source→brain (одна) и brain→каждый output (три).
  // Используем cubic Bezier с горизонтальными контрольными точками — линии
  // плавно расходятся, не пересекают друг друга.

  function drawPipelineLines() {
    const svg = document.querySelector('.pipeline-flow__lines');
    const container = document.querySelector('.pipeline-flow');
    if (!svg || !container) return;

    const source = container.querySelector('[data-pf="source"]');
    const brain = container.querySelector('[data-pf="brain"]');
    const outputs = container.querySelectorAll('.pf-node--out');
    if (!source || !brain || !outputs.length) return;

    const cRect = container.getBoundingClientRect();
    const rightOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.right - cRect.left, y: r.top + r.height / 2 - cRect.top };
    };
    const leftOf = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - cRect.left, y: r.top + r.height / 2 - cRect.top };
    };

    const paths = [];
    // source → brain
    {
      const a = rightOf(source);
      const b = leftOf(brain);
      const cx = (a.x + b.x) / 2;
      paths.push(`<path data-to="brain" d="M${a.x} ${a.y} C ${cx} ${a.y}, ${cx} ${b.y}, ${b.x} ${b.y}" />`);
    }
    // brain → каждый output
    const brainRight = rightOf(brain);
    outputs.forEach((out) => {
      const target = leftOf(out);
      const cx = (brainRight.x + target.x) / 2;
      const key = out.dataset.pf || '';
      paths.push(`<path data-to="${key}" d="M${brainRight.x} ${brainRight.y} C ${cx} ${brainRight.y}, ${cx} ${target.y}, ${target.x} ${target.y}" />`);
    });

    svg.setAttribute('viewBox', `0 0 ${cRect.width} ${cRect.height}`);
    svg.innerHTML = paths.join('\n');
  }

  // Draw after layout
  window.addEventListener('load', () => {
    setTimeout(drawPipelineLines, 300);
  });

  window.addEventListener('resize', () => {
    clearTimeout(window._pfResize);
    window._pfResize = setTimeout(drawPipelineLines, 200);
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
      const label = document.createElement('span');
      label.className = 'result-field-label';
      label.textContent = f.label;
      const value = document.createElement('span');
      value.className = 'result-field-value';
      value.textContent = String(f.value);
      div.append(label, value);
      resultFields.appendChild(div);
    });

    // Items
    resultItems.innerHTML = '';
    const items = data.items || [];
    items.forEach((item) => {
      const tr = document.createElement('tr');
      const values = [
        item.name || item.original_name || '—',
        `${item.qty ?? item.quantity ?? ''} ${item.unit || ''}`.trim(),
        `${formatNum(item.price)} ₽`,
        `${formatNum(item.total)} ₽`,
      ];
      values.forEach((value) => {
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.appendChild(td);
      });
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
  // Source of truth: the same persistent key the dashboard reads, with the
  // legacy sessionStorage fallback kept during the storage migration.
  function readApiKey() {
    return localStorage.getItem('apiKey') || sessionStorage.getItem('apiKey') || '';
  }

  // Toggle every element marked with data-auth-state="in" / "out"
  // — hide the "wrong" ones, show the right ones. Also fills the username
  // hello-pill on the bottom CTA if present.
  function applyAuthState() {
    const authed = !!readApiKey();
    document.querySelectorAll('[data-site-logo]').forEach((logo) => {
      logo.setAttribute('href', authed ? '/app.html#/invoices' : '/');
      logo.setAttribute('title', authed ? 'К накладным' : 'На главную');
    });
    document.querySelectorAll('[data-auth-state]').forEach((el) => {
      const want = el.getAttribute('data-auth-state');
      const show = (want === 'in' && authed) || (want === 'out' && !authed);
      el.hidden = !show;
    });
    const userEl = document.getElementById('auth-cta-username');
    if (userEl) {
      const name = localStorage.getItem('adminUsername')
        || sessionStorage.getItem('adminUsername')
        || 'пользователь';
      userEl.textContent = name;
    }
    const mobileDock = document.getElementById('mobile-action-dock');
    const mobileDockLabel = document.getElementById('mobile-action-dock-label');
    if (mobileDock && mobileDockLabel) {
      mobileDock.setAttribute('href', authed ? '/app.html#/invoices' : '#try');
      mobileDock.setAttribute('aria-label', authed ? 'Открыть накладные' : 'Попробовать ScanFlow бесплатно');
      mobileDockLabel.textContent = authed ? 'Открыть накладные' : 'Попробовать бесплатно';
    }
  }

  applyAuthState();

  // Cross-tab sync: if другой таб разлогинился — отрази здесь же.
  window.addEventListener('storage', (e) => {
    if (e.key === 'apiKey' || e.key === 'adminUsername') applyAuthState();
  });

  // On a long mobile landing keep one useful next action within thumb reach.
  // It stays out of the way while the hero, upload demo or footer is visible.
  (function setupMobileActionDock() {
    const dock = document.getElementById('mobile-action-dock');
    const hero = document.getElementById('main-content');
    const demo = document.getElementById('try');
    const footer = document.querySelector('.site-footer');
    if (!dock || !hero || !('IntersectionObserver' in window)) return;

    const visibility = new Map([[hero, true], [demo, false], [footer, false]]);
    const render = () => {
      const blocked = visibility.get(hero) || visibility.get(demo) || visibility.get(footer);
      dock.classList.toggle('is-visible', !blocked);
    };
    const dockObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => visibility.set(entry.target, entry.isIntersecting));
      render();
    }, { threshold: 0.08 });
    [hero, demo, footer].filter(Boolean).forEach((el) => dockObserver.observe(el));
    render();
  })();

  // Bottom CTA (logged-out variant): «Создать аккаунт» → модалка с табой
  // register; «Уже есть? Войти» → та же модалка с табой login.
  // Залогиненный вариант «Открыть кабинет» — простой anchor, без JS.
  const ctaRegisterBtn = document.getElementById('auth-cta-register');
  if (ctaRegisterBtn) {
    ctaRegisterBtn.addEventListener('click', () => openLogin('register'));
  }
  const ctaLoginBtn = document.getElementById('auth-cta-login');
  if (ctaLoginBtn) {
    ctaLoginBtn.addEventListener('click', () => openLogin('login'));
  }

  // Pricing card buttons «Зарегистрироваться» / «Начать работу» (href="#auth")
  // — теперь открывают модалку регистрации напрямую, без скролла к секции
  // с кнопкой (две клика — лишнее трение).
  document.querySelectorAll('.pricing-card a[href="#auth"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openLogin('register');
    });
  });

  // Hero CTA «Начать бесплатно» — открывает модалку регистрации.
  document.querySelectorAll('[data-action="hero-register"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openLogin('register');
    });
  });

  // Hero inline email-form: дублирует логику модальной регистрации, но без
  // открытия модалки сначала. На успех — переключаем модалку в state mail-sent
  // (через showMailSentView), чтобы пользователь увидел стандартный экран
  // «проверь почту». Endpoint и поведение совпадают с register-form в модалке.
  const heroEmailForm = document.getElementById('hero-email-form');
  const heroEmailInput = document.getElementById('hero-email-input');
  const heroEmailSubmit = document.getElementById('hero-email-submit');
  const heroEmailError = document.getElementById('hero-email-error');
  if (heroEmailForm) {
    heroEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (heroEmailInput.value || '').trim();
      if (!email) return;
      if (!heroEmailForm.checkValidity()) {
        heroEmailInput.reportValidity();
        return;
      }

      heroEmailSubmit.disabled = true;
      const originalLabel = heroEmailSubmit.textContent;
      heroEmailSubmit.textContent = 'Отправляем…';
      heroEmailError.hidden = true;

      try {
        const resp = await fetch('/api/auth/register-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          heroEmailError.textContent = data.error || `Сервер вернул ошибку (${resp.status}).`;
          heroEmailError.hidden = false;
          return;
        }
        localStorage.removeItem('sf-onboarding-done');
        localStorage.removeItem('sf-onboarding-sber-skip');
        localStorage.removeItem('sf-onboarding-1c-ok');
        heroEmailForm.reset();
        openLogin('register');
        showMailSentView(email, 'register');
      } catch (err) {
        heroEmailError.textContent = 'Не удалось связаться с сервером. Проверьте интернет.';
        heroEmailError.hidden = false;
      } finally {
        heroEmailSubmit.disabled = false;
        heroEmailSubmit.textContent = originalLabel;
      }
    });
  }

  // Logout from the bottom CTA — clears creds and re-renders the CTA card.
  const ctaLogoutBtn = document.getElementById('auth-cta-logout');
  if (ctaLogoutBtn) {
    ctaLogoutBtn.addEventListener('click', () => {
      localStorage.removeItem('apiKey');
      sessionStorage.removeItem('apiKey');
      localStorage.removeItem('adminUsername');
      sessionStorage.removeItem('adminUsername');
      localStorage.removeItem('adminRole');
      sessionStorage.removeItem('adminRole');
      applyAuthState();
    });
  }

  // ========== Scan-types tabs ==========
  // Простое переключение табов: клик по кнопке → активный класс + показ
  // соответствующего panel'а, остальные hidden. Keyboard accessible: стрелки
  // в режиме role="tablist" не обязательны для MVP — клик/таб работают.
  (function initScanTabs() {
    const strip = document.querySelector('.scan-tabs__strip');
    if (!strip) return;
    const btns = strip.querySelectorAll('.scan-tabs__btn');
    const panels = document.querySelectorAll('.scan-tabs__panel');
    btns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        btns.forEach((b) => {
          const on = b === btn;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        panels.forEach((p) => {
          p.hidden = p.dataset.panel !== tab;
        });
      });
    });
  })();

  // ========== Login Modal ==========

  const loginModal = document.getElementById('login-modal');
  const loginOpenBtn = document.getElementById('btn-login-open');
  const loginForm = document.getElementById('login-form');
  const loginUsername = document.getElementById('login-username');
  const loginPassword = document.getElementById('login-password');
  const loginSubmit = document.getElementById('login-submit');
  const loginError = document.getElementById('login-error');

  // Tab switching inside the modal — login | register | recover | mail-sent
  // Top-tabs подсвечиваются только для login/register. Остальные state'ы
  // (recover, mail-sent) — оверлей-режимы внутри модалки, без активной табы.
  const VALID_VIEWS = ['login', 'register', 'recover', 'mail-sent'];
  function switchModalTab(mode) {
    if (!loginModal) return;
    const target = VALID_VIEWS.includes(mode) ? mode : 'login';
    loginModal.setAttribute('data-mode', target);
    loginModal.querySelectorAll('.login-modal__tabs button[role="tab"]').forEach((btn) => {
      const isActive = btn.dataset.tab === target;
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    loginModal.querySelectorAll('.login-modal__view').forEach((view) => {
      view.hidden = view.dataset.view !== target;
    });
    // clear any stale errors when switching
    ['login-error', 'register-error', 'recover-error'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) { el.hidden = true; el.textContent = ''; }
    });
    // focus first empty input in the target view
    setTimeout(() => {
      const view = loginModal.querySelector(`[data-view="${target}"]`);
      const first = view && view.querySelector('input');
      if (first && !first.value) first.focus();
    }, 50);
  }

  function openLogin(mode) {
    if (!loginModal) return;
    loginModal.classList.add('open');
    loginModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('login-open');
    switchModalTab(mode || 'login');
    const savedUser = localStorage.getItem('adminUsername');
    if (savedUser && loginUsername) loginUsername.value = savedUser;
    setTimeout(() => {
      const target = (loginUsername && !loginUsername.value) ? loginUsername : loginPassword;
      if (target && mode !== 'register') target.focus();
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

  // Dashboard / pricing redirects un-authed users here with ?login=1 (or
  // ?login=1&mode=register для CTA «Создать аккаунт»). Авто-открываем модалку
  // нужной табы и чистим query чтобы reload её не дёргал.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === '1' && !readApiKey()) {
      const reason = params.get('reason');
      const mode = params.get('mode') === 'register' ? 'register' : 'login';
      params.delete('login');
      params.delete('reason');
      params.delete('mode');
      const qs = params.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
      setTimeout(() => {
        openLogin(mode);
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

  // Tab buttons + inline «Зарегистрироваться / Войти» switch links
  document.querySelectorAll('.login-modal__tabs button[role="tab"]').forEach((btn) => {
    btn.addEventListener('click', () => switchModalTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-switch-tab]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchModalTab(link.getAttribute('data-switch-tab'));
    });
  });

  // Eye-toggle: показать/скрыть пароль на всех `data-toggle-password` кнопках.
  // Переключает type input'а и подменяет SVG (открытый глаз ↔ перечёркнутый).
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.getAttribute('data-toggle-password'));
      if (!target) return;
      const showing = target.type === 'text';
      target.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-label', showing ? 'Показать пароль' : 'Скрыть пароль');
      const eye = btn.querySelector('.ico-eye');
      const eyeOff = btn.querySelector('.ico-eye-off');
      if (eye) eye.style.display = showing ? '' : 'none';
      if (eyeOff) eyeOff.style.display = showing ? 'none' : '';
    });
  });

  // Eye-toggle оставлен выше для login-формы (поле пароля).
  // На регистрации/recover паролей нет — пользователь получит их в письме.

  // === Register form submission — email-only flow ===
  // Сервер `/api/auth/register-email` сам генерит username/password/magic-token
  // и отправляет welcome-email. Здесь мы только показываем mail-sent state с
  // подставленным email. Никакого auto-login: пользователь должен пройти
  // через email чтобы доказать что адрес рабочий.
  const registerForm = document.getElementById('register-form');
  const registerError = document.getElementById('register-error');
  const registerSubmit = document.getElementById('register-submit');
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (document.getElementById('register-email').value || '').trim();
      if (!email) return;

      registerSubmit.disabled = true;
      const originalLabel = registerSubmit.textContent;
      registerSubmit.textContent = 'Отправляем письмо…';
      registerError.hidden = true;

      try {
        const resp = await fetch('/api/auth/register-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          registerError.textContent = data.error || `Сервер вернул ошибку (${resp.status}).`;
          registerError.hidden = false;
          return;
        }
        // Чистим возможные старые «done» флаги от прошлых аккаунтов в этом
        // браузере, чтобы wizard точно открылся когда пользователь перейдёт
        // по magic-ссылке из письма.
        localStorage.removeItem('sf-onboarding-done');
        localStorage.removeItem('sf-onboarding-sber-skip');
        localStorage.removeItem('sf-onboarding-1c-ok');
        showMailSentView(email, 'register');
      } catch (err) {
        registerError.textContent = 'Не удалось связаться с сервером. Проверьте интернет.';
        registerError.hidden = false;
      } finally {
        registerSubmit.disabled = false;
        registerSubmit.textContent = originalLabel;
      }
    });
  }

  // === Recover form submission ===
  // Анти-enumeration: сервер всегда отвечает 200 — мы показываем тот же
  // mail-sent state даже если email не зарегистрирован.
  const recoverForm = document.getElementById('recover-form');
  const recoverError = document.getElementById('recover-error');
  const recoverSubmit = document.getElementById('recover-submit');
  if (recoverForm) {
    recoverForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (document.getElementById('recover-email').value || '').trim();
      if (!email) return;

      recoverSubmit.disabled = true;
      const originalLabel = recoverSubmit.textContent;
      recoverSubmit.textContent = 'Отправляем…';
      recoverError.hidden = true;

      try {
        const resp = await fetch('/api/auth/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        // Не показываем error даже на 400 (только если 5xx) — анти-enum.
        if (resp.status >= 500) {
          recoverError.textContent = 'Сервис временно недоступен. Попробуйте позже.';
          recoverError.hidden = false;
          return;
        }
        if (resp.status === 400) {
          const data = await resp.json().catch(() => ({}));
          recoverError.textContent = data.error || 'Проверьте формат email';
          recoverError.hidden = false;
          return;
        }
        showMailSentView(email, 'recover');
      } catch (err) {
        recoverError.textContent = 'Не удалось связаться с сервером. Проверьте интернет.';
        recoverError.hidden = false;
      } finally {
        recoverSubmit.disabled = false;
        recoverSubmit.textContent = originalLabel;
      }
    });
  }

  // Показывает финальную страницу «письмо отправлено» с email-ом из формы
  // и подменяет заголовок под контекст (welcome vs recover).
  function showMailSentView(email, kind) {
    const title = document.getElementById('mail-sent-title');
    const emailSpan = document.getElementById('mail-sent-email');
    if (title) title.textContent = kind === 'recover' ? 'Проверьте почту' : 'Письмо отправлено';
    if (emailSpan) emailSpan.textContent = email;
    switchModalTab('mail-sent');
  }

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
        localStorage.setItem('adminRole', data.role || 'user');
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

  // ========== Theme — pure time-of-day (07:00–19:00 light, else dark) ==========
  // Anti-FOUC inline script in <head> sets the initial value. Re-check every 60s
  // so a long-open tab flips at the 7am/7pm boundary without a reload.
  (function setupAutoTheme() {
    const root = document.documentElement;
    function apply() {
      const h = new Date().getHours();
      root.setAttribute('data-theme', (h >= 7 && h < 19) ? 'light' : 'dark');
    }
    apply();
    setInterval(apply, 60 * 1000);

    // One-time cleanup: legacy 'sf-theme' localStorage key from the old toggle.
    try { localStorage.removeItem('sf-theme'); } catch (_) { /* ignore */ }
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
