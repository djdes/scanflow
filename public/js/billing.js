/* global App */
const Billing = {
  data: null,
  requestId: 0,

  async load() {
    const container = document.getElementById('billing-content');
    if (!container) return;
    const requestId = ++this.requestId;
    this.data = null;
    container.setAttribute('aria-busy', 'true');
    container.innerHTML = '<div class="billing-loading" role="status"><span class="sr-only">Загружаем сведения об оплате</span><div></div><div></div><div></div></div>';
    try {
      const { data } = await App.apiJson('/billing');
      if (requestId !== this.requestId) return;
      if (!data || data.mode !== 'beta' || !Array.isArray(data.plans) || data.payments?.enabled !== false) {
        throw new Error('Не удалось получить сведения об оплате');
      }
      this.data = data;
      this.render();
    } catch (error) {
      if (requestId !== this.requestId) return;
      container.innerHTML = `<div class="billing-error" role="alert"><h2>Не удалось загрузить раздел</h2><p>${App.esc(error.message || 'Проверьте подключение и попробуйте ещё раз.')}</p><button type="button" class="btn btn-outline" onclick="Billing.load()">Попробовать снова</button></div>`;
    } finally {
      if (requestId === this.requestId) container.setAttribute('aria-busy', 'false');
    }
  },

  money(kopecks) { return new Intl.NumberFormat('ru-RU').format(kopecks / 100) + ' ₽'; },






  render() {
    const container = document.getElementById('billing-content');
    if (!container || !this.data) return;
    const e = App.esc;
    const state = new URLSearchParams(location.hash.split('?')[1] || '').get('payment');
    const returnNote = ['returned', 'cancelled'].includes(state)
      ? '<div class="billing-return" role="status">Вы вернулись в раздел оплаты. Приём платежей ещё не открыт; статус доступа не изменился.</div>' : '';
    const sub = this.data.subscription || {};
    const hasCustomPlan = !!sub.planId;
    const accessTitle = hasCustomPlan ? `Тариф «${e(sub.name)}»` : 'Пользуйтесь бесплатно';
    const limitNote = sub.pageLimit != null
      ? `Лимит вашего аккаунта: ${e(new Intl.NumberFormat('ru-RU').format(sub.pageLimit))} страниц в месяц.`
      : 'Во время открытой беты все возможности ScanFlow доступны без оплаты и лимита страниц. О переходе на платные тарифы предупредим заранее.';
    const validUntil = sub.nextPaymentAt ? `<p class="billing-valid">Действует до ${e(App.formatDate(sub.nextPaymentAt))}</p>` : '';
    const priceRub = sub.monthlyPriceKopecks ? new Intl.NumberFormat('ru-RU').format(sub.monthlyPriceKopecks / 100) : '0';
    const current = hasCustomPlan ? sub.planId : null;

    // Открытая бета (2026-11-17): платить нечем и не за что — без пустых «Следующее списание:
    // не назначено», пустой истории платежей и карточки «Robokassa — скоро». Тарифы — для
    // сравнения, без кнопок «Посмотреть тариф», которые ничего не меняли.
    container.innerHTML = `${returnNote}
      <div class="billing-access">
        <div class="billing-access-main"><span class="billing-access-label">Ваш текущий доступ</span><h2>${accessTitle}</h2><p>${limitNote}</p>${validUntil}<a href="#/upload" class="btn btn-outline">Загрузить накладную</a></div>
        <div class="billing-access-price"><strong>${e(priceRub)} <span>₽</span></strong><span>за использование сервиса</span></div>
      </div>
      <div class="billing-block-heading"><h2>Тарифы после беты</h2><p>Для сравнения — сейчас выбирать ничего не нужно.</p></div>
      <div class="billing-plans" id="billing-plans" role="list" aria-label="Будущие тарифы">${this.data.plans.map(plan => `<article role="listitem" class="billing-plan ${plan.id === current ? 'is-selected' : ''}"><div class="billing-plan-heading"><h3>${e(plan.name)}</h3>${plan.id === current ? '<span>Ваш тариф</span>' : ''}</div><p class="billing-plan-price">${e(this.money(plan.monthlyPriceKopecks))}<span> / месяц</span></p><p class="billing-plan-quota">${e(new Intl.NumberFormat('ru-RU').format(plan.pagesPerMonth))} страниц в месяц</p><p class="billing-plan-description">${e(plan.description)}</p><ul>${plan.features.map(feature => `<li>${e(feature)}</li>`).join('')}</ul></article>`).join('')}</div>
      <div class="billing-enterprise"><div><h3>Нужен индивидуальный формат?</h3><p>Свой сервер, свои интеграции и условия для большого объёма.</p></div><a class="btn btn-outline" href="mailto:hi@scanflow.ru?subject=ScanFlow%20Enterprise">Обсудить условия</a></div>
      <div class="billing-faq billing-faq--wide"><h2>Об оплате</h2><details><summary>Нужно ли выбирать тариф сейчас?</summary><p>Нет. Во время открытой беты доступ бесплатный.</p></details><details><summary>Будут ли деньги списываться автоматически?</summary><p>Нет. Платная подписка и регулярные списания не подключены.</p></details><details><summary>Где будут платежи и документы?</summary><p>Здесь же, когда запустим оплату: дата, сумма, статус и закрывающие документы.</p></details></div>`;
  },
};
