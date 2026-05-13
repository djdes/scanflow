# Hero Email-Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Вынести email-инпут и кнопку «Получить доступ» прямо в hero-секцию лендинга, чтобы пользователь регистрировался без открытия модалки.

**Architecture:** Чистый front-only фронт-патч в трёх файлах: `public/index.html` (разметка hero), `public/css/landing.css` (стили формы + mobile-стек), `public/js/landing.js` (обработчик submit). Reuse существующего endpoint `POST /api/auth/register-email` и существующего `showMailSentView()` для UX'а отправленного письма.

**Tech Stack:** vanilla HTML/CSS/JS, без сборки. Existing endpoint `/api/auth/register-email` ([src/api/routes/auth.ts](../../../src/api/routes/auth.ts)).

**Spec:** [docs/superpowers/specs/2026-05-13-hero-email-form-design.md](../specs/2026-05-13-hero-email-form-design.md)

---

## Pre-flight

- [ ] **Запустить dev-сервер**

Run: `npm run dev`
Expected: сервер на `http://localhost:8899`, лендинг по `/` отдаёт `public/index.html`.

Оставить запущенным до конца плана — будем перезагружать страницу после каждой задачи.

---

## Task 1: Разметка — заменить hero-cta на email-форму + вторичную кнопку

**Files:**
- Modify: `public/index.html:154-160`

- [ ] **Step 1: Открыть `public/index.html`, найти блок `.hero-cta`**

Текущий код (строки 154-160):

```html
      <div class="hero-cta" data-animate="fade-up" data-delay="3">
        <a href="#" data-action="hero-register" class="btn-primary btn-magnetic">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 14V4m0 0L6 8m4-4l4 4M3 14v1a2 2 0 002 2h10a2 2 0 002-2v-1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Начать бесплатно
        </a>
        <a href="#scan-types" class="btn-outline">Что можно сканировать →</a>
      </div>
```

- [ ] **Step 2: Заменить блок целиком на новую разметку**

```html
      <div class="hero-cta" data-animate="fade-up" data-delay="3">
        <form class="hero-email-form" id="hero-email-form" novalidate>
          <input
            type="email"
            id="hero-email-input"
            class="hero-email-form__input"
            placeholder="ваш@email.com"
            autocomplete="email"
            required
            aria-label="Email для регистрации"
          >
          <button type="submit" id="hero-email-submit" class="btn-primary hero-email-form__submit">
            Получить доступ
          </button>
        </form>
        <p class="hero-email-form__error" id="hero-email-error" role="alert" hidden></p>
        <a href="#" data-action="hero-register" class="btn-outline hero-email-form__secondary">
          Попробовать →
        </a>
      </div>
```

Что поменялось:
- Удалена ссылка `<a href="#scan-types">Что можно сканировать →</a>`.
- Кнопка «Начать бесплатно» → ссылка «Попробовать →» с классом `btn-outline` (вторичный визуальный вес). Поведение `data-action="hero-register"` сохранено — открывает модалку.
- Появилась `<form class="hero-email-form">` с email-инпутом и кнопкой submit.
- Под формой `<p class="hero-email-form__error">` для inline-ошибок (скрыто по умолчанию).

- [ ] **Step 3: Проверить страницу в браузере**

Открыть `http://localhost:8899/`. Hero должен показывать форму с инпутом и две кнопки. Стилей пока нет — это ок, визуал поправим в Task 2.

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "feat(landing): replace hero CTA with inline email-form + secondary button"
```

---

## Task 2: Стили — `.hero-email-form` + responsive

**Files:**
- Modify: `public/css/landing.css` (добавление в конец секции hero около строки 717, mobile-правила около строки 3653)

- [ ] **Step 1: Найти конец блока `.hero-cta` (строка 717) и добавить после него**

```css
/* Hero inline email form — primary CTA above the secondary outline button */
.hero-email-form {
  display: flex;
  gap: 8px;
  width: 100%;
  max-width: 480px;
  margin: 0 auto 12px;
}

.hero-email-form__input {
  flex: 1;
  min-width: 0;
  padding: 14px 16px;
  font-family: var(--font);
  font-size: 16px;
  color: var(--text);
  background: var(--bg-surface);
  border: 1px solid var(--border-lit);
  border-radius: var(--radius-lg);
  outline: none;
  transition: var(--transition);
}

.hero-email-form__input::placeholder {
  color: var(--text-muted);
}

.hero-email-form__input:focus {
  border-color: var(--accent-blue, #3b82f6);
  box-shadow: 0 0 0 3px var(--accent-blue-glow);
}

.hero-email-form__input:invalid:not(:placeholder-shown) {
  border-color: #ef4444;
}

.hero-email-form__submit {
  flex-shrink: 0;
  padding: 14px 24px;
}

.hero-email-form__error {
  max-width: 480px;
  margin: -4px auto 16px;
  font-size: 14px;
  color: #ef4444;
  text-align: center;
}

.hero-email-form__secondary {
  font-size: 14px;
  padding: 10px 20px;
}
```

Примечания:
- Используем существующие CSS-переменные (`--bg-surface`, `--border-lit`, `--text`, `--radius-lg`, `--transition`, `--accent-blue-glow`) — они уже определены в `:root`/`html[data-theme]` блоках в начале файла.
- `var(--accent-blue, #3b82f6)` — fallback на случай, если переменная не определена для focus-цвета. Если в файле уже есть `--accent-blue` (проверь грепом перед коммитом — `grep -n "\-\-accent-blue" public/css/landing.css`), fallback не нужен, но мешать не будет.
- `:invalid:not(:placeholder-shown)` — красная рамка только когда пользователь начал вводить и ввёл невалидное (не сразу на пустом).
- `.hero-email-form__secondary` уменьшен в размере, чтобы визуальный приоритет был на форме.

- [ ] **Step 2: Найти `@media (max-width: 768px)` блок с `.hero-cta` (строка 3653) и расширить**

Найти:

```css
  .hero-cta {
    flex-direction: column;
    align-items: stretch;
  }

  .hero-cta .btn-primary,
  .hero-cta .btn-outline {
    justify-content: center;
  }
```

Заменить на:

```css
  .hero-cta {
    flex-direction: column;
    align-items: stretch;
  }

  .hero-cta .btn-primary,
  .hero-cta .btn-outline {
    justify-content: center;
  }

  .hero-email-form {
    flex-direction: column;
    gap: 12px;
  }

  .hero-email-form__submit {
    width: 100%;
  }

  .hero-email-form__secondary {
    align-self: center;
  }
```

- [ ] **Step 3: Проверить в браузере на desktop**

Открыть `http://localhost:8899/`, обновить. Должно быть:
- Email-форма по центру, инпут + синяя кнопка «Получить доступ» в одну строку, max-width ~480px.
- Под формой по центру меньшая outline-кнопка «Попробовать →».
- Иконки галочек trust-списка без изменений.

- [ ] **Step 4: Проверить mobile (DevTools → toggle device → iPhone SE / 375px)**

Должно быть:
- Инпут и кнопка «Получить доступ» в столбик, оба full-width.
- «Попробовать →» по центру под формой.
- Layout не съезжает.

- [ ] **Step 5: Проверить тему (auto-switch 07-19 light / иначе dark)**

В DevTools переключить тему вручную через `<html data-theme="light">` ↔ `data-theme="dark"`. Инпут должен читаться в обеих темах: тёмный текст на белом фоне (light), светлый текст на тёмном фоне (dark). Если placeholder не читается — поправить `--text-muted` fallback.

- [ ] **Step 6: Commit**

```bash
git add public/css/landing.css
git commit -m "feat(landing): style hero email-form + responsive stack on mobile"
```

---

## Task 3: JS — submit handler для hero-формы

**Files:**
- Modify: `public/js/landing.js` (после блока `[data-action="hero-register"]`, строка 512)

- [ ] **Step 1: Найти блок Hero CTA listener (строки 506-512) и добавить новый обработчик ПОСЛЕ него (до Logout listener на строке 514)**

Текущий код:

```javascript
  // Hero CTA «Начать бесплатно» — открывает модалку регистрации.
  document.querySelectorAll('[data-action="hero-register"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openLogin('register');
    });
  });
```

Добавить сразу после:

```javascript
  // Hero inline email-form: дублирует логику модальной регистрации, но без
  // открытия модалки сначала. На успех — переключаем модалку в state mail-sent
  // (через showMailSentView), чтобы пользователь увидел стандартный экран
  // «проверь почту». Endpoint и поведение совпадают с register-form в модалке
  // (см. ниже, ~строка 695).
  const heroEmailForm = document.getElementById('hero-email-form');
  const heroEmailInput = document.getElementById('hero-email-input');
  const heroEmailSubmit = document.getElementById('hero-email-submit');
  const heroEmailError = document.getElementById('hero-email-error');
  if (heroEmailForm) {
    heroEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = (heroEmailInput.value || '').trim();
      if (!email) return;
      // HTML5 validation: type=email + required. Если браузер пропустил пустое
      // или невалидное — checkValidity подстрахует.
      if (!heroEmailForm.checkValidity()) {
        heroEmailInput.reportValidity();
        return;
      }

      heroEmailSubmit.disabled = true;
      const originalLabel = heroEmailSubmit.textContent;
      heroEmailSubmit.textContent = 'Отправляем…';
      heroEmailError.hidden = true;

      try {
        const resp = await fetch('/api/auth/register-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          heroEmailError.textContent = data.error || `Сервер вернул ошибку (${resp.status}).`;
          heroEmailError.hidden = false;
          return;
        }
        // Очистка onboarding-флагов — тот же подход, что в register-form.
        localStorage.removeItem('sf-onboarding-done');
        localStorage.removeItem('sf-onboarding-sber-skip');
        localStorage.removeItem('sf-onboarding-1c-ok');
        // Открываем модалку сразу в mail-sent state — единый UX с модальной регистрацией.
        openLogin('register');
        showMailSentView(email, 'register');
      } catch (err) {
        heroEmailError.textContent = 'Не удалось связаться с сервером. Проверьте интернет.';
        heroEmailError.hidden = false;
      } finally {
        heroEmailSubmit.disabled = false;
        heroEmailSubmit.textContent = originalLabel;
      }
    });
  }
```

Примечания:
- `openLogin('register')` + `showMailSentView(email, 'register')` — последовательность нужна, чтобы модалка сначала открылась (в register-tab), а потом мгновенно переключилась в mail-sent overlay. `switchModalTab` внутри `showMailSentView` ставит правильный state.
- Email из hero-инпута передаётся в `showMailSentView` напрямую — модальный `register-email` инпут трогать не нужно.

- [ ] **Step 2: Проверить — happy path**

В браузере:
1. Открыть `/`.
2. Ввести валидный email (например `test@example.com`).
3. Нажать `Получить доступ`.

Expected:
- Кнопка disabled, текст `Отправляем…`.
- Через ~500ms открывается модалка в state `mail-sent` с подставленным email.
- На сервере (если SMTP/sendmail настроены) уходит письмо.
- В `pm2 logs` / dev-консоли видим лог `register-email` запроса.

- [ ] **Step 3: Проверить — невалидный email**

Ввести `notanemail`, нажать submit.
Expected: браузер показывает свой tooltip «Введите адрес электронной почты», submit не уходит.

- [ ] **Step 4: Проверить — ошибка сервера**

В DevTools → Network → правым кликом на `/api/auth/register-email` → Block request URL. Или временно подменить URL в коде на `/api/auth/register-email-xxx`.
Снова submit с валидным email.
Expected: красный текст под формой `Не удалось связаться с сервером.` или `Сервер вернул ошибку (404).`, кнопка возвращается в нормальное состояние с текстом `Получить доступ`.

Отменить блокировку после проверки.

- [ ] **Step 5: Проверить — Enter в инпуте**

Ввести email, нажать Enter (не клик).
Expected: то же самое, что клик по кнопке — submit срабатывает.

- [ ] **Step 6: Проверить — secondary кнопка «Попробовать»**

Кликнуть `Попробовать →`.
Expected: открывается модалка регистрации (вкладка register), email-инпут пустой. Поведение прежней `Начать бесплатно`.

- [ ] **Step 7: Commit**

```bash
git add public/js/landing.js
git commit -m "feat(landing): submit hero email-form to /api/auth/register-email"
```

---

## Task 4: Финальная проверка

- [ ] **Step 1: TypeScript build (на всякий случай — JS файл не вынуждает, но проверим что ничего не сломалось)**

Run: `npm run build` (если такой скрипт есть — посмотри `package.json`). Если в проекте только `npm run dev` и tsx — пропустить.

Expected: успешная компиляция, либо команда отсутствует.

- [ ] **Step 2: Lint (если настроен)**

Run: `npm run lint` (если есть в `package.json`).

Expected: успешно, либо команда отсутствует.

- [ ] **Step 3: Tests (на всякий случай)**

Run: `npm test`

Expected: все существующие тесты проходят. Новых тестов не добавляем — это чисто DOM-логика без юнит-покрытия (consistent с остальным `landing.js`).

- [ ] **Step 4: Полный smoke-test happy path в браузере**

1. Очистить кэш браузера + localStorage (`localStorage.clear()` в консоли).
2. Открыть `/` инкогнито.
3. Скроллить hero — должна быть видна форма.
4. Ввести реальный email (с настроенной почтой) → submit → проверить, что письмо доходит.
5. Перейти по magic-link из письма → должен открыться кабинет / onboarding.

- [ ] **Step 5: Проверить, что header `Войти` и `Попробовать` (в шапке) всё ещё работают**

Кликнуть `Войти` в шапке → открывается модалка login.
Кликнуть `Попробовать` в шапке → открывается модалка register.

Expected: поведение шапки не сломалось.

- [ ] **Step 6: Final commit (если в Task 4 что-то поправили)**

```bash
git status
# если есть незакоммиченные правки:
git add -p
git commit -m "fix(landing): <описание правки>"
```

---

## Out of Scope (не трогаем)

- Rate-limit / capcha для `/api/auth/register-email`.
- Изменение endpoint'а или модели данных.
- Логика модалки логина (она reuse'ится как есть).
- Удаление секции `#scan-types` сама по себе — мы только удалили ссылку на неё из hero.
- Telegram-уведомление о регистрации (если есть отдельная фича).

## Если что-то пойдёт не так

- **Модалка не открывается после submit** — проверить, что `openLogin` и `showMailSentView` доступны в той же IIFE-области (всё внутри `(function () { ... })()` в landing.js). Если они объявлены ниже handler'а — это ок, JS вешает handler на event listener, а к моменту click обе функции уже определены.
- **Стили инпута выглядят странно в light/dark** — проверь, какие переменные дают читаемый контраст; возможно нужен явный `color: var(--text)` для инпута (он уже есть в плане).
- **`/api/auth/register-email` отвечает 404** — endpoint реализован в [src/api/routes/auth.ts](../../../src/api/routes/auth.ts), проверь что роут смонтирован в `src/api/server.ts`.
- **На прод letter не уходит** — это вне scope этого плана, см. недавние коммиты про `sendmail` (`d83046a`, `6be6144`, `412aec1`).
