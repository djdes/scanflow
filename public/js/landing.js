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

  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      mainNav.classList.toggle('open');
      menuBtn.classList.toggle('active');
    });

    // Close on nav link click
    mainNav.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        mainNav.classList.remove('open');
        menuBtn.classList.remove('active');
      });
    });
  }

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
      const target = document.querySelector(a.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  });

  // ========== Login Modal ==========

  const loginModal = document.getElementById('login-modal');
  const loginOpenBtn = document.getElementById('btn-login-open');
  const loginForm = document.getElementById('login-form');
  const loginInput = document.getElementById('login-api-key');
  const loginSubmit = document.getElementById('login-submit');
  const loginError = document.getElementById('login-error');

  function openLogin() {
    if (!loginModal) return;
    loginModal.classList.add('open');
    loginModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('login-open');
    const saved = localStorage.getItem('apiKey');
    if (saved) loginInput.value = saved;
    setTimeout(() => loginInput && loginInput.focus(), 50);
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
      const key = (loginInput.value || '').trim();
      if (!key) return;

      loginSubmit.disabled = true;
      loginSubmit.textContent = 'Проверяем…';
      loginError.hidden = true;

      try {
        const resp = await fetch('/api/invoices/stats', {
          headers: { 'X-API-Key': key },
        });
        if (resp.status === 401) {
          loginError.textContent = 'API-ключ не принят. Проверьте значение и попробуйте снова.';
          loginError.hidden = false;
          return;
        }
        if (!resp.ok) {
          loginError.textContent = `Сервер вернул ошибку (${resp.status}). Попробуйте позже.`;
          loginError.hidden = false;
          return;
        }
        localStorage.setItem('apiKey', key);
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

})();
