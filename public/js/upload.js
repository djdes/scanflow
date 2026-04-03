/* global App, Upload */
const Upload = {
  initialized: false,

  init() {
    if (this.initialized) return;
    this.initialized = true;

    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    dropZone.addEventListener('click', () => fileInput.click());

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
      if (e.dataTransfer.files.length > 0) {
        this.uploadFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        this.uploadFile(fileInput.files[0]);
        fileInput.value = '';
      }
    });
  },

  uploadFile(file) {
    const allowed = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      App.notify('Неподдерживаемый формат: ' + ext, 'error');
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      App.notify('Файл слишком большой (макс. 20 МБ)', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    const progressBar = document.getElementById('upload-progress');
    const progressFill = document.getElementById('upload-progress-fill');
    const resultDiv = document.getElementById('upload-result');

    progressBar.style.display = 'block';
    progressFill.style.width = '0%';
    resultDiv.style.display = 'none';

    const xhr = new XMLHttpRequest();

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = pct + '%';
      }
    });

    xhr.addEventListener('load', () => {
      progressFill.style.width = '100%';
      try {
        const resp = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resultDiv.style.display = 'block';
          resultDiv.innerHTML = `
            <div class="card" style="background:#f0fdf4;border-color:#bbf7d0">
              <strong>Файл обработан!</strong><br>
              Накладная ID: <a href="#/invoices/${resp.invoice_id}" style="color:var(--primary);font-weight:600">#${resp.invoice_id}</a>
              <br><br>
              <button class="btn btn-primary btn-sm" onclick="App.navigate('#/invoices/${resp.invoice_id}')">Открыть накладную</button>
            </div>
          `;
          App.notify('Файл успешно обработан', 'success');
        } else {
          resultDiv.style.display = 'block';
          resultDiv.innerHTML = `
            <div class="card" style="background:#fef2f2;border-color:#fecaca">
              <strong>Ошибка!</strong><br>${resp.error || 'Неизвестная ошибка'}
            </div>
          `;
          App.notify('Ошибка обработки файла', 'error');
        }
      } catch {
        resultDiv.style.display = 'block';
        resultDiv.innerHTML = `<div class="card" style="background:#fef2f2;border-color:#fecaca">
          <strong>Ошибка!</strong><br>HTTP ${xhr.status}: ${xhr.statusText}
        </div>`;
      }
    });

    xhr.addEventListener('error', () => {
      App.notify('Ошибка сети', 'error');
      progressBar.style.display = 'none';
    });

    xhr.open('POST', App.baseUrl + '/upload');
    xhr.setRequestHeader('X-API-Key', App.apiKey);
    xhr.send(formData);
  }
};
