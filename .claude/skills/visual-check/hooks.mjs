// Подготовка браузера и вход для снимков ScanFlow (см. SKILL.md рядом).
//
// Кабинет держит ключ API в localStorage (public/js/app.js), поэтому «вход» — это ключ
// в localStorage до загрузки страницы. На дев-стенде ключ admin = API_KEY из .env стенда.
// Без sf-onboarding-done компания без накладных уходит на #/onboarding.

const DEV_KEY = 'dev-stand-api-key-0123456789abcdef';

export async function prepareContext(context, { login }) {
  await context.addInitScript(
    ({ apiKey }) => {
      try {
        localStorage.setItem('sf-onboarding-done', '1');
        if (apiKey) {
          localStorage.setItem('apiKey', apiKey);
          localStorage.setItem('adminUsername', 'admin');
          localStorage.setItem('adminRole', 'admin');
        }
      } catch {}
    },
    { apiKey: login ? process.env.SHOTS_API_KEY || DEV_KEY : '' },
  );
}

// Сессия хранится в localStorage, а не в cookie: отдельный вход не нужен, ключ ставит prepareContext.
export async function login() {}
