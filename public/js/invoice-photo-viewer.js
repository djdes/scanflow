/* global App */
// Read-only viewer: never rewrites the uploaded source or its OCR data.
const InvoicePhotoViewer = {
  open(pages, initialPage, title, onRotate) {
    if (!pages.length) return;
    this.close();
    this.pages = pages;
    this.index = Math.max(0, pages.findIndex(p => p.page === initialPage));
    this.onRotate = onRotate;
    this.returnFocus = document.activeElement;
    this.scrollBefore = document.body.style.overflow;
    const dialog = document.createElement('dialog');
    dialog.className = 'invoice-photo-dialog';
    dialog.setAttribute('aria-label', 'Просмотр фотографии накладной');
    dialog.innerHTML = `
      <div class="photo-viewer-header"><div><strong>${App.esc(title || 'Фото накладной')}</strong><span id="photo-viewer-page-label"></span></div><button type="button" data-action="close" aria-label="Закрыть просмотр">✕</button></div>
      <div class="photo-viewer-toolbar" aria-label="Управление фотографией">
        <button type="button" data-action="previous" aria-label="Предыдущий лист">←</button>
        <button type="button" data-action="next" aria-label="Следующий лист">→</button>
        <span class="photo-viewer-divider"></span>
        <button type="button" data-action="out" aria-label="Уменьшить">−</button>
        <output id="photo-viewer-zoom" aria-live="polite"></output>
        <button type="button" data-action="in" aria-label="Увеличить">＋</button>
        <button type="button" data-action="fit">Вписать</button>
        <button type="button" data-action="width">По ширине</button>
        <button type="button" data-action="rotate-left" aria-label="Повернуть влево">↺</button>
        <button type="button" data-action="rotate-right" aria-label="Повернуть вправо">↻</button>
      </div>
      <div class="photo-viewer-stage" tabindex="0" aria-label="Фото: увеличивайте двумя пальцами, перемещайте перетаскиванием">
        <img alt="" draggable="false"><div class="photo-viewer-error" hidden>Не удалось загрузить фото. <button type="button" data-action="retry">Повторить</button></div>
      </div>
      <div class="photo-viewer-pages" aria-label="Листы накладной"></div>
      <div class="photo-viewer-hint">Два пальца — увеличение · Перетаскивание — перемещение · ← → — листы · Esc — закрыть</div>`;
    document.body.append(dialog);
    this.dialog = dialog;
    this.stage = dialog.querySelector('.photo-viewer-stage');
    this.image = this.stage.querySelector('img');
    this.pointers = new Map();
    this.image.addEventListener('load', () => this.fit());
    this.image.addEventListener('error', () => {
      this.image.hidden = true;
      dialog.querySelector('.photo-viewer-error').hidden = false;
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    dialog.addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.page != null) this.select(Number(button.dataset.page));
      const action = button.dataset.action;
      if (action === 'close') this.close();
      if (action === 'previous') this.select(this.index - 1);
      if (action === 'next') this.select(this.index + 1);
      if (action === 'in') this.zoom(this.scale * 1.25);
      if (action === 'out') this.zoom(this.scale / 1.25);
      if (action === 'fit' || action === 'width') this.fit(action === 'width');
      if (action === 'rotate-left') this.rotate(-90);
      if (action === 'rotate-right') this.rotate(90);
      if (action === 'retry') this.select(this.index);
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); this.select(this.index - 1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); this.select(this.index + 1); }
      if (event.key === '+' || event.key === '=') { event.preventDefault(); this.zoom(this.scale * 1.25); }
      if (event.key === '-') { event.preventDefault(); this.zoom(this.scale / 1.25); }
      if (event.key === '0') { event.preventDefault(); this.fit(); }
    });
    this.stage.addEventListener('wheel', event => {
      event.preventDefault();
      this.zoom(this.scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    this.stage.addEventListener('dblclick', () => this.zoom(this.scale * 1.8));
    this.stage.addEventListener('pointerdown', event => {
      this.stage.setPointerCapture(event.pointerId);
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    });
    this.stage.addEventListener('pointermove', event => {
      if (!this.pointers.has(event.pointerId)) return;
      const old = this.pointers.get(event.pointerId);
      const before = [...this.pointers.values()];
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 1) {
        this.x += event.clientX - old.x;
        this.y += event.clientY - old.y;
        this.render();
      } else {
        const after = [...this.pointers.values()];
        const distance = p => Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const d = distance(before);
        if (d > 0) this.zoom(this.scale * distance(after) / d);
      }
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.stage.addEventListener(name, event => this.pointers.delete(event.pointerId));
    }
    this.resizeObserver = new ResizeObserver(() => { if (this.image.naturalWidth) this.fit(); });
    this.resizeObserver.observe(this.stage);
    document.body.style.overflow = 'hidden';
    dialog.showModal();
    this.select(this.index);
  },

  select(index) {
    if (!this.dialog || index < 0 || index >= this.pages.length) return;
    this.index = index;
    this.pointers.clear();
    const page = this.pages[index];
    this.rotation = page.rotation || 0;
    this.x = this.y = 0;
    this.scale = 1;
    this.image.hidden = false;
    this.dialog.querySelector('.photo-viewer-error').hidden = true;
    this.image.alt = `Лист ${page.page + 1}: ${page.name}`;
    this.image.src = page.src;
    this.dialog.querySelector('#photo-viewer-page-label').textContent = `Лист ${page.page + 1} · ${index + 1} из ${this.pages.length}`;
    this.dialog.querySelector('[data-action="previous"]').disabled = index === 0;
    this.dialog.querySelector('[data-action="next"]').disabled = index === this.pages.length - 1;
    this.dialog.querySelector('.photo-viewer-pages').innerHTML = this.pages.map((p, i) => `
      <button type="button" data-page="${i}" aria-label="Лист ${p.page + 1}" aria-pressed="${i === index}"><img src="${App.esc(p.src)}" alt="" loading="lazy"><span>Лист ${p.page + 1}</span></button>`).join('');
    if (this.image.complete && this.image.naturalWidth) this.fit();
  },

  fit(byWidth = false) {
    if (!this.dialog || !this.image.naturalWidth) return;
    const quarter = this.rotation % 180 !== 0;
    const w = quarter ? this.image.naturalHeight : this.image.naturalWidth;
    const h = quarter ? this.image.naturalWidth : this.image.naturalHeight;
    const widthScale = Math.max(1, this.stage.clientWidth - 32) / w;
    const heightScale = Math.max(1, this.stage.clientHeight - 32) / h;
    this.scale = byWidth ? widthScale : Math.min(widthScale, heightScale);
    this.x = this.y = 0;
    this.render();
  },

  zoom(scale) {
    if (!this.dialog || !Number.isFinite(scale) || !this.image.naturalWidth) return;
    this.scale = Math.max(0.03, Math.min(8, scale));
    this.render();
  },

  render() {
    if (!this.dialog) return;
    this.image.style.transform = `translate(-50%, -50%) translate(${this.x}px, ${this.y}px) scale(${this.scale}) rotate(${this.rotation}deg)`;
    this.dialog.querySelector('#photo-viewer-zoom').textContent = `${Math.round(this.scale * 100)}%`;
  },

  rotate(delta) {
    this.rotation = (this.rotation + delta + 360) % 360;
    this.pages[this.index].rotation = this.rotation;
    this.onRotate?.(this.pages[this.index].page, delta);
    this.fit();
  },

  close() {
    if (!this.dialog) return;
    this.resizeObserver?.disconnect();
    this.dialog.close();
    this.dialog.remove();
    this.dialog = null;
    document.body.style.overflow = this.scrollBefore || '';
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    this.pointers?.clear();
  },
};
