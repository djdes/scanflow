# Мобильное приложение ScanFlow — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Простое крупное мобильное приложение `/m/` (PWA для Android и iPhone) и APK для Android (TWA) с автоматической сборкой.

**Architecture:** Новая страница-оболочка `/m/` на чистом JS без сборки. Отправку фото берёт у кабинета (`upload.js`, `recognition-queue.js`) через прослойку `App`. Service worker с областью `/m/` хранит только оболочку. APK — Trusted Web Activity на `https://scanflow.ru/m/`, его собирает GitHub Actions и выкладывает на сервер; сайт подтверждает ключ через `/.well-known/assetlinks.json`.

**Tech Stack:** Express 5, vanilla JS, Service Worker, Web App Manifest; Android Gradle Plugin 8.11.2, Gradle 8.14.3, androidbrowserhelper 2.7.4; vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-06-mobile-app-design.md`

## Global Constraints

- Текст основной 18 px, кнопки ≥ 60 px, главная кнопка «Снять накладную» ≈ 150 px, на кнопке ≤ 3 слов, пояснение — одно предложение.
- На экране одна залитая кнопка; дополнительное — под «Ещё» (раскрытие на месте).
- Слова интерфейса — из таблицы статусов спека, без «OCR/распознавание/маппинг».
- Шрифт Geist с нашего домена (`/css/fonts.css`), тема по `prefers-color-scheme`, `env(safe-area-inset-*)`.
- Сетка в одну колонку — `minmax(0, 1fr)` (правило 38), `scrollWidth` ≤ ширины на 390/360/320 px.
- Service worker не трогает `/api/*`.
- Пакет Android `ru.scanflow.app`, `minSdk` 26, `compileSdk`/`targetSdk` 36, адрес `https://scanflow.ru/m/`.
- Ключ подписи APK — на сервере в `~/scanflow-android/`, APK и отпечаток — в `data/downloads/`.

## Review Focus

1. Пользователь вышел, а на устройстве остались неотправленные фото: они не должны уйти под ключом следующего входа. Ожидание — «Выйти» спрашивает и удаляет их (тест `MobileCore.logoutWarning`).
2. Нет сети при открытии приложения: оболочка открывается из кеша, вместо списка — «Нет интернета», фото ставятся в очередь (ручная проверка в Playwright, офлайн-режим).
3. Ключ отозван (401 на любом запросе): возврат на вход внутри `/m/`, а не на лендинг кабинета (тест `App.api` 401 → экран входа — ручная проверка; логика в `mobile.js`).
4. Длинное название поставщика или сумма в миллионах на 320 px: без горизонтальной прокрутки (visual-check).
5. `assetlinks.json` при пустом файле, мусоре в файле и нескольких отпечатках в env: валидный JSON, только корректные отпечатки `AA:BB:…` (тест в `mobile-routes.test.ts`).

---

### Task 1: Чистая логика `MobileCore`

**Files:**
- Create: `public/js/mobile-core.js`
- Test: `tests/frontend/mobileCore.test.ts`

**Interfaces:**
- Produces (глобальный `MobileCore`):
  - `invoiceState(inv) → { tone: 'blue'|'green'|'amber'|'red'|'grey', label: string, hint: string, action: 'send'|'review'|'retake'|null }` — по таблице спека; порядок проверок как в `_onecPill`.
  - `formatMoney(n) → '12 400 ₽'` (без копеек при целом, иначе `12 400,50 ₽`; `null` → `'—'`).
  - `formatShortDate('2026-11-05') → '05.11'`; другой год → `'05.11.2025'`.
  - `plural(n, one, few, many)`.
  - `uploadSummary(history, online) → { tone, text } | null` — тексты «Отправляем N фото…», «Нет интернета. Фото сохранены — отправим сами», «Читаем N фото…», «Не отправилось N фото. Повторим сами», `null` если делать нечего.
  - `sendResultText(status, body) → { ok: boolean, text: string }` — по разделу «Ответы на Отправить в 1С».
  - `logoutWarning(history) → string|null` — «Не отправлено фото: N. Если выйти, они удалятся.» при `queued|uploading|error`.
  - `installHint(ua, standalone) → 'installed'|'ios'|'android'|'other'`.

- [ ] **Step 1: тесты** — по одному `it` на каждую строку таблицы статусов (ожидаемые `label`/`action`), `formatMoney(12400) === '12 400 ₽'`, `formatMoney(12400.5) === '12 400,50 ₽'`, `uploadSummary` для четырёх случаев и `null`, `sendResultText(409, {code:'incomplete_pages'}).text === 'Не все листы. Доснимите.'`, `sendResultText(409, {needs_approval:true})`, `logoutWarning` с 2 ошибками → строка с «2», `installHint` для iPhone Safari / Android Chrome / standalone.
- [ ] **Step 2:** `npx vitest run tests/frontend/mobileCore.test.ts` → FAIL (нет файла).
- [ ] **Step 3:** реализовать `mobile-core.js` (объект `const MobileCore = {...}`; `window.MobileCore = MobileCore` под `typeof window`).
- [ ] **Step 4:** тот же запуск → PASS.
- [ ] **Step 5:** commit `feat(mobile): статусы и тексты приложения простыми словами`.

### Task 2: Маршруты сервера, манифест, assetlinks, APK

**Files:**
- Modify: `src/api/server.ts` (рядом с `/camera`), `src/config.ts` (`downloadsDir` из env `DOWNLOADS_DIR`, по умолчанию `./data/downloads`)
- Create: `src/api/mobileRoutes.ts` — `registerMobileRoutes(app, publicDir)` и чистая `assetLinks(fileText: string|null, env: string|undefined) → object[]`
- Modify: `public/site.webmanifest`; Create: `public/icon-maskable-512.png`
- Delete: `public/camera.html`
- Test: `tests/api/mobile-routes.test.ts`

**Interfaces:**
- Produces: `GET /m/` (HTML `mobile.html`), `GET /m` → 301 `/m/`, `GET /camera`, `/camera.html` → 301 `/m/`, `GET /.well-known/assetlinks.json`, `GET /downloads/scanflow.apk`.
- `assetLinks` → `[]` либо `[{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'ru.scanflow.app', sha256_cert_fingerprints: [...] } }]`; отпечаток — `/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/` после `toUpperCase()`, дубли убираются.

- [ ] **Step 1: тесты** — `/m/` 200 html содержит `<title>ScanFlow`; `/m` 301 `/m/`; `/camera` и `/camera.html` 301 `/m/`; `/sw.js` 200 `javascript`; манифест: `start_url === '/m/'`, `scope === '/'`, есть иконка `purpose: 'maskable'`; `assetLinks(null, undefined)` → `[]`; мусор + env с двумя отпечатками → два отпечатка; `/.well-known/assetlinks.json` 200 `application/json`; APK: нет файла → 404, есть (временный `DOWNLOADS_DIR`) → 200 и `application/vnd.android.package-archive`.
- [ ] **Step 2:** `npx vitest run tests/api/mobile-routes.test.ts` → FAIL.
- [ ] **Step 3:** реализовать маршруты, манифест (поля из спека, `shortcuts`), maskable-иконку (рисунок `icon.svg` в 60 % полотна на `#2383e2`, рендер Chromium/Playwright).
- [ ] **Step 4:** тест → PASS; `npx tsc --noEmit` чисто.
- [ ] **Step 5:** commit `feat(mobile): маршрут /m/, манифест приложения, assetlinks и выдача APK`.

### Task 3: Оболочка `/m/`, стили, service worker

**Files:**
- Create: `public/mobile.html`, `public/css/mobile.css`, `public/js/mobile.js`, `public/sw.js`
- Modify: `public/app.html` (ссылка «📱 Простой режим» в `.app-mobile-header`, мета-теги iPhone), `public/css/sidebar.css` или `style.css` (стиль ссылки)

**Interfaces:**
- Consumes: `MobileCore.*` (Task 1), `Upload` (`upload.js`: `init`, `history`, `addFile`, `remove`, `retryAllErrors`), `RecognitionQueue.refresh/data`, API `/auth/login`, `/invoices/stats`, `/invoices?view=&limit=&offset=`, `/invoices/:id`, `/invoices/:id/photos`, `/invoices/:id/photos/:file`, `POST /invoices/:id/send`, `POST /invoices/send-1c-batch {ids}`, `/profile`.
- Produces: глобальные `App` (прослойка) и `Mobile` (`route()`, `openCamera()`, `toggleMore(el)`), маршруты `#/`, `#/camera`, `#/list/<view>`, `#/inv/<id>`.

- [ ] **Step 1:** вёрстка и логика экранов по спеку; `Upload` переопределение `renderHistory`/`updateCounter`/`_renderWakeLockNotice` → `Mobile.renderUploadBar()`; после фото — лист «Фото принято»; 401 → экран входа; «Выйти» с `MobileCore.logoutWarning`.
- [ ] **Step 2:** `sw.js`: `CACHE='sf-m-v1'`, precache списка, network-first для GET тех же URL, `/api/` — без `respondWith`; регистрация из `mobile.js` с `{ scope: '/m/' }`.
- [ ] **Step 3:** дев-стенд (`bash .claude/skills/dev-stand/stand.sh`), ручной проход: вход `admin/DemoPass1`, главная, список, накладная, «Ещё», отправка в 1С.
- [ ] **Step 4:** `visual-check` `/m/` на телефоне 390/360/320, светлая/тёмная: нет ошибок консоли, нет горизонтальной прокрутки.
- [ ] **Step 5:** commit `feat(mobile): простое приложение /m/ — снять, проверить, отправить в 1С`.

### Task 4: Android TWA и сборка

**Files:**
- Create: `android/settings.gradle`, `android/build.gradle`, `android/gradle.properties`, `android/app/build.gradle`, `android/app/src/main/AndroidManifest.xml`, `android/app/src/main/res/**` (строки, цвета, адаптивная иконка — векторная, заставка), `android/README.md` нет — описание в `docs/runbooks/android-apk.md`
- Create: `.github/workflows/android.yml`
- Modify: `.gitignore` (`android/.gradle`, `android/**/build`, `android/local.properties`, `*.jks`, `*.apk`)

**Interfaces:**
- Consumes: `GET /.well-known/assetlinks.json` (Task 2) для проверки связи.
- Produces: `assembleRelease` подписывает ключом из env `SF_KEYSTORE`, `SF_KEYSTORE_PASSWORD`, `SF_KEY_ALIAS`, `SF_KEY_PASSWORD`; `versionCode` из `SF_VERSION_CODE` (по умолчанию 1), `versionName` из `SF_VERSION_NAME`.

- [ ] **Step 1:** проект TWA; локально поставить Android SDK (cmdline-tools, `platforms;android-36`, `build-tools;36.0.0`) в scratchpad.
- [ ] **Step 2:** `gradle -p android assembleDebug` → BUILD SUCCESSFUL; `aapt2 dump badging` показывает пакет `ru.scanflow.app` и `minSdkVersion:'26'`.
- [ ] **Step 3:** release-подпись временным ключом → `apksigner verify --print-certs` выводит SHA-256.
- [ ] **Step 4:** `android.yml`: PR → `assembleDebug` + артефакт; `main`/ручной запуск → ключ с сервера (создать при отсутствии), `assembleRelease`, отпечаток, `scp` APK и отпечатка в `data/downloads/`, артефакт.
- [ ] **Step 5:** commit `feat(android): APK-приложение (TWA) и его сборка в Actions`.

### Task 5: Документация и PR

- [ ] CLAUDE.md: правило 48 (мобильное приложение, `/camera` → `/m/`, APK, ключ на сервере), строки в таблице API.
- [ ] `docs/runbooks/android-apk.md`: где ключ, как пересобрать, как сделать резервную копию ключа.
- [ ] `npm test` на стенде (`stand.sh test`), `npx tsc --noEmit`.
- [ ] git-синхронизация по AGENTS.md, push, PR, подписка.
