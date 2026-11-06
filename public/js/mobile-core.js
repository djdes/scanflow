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
   */
  uploadSummary(history, online, serverQueued = 0, aiAvailable = true) {
    const count = (...st) => history.filter(h => st.includes(h.status)).length;
    const failed = count('error', 'lost');
    const sending = count('queued', 'uploading');
    const reading = Math.max(count('server_queued', 'processing'), Number(serverQueued) || 0);
    if (failed && !online) return { tone: 'amber', text: 'Нет интернета. Фото сохранены — отправим сами.' };
    if (sending) return { tone: 'blue', text: `Отправляем ${sending} фото…` };
    if (failed) return { tone: 'red', text: `Не отправилось ${failed} фото. Повторим сами.` };
    if (reading && !aiAvailable) return { tone: 'amber', text: `Фото сохранены (${reading}). Прочитаем позже.` };
    if (reading) return { tone: 'blue', text: `Читаем ${reading} фото…` };
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
};

if (typeof window !== 'undefined') window.MobileCore = MobileCore;
