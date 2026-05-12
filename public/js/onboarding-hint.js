/* global App, OnboardingHint */
// Coach-mark / spotlight для онбординг-перехода.
//
// Когда пользователь кликает CTA в #/onboarding (например «Загрузить
// накладную»), onboarding.js пишет в localStorage флаг `sf-onboarding-hint`
// со значением `upload` или `sber`. После навигации на целевую страницу
// этот модуль:
//   1. Дожидается пока нужный таргет-элемент появится в DOM.
//   2. Подсвечивает его (выпадает из dark backdrop'а), рисует стрелку и
//      подсказку с инструкцией.
//   3. Снимает overlay по любому клику внутри tooltip'а или по самому
//      таргету (а также по Escape) — и чистит флаг.
//
// Конфигурация подсказок — таблица `HINTS` ниже. Каждая запись:
//   - route: hash-маршрут, на котором она применима
//   - selector: что подсветить
//   - title / body: текст в подсказке
//   - placement: 'top' | 'bottom' | 'left' | 'right' (откуда стрелка)
const OnboardingHint = {
  LS_KEY: 'sf-onboarding-hint',

  HINTS: {
    upload: {
      route: '#/upload',
      selector: '#btn-capture',
      title: 'Сделайте фото или выберите файл',
      body: 'Сфотографируйте бумажную накладную на камеру или нажмите «Сфотографировать» — за 3 секунды ScanFlow её распознает.',
      placement: 'top',
    },
    sber: {
      route: '#/sber',
      selector: '#sber-connect-oauth',
      title: 'Подключите СберБизнес',
      body: 'Нажмите, чтобы войти через OAuth — после этого ScanFlow сможет создавать черновики платёжек прямо в вашем интернет-банке.',
      placement: 'bottom',
    },
  },

  _overlay: null,
  _activeTarget: null,
  _resizeRaf: null,

  read() {
    return localStorage.getItem(this.LS_KEY) || null;
  },

  clear() {
    localStorage.removeItem(this.LS_KEY);
  },

  // Public — App.route() зовёт это после каждой смены hash'а.
  apply(currentHash) {
    const hint = this.read();
    if (!hint) {
      this.dismiss();
      return;
    }
    const cfg = this.HINTS[hint];
    if (!cfg) { this.clear(); return; }
    if (currentHash !== cfg.route) {
      // Юзер ушёл на другую страницу не дойдя до цели — снимаем hint
      // (не агрессивно: если он вернётся на правильный route, hint всё
      // равно уже очищен; в нашем потоке это нормально).
      this.dismiss();
      this.clear();
      return;
    }
    // Ждём пока таргет появится — некоторые вью лениво рендерятся
    this._waitForTarget(cfg.selector, 2000).then((target) => {
      if (!target) return;
      this._render(target, cfg);
    });
  },

  _waitForTarget(selector, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const el = document.querySelector(selector);
        if (el) return resolve(el);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        requestAnimationFrame(check);
      };
      check();
    });
  },

  _render(target, cfg) {
    this.dismiss(); // снять предыдущий, если был

    // Прокрутить таргет в видимую зону
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });

    // Овлерлей со «вырезом» делаем через 4 div'а вокруг таргета — так
    // и блокируется клик за пределами таргета, и можно нормально клик
    // самого таргета пропустить вниз без z-index хаков. Каждый из 4
    // div'ов закрывает свою сторону вокруг bounding box.
    const overlay = document.createElement('div');
    overlay.className = 'onb-hint-overlay';
    overlay.innerHTML = `
      <div class="onb-hint-mask onb-hint-mask--top"></div>
      <div class="onb-hint-mask onb-hint-mask--right"></div>
      <div class="onb-hint-mask onb-hint-mask--bottom"></div>
      <div class="onb-hint-mask onb-hint-mask--left"></div>
      <div class="onb-hint-ring"></div>
      <div class="onb-hint-arrow" aria-hidden="true">
        <svg width="36" height="44" viewBox="0 0 36 44" fill="none">
          <path d="M18 4 V36 M8 26 L18 36 L28 26" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="onb-hint-tooltip" role="dialog" aria-live="polite">
        <button class="onb-hint-close" aria-label="Закрыть подсказку">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        </button>
        <div class="onb-hint-tooltip__head">
          <span class="onb-hint-tooltip__badge">Онбординг</span>
          <h4 class="onb-hint-tooltip__title">${this._esc(cfg.title)}</h4>
        </div>
        <p class="onb-hint-tooltip__body">${this._esc(cfg.body)}</p>
        <div class="onb-hint-tooltip__actions">
          <button type="button" class="btn btn-primary btn-sm onb-hint-tooltip__got-it">Понятно</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this._overlay = overlay;
    this._activeTarget = target;

    overlay.querySelector('.onb-hint-close').addEventListener('click', () => this._dismiss());
    overlay.querySelector('.onb-hint-tooltip__got-it').addEventListener('click', () => this._dismiss());
    // Клик по самой подсветке таргета: тоже снимаем (юзер собрался жать)
    target.addEventListener('click', this._onTargetClick = () => this._dismiss(), { once: true });

    // Escape — снять
    document.addEventListener('keydown', this._onKey = (e) => {
      if (e.key === 'Escape') this._dismiss();
    });

    // Расчёт позиций
    this._reflow(target, cfg);
    window.addEventListener('resize', this._onResize = () => {
      cancelAnimationFrame(this._resizeRaf);
      this._resizeRaf = requestAnimationFrame(() => this._reflow(target, cfg));
    });
    window.addEventListener('scroll', this._onResize, { passive: true });
  },

  _reflow(target, cfg) {
    const r = target.getBoundingClientRect();
    const pad = 12; // воздух между таргетом и подсветкой
    const top = r.top - pad;
    const left = r.left - pad;
    const right = window.innerWidth - r.right - pad;
    const bottom = window.innerHeight - r.bottom - pad;
    const width = r.width + pad * 2;
    const height = r.height + pad * 2;

    const o = this._overlay;
    o.querySelector('.onb-hint-mask--top').style.cssText =
      `position:fixed;left:0;top:0;width:100%;height:${Math.max(0, top)}px`;
    o.querySelector('.onb-hint-mask--bottom').style.cssText =
      `position:fixed;left:0;bottom:0;width:100%;height:${Math.max(0, bottom)}px`;
    o.querySelector('.onb-hint-mask--left').style.cssText =
      `position:fixed;left:0;top:${Math.max(0, top)}px;width:${Math.max(0, left)}px;height:${height}px`;
    o.querySelector('.onb-hint-mask--right').style.cssText =
      `position:fixed;right:0;top:${Math.max(0, top)}px;width:${Math.max(0, right)}px;height:${height}px`;

    const ring = o.querySelector('.onb-hint-ring');
    ring.style.cssText =
      `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;` +
      `border-radius:14px;pointer-events:none`;

    // Tooltip + arrow positioning. Меряем реальную высоту tooltip'а после
    // вставки в DOM, чтобы стрелка не залезала под него.
    const tooltip = o.querySelector('.onb-hint-tooltip');
    const arrow = o.querySelector('.onb-hint-arrow');
    const placement = cfg.placement || 'bottom';
    const tWidth = 320; const arrowGap = 14;

    // Сначала ставим tooltip за viewport, измеряем высоту, потом позиционируем
    tooltip.style.cssText = `position:fixed;top:-9999px;left:-9999px;width:${tWidth}px`;
    const tHeight = tooltip.getBoundingClientRect().height || 200;
    const arrowH = 44;

    const targetCx = r.left + r.width / 2;
    const targetCy = r.top + r.height / 2;
    let tTop, tLeft, arrTop, arrLeft, arrRotate;

    // SVG-стрелка нарисована вершиной вниз (default rotate(0) → ↓).
    // На placement='top' tooltip над таргетом, стрелка между ними → ↓ (0deg).
    // На placement='bottom' tooltip под таргетом, стрелка → ↑ (180deg).
    if (placement === 'top') {
      arrTop = top - arrowH - 4;
      arrLeft = targetCx - 18;
      arrRotate = 0;
      tTop = arrTop - tHeight - arrowGap;
      tLeft = Math.max(16, Math.min(window.innerWidth - tWidth - 16, targetCx - tWidth / 2));
    } else if (placement === 'bottom') {
      arrTop = top + height + 4;
      arrLeft = targetCx - 18;
      arrRotate = 180;
      tTop = arrTop + arrowH + arrowGap;
      tLeft = Math.max(16, Math.min(window.innerWidth - tWidth - 16, targetCx - tWidth / 2));
    } else if (placement === 'left') {
      arrTop = targetCy - 22;
      arrLeft = left - arrowH - 4;
      arrRotate = -90; // → таргет справа
      tTop = Math.max(16, targetCy - tHeight / 2);
      tLeft = arrLeft - tWidth - arrowGap;
    } else {
      arrTop = targetCy - 22;
      arrLeft = left + width + 4;
      arrRotate = 90; // ← таргет слева
      tTop = Math.max(16, targetCy - tHeight / 2);
      tLeft = arrLeft + arrowH + arrowGap;
    }

    // Если tooltip уехал за верх экрана — флипаем размещение вниз.
    if (placement === 'top' && tTop < 12) {
      arrTop = top + height + 4;
      arrRotate = 180; // показывает вверх на таргет
      tTop = arrTop + arrowH + arrowGap;
    }

    tooltip.style.cssText = `position:fixed;top:${tTop}px;left:${tLeft}px;width:${tWidth}px`;
    arrow.style.cssText = `position:fixed;top:${arrTop}px;left:${arrLeft}px;transform:rotate(${arrRotate}deg);--rot:${arrRotate}deg`;
  },

  _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _dismiss() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    if (this._activeTarget && this._onTargetClick) {
      this._activeTarget.removeEventListener('click', this._onTargetClick);
    }
    this._activeTarget = null;
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('scroll', this._onResize);
    }
    this.clear();
  },

  // Внешний dismiss (без чистки флага) — используется при смене страницы
  dismiss() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    this._activeTarget = null;
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
    if (this._onResize) {
      window.removeEventListener('resize', this._onResize);
      window.removeEventListener('scroll', this._onResize);
    }
  },
};

window.OnboardingHint = OnboardingHint;
