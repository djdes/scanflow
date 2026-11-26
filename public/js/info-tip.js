// Значок «i» с подсказкой — пояснения не занимают место на экране:
//   <button type="button" class="info-tip" data-tip="Текст подсказки" aria-label="Подробнее">i</button>
// Наведение или фокус показывают подсказку, нажатие (телефон) — показывает и
// прячет. Подсказка — в <body> с position: fixed и не выходит за края экрана.
(function () {
  let tip = null;
  let anchor = null;
  let shownAt = 0;

  function hide() {
    if (tip) { tip.remove(); tip = null; }
    if (anchor) { anchor.setAttribute('aria-expanded', 'false'); anchor = null; }
  }

  function show(el) {
    if (anchor === el) return;
    hide();
    anchor = el;
    shownAt = Date.now();
    el.setAttribute('aria-expanded', 'true');
    tip = document.createElement('div');
    tip.className = 'info-tip__pop';
    tip.setAttribute('role', 'tooltip');
    tip.textContent = el.dataset.tip || '';
    document.body.appendChild(tip);
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  const tipOf = (target) => (target && target.closest ? target.closest('.info-tip') : null);

  document.addEventListener('mouseover', (e) => { const el = tipOf(e.target); if (el) show(el); });
  document.addEventListener('mouseout', (e) => {
    const el = tipOf(e.target);
    if (el && !el.contains(e.relatedTarget) && document.activeElement !== el) hide();
  });
  document.addEventListener('focusin', (e) => { const el = tipOf(e.target); if (el) show(el); });
  document.addEventListener('focusout', (e) => { if (tipOf(e.target)) hide(); });
  document.addEventListener('click', (e) => {
    const el = tipOf(e.target);
    if (!el) { hide(); return; }
    e.preventDefault();
    e.stopPropagation();
    // Касание сначала даёт фокус (подсказка уже открыта) — то же касание её не закрывает.
    if (anchor === el && Date.now() - shownAt > 400) hide(); else show(el);
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
})();
