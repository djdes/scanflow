// Мобильное приложение /m/ — чистая логика без DOM (спек 2026-11-06-mobile-app).
// Правило текста: крупно, простыми словами, коротко. Порядок проверок статуса
// повторяет _onecPill в invoices.js, чтобы телефон и кабинет не расходились.
const MobileCore = {
  REASONS: {
    incomplete_pages: 'Не все листы. Доснимите.',
    total: 'Сумма не сходится.',
    header: 'Нет номера, даты или поставщика.',
    items: 'Нет товаров.',
    quantity: 'Проверьте количество.',
    mapping: 'Есть новые товары.',
    supplier: 'Проверьте поставщика.',
    duplicate: 'Похоже на повтор.',
  },

  // Значок плашки — по цвету, чтобы статус читался и без различения цветов:
  // синий — ждём, зелёный — можно отправлять, янтарный — проверить,
  // красный — ошибка, серый — дело сделано.
  TONE_ICON: { blue: 'clock', green: 'send', amber: 'alert', red: 'cross', grey: 'check' },

  /** Плашка, пояснение в одно предложение, значок и главная кнопка накладной. */
  invoiceState(inv) {
    const s = (tone, label, hint, action = null) => ({ tone, label, hint, action, icon: this.TONE_ICON[tone] });
    const status = inv.status;
    if (inv.duplicate_of || status === 'duplicate') return s('amber', 'Уже есть', 'Такую накладную уже загружали.');
    if (status === 'error' || status === 'failed') return s('red', 'Не прочиталась', 'Переснимите при хорошем свете.', 'retake');
    if (status === 'waiting_ai') return s('blue', 'Прочитаем позже', 'Фото сохранено. Прочитаем сами.');
    if (['new', 'ocr_processing', 'parsing'].includes(status)) return s('blue', 'Читаем', 'Обычно до минуты.');
    if (['error', 'rejected'].includes(inv.onec_status)) {
      return s('red', '1С не приняла', String(inv.onec_error || '').trim() || 'Откройте и проверьте.', 'review');
    }
    if (status === 'sent_to_1c') return s('grey', 'В 1С', 'Накладная уже в 1С.');
    if (inv.approved_for_1c) return s('blue', 'Ждёт 1С', '1С заберёт сама.');
    if (inv.review_reason || inv.sibling_is_copy) {
      const reason = inv.review_reason || 'duplicate';
      return s('amber', 'Проверить', this.REASONS[reason] || 'Откройте и проверьте.', 'review');
    }
    if (status === 'processed') return s('green', 'Готова', 'Можно отправлять в 1С.', 'send');
    return { ...s('grey', String(status || '—'), ''), icon: null };
  },

  /** Накладная ещё читается — экран стоит обновлять сам. */
  isReading(inv) {
    return ['new', 'ocr_processing', 'parsing'].includes(inv.status) && !inv.duplicate_of;
  },

  /** 12 400 ₽ / 12 400,50 ₽ — неразрывные пробелы, чтобы сумма не ломалась. */
  formatMoney(value) {
    if (value == null || value === '') return '—';
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    const [int, frac] = Math.abs(n).toFixed(2).split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${n < 0 ? '−' : ''}${grouped}${frac === '00' ? '' : ',' + frac} ₽`;
  },

  /** «05.11» в этом году, «31.12.2025» — в другом. База отдаёт даты строками. */
  formatShortDate(value, now = new Date()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    if (!m) return '';
    return Number(m[1]) === now.getFullYear() ? `${m[3]}.${m[2]}` : `${m[3]}.${m[2]}.${m[1]}`;
  },

  /** «сегодня», «вчера» или «05.11»: так быстрее, чем считать по календарю. */
  relativeDay(value, now = new Date()) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    if (!m) return '';
    const day = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return 'сегодня';
    if (diff === 1) return 'вчера';
    return this.formatShortDate(value, now);
  },

  /** «05.11.2026» — полная дата для карточки накладной. */
  formatDate(value) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
  },

  plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  },

  /**
   * Одна строка о фото на устройстве; null — показывать нечего. serverQueued —
   * задания компании в очереди сервера (видны и после перезапуска приложения),
   * aiAvailable=false — чтение на паузе (нет связи с моделью, лимит).
   * retry — показать «Повторить», dismiss — «Убрать»: окончательные ошибки
   * (плохой файл, фото другого входа, потерянное) сами не повторятся.
   */
  uploadSummary(history, online, serverQueued = 0, aiAvailable = true) {
    const count = (...st) => history.filter(h => st.includes(h.status)).length;
    const retrying = history.filter(h => h.status === 'error' && h.autoRetry).length;
    const final = history.filter(h => (h.status === 'error' && !h.autoRetry) || h.status === 'lost');
    const sending = count('queued', 'uploading');
    const reading = Math.max(count('server_queued', 'processing'), Number(serverQueued) || 0);
    const bar = (tone, text, extra = {}) => ({ tone, text, retry: false, dismiss: false, ...extra });
    if (retrying && !online) return bar('amber', 'Нет интернета. Фото сохранены — отправим сами.');
    if (sending) return bar('blue', `Отправляем ${sending} фото…`);
    if (final.length) {
      const reason = final.length === 1 && final[0].error ? ` ${String(final[0].error).replace(/\.?$/, '.')}` : '';
      return bar('red', `Не отправилось ${final.length} фото.${reason}`, { dismiss: true });
    }
    if (retrying) return bar('red', `Не отправилось ${retrying} фото. Повторим сами.`, { retry: true });
    if (reading && !aiAvailable) return bar('amber', `Фото сохранены (${reading}). Прочитаем позже.`);
    if (reading) return bar('blue', `Читаем ${reading} фото…`);
    return null;
  },

  /** Текст ответа на «Отправить в 1С». */
  sendResultText(status, body) {
    if (status >= 200 && status < 300) return { ok: true, text: 'Отправлено. 1С заберёт сама.' };
    if (body && body.code === 'incomplete_pages') return { ok: false, text: 'Не все листы. Доснимите.' };
    if (body && body.needs_approval) return { ok: false, text: 'Нужно согласование. Сумма выше лимита.' };
    return { ok: false, text: (body && body.error) || 'Не получилось. Попробуйте ещё раз.' };
  },

  /** Фото, ещё не принятые сервером: при выходе их надо удалить, иначе они уйдут под следующим входом. */
  logoutWarning(history) {
    const n = history.filter(h => ['queued', 'uploading', 'error'].includes(h.status)).length;
    return n ? `Не отправлено фото: ${n}. Если выйти, они удалятся.` : null;
  },

  /** Как установить: уже стоит / iPhone (через «Поделиться») / Android / прочее. */
  installHint(ua, standalone, maxTouchPoints = 0) {
    if (standalone) return 'installed';
    const s = String(ua || '');
    if (/iPhone|iPad|iPod/.test(s) || (/Macintosh/.test(s) && maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(s)) return 'android';
    return 'other';
  },

  /**
   * Какую подсказку установки показать внизу экрана, null — никакую:
   * ios-safari — «Поделиться» → «На экран Домой» со стрелкой вниз к панели Safari;
   * ios-other — Chrome, Firefox и др. на iPhone: те же шаги из строки адреса;
   * ios-inapp — встроенный браузер соцсети: на экран «Домой» оттуда не добавить;
   * android-prompt — есть системное окно установки (beforeinstallprompt);
   * android-menu — его нет (Samsung, Яндекс, Firefox): через меню браузера.
   */
  installVariant(ua, standalone, maxTouchPoints, hasPrompt) {
    const kind = this.installHint(ua, standalone, maxTouchPoints);
    const s = String(ua || '');
    if (kind === 'ios') {
      if (/FBAN|FBAV|Instagram|Line\/|VKClient|OKApp|MicroMessenger/.test(s)) return 'ios-inapp';
      return /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser|GSA\//.test(s) ? 'ios-other' : 'ios-safari';
    }
    if (kind === 'android') return hasPrompt ? 'android-prompt' : 'android-menu';
    return null;
  },

  /**
   * Имя файла из «Поделиться»: у части приложений (галерея, почта) файл приходит
   * без расширения, а загрузчик принимает файл по расширению. Добавляем его по типу.
   */
  sharedFileName(name, type) {
    const base = String(name || '').trim() || 'shared';
    if (/\.(jpe?g|png|webp|bmp|tiff?|pdf|xml)$/i.test(base)) return base;
    const ext = {
      'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
      'application/pdf': 'pdf', 'text/xml': 'xml', 'application/xml': 'xml',
    }[String(type || '').toLowerCase()];
    return ext ? `${base}.${ext}` : base;
  },

  /** Прошло ли больше days дней с отметки at (мс); нет отметки — да. */
  due(at, days, now = Date.now()) {
    const t = Number(at);
    return !Number.isFinite(t) || t <= 0 || now - t > days * 24 * 60 * 60 * 1000;
  },

  /** Показывать ли подсказку снова: «Не сейчас» прячет её на 14 дней. */
  installDue(dismissedAt, now = Date.now()) {
    return this.due(dismissedAt, 14, now);
  },

  /**
   * Уведомления на этом телефоне: on / off / denied (запрещены в настройках) /
   * install-first (iPhone: только у приложения на экране «Домой», iOS 16.4+) /
   * unsupported (браузер не умеет — пункт не показываем).
   */
  pushState({ supported, ios, standalone, permission, subscribed }) {
    if (!supported) return ios && !standalone ? 'install-first' : 'unsupported';
    if (permission === 'denied') return 'denied';
    return subscribed && permission === 'granted' ? 'on' : 'off';
  },

  /**
   * Яркость и резкость снимка по серому уменьшенному изображению (около 640 px):
   * средняя яркость 0–255 и дисперсия лапласиана — чем меньше, тем мутнее.
   */
  photoStats(gray, width, height) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    let s = 0, s2 = 0, n = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
        s += lap; s2 += lap * lap; n++;
      }
    }
    const mean = n ? s / n : 0;
    return { brightness: gray.length ? sum / gray.length : 0, sharpness: n ? s2 / n - mean * mean : 0 };
  },

  /**
   * Что не так со снимком: 'dark', 'blurry' или null. Пороги — с запасом
   * (лист в тени у окна и лёгкая нерезкость читаются): спрашиваем только о
   * явно плохом фото, иначе вопрос стал бы привычным «Отправить так».
   */
  photoIssue(stats) {
    if (!stats || !Number.isFinite(stats.brightness) || !Number.isFinite(stats.sharpness)) return null;
    if (stats.brightness < 70) return 'dark';
    if (stats.sharpness < 150) return 'blurry';
    return null;
  },
};

if (typeof window !== 'undefined') window.MobileCore = MobileCore;
