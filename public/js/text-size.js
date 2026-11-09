// Размер текста в полном кабинете: «Обычный / Крупный / Огромный» внизу меню.
// Шрифты кабинета — в rem, ступень — html[data-text] (style.css). Выбор общий
// с приложением /m/ (localStorage['sf-text']): выбрали крупный на телефоне —
// кабинет на том же телефоне тоже крупный. Ставится до отрисовки инлайн-
// скриптом в <head> app.html; здесь — переключатель и другие вкладки.
(function () {
  const KEY = 'sf-text';
  const valid = (v) => (v === 'l' || v === 'xl' ? v : 'm');

  function apply(size) {
    const root = document.documentElement;
    if (size === 'm') root.removeAttribute('data-text');
    else root.setAttribute('data-text', size);
    document.querySelectorAll('[data-text-size]').forEach((btn) => {
      btn.setAttribute('aria-checked', String(btn.dataset.textSize === size));
    });
  }

  function current() {
    try { return valid(localStorage.getItem(KEY)); } catch { return valid(document.documentElement.dataset.text); }
  }

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-text-size]');
    if (!btn) return;
    const size = valid(btn.dataset.textSize);
    try { localStorage.setItem(KEY, size); } catch { /* приватный режим — только до перезагрузки */ }
    apply(size);
  });

  // Стрелки внутри группы — как у обычных переключателей.
  document.addEventListener('keydown', (e) => {
    const btn = e.target.closest && e.target.closest('[data-text-size]');
    if (!btn || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const all = Array.from(btn.parentElement.querySelectorAll('[data-text-size]'));
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = all[(all.indexOf(btn) + step + all.length) % all.length];
    e.preventDefault();
    next.focus();
    next.click();
  });

  // Поменяли в другой вкладке или в приложении /m/ — здесь тоже.
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply(valid(e.newValue)); });

  apply(current());
})();
