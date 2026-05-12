/* global App, Onboarding */
// Three-step onboarding wizard shown to fresh accounts.
//
// State lives in localStorage (per-browser) so we don't need a DB column —
// detection is cross-checked against /api/invoices/stats and /api/sber/status
// so an existing user with data never sees the wizard, even if localStorage is
// empty (e.g. cleared cache or new browser).
//
// localStorage keys:
//   sf-onboarding-done       — '1' if wizard finished or explicitly dismissed
//   sf-onboarding-sber-skip  — '1' if user clicked «Пропустить пока» on step 2
//   sf-onboarding-1c-ok      — '1' if user confirmed обработка установлена
const Onboarding = {
  LS_DONE: 'sf-onboarding-done',
  LS_SBER_SKIP: 'sf-onboarding-sber-skip',
  LS_1C_OK: 'sf-onboarding-1c-ok',

  _state: { step1: false, step2: false, step3: false },
  _bound: false,

  isDone() {
    return localStorage.getItem(this.LS_DONE) === '1';
  },

  markDone() {
    localStorage.setItem(this.LS_DONE, '1');
  },

  // Решение «делать ли AUTO-redirect на wizard» при заходе в кабинет.
  // Только для свежих аккаунтов (0 накладных). У всех у кого есть данные —
  // нет авто-редиректа (но banner будет показан с прогрессом, пока юзер
  // не дойдёт сам до «Готово» или не нажмёт «Пропустить wizard»).
  //
  // Важно: НЕ помечаем `done` тут. Иначе юзер, прошедший Шаг 1, потеряет
  // напоминание про Шаги 2/3. markDone делает либо finish-кнопка, либо
  // «Пропустить wizard».
  async shouldShow() {
    if (this.isDone()) return false;
    try {
      const stats = await App.apiJson('/invoices/stats').catch(() => null);
      const hasInvoices = stats && stats.data && (stats.data.total || 0) > 0;
      return !hasInvoices;
    } catch (e) {
      return false;
    }
  },

  // Refresh derived state from server + localStorage. Returns boolean trio.
  async refreshState() {
    let hasInvoices = false;
    let sberConnected = false;
    try {
      const stats = await App.apiJson('/invoices/stats').catch(() => null);
      hasInvoices = !!(stats && stats.data && (stats.data.total || 0) > 0);
    } catch { /* swallow */ }
    try {
      const sber = await App.apiJson('/sber/status').catch(() => null);
      sberConnected = sber && sber.connected === true;
    } catch { /* swallow */ }

    this._state = {
      step1: hasInvoices,
      step2: sberConnected || localStorage.getItem(this.LS_SBER_SKIP) === '1',
      step3: localStorage.getItem(this.LS_1C_OK) === '1',
    };
    return this._state;
  },

  // Полная отрисовка состояния: подсветка шагов, прогресс-бар, кнопки.
  async render() {
    await this.refreshState();
    const { step1, step2, step3 } = this._state;

    const allDone = step1 && step2 && step3;
    const finish = document.getElementById('onboarding-finish');
    const stepsList = document.getElementById('onboarding-steps');
    if (allDone) {
      if (stepsList) stepsList.hidden = true;
      if (finish) finish.hidden = false;
    } else {
      if (stepsList) stepsList.hidden = false;
      if (finish) finish.hidden = true;
    }

    // Active step = первый незавершённый
    const activeStep = step1 ? (step2 ? 3 : 2) : 1;
    document.querySelectorAll('.onboarding-step').forEach((el) => {
      const n = Number(el.dataset.step);
      const done = (n === 1 && step1) || (n === 2 && step2) || (n === 3 && step3);
      const active = !done && n === activeStep;
      el.dataset.state = done ? 'done' : active ? 'active' : 'locked';
      const checkIcon = el.querySelector('.onboarding-step__check-icon');
      if (checkIcon) checkIcon.style.opacity = done ? '1' : '0';
      const statusEl = el.querySelector('.onboarding-step__status');
      if (statusEl) {
        statusEl.textContent = done ? 'Готово' : active ? 'Активный' : 'Заблокирован';
      }
    });

    // Progress bar fill: 0% / 33% / 66% / 100%
    const completed = [step1, step2, step3].filter(Boolean).length;
    const fill = document.getElementById('onboarding-progress-fill');
    if (fill) fill.style.width = (completed / 3) * 100 + '%';
    document.querySelectorAll('.onboarding-progress__dots li').forEach((li) => {
      const n = Number(li.dataset.step);
      const done = (n === 1 && step1) || (n === 2 && step2) || (n === 3 && step3);
      li.classList.toggle('done', done);
      li.classList.toggle('active', !done && n === activeStep);
    });
  },

  bind() {
    if (this._bound) return;
    this._bound = true;

    // Любой CTA-линк с `data-onboarding-cta="..."` ставит hint в localStorage
    // перед навигацией — onboarding-hint.js потом подсветит нужный элемент
    // на целевой странице.
    document.querySelectorAll('[data-onboarding-cta]').forEach((el) => {
      el.addEventListener('click', () => {
        localStorage.setItem('sf-onboarding-hint', el.dataset.onboardingCta);
      });
    });

    const skipAll = document.getElementById('onboarding-skip-all');
    if (skipAll) {
      skipAll.addEventListener('click', () => {
        if (!confirm('Закрыть онбординг? Шаги можно пройти позже из настроек.')) return;
        this.markDone();
        App.navigate('#/invoices');
      });
    }

    const skipSber = document.getElementById('step2-skip');
    if (skipSber) {
      skipSber.addEventListener('click', () => {
        localStorage.setItem(this.LS_SBER_SKIP, '1');
        this.render();
        App.notify('Шаг 2 пропущен — банк можно подключить позже из меню «Сбербанк».', 'info');
      });
    }

    const confirm1c = document.getElementById('step3-confirm');
    if (confirm1c) {
      confirm1c.addEventListener('click', () => {
        localStorage.setItem(this.LS_1C_OK, '1');
        this.render();
      });
    }

    const finishGo = document.getElementById('onboarding-finish-go');
    if (finishGo) {
      finishGo.addEventListener('click', () => {
        this.markDone();
        // навигация по href сама уведёт на #/invoices
      });
    }
  },

  // Public entry — вызывается из App.route() для хеша #/onboarding.
  show() {
    this.bind();
    this.render();
  },

  // Sticky-баннер на остальных страницах дашборда — показывает прогресс
  // и кнопку «Продолжить». Зовётся из App.route() после каждой навигации.
  async renderBanner(currentHash) {
    const banner = document.getElementById('onboarding-banner');
    if (!banner) return;

    // На самой странице wizard'а баннер не нужен — wizard и так перед глазами
    if (currentHash && currentHash.startsWith('#/onboarding')) {
      banner.hidden = true;
      return;
    }
    if (this.isDone()) {
      banner.hidden = true;
      return;
    }

    await this.refreshState();
    const { step1, step2, step3 } = this._state;
    const completed = [step1, step2, step3].filter(Boolean).length;
    if (completed === 3) {
      // Все шаги фактически выполнены — отмечаем done и прячемся
      this.markDone();
      banner.hidden = true;
      return;
    }

    // Обновляем «N из 3 шагов»
    const progressEl = document.getElementById('onboarding-banner-progress');
    if (progressEl) progressEl.textContent = `${completed} из 3 шагов`;

    // Подсветка точек прогресса
    const dotsWrap = document.getElementById('onboarding-banner-dots');
    if (dotsWrap) {
      dotsWrap.querySelectorAll('span[data-step]').forEach((dot) => {
        const n = Number(dot.dataset.step);
        const done = (n === 1 && step1) || (n === 2 && step2) || (n === 3 && step3);
        dot.classList.toggle('done', done);
        const activeStep = step1 ? (step2 ? 3 : 2) : 1;
        dot.classList.toggle('active', !done && n === activeStep);
      });
    }

    banner.hidden = false;
  },
};

window.Onboarding = Onboarding;
