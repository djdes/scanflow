/* global App */
// Плашка внизу полного кабинета на телефоне: «есть приложение — крупно и просто».
// Ведёт в /m/, там же подсказка, как поставить его на экран (правило 48).
// Нет на компьютере, в установленном приложении и 14 дней после «×».
(function () {
  const KEY = 'sf-app-nudge-dismissed';
  const QUIET_MS = 14 * 24 * 60 * 60 * 1000;

  function standalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function dismissedRecently() {
    try { return Date.now() - (Number(localStorage.getItem(KEY)) || 0) < QUIET_MS; } catch { return false; }
  }

  function show() {
    if (!window.matchMedia('(max-width: 900px)').matches || standalone() || dismissedRecently()) return;
    if (typeof App !== 'undefined' && !App.apiKey) return;
    const el = document.createElement('div');
    el.className = 'app-nudge';
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Приложение для телефона');
    el.innerHTML = `
      <img class="app-nudge__icon" src="/icon-192.png" alt="" width="44" height="44">
      <div class="app-nudge__text"><strong>Приложение для телефона</strong><span>Крупно и просто: снять, проверить, отправить.</span></div>
      <a class="app-nudge__open" href="/m/">Открыть</a>
      <button type="button" class="app-nudge__close" aria-label="Закрыть">×</button>`;
    el.querySelector('.app-nudge__close').addEventListener('click', () => {
      try { localStorage.setItem(KEY, String(Date.now())); } catch { /* приватный режим */ }
      el.remove();
    });
    document.body.appendChild(el);
  }

  setTimeout(show, 2500);
})();
