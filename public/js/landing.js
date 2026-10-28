/* ============================================================
   ScanFlow — главная и страницы блога: поведение и анимации.
   Блог подключает этот же файл, поэтому каждый блок проверяет,
   что его разметка есть на странице.
   ============================================================ */

(function () {
  'use strict';

  // Сигнал инлайн-скрипту в <head>: скрипт загрузился, анимации появления
  // можно оставлять. Если файл не загрузится, <head> через 3 с снимет класс js
  // и всё содержимое станет видно без анимаций.
  window.__sfLanding = true;

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

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hasIO = 'IntersectionObserver' in window;

  // Цели Яндекс Метрики. Номер счётчика приходит с сервера (window.SF_SITE,
  // env YANDEX_METRIKA_ID), а сам счётчик загружается только после «Принять»
  // в сообщении о cookie (initAnalytics ниже) — до этого track() молчит.
  const SITE = window.SF_SITE || {};
  function track(goal, params) {
    if (SITE.metrika && typeof window.ym === 'function') window.ym(SITE.metrika, 'reachGoal', goal, params);
  }

  // ========== Появление секций при прокрутке ==========
  // Один раз, через IntersectionObserver — без листенера scroll.
  (function initReveal() {
    const items = document.querySelectorAll('[data-animate]');
    if (!items.length) return;
    if (!hasIO) {
      items.forEach((el) => el.classList.add('visible'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('visible');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    items.forEach((el) => io.observe(el));
  })();

  // ========== Шапка: плотнее после начала прокрутки ==========
  // Вместо листенера scroll — наблюдатель за невидимой меткой в начале страницы.
  (function initHeaderState() {
    const header = document.getElementById('site-header');
    if (!header || !hasIO) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'scroll-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    document.body.prepend(sentinel);
    new IntersectionObserver(([entry]) => {
      header.classList.toggle('scrolled', !entry.isIntersecting);
    }).observe(sentinel);
  })();

  // ========== Меню на телефоне ==========
  // Полноэкранная панель; кнопки «Войти / Попробовать» на время меню
  // переезжают внутрь панели и возвращаются в шапку при закрытии.
  const menuBtn = document.getElementById('mobile-menu-btn');
  const mainNav = document.getElementById('main-nav');
  const headerActions = document.querySelector('.site-header .header-actions');
  const actionsHome = headerActions ? headerActions.parentElement : null;
  const actionsAnchor = headerActions ? headerActions.nextElementSibling : null;

  function moveActionsIntoNav() {
    if (headerActions && mainNav && headerActions.parentElement !== mainNav) mainNav.appendChild(headerActions);
  }

  function moveActionsBackToHeader() {
    if (!headerActions || !actionsHome || headerActions.parentElement === actionsHome) return;
    if (actionsAnchor && actionsAnchor.parentElement === actionsHome) {
      actionsHome.insertBefore(headerActions, actionsAnchor);
    } else {
      actionsHome.appendChild(headerActions);
    }
  }

  function isMenuOpen() {
    return !!mainNav && mainNav.classList.contains('open');
  }

  function openMobileMenu() {
    if (!mainNav || !menuBtn) return;
    moveActionsIntoNav();
    mainNav.classList.add('open');
    menuBtn.classList.add('active');
    menuBtn.setAttribute('aria-expanded', 'true');
    menuBtn.setAttribute('aria-label', 'Закрыть меню');
    document.body.classList.add('menu-open');
    const first = mainNav.querySelector('a');
    if (first) first.focus({ preventScroll: true });
  }

  function closeMobileMenu(returnFocus) {
    if (!mainNav || !menuBtn) return;
    mainNav.classList.remove('open');
    menuBtn.classList.remove('active');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-label', 'Открыть меню');
    document.body.classList.remove('menu-open');
    moveActionsBackToHeader();
    if (returnFocus) menuBtn.focus();
  }

  if (menuBtn && mainNav) {
    menuBtn.addEventListener('click', () => {
      if (isMenuOpen()) closeMobileMenu(false);
      else openMobileMenu();
    });

    // Любая ссылка внутри меню (пункты и кнопки) закрывает его.
    mainNav.addEventListener('click', (e) => {
      if (e.target.closest('a') && isMenuOpen()) closeMobileMenu(false);
    });

    window.matchMedia('(min-width: 861px)').addEventListener('change', (e) => {
      if (e.matches && isMenuOpen()) closeMobileMenu(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && isMenuOpen()) closeMobileMenu(true);
    });
  }

  // ========== Подсветка текущей секции в меню ==========
  (function initScrollSpy() {
    if (!mainNav || !hasIO) return;
    const links = Array.from(mainNav.querySelectorAll('a[href^="#"]'));
    const pairs = links
      .map((link) => [link, document.querySelector(link.getAttribute('href'))])
      .filter(([, section]) => section);
    if (!pairs.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const pair = pairs.find(([, section]) => section === entry.target);
        if (!pair) return;
        if (entry.isIntersecting) {
          links.forEach((l) => l.removeAttribute('aria-current'));
          pair[0].setAttribute('aria-current', 'true');
        } else if (pair[0].hasAttribute('aria-current')) {
          pair[0].removeAttribute('aria-current');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    pairs.forEach(([, section]) => io.observe(section));
  })();

  // ========== Сцена героя: фото → подсветка полей → приходная → отправка ==========
  // Цикл идёт, пока сцена на экране; вне экрана и при свёрнутой вкладке стоит
  // на итоговом кадре. При prefers-reduced-motion — сразу итоговый кадр.
  (function initHeroStage() {
    const stage = document.querySelector('[data-hero-stage]');
    if (!stage) return;
    const statusEl = stage.querySelector('[data-stage-status]');
    const PHASES = ['is-scan', 'is-doc', 'is-rows', 'is-total', 'is-sent', 'is-done', 'is-reset'];
    let timers = [];
    let running = false;

    const at = (ms, fn) => timers.push(setTimeout(fn, ms));
    const setStatus = (text) => { if (statusEl) statusEl.textContent = text; };
    const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

    function finalFrame() {
      stage.classList.remove('is-reset');
      stage.classList.add('is-scan', 'is-doc', 'is-rows', 'is-total', 'is-sent', 'is-done');
      setStatus('Готово');
    }

    function cycle() {
      clearTimers();
      stage.classList.remove(...PHASES);
      setStatus('Читаем фото');
      void stage.offsetWidth; // перезапуск анимации луча
      at(150, () => stage.classList.add('is-scan'));
      at(2000, () => { stage.classList.add('is-doc'); setStatus('Сверяем суммы'); });
      at(2300, () => stage.classList.add('is-rows'));
      at(3300, () => stage.classList.add('is-total'));
      at(3900, () => { stage.classList.add('is-sent'); setStatus('Отправляем'); });
      at(5000, () => { stage.classList.add('is-done'); setStatus('Готово'); });
      at(10500, () => stage.classList.add('is-reset'));
      at(11200, cycle);
    }

    function start() {
      if (running || reduceMotion.matches) return;
      running = true;
      cycle();
    }

    function stop() {
      running = false;
      clearTimers();
      finalFrame();
    }

    if (reduceMotion.matches || !hasIO) {
      finalFrame();
      return;
    }

    let inView = false;
    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView && !document.hidden) start();
      else stop();
    }, { threshold: 0.25 }).observe(stage);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stop();
      else if (inView) start();
    });
    reduceMotion.addEventListener('change', () => { if (reduceMotion.matches) stop(); });

    // Лёгкий параллакс слоёв за курсором (только мышь, на requestAnimationFrame).
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    let frame = 0;
    let px = 0;
    let py = 0;
    const paint = () => {
      frame = 0;
      stage.style.setProperty('--px', px.toFixed(3));
      stage.style.setProperty('--py', py.toFixed(3));
    };
    stage.addEventListener('pointermove', (e) => {
      if (reduceMotion.matches) return;
      const r = stage.getBoundingClientRect();
      px = ((e.clientX - r.left) / r.width - 0.5) * 2;
      py = ((e.clientY - r.top) / r.height - 0.5) * 2;
      if (!frame) frame = requestAnimationFrame(paint);
    });
    stage.addEventListener('pointerleave', () => {
      px = 0;
      py = 0;
      if (!frame) frame = requestAnimationFrame(paint);
    });
  })();

  // ========== Слоган: слова загораются по одному ==========
  // Один листенер scroll на requestAnimationFrame, включён только пока секция
  // рядом с экраном. Слова, склеенные &nbsp;, загораются вместе.
  (function initTagline() {
    const el = document.querySelector('[data-tagline]');
    if (!el) return;
    const text = el.textContent.trim();
    const parts = text.split(/ +/);
    el.textContent = '';
    const words = parts.map((part, i) => {
      const span = document.createElement('span');
      span.className = 'tagline__word';
      span.textContent = part;
      el.appendChild(span);
      if (i < parts.length - 1) el.appendChild(document.createTextNode(' '));
      return span;
    });

    if (reduceMotion.matches || !hasIO) {
      words.forEach((w) => w.classList.add('is-lit'));
      return;
    }

    let ticking = false;
    let lit = -1;
    function update() {
      ticking = false;
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const progress = Math.min(1, Math.max(0, (vh * 0.8 - rect.top) / (rect.height + vh * 0.35)));
      const count = Math.round(progress * words.length);
      if (count === lit) return;
      lit = count;
      words.forEach((w, i) => w.classList.toggle('is-lit', i < count));
    }
    function onScroll() {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    }
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        window.addEventListener('scroll', onScroll, { passive: true });
        update();
      } else {
        window.removeEventListener('scroll', onScroll);
        update();
      }
    }, { rootMargin: '20% 0px 20% 0px' }).observe(el);
  })();

  // ========== «Как это работает»: шаги и липкий визуал ==========
  // На ПК визуал один и меняется по шагу, который пересекает середину экрана.
  // На телефоне визуал стоит под каждым шагом и оживает, когда виден.
  (function initSteps() {
    const root = document.querySelector('[data-steps]');
    if (!root || !hasIO) return;
    const steps = Array.from(root.querySelectorAll('.how__step'));
    const panels = Array.from(root.querySelectorAll('.how__panel'));
    const mobile = window.matchMedia('(max-width: 767px)');

    function activate(n) {
      steps.forEach((s) => s.classList.toggle('is-active', s.dataset.step === n));
      if (!mobile.matches) panels.forEach((p) => p.classList.toggle('is-active', p.dataset.panel === n));
    }

    const stepIO = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) activate(entry.target.dataset.step); });
    }, { rootMargin: '-45% 0px -50% 0px' });
    steps.forEach((s) => stepIO.observe(s));

    const panelIO = new IntersectionObserver((entries) => {
      if (!mobile.matches) return;
      entries.forEach((entry) => { if (entry.isIntersecting) entry.target.classList.add('is-active'); });
    }, { threshold: 0.3 });
    panels.forEach((p) => panelIO.observe(p));

    mobile.addEventListener('change', () => {
      if (mobile.matches) {
        panels.forEach((p) => { panelIO.unobserve(p); panelIO.observe(p); });
      } else {
        const current = steps.find((s) => s.classList.contains('is-active'));
        activate(current ? current.dataset.step : '1');
      }
    });
  })();

  // ========== Живые визуалы в плитках ==========
  // Пока плитка на экране, её сюжет проигрывается по кругу; вне экрана — пауза.
  (function initLiveTiles() {
    const tiles = document.querySelectorAll('[data-live]');
    if (!tiles.length) return;
    if (reduceMotion.matches || !hasIO) {
      tiles.forEach((t) => t.classList.add('is-playing'));
      return;
    }
    const PLAY_MS = 5600;
    const REST_MS = 900;
    const state = new Map();

    function loop(tile) {
      const s = state.get(tile);
      tile.classList.add('is-playing');
      s.timer = setTimeout(() => {
        tile.classList.remove('is-playing');
        s.timer = setTimeout(() => loop(tile), REST_MS);
      }, PLAY_MS);
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const tile = entry.target;
        const s = state.get(tile);
        if (entry.isIntersecting && !s.on) {
          s.on = true;
          loop(tile);
        } else if (!entry.isIntersecting && s.on) {
          s.on = false;
          clearTimeout(s.timer);
          tile.classList.add('is-playing');
        }
      });
    }, { threshold: 0.35 });

    tiles.forEach((tile) => {
      state.set(tile, { on: false, timer: 0 });
      io.observe(tile);
    });
  })();

  // ========== Запись кабинета ==========
  // Видео (≈650 КБ) начинает грузиться, только когда секция на экране, играет,
  // пока она видна, и встаёт на паузу вне экрана и в фоновой вкладке. При
  // prefers-reduced-motion само не стартует — только по кнопке или главе.
  (function initCabinetVideo() {
    const root = document.querySelector('[data-cabinet-video]');
    if (!root) return;
    const video = root.querySelector('video');
    const toggle = root.querySelector('[data-video-toggle]');
    const bar = root.querySelector('.cabinet__progress span');
    const chapters = Array.from(root.querySelectorAll('[data-at]'));
    if (!video || !toggle) return;
    let userPaused = reduceMotion.matches;
    let visible = false;
    let started = false;

    function play() {
      video.preload = 'auto';
      const pending = video.play();
      if (pending && pending.catch) pending.catch(() => { /* автозапуск запрещён — ждём кнопку */ });
      if (!started) { started = true; track('video_play'); }
    }

    function setPlaying(on) {
      root.classList.toggle('is-playing', on);
      toggle.setAttribute('aria-label', on ? 'Пауза' : 'Смотреть запись');
    }

    video.addEventListener('play', () => setPlaying(true));
    video.addEventListener('pause', () => setPlaying(false));
    video.addEventListener('timeupdate', () => {
      const t = video.currentTime;
      if (bar && video.duration) bar.style.transform = `scaleX(${t / video.duration})`;
      let current = 0;
      chapters.forEach((c, i) => { if (t >= Number(c.dataset.at)) current = i; });
      chapters.forEach((c, i) => {
        c.classList.toggle('is-current', i === current);
        if (i === current) c.setAttribute('aria-current', 'step'); else c.removeAttribute('aria-current');
      });
    });

    toggle.addEventListener('click', () => {
      if (video.paused) { userPaused = false; play(); } else { userPaused = true; video.pause(); }
    });

    chapters.forEach((c) => c.addEventListener('click', () => {
      const seek = () => { video.currentTime = Number(c.dataset.at); };
      userPaused = false;
      video.preload = 'auto';
      if (video.readyState >= 1) seek(); else video.addEventListener('loadedmetadata', seek, { once: true });
      play();
    }));

    if (hasIO) {
      new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          visible = entry.isIntersecting;
          if (visible && !userPaused) play();
          else if (!visible && !video.paused) video.pause();
        });
      }, { threshold: 0.35 }).observe(video);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) video.pause();
      else if (visible && !userPaused) play();
    });
  })();

  // ========== Калькулятор экономии ==========
  // Оценка по цифрам посетителя. Допущения те же, что в «Как считаем» под
  // ползунками: меняете число здесь — меняйте и текст там.
  (function initSavings() {
    const root = document.querySelector('[data-calc]');
    if (!root) return;
    const HEADER_MIN = 3;          // шапка накладной вручную, минут
    const CHECK_MIN = 1;           // проверка шапки и одобрение в ScanFlow, минут
    const CHECK_SEC_PER_LINE = 2;  // взгляд на строку в ScanFlow, секунд
    // Тарифы — как в разделе «Тарифы» (src/billing/catalog.ts); ползунок
    // накладных кончается на 1 500, дальше «Бизнеса» не бывает.
    const PLANS = [
      { pages: 50, name: 'Старт', price: '(0\u00a0₽)' },
      { pages: 1000, name: 'Pro', price: '(990\u00a0₽ в\u00a0месяц после беты)' },
      { pages: Infinity, name: 'Бизнес', price: '(4\u00a0990\u00a0₽ в\u00a0месяц после беты)' },
    ];
    const num = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
    const ranges = Array.from(root.querySelectorAll('.calc__range'));
    const out = (key) => root.querySelector(`[data-out="${key}"]`);
    const shown = { hours: 0, money: 0 };
    let frame = 0;
    let announceTimer = 0;
    let used = false;
    let first = true;

    const roundHours = (h) => (h < 10 ? Math.round(h * 10) / 10 : Math.round(h));
    const roundMoney = (rub) => Math.round(rub / 100) * 100;
    const value = (name) => Number(root.querySelector(`[name="${name}"]`).value);

    function paintRange(el) {
      const min = Number(el.min);
      const max = Number(el.max);
      el.style.setProperty('--fill', `${((Number(el.value) - min) / (max - min)) * 100}%`);
    }

    function draw(hours, money) {
      shown.hours = hours;
      shown.money = money;
      out('saved-hours').textContent = num.format(roundHours(hours));
      out('saved-money').textContent = num.format(roundMoney(money));
    }

    // Числа результата «докручиваются» за 300 мс, а не прыгают.
    function animateTo(hours, money) {
      cancelAnimationFrame(frame);
      if (reduceMotion.matches) { draw(hours, money); return; }
      const from = { hours: shown.hours, money: shown.money };
      const start = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - start) / 300);
        const k = 1 - Math.pow(1 - t, 3);
        draw(from.hours + (hours - from.hours) * k, from.money + (money - from.money) * k);
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }

    function update() {
      const invoices = value('invoices');
      const lines = value('lines');
      const seconds = value('seconds');
      const rate = value('rate');
      ranges.forEach(paintRange);
      out('invoices').textContent = num.format(invoices);
      out('lines').textContent = num.format(lines);
      out('seconds').textContent = `${seconds}\u00a0с`;
      out('rate').textContent = `${num.format(rate)}\u00a0₽`;

      const manualHours = (invoices * (HEADER_MIN + (lines * seconds) / 60)) / 60;
      const scanHours = (invoices * (CHECK_MIN + (lines * CHECK_SEC_PER_LINE) / 60)) / 60;
      const savedHours = Math.max(0, manualHours - scanHours);
      if (first) draw(savedHours, savedHours * rate); else animateTo(savedHours, savedHours * rate);
      first = false;
      out('manual-hours').textContent = `${num.format(roundHours(manualHours))}\u00a0ч`;
      out('scan-hours').textContent = `${num.format(roundHours(scanHours))}\u00a0ч`;
      root.querySelector('[data-bar="manual"]').style.setProperty('--w', '100%');
      root.querySelector('[data-bar="scan"]').style.setProperty('--w', `${Math.max(2, (scanHours / manualHours) * 100)}%`);

      // Одна накладная — один лист: страниц столько же, сколько накладных.
      const plan = PLANS.find((p) => invoices <= p.pages);
      out('pages').textContent = num.format(invoices);
      out('plan').textContent = plan.name;
      out('plan-price').textContent = plan.price;

      // Для скринридера — итог одной фразой, когда ползунок отпустили.
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => {
        out('summary').textContent = `Экономия около ${num.format(roundHours(savedHours))} ч и ${num.format(roundMoney(savedHours * rate))} ₽ в месяц, подойдёт тариф ${plan.name}.`;
      }, 700);
    }

    root.querySelector('.calc__inputs').addEventListener('submit', (e) => e.preventDefault());
    ranges.forEach((el) => el.addEventListener('input', () => {
      update();
      if (!used) { used = true; track('calc_used'); }
    }));
    update();
  })();

  // ========== Состояние входа (лендинг знает, что вы уже в кабинете) ==========

  // Источник правды — тот же ключ, что читает кабинет; sessionStorage —
  // запасной вариант на время миграции хранилища.
  function readApiKey() {
    return localStorage.getItem('apiKey') || sessionStorage.getItem('apiKey') || '';
  }

  // Показывает нужный вариант у элементов data-auth-state="in"/"out",
  // меняет ссылку логотипа, имя в финальном блоке и надпись дока.
  function applyAuthState() {
    const authed = !!readApiKey();
    document.querySelectorAll('[data-site-logo]').forEach((logo) => {
      logo.setAttribute('href', authed ? '/app.html#/invoices' : '/');
      logo.setAttribute('title', authed ? 'К накладным' : 'На главную');
    });
    document.querySelectorAll('[data-auth-state]').forEach((el) => {
      const want = el.getAttribute('data-auth-state');
      el.hidden = !((want === 'in' && authed) || (want === 'out' && !authed));
    });
    const userEl = document.getElementById('auth-cta-username');
    if (userEl) {
      userEl.textContent = localStorage.getItem('adminUsername')
        || sessionStorage.getItem('adminUsername')
        || 'пользователь';
    }
    const dock = document.getElementById('mobile-action-dock');
    const dockLabel = document.getElementById('mobile-action-dock-label');
    if (dock && dockLabel) {
      dock.setAttribute('href', authed ? '/app.html#/invoices' : '#try');
      dock.setAttribute('aria-label', authed ? 'Открыть накладные' : 'Попробовать ScanFlow бесплатно');
      dockLabel.textContent = authed ? 'Открыть накладные' : 'Попробовать бесплатно';
    }
  }

  applyAuthState();

  // Другая вкладка вошла или вышла — отражаем здесь же.
  window.addEventListener('storage', (e) => {
    if (e.key === 'apiKey' || e.key === 'adminUsername') applyAuthState();
  });

  // На длинной странице держим одно полезное действие под пальцем. Док
  // прячется, пока видны герой, пример результата или подвал.
  (function setupMobileActionDock() {
    const dock = document.getElementById('mobile-action-dock');
    const hero = document.querySelector('.hero');
    const demo = document.getElementById('try');
    const footer = document.querySelector('.site-footer');
    if (!dock || !hero || !hasIO) return;
    const watched = [hero, demo, footer].filter(Boolean);
    const visibility = new Map(watched.map((el) => [el, el === hero]));
    const render = () => {
      const blocked = watched.some((el) => visibility.get(el));
      dock.classList.toggle('is-visible', !blocked);
    };
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => visibility.set(entry.target, entry.isIntersecting));
      render();
    }, { threshold: 0.08 });
    watched.forEach((el) => io.observe(el));
    render();
  })();

  // ========== Проверка email ==========
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function emailProblem(value) {
    if (!value) return 'Введите email: на него придут логин и пароль.';
    if (!EMAIL_RE.test(value)) return 'Проверьте адрес: в нём должны быть «@» и домен, например name@company.ru.';
    return '';
  }

  // Согласие на обработку ПДн (152-ФЗ) — отдельная галочка в каждой форме
  // регистрации, по умолчанию снята. Сервер без pd_consent: true аккаунт не создаёт.
  const CONSENT_PROBLEM = 'Отметьте согласие на обработку персональных данных — без него мы не можем создать аккаунт.';

  function markConsent(box, missing) {
    if (!box) return;
    box.setAttribute('aria-invalid', missing ? 'true' : 'false');
    const row = box.closest('.consent');
    if (row) row.classList.toggle('is-invalid', missing);
  }

  document.querySelectorAll('.consent__input').forEach((box) => {
    box.addEventListener('change', () => { if (box.checked) markConsent(box, false); });
  });

  // ========== Регистрация по email: форма в герое и в финальном блоке ==========
  // Сервер /api/auth/register-email сам создаёт логин, пароль и ссылку для входа
  // и присылает письмо. Здесь — проверка адреса, состояние кнопки и экран
  // «письмо отправлено» в модалке.
  function clearOnboardingFlags() {
    localStorage.removeItem('sf-onboarding-done');
    localStorage.removeItem('sf-onboarding-sber-skip');
    localStorage.removeItem('sf-onboarding-1c-ok');
  }

  document.querySelectorAll('[data-register-form]').forEach((form) => {
    const input = form.querySelector('input[type="email"]');
    const consent = form.querySelector('.consent__input');
    const submit = form.querySelector('button[type="submit"]');
    const label = submit ? submit.querySelector('.signup__label') : null;
    const errorEl = form.querySelector('.signup__error');
    if (!input || !submit) return;

    // invalidEmail = false — ошибка не про адрес (согласие, ответ сервера):
    // рамку поля email не красим.
    function showError(message, invalidEmail = true) {
      form.classList.toggle('is-invalid', !!message && invalidEmail);
      input.setAttribute('aria-invalid', message && invalidEmail ? 'true' : 'false');
      if (errorEl) {
        errorEl.textContent = message;
        errorEl.hidden = !message;
      }
    }

    input.addEventListener('input', () => {
      if (form.classList.contains('is-invalid')) showError('');
    });
    if (consent) {
      consent.addEventListener('change', () => {
        if (consent.checked && errorEl && errorEl.textContent === CONSENT_PROBLEM) showError('');
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (input.value || '').trim();
      const problem = emailProblem(email);
      if (problem) {
        showError(problem);
        input.focus();
        return;
      }
      if (consent && !consent.checked) {
        showError(CONSENT_PROBLEM, false);
        markConsent(consent, true);
        consent.focus();
        return;
      }
      showError('');
      const formName = form.id === 'hero-email-form' ? 'hero' : 'cta';
      track('register_submit', { form: formName });
      submit.disabled = true;
      submit.setAttribute('aria-busy', 'true');
      const idleLabel = label ? label.textContent : '';
      if (label) label.textContent = 'Отправляем…';
      try {
        const resp = await fetch('/api/auth/register-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, pd_consent: true }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          showError(data.error || `Не получилось отправить письмо: сервер ответил ${resp.status}. Попробуйте ещё раз.`, resp.status === 400 && data.code !== 'pd_consent_required');
          return;
        }
        clearOnboardingFlags();
        track('register_success', { form: formName });
        form.reset();
        openLogin('register');
        showMailSentView(email, 'register');
      } catch (err) {
        showError('Нет связи с сервером. Проверьте интернет и отправьте ещё раз.');
      } finally {
        submit.disabled = false;
        submit.removeAttribute('aria-busy');
        if (label) label.textContent = idleLabel;
      }
    });
  });

  // Кнопки «Создать аккаунт» (тарифы, приёмник файлов) — сразу модалка
  // регистрации, без прокрутки к нижнему блоку.
  function registerSource(el) {
    const plan = el.closest('.plan');
    if (plan) return `plan-${(plan.querySelector('.plan__name') || {}).textContent || ''}`.toLowerCase();
    if (el.closest('.result__next')) return 'sandbox';
    if (el.closest('#demo-dropzone')) return 'dropzone';
    return 'other';
  }

  document.querySelectorAll('[data-action="register"], [data-action="hero-register"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      track('register_open', { from: registerSource(link) });
      openLogin('register');
    });
  });

  // «Попробовать» в шапке, в доке на телефоне и ссылки на пример результата.
  document.querySelectorAll('a[href="#try"], a[href="/#try"]').forEach((link) => {
    link.addEventListener('click', () => track('try_click', { from: link.id || link.className.split(' ')[0] || 'link' }));
  });

  const ctaLoginBtn = document.getElementById('auth-cta-login');
  if (ctaLoginBtn) ctaLoginBtn.addEventListener('click', () => openLogin('login'));

  // Выход из финального блока: стираем ключи и перерисовываем состояние.
  const ctaLogoutBtn = document.getElementById('auth-cta-logout');
  if (ctaLogoutBtn) {
    ctaLogoutBtn.addEventListener('click', () => {
      ['apiKey', 'adminUsername', 'adminRole'].forEach((key) => {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      });
      applyAuthState();
    });
  }

  // ========== Пример результата ==========
  // Анонимного распознавания нет: /api/upload требует ключ. Раньше лендинг слал
  // туда фото, получал 401 и показывал выдуманную накладную вместо загруженной.
  // Теперь справа статичный пример, а файл, брошенный на панель, или клик по ней
  // открывают регистрацию — свою накладную распознаём в кабинете.
  const demoDropzone = document.getElementById('demo-dropzone');
  if (demoDropzone) {
    demoDropzone.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return; // у кнопки свой обработчик
      track('register_open', { from: 'dropzone' });
      openLogin('register');
    });
    demoDropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      demoDropzone.classList.add('dragover');
    });
    demoDropzone.addEventListener('dragleave', () => demoDropzone.classList.remove('dragover'));
    demoDropzone.addEventListener('drop', (e) => {
      e.preventDefault(); // иначе браузер откроет файл вместо страницы
      demoDropzone.classList.remove('dragover');
      track('file_drop');
      openLogin('register');
    });
  }

  // ========== Вкладки документов ==========
  // role="tablist": клик, стрелки, Home/End; у неактивных вкладок tabindex=-1.
  (function initDocTabs() {
    const list = document.querySelector('.docs__tabs');
    if (!list) return;
    const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
    const panels = Array.from(document.querySelectorAll('.docs__panel'));

    function select(tab, focus) {
      tabs.forEach((t) => {
        const on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
      if (focus) tab.focus();
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }

    tabs.forEach((tab) => tab.addEventListener('click', () => select(tab, false)));
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      let next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (!next) return;
      e.preventDefault();
      select(next, true);
    });
  })();

  // ========== Песочница: «Распознать пример» ==========
  // Анонимного распознавания нет (правило 36): кнопка по шагам показывает тот
  // же заготовленный результат, что без JS виден сразу. Показ ускорен — под
  // результатом сказано, что в жизни это около 30 секунд.
  (function initSandbox() {
    const panels = document.querySelectorAll('.docs__panel[data-sandbox]');
    panels.forEach((panel) => {
      const run = panel.querySelector('[data-run]');
      const label = run && run.querySelector('span');
      const next = panel.querySelector('[data-run-next]');
      const type = panel.querySelector('.result__type');
      if (!run || !label || !next || !type) return;
      const rows = Array.from(panel.querySelectorAll('.paper__row'));
      const items = Array.from(panel.querySelectorAll('.result__fields dd, .result__table tbody tr, .result__total'));
      const checks = Array.from(panel.querySelectorAll('.result__checks li, .result__out'));
      let timers = [];

      function setState(state) {
        panel.dataset.state = state;
        const word = { ready: 'до распознавания', running: 'читаем…', done: 'распознано' }[state];
        type.textContent = `${type.dataset.type} · ${word}`;
      }

      function clear() {
        timers.forEach(clearTimeout);
        timers = [];
        panel.querySelectorAll('.is-in, .is-hit').forEach((el) => el.classList.remove('is-in', 'is-hit'));
      }

      function finish() {
        timers.forEach(clearTimeout);
        timers = [];
        items.concat(checks).forEach((el) => el.classList.add('is-in'));
        setState('done');
        next.hidden = false;
        label.textContent = 'Ещё раз';
        run.disabled = false;
      }

      function start() {
        track('sandbox_run', { doc: panel.dataset.panel });
        clear();
        next.hidden = true;
        if (reduceMotion.matches) { finish(); return; }
        setState('running');
        run.disabled = true;
        const later = (ms, fn) => timers.push(setTimeout(fn, ms));
        rows.forEach((row, i) => later(120 + i * 100, () => row.classList.add('is-hit')));
        items.forEach((el, i) => later(450 + i * 130, () => el.classList.add('is-in')));
        const checksAt = 450 + items.length * 130 + 150;
        checks.forEach((el, i) => later(checksAt + i * 220, () => el.classList.add('is-in')));
        later(checksAt + checks.length * 220 + 250, finish);
      }

      setState('ready');
      run.hidden = false;
      run.addEventListener('click', start);
    });
  })();

  // ========== Модалка входа, регистрации и восстановления ==========

  const loginModal = document.getElementById('login-modal');
  const loginOpenBtn = document.getElementById('btn-login-open');
  const loginForm = document.getElementById('login-form');
  const loginUsername = document.getElementById('login-username');
  const loginPassword = document.getElementById('login-password');
  const loginSubmit = document.getElementById('login-submit');
  const loginError = document.getElementById('login-error');
  let lastFocus = null;

  // Вкладки login | register | recover | mail-sent. Верхние табы подсвечиваются
  // только для login/register; recover и mail-sent — режимы внутри модалки.
  const VALID_VIEWS = ['login', 'register', 'recover', 'mail-sent'];
  function switchModalTab(mode) {
    if (!loginModal) return;
    const target = VALID_VIEWS.includes(mode) ? mode : 'login';
    loginModal.setAttribute('data-mode', target);
    loginModal.querySelectorAll('.login-modal__tabs button[role="tab"]').forEach((btn) => {
      btn.setAttribute('aria-selected', btn.dataset.tab === target ? 'true' : 'false');
    });
    loginModal.querySelectorAll('.login-modal__view').forEach((view) => {
      view.hidden = view.dataset.view !== target;
    });
    ['login-error', 'register-error', 'recover-error'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) { el.hidden = true; el.textContent = ''; }
    });
    setTimeout(() => {
      const view = loginModal.querySelector(`[data-view="${target}"]`);
      const first = view && view.querySelector('input');
      if (first && !first.value) first.focus();
    }, 50);
  }

  function openLogin(mode) {
    if (!loginModal) return;
    if (isMenuOpen()) closeMobileMenu(false);
    if (!loginModal.classList.contains('open')) lastFocus = document.activeElement;
    if ((mode || 'login') === 'login' && !loginModal.classList.contains('open')) track('login_open');
    loginModal.classList.add('open');
    loginModal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('login-open');
    switchModalTab(mode || 'login');
    const savedUser = localStorage.getItem('adminUsername');
    if (savedUser && loginUsername) loginUsername.value = savedUser;
    setTimeout(() => {
      const target = (loginUsername && !loginUsername.value) ? loginUsername : loginPassword;
      if (target && (mode || 'login') === 'login') target.focus();
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
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus({ preventScroll: true });
  }

  if (loginOpenBtn) {
    loginOpenBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openLogin('login');
    });
  }

  // Кабинет и тарифы отправляют сюда без ключа с ?login=1 (или
  // ?login=1&mode=register для «Создать аккаунт»). Открываем нужную вкладку
  // и чистим query, чтобы перезагрузка её не дёргала.
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

  document.querySelectorAll('[data-close-login]').forEach((el) => {
    el.addEventListener('click', (e) => {
      closeLogin();
      if (el.tagName !== 'A') e.preventDefault();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && loginModal && loginModal.classList.contains('open')) closeLogin();
  });

  document.querySelectorAll('.login-modal__tabs button[role="tab"]').forEach((btn) => {
    btn.addEventListener('click', () => switchModalTab(btn.dataset.tab));
  });
  document.querySelectorAll('[data-switch-tab]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchModalTab(link.getAttribute('data-switch-tab'));
    });
  });

  // Показать/скрыть пароль: меняет type поля и иконку глаза.
  document.querySelectorAll('[data-toggle-password]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.getAttribute('data-toggle-password'));
      if (!target) return;
      const showing = target.type === 'text';
      target.type = showing ? 'password' : 'text';
      btn.setAttribute('aria-label', showing ? 'Показать пароль' : 'Скрыть пароль');
      const eye = btn.querySelector('.ico-eye');
      const eyeOff = btn.querySelector('.ico-eye-off');
      if (eye) eye.hidden = !showing;
      if (eyeOff) eyeOff.hidden = showing;
    });
  });

  function showModalError(el, message) {
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  // Регистрация в модалке — тот же поток, что у форм на странице.
  const registerForm = document.getElementById('register-form');
  const registerError = document.getElementById('register-error');
  const registerSubmit = document.getElementById('register-submit');
  if (registerForm) {
    const registerConsent = document.getElementById('register-consent');
    if (registerConsent) {
      registerConsent.addEventListener('change', () => {
        if (registerConsent.checked && registerError && registerError.textContent === CONSENT_PROBLEM) showModalError(registerError, '');
      });
    }
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('register-email');
      const email = (input.value || '').trim();
      const problem = emailProblem(email);
      if (problem) {
        showModalError(registerError, problem);
        input.focus();
        return;
      }
      if (registerConsent && !registerConsent.checked) {
        showModalError(registerError, CONSENT_PROBLEM);
        markConsent(registerConsent, true);
        registerConsent.focus();
        return;
      }
      track('register_submit', { form: 'modal' });
      registerSubmit.disabled = true;
      const idleLabel = registerSubmit.textContent;
      registerSubmit.textContent = 'Отправляем письмо…';
      showModalError(registerError, '');
      try {
        const resp = await fetch('/api/auth/register-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, pd_consent: true }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          showModalError(registerError, data.error || `Не получилось отправить письмо: сервер ответил ${resp.status}.`);
          return;
        }
        clearOnboardingFlags();
        track('register_success', { form: 'modal' });
        showMailSentView(email, 'register');
      } catch (err) {
        showModalError(registerError, 'Нет связи с сервером. Проверьте интернет и отправьте ещё раз.');
      } finally {
        registerSubmit.disabled = false;
        registerSubmit.textContent = idleLabel;
      }
    });
  }

  // Восстановление: сервер всегда отвечает 200 (защита от перебора адресов),
  // поэтому экран «письмо отправлено» показываем и для незнакомого email.
  const recoverForm = document.getElementById('recover-form');
  const recoverError = document.getElementById('recover-error');
  const recoverSubmit = document.getElementById('recover-submit');
  if (recoverForm) {
    recoverForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('recover-email');
      const email = (input.value || '').trim();
      const problem = emailProblem(email);
      if (problem) {
        showModalError(recoverError, problem);
        input.focus();
        return;
      }
      recoverSubmit.disabled = true;
      const idleLabel = recoverSubmit.textContent;
      recoverSubmit.textContent = 'Отправляем…';
      showModalError(recoverError, '');
      try {
        const resp = await fetch('/api/auth/recover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        if (resp.status >= 500) {
          showModalError(recoverError, 'Сервис временно недоступен. Попробуйте через несколько минут.');
          return;
        }
        if (resp.status === 400) {
          const data = await resp.json().catch(() => ({}));
          showModalError(recoverError, data.error || 'Проверьте формат email.');
          return;
        }
        showMailSentView(email, 'recover');
      } catch (err) {
        showModalError(recoverError, 'Нет связи с сервером. Проверьте интернет и отправьте ещё раз.');
      } finally {
        recoverSubmit.disabled = false;
        recoverSubmit.textContent = idleLabel;
      }
    });
  }

  // Экран «письмо отправлено» с адресом из формы; заголовок под контекст.
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
      if (!username || !password) {
        showModalError(loginError, !username ? 'Введите логин из письма.' : 'Введите пароль.');
        (!username ? loginUsername : loginPassword).focus();
        return;
      }
      loginSubmit.disabled = true;
      loginSubmit.textContent = 'Проверяем…';
      showModalError(loginError, '');
      try {
        const resp = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 401) {
          showModalError(loginError, data.error || 'Неверный логин или пароль.');
          return;
        }
        if (!resp.ok || !data.apiKey) {
          showModalError(loginError, data.error || `Не получилось войти: сервер ответил ${resp.status}.`);
          return;
        }
        localStorage.setItem('apiKey', data.apiKey);
        localStorage.setItem('adminUsername', data.username || username);
        localStorage.removeItem('superadminSession');
        localStorage.setItem('adminRole', data.role || 'user');
        applyAuthState();
        track('login_success');
        window.location.href = '/app.html';
      } catch (err) {
        showModalError(loginError, 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
      } finally {
        loginSubmit.disabled = false;
        loginSubmit.textContent = 'Войти';
      }
    });
  }

  // ========== Cookie и Яндекс Метрика ==========
  // Счётчик есть, только если сервер передал номер (window.SF_SITE.metrika, env
  // YANDEX_METRIKA_ID), и загружается только после «Принять». «Только
  // необходимые» — счётчик не грузится, а уже загруженный перестаёт слать
  // данные (disableYaCounter…) и его cookie стираются. Решение хранится в
  // браузере; сменить — «Настройки cookie» в подвале. Вебвизор выключен.
  (function initAnalytics() {
    const id = SITE.metrika;
    if (!id) return;
    const KEY = 'sf-cookie-consent';
    const read = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
    const save = (value) => { try { localStorage.setItem(KEY, value); } catch (e) { /* приватный режим */ } };
    const heroVariant = document.documentElement.getAttribute('data-hero');
    let banner = null;

    function loadCounter() {
      window[`disableYaCounter${id}`] = false;
      if (typeof window.ym === 'function') return;
      window.ym = function () { (window.ym.a = window.ym.a || []).push(arguments); };
      window.ym.l = Date.now();
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://mc.yandex.ru/metrika/tag.js';
      document.head.appendChild(script);
      const options = { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false };
      if (heroVariant) options.params = { hero_variant: heroVariant };
      window.ym(id, 'init', options);
    }

    function stopCounter() {
      window[`disableYaCounter${id}`] = true;
      const domains = ['', `; domain=${location.hostname}`, `; domain=.${location.hostname.replace(/^www\./, '')}`];
      document.cookie.split(';').map((c) => c.split('=')[0].trim()).filter((name) => /^_ym/.test(name)).forEach((name) => {
        domains.forEach((d) => { document.cookie = `${name}=; Max-Age=0; path=/${d}`; });
      });
      try {
        Object.keys(localStorage).filter((k) => /^_ym/.test(k)).forEach((k) => localStorage.removeItem(k));
      } catch (e) { /* приватный режим */ }
    }

    function closeBanner() {
      if (!banner) return;
      const el = banner;
      banner = null;
      el.classList.remove('is-open');
      document.body.classList.remove('cookie-open');
      setTimeout(() => el.remove(), 400);
    }

    function decide(choice) {
      save(choice);
      if (choice === 'all') loadCounter(); else stopCounter();
      closeBanner();
    }

    function openBanner() {
      if (banner) return;
      banner = document.createElement('div');
      banner.className = 'cookie';
      banner.setAttribute('role', 'region');
      banner.setAttribute('aria-label', 'Cookie');
      banner.innerHTML = '<p class="cookie__title">Cookie для аналитики</p>'
        + '<p>Яндекс&nbsp;Метрика помогает понять, какие разделы сайта полезны. Без вашего согласия счётчик не&nbsp;загружается. '
        + '<a href="/privacy#cookies">Подробнее</a></p>'
        + '<div class="cookie__actions">'
        + '<button type="button" class="btn btn--secondary" data-cookie="necessary">Только необходимые</button>'
        + '<button type="button" class="btn btn--primary" data-cookie="all">Принять</button>'
        + '</div>';
      banner.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cookie]');
        if (btn) decide(btn.dataset.cookie);
      });
      document.body.appendChild(banner);
      document.body.classList.add('cookie-open');
      requestAnimationFrame(() => requestAnimationFrame(() => { if (banner) banner.classList.add('is-open'); }));
    }

    document.querySelectorAll('[data-cookie-settings]').forEach((btn) => {
      btn.hidden = false;
      btn.addEventListener('click', openBanner);
    });

    const choice = read();
    if (choice === 'all') loadCounter();
    else if (choice !== 'necessary') openBanner();
  })();

  // ========== Тема — как в системе пользователя (prefers-color-scheme) ==========
  // Начальное значение ставит инлайн-скрипт в <head> (без мигания). Здесь —
  // реакция на смену темы в системе без перезагрузки.
  (function setupSystemTheme() {
    const root = document.documentElement;
    const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    function apply() {
      root.setAttribute('data-theme', media && media.matches ? 'dark' : 'light');
    }
    apply();
    if (media && media.addEventListener) media.addEventListener('change', apply);

    // Разовая уборка: ключ 'sf-theme' от старого переключателя темы.
    try { localStorage.removeItem('sf-theme'); } catch (_) { /* ignore */ }
  })();

  // ========== Подбор товаров (интерактивная демонстрация) ==========

  (function initMappingDemo() {
    const demo = document.getElementById('mapping-demo');
    if (!demo) return;
    const cta = document.getElementById('mapping-cta');
    const counterEl = document.getElementById('mapping-counter-num');
    const label = cta ? cta.querySelector('.mapping-demo__cta-label') : null;
    const rows = Array.from(demo.querySelectorAll('.mapping-demo__row:not(.mapping-demo__row--head)'));
    const total = rows.length;
    const initiallyMatched = rows.filter((r) => r.dataset.matched === '1').length;
    let animating = false;

    // Исходное состояние строк — чтобы демо можно было повторить.
    rows.forEach((r) => r.setAttribute('data-original-matched', r.dataset.matched));

    function reset() {
      demo.classList.remove('is-matched', 'is-running');
      rows.forEach((r) => { r.dataset.matched = r.getAttribute('data-original-matched'); });
      counterEl.textContent = String(initiallyMatched);
      if (label) label.textContent = 'Подобрать из 1С';
    }

    function runDemo() {
      if (animating) return;
      animating = true;
      if (demo.classList.contains('is-matched')) {
        reset();
        void demo.offsetWidth;
      }
      demo.classList.add('is-running');
      cta.setAttribute('aria-busy', 'true');
      if (label) label.textContent = 'Подбираем…';

      // Стадия 1: «ИИ смотрит в справочник» — скелетоны вместо результата.
      setTimeout(() => {
        demo.classList.remove('is-running');
        demo.classList.add('is-matched');
        cta.removeAttribute('aria-busy');

        // Стадия 2: строки находят пары по очереди, счётчик растёт.
        const stagger = 140;
        let matched = initiallyMatched;
        counterEl.textContent = String(matched);
        let step = 0;
        rows.forEach((r) => {
          if (r.dataset.matched === '1') return;
          step += 1;
          setTimeout(() => {
            r.dataset.matched = '1';
            matched += 1;
            counterEl.textContent = String(matched);
          }, step * stagger);
        });

        setTimeout(() => {
          if (label) label.textContent = 'Подобрано, повторить';
          animating = false;
        }, (total - initiallyMatched) * stagger + 400);
      }, reduceMotion.matches ? 200 : 900);
    }

    cta.addEventListener('click', runDemo);

    // Один автозапуск, когда блок попадает на экран: сначала даём
    // рассмотреть исходные строки, потом подбираем.
    if (!hasIO) return;
    let autoplayed = false;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting || autoplayed) return;
        autoplayed = true;
        io.unobserve(entry.target);
        setTimeout(runDemo, 900);
      });
    }, { threshold: 0.35 });
    io.observe(demo);
  })();

})();
