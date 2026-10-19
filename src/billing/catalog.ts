// Published plans from public/index.html. These are previews during open beta;
// this catalog does not impose quotas or activate paid entitlements.
export const billingPlans = [
  { id: 'start', name: 'Старт', monthlyPriceKopecks: 0, pagesPerMonth: 50,
    description: 'Для небольшого потока документов',
    features: ['Распознавание основных типов документов', 'Многостраничные накладные', 'Выгрузка в 1С:УНФ', 'Уведомления в Telegram'] },
  { id: 'pro', name: 'Pro', monthlyPriceKopecks: 99000, pagesPerMonth: 1000,
    description: 'Для регулярной работы с накладными',
    features: ['Всё из тарифа «Старт»', 'Черновики платежей в СберБизнес', 'ИИ-подбор товаров из каталога 1С', 'Приоритетная поддержка в Telegram'] },
  { id: 'business', name: 'Бизнес', monthlyPriceKopecks: 499000, pagesPerMonth: 10000,
    description: 'Для большого объёма закупок',
    features: ['Всё из тарифа Pro', 'Webhook на свои события', 'Помощь с настройкой 1С', 'Расширенное сопровождение'] },
] as const;

export function getBillingOverview() {
  return {
    mode: 'beta', currency: 'RUB',
    subscription: { planId: null, name: 'Открытая бета', monthlyPriceKopecks: 0,
      nextPaymentAt: null, autoRenewal: false, pageLimit: null },
    payments: { enabled: false, provider: 'robokassa', connected: false },
    plans: billingPlans,
    // No payment ledger exists yet. Never synthesize transactions or receipts.
    history: [], documents: [],
  };
}
