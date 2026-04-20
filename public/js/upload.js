/* global App, Upload */
const Upload = {
  initialized: false,
  // Carousel state: array of { file, objectUrl, status, invoiceId, error }
  slides: [],
  currentIndex: 0,

  init() {
    if (this.initialized) return;
    this.initialized = true;

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', (e) => {
      // Don't trigger file picker when clicking on the preview info links
      if (e.target.closest('.upload-preview-info a')) return;
      if (e.target.closest('button')) return;
      fileInput.click();
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) this.addFiles(files);
    });

    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files);
      if (files.length > 0) this.addFiles(files);
      fileInput.value = '';
    });
  },

  addFiles(files) {
    const allowed = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp'];
    for (const file of files) {
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      if (!allowed.includes(ext)) {
        App.notify(`Пропущен: ${file.name} (неподдерживаемый формат)`, 'error');
        continue;
      }
      if (file.size > 20 * 1024 * 1024) {
        App.notify(`Пропущен: ${file.name} (больше 20 МБ)`, 'error');
        continue;
      }
      const objectUrl = URL.createObjectURL(file);
      this.slides.push({
        file,
        objectUrl,
        status: 'pending',    // pending | uploading | done | error
        invoiceId: null,
        error: null,
      });
    }
    // Jump to the first new file and start uploading
    this.currentIndex = this.slides.length - files.length;
    if (this.currentIndex < 0) this.currentIndex = 0;
    this.renderSlide();
    this.uploadPending();
  },

  renderSlide() {
    const placeholder = document.getElementById('drop-placeholder');
    const preview = document.getElementById('upload-preview');
    const previewImg = document.getElementById('upload-preview-img');
    const previewInfo = document.getElementById('upload-preview-info');
    const counter = document.getElementById('upload-counter');
    const bottomBtns = document.getElementById('upload-bottom-buttons');

    if (this.slides.length === 0) {
      placeholder.style.display = '';
      preview.style.display = 'none';
      counter.textContent = '';
      bottomBtns.style.display = 'none';
      return;
    }

    placeholder.style.display = 'none';
    preview.style.display = 'flex';

    const slide = this.slides[this.currentIndex];
    previewImg.src = slide.objectUrl;

    let infoHtml = `<span class="upload-filename">${this.esc(slide.file.name)}</span>`;
    if (slide.status === 'uploading') {
      infoHtml += ' <span class="upload-status upload-status-uploading">Обработка...</span>';
    } else if (slide.status === 'done') {
      infoHtml += ` <span class="upload-status upload-status-done">Готово</span>`;
      infoHtml += ` <a href="#/invoices/${slide.invoiceId}" class="upload-link">Накладная #${slide.invoiceId}</a>`;
    } else if (slide.status === 'error') {
      infoHtml += ` <span class="upload-status upload-status-error">${this.esc(slide.error || 'Ошибка')}</span>`;
      infoHtml += ` <button type="button" class="upload-retry-btn" onclick="Upload.retrySlide(${this.currentIndex})">↻ Повторить</button>`;
    }
    previewInfo.innerHTML = infoHtml;

    counter.textContent = `${this.currentIndex + 1} / ${this.slides.length}`;

    // Show bottom bar if any done or any errors
    const doneCount = this.slides.filter(s => s.status === 'done').length;
    const errorCount = this.slides.filter(s => s.status === 'error').length;
    bottomBtns.style.display = (doneCount > 0 || errorCount > 0) ? '' : 'none';

    const openAllBtn = bottomBtns.querySelector('.upload-btn-open-all');
    if (openAllBtn) openAllBtn.style.display = doneCount > 0 ? '' : 'none';

    const retryAllBtn = document.getElementById('upload-btn-retry-all');
    const errorsCountEl = document.getElementById('upload-errors-count');
    if (retryAllBtn) retryAllBtn.style.display = errorCount > 0 ? '' : 'none';
    if (errorsCountEl) errorsCountEl.textContent = String(errorCount);

    // Arrow visibility
    document.querySelector('.upload-arrow-left').style.visibility =
      this.currentIndex > 0 ? 'visible' : 'hidden';
    document.querySelector('.upload-arrow-right').style.visibility =
      this.currentIndex < this.slides.length - 1 ? 'visible' : 'hidden';
  },

  prevSlide() {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      this.renderSlide();
    }
  },

  nextSlide() {
    if (this.currentIndex < this.slides.length - 1) {
      this.currentIndex++;
      this.renderSlide();
    }
  },

  async uploadPending() {
    for (const slide of this.slides) {
      if (slide.status !== 'pending') continue;
      slide.status = 'uploading';
      this.renderSlide();
      await this.uploadOneFile(slide);
      this.renderSlide();
    }
  },

  async uploadOneFile(slide) {
    const formData = new FormData();
    formData.append('file', slide.file);

    const progressBar = document.getElementById('upload-progress');
    const progressFill = document.getElementById('upload-progress-fill');

    progressBar.style.display = 'block';
    progressFill.style.width = '0%';

    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          progressFill.style.width = Math.round((e.loaded / e.total) * 100) + '%';
        }
      });

      xhr.addEventListener('load', () => {
        progressFill.style.width = '100%';
        let resp = {};
        try { resp = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) {
          slide.status = 'done';
          slide.invoiceId = resp.invoice_id;
          App.notify(`${slide.file.name} обработан`, 'success');
        } else if (xhr.status === 429) {
          // Rate-limited. Honor the RateLimit-Reset header so we don't
          // hammer the server into refusing the whole queue.
          const retryAfter = parseInt(xhr.getResponseHeader('RateLimit-Reset') || xhr.getResponseHeader('Retry-After') || '60', 10);
          slide.status = 'error';
          slide.error = `Слишком много загрузок, подожди ${retryAfter}с`;
          slide._retryAfterMs = Math.max(1, retryAfter) * 1000;
        } else {
          slide.status = 'error';
          slide.error = resp.error || `HTTP ${xhr.status}`;
        }
        progressBar.style.display = 'none';
        resolve();
      });

      xhr.addEventListener('error', () => {
        slide.status = 'error';
        slide.error = 'Ошибка сети';
        progressBar.style.display = 'none';
        resolve();
      });

      xhr.open('POST', App.baseUrl + '/upload');
      xhr.setRequestHeader('X-API-Key', App.apiKey);
      xhr.send(formData);
    });
  },

  async retryAllErrors() {
    let found = 0;
    let maxWaitMs = 0;
    for (const slide of this.slides) {
      if (slide.status === 'error') {
        if (slide._retryAfterMs && slide._retryAfterMs > maxWaitMs) {
          maxWaitMs = slide._retryAfterMs;
        }
        slide.status = 'pending';
        slide.error = null;
        slide.invoiceId = null;
        slide._retryAfterMs = null;
        found++;
      }
    }
    if (found === 0) return;
    // Jump to first error-turned-pending for visibility
    const firstIdx = this.slides.findIndex(s => s.status === 'pending');
    if (firstIdx >= 0) this.currentIndex = firstIdx;
    this.renderSlide();
    if (maxWaitMs > 0) {
      App.notify(`Ждём ${Math.ceil(maxWaitMs / 1000)}с до сброса лимита...`, 'info');
      await new Promise(r => setTimeout(r, maxWaitMs));
    }
    await this.uploadPending();
  },

  async retrySlide(index) {
    const slide = this.slides[index];
    if (!slide || slide.status === 'uploading') return;
    const waitMs = slide._retryAfterMs || 0;
    slide.status = 'pending';
    slide.error = null;
    slide.invoiceId = null;
    slide._retryAfterMs = null;
    this.renderSlide();
    if (waitMs > 0) {
      App.notify(`Ждём ${Math.ceil(waitMs / 1000)}с до сброса лимита...`, 'info');
      await new Promise(r => setTimeout(r, waitMs));
    }
    await this.uploadPending();
  },

  clearAll() {
    // Release object URLs
    for (const slide of this.slides) {
      if (slide.objectUrl) URL.revokeObjectURL(slide.objectUrl);
    }
    this.slides = [];
    this.currentIndex = 0;
    this.renderSlide();
    document.getElementById('upload-result').innerHTML = '';
    document.getElementById('upload-result').style.display = 'none';
  },

  openAllResults() {
    const doneIds = this.slides
      .filter(s => s.status === 'done' && s.invoiceId)
      .map(s => s.invoiceId);
    if (doneIds.length === 0) return;
    // Navigate to the first one
    App.navigate(`#/invoices/${doneIds[0]}`);
  },

  esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },
};
