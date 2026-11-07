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

  /** Плашка, пояснение в одно предложение и главная кнопка накладной. */
  invoiceState(inv) {
    const s = (tone, label, hint, action = null) => ({ tone, label, hint, action });
    const status = inv.status;
    if (inv.duplicate_of || status === 'duplicate') return s('amber', 'Уже есть', 'Такую накладную уже загружали.');
    if (status === 'error' || status === 'failed') return s('red', 'Не прочиталась', 'Переснимите при хорошем свете.', 'retake');
    if (status === 'waiting_ai') return s('blue', 'Прочитаем позже', 'Фото сохранено. Прочитаем сами.');
    if (['new', 'ocr_processing', 'parsing'].includes(status)) return s('blue', 'Читаем', 'Обычно до минуты.');
    if (['error', 'rejected'].includes(inv.onec_status)) {
      return s('red', '1С не приняла', String(inv.onec_error || '').trim() || 'Откройте и проверьте.', 'review');
    }
    if (status === 'sent_to_1c') return s('grey', 'В 1С ✓', 'Накладная уже в 1С.');
    if (inv.approved_for_1c) return s('blue', 'Ждёт 1С', '1С заберёт сама.');
    if (inv.review_reason || inv.sibling_is_copy) {
      const reason = inv.review_reason || 'duplicate';
      return s('amber', 'Проверить', this.REASONS[reason] || 'Откройте и проверьте.', 'review');
    }
    if (status === 'processed') return s('green', 'Готова', 'Можно отправлять в 1С.', 'send');
    return s('grey', String(status || '—'), '');
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

  /** Показывать ли подсказку снова: «Не сейчас» прячет её на 14 дней. */
  installDue(dismissedAt, now = Date.now()) {
    const at = Number(dismissedAt);
    return !Number.isFinite(at) || at <= 0 || now - at > 14 * 24 * 60 * 60 * 1000;
  },
};

if (typeof window !== 'undefined') window.MobileCore = MobileCore;
