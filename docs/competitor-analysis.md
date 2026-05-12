# ScanFlow — конкурентный анализ (май 2026)

## Intro

ScanFlow — сервис распознавания бумажных накладных (фото → OCR через Claude Sonnet 4.6 vision-LLM → 1С:УНФ «Приходная накладная» + черновик платёжки СберБизнес + Telegram-уведомление). Целевая аудитория: малый и средний российский бизнес на 1С:УНФ (общепит, опт, продукты). Сейчас открытая бета, биллинга нет.

**Методология:** для каждого конкурента — WebSearch + WebFetch главной и pricing-страницы. По 10 игрокам, микс российских (5) и международных (5). Цены нормализованы в ₽/мес там, где это возможно (курс 90 ₽/$, 100 ₽/€).

**Что искали особенно внимательно:**
- Как объясняют «что можно сканировать» в первые 5 секунд лендинга.
- Pricing-модель (per-scan, per-month, per-seat, freemium, enterprise).
- Визуальные паттерны лендинга (демо? видео? скрины? схема пайплайна?).

---

## 1. Сводная таблица

| # | Название | URL | Тип | Pricing-модель | Ключевая фишка |
|---|---|---|---|---|---|
| 1 | **1С:Распознавание первичных документов** | [ocr.1c.ai](https://ocr.1c.ai/) | RU | per-page (от 3 ₽/стр) | официальный продукт 1С, нативная интеграция в БП/УНФ/Розницу |
| 2 | **Entera** | [entera.pro](https://entera.pro/) | RU | annual subscription + page-cap | 13+ типов документов, 98% точность, EDO-интеграция |
| 3 | **Скан-Загрузка (Гэндальф)** | [gendalf.ru/svc/scan-doc](https://gendalf.ru/svc/scan-doc/) | RU | per-seat/year (от 12 000 ₽/год) | внешняя обработка для 1С, неограниченный объём |
| 4 | **Smart Engines** | [smartengines.ru](https://smartengines.ru/raspoznavanie-pervichki/) | RU | enterprise (по запросу) | on-premise, 600K стр/день, mobile SDK, российский ПО |
| 5 | **DocsInBox** | [docsinbox.ru](https://docsinbox.ru/) | RU | tier (7 900–21 700 ₽/мес) | HoReCa-фокус, ЭДО + ЕГАИС + Меркурий + накладные в одном окне |
| 6 | **Rossum** | [rossum.ai](https://rossum.ai/) | INT | enterprise (от $18K/год) | LLM-агенты, 276 языков, end-to-end AP-автоматизация |
| 7 | **Klippa DocHorizon** | [klippa.com](https://www.klippa.com/en/ocr/financial-documents/invoices/) | INT | per-scan / licence (по запросу) | 100+ стран, 99% точность, белый лейбл API+SDK |
| 8 | **Veryfi** | [veryfi.com](https://www.veryfi.com/) | INT | per-doc ($0.08–0.16) + $500/мес минимум | OCR API для разработчиков, fraud-detection |
| 9 | **Mindee** | [mindee.com](https://www.mindee.com/) | INT | от €44/мес (500 credits) | freemium, page-based, transparent pricing |
| 10 | **Dext (ex-Receipt Bank)** | [dext.com](https://dext.com/) | INT | subscription (скрыто) | бухгалтер-first, 1400+ supplier-fetchers, 14-day free trial |

---

## 2. Детальные карточки

### 1. 1С:Распознавание первичных документов (1С:РПД)

- **URL:** [ocr.1c.ai](https://ocr.1c.ai/) · pricing внутри той же страницы
- **Hero:** «Пусть компьютер вводит первичку за вас». Подзаголовок про ускорение ввода в базу 1С.
- **ЦА:** пользователи 1С (БП, УНФ, Розница), high-volume бухгалтерия, удалённые сотрудники со сканами/фото.
- **Pricing:** **per-page, от 3 ₽/страницу.** Бесплатный пакет 250 страниц с подпиской 1С:ИТС. Это самая прозрачная и самая дешёвая модель в российском сегменте.
- **Фичи:** распознавание ТОРГ-12/УПД/счетов/актов/счёт-фактур/чеков, мобильное приложение «1С:Сканер документов», auto-attachment подписанных скан-копий, AI entity-matching, обработка внутри 1С (никаких third-party).
- **Лендинг:** простой и текстовый. Hero + 3 карточки преимуществ + use-case иллюстрации + 6-step workflow-схема + список форматов (PDF/PNG/JPEG/BMP/TIFF/Word/Excel/архивы) + pricing-блок + мобильное приложение. **Нет видео, нет интерактивного демо**, только иконки и текст. CTA «Попробовать бесплатно» x4.
- **Слабые места:** нет красивого визуального демо (что сканируется не показано картинками), нет SaaS-UX вне 1С (всё через 1С-клиента), нет интеграций со СберБизнес или Telegram, не работает для пользователей вне 1С-экосистемы.

### 2. Entera

- **URL:** [entera.pro](https://entera.pro/) · [entera.pro/cost](https://entera.pro/cost)
- **Hero:** «Ввод первички в 1С в 10 раз быстрее!». Подзаголовок про облачный мультисервис.
- **ЦА:** бухгалтеры и команды 1–10 сотрудников, объёмы 50–2000 документов/мес.
- **Pricing:**
  - Начинающий: **бесплатно**, 10 страниц на 1 месяц
  - Лайт: **6 334 ₽/мес** (4 800 стр/год, лимит 1 200/квартал)
  - Базовый: **9 334 ₽/мес** (6 000 стр/год)
  - Pro: **16 250 ₽/мес** (12 000 стр/год)
  - Enterprise: по запросу, >10 000 стр/год + персональный менеджер
- **Фичи:** 30+ типов документов, 98% точность для печати, batch 100 документов, multi-source ingestion (email/EDO/QR/фото), мат.валидация, проверка контрагентов, 15-минутная установка в 1С, EDO-интеграция (СБИС, Контур Диадок).
- **Лендинг:** длинный single-page, **многосекционный** — hero, процесс, статистика, отзывы, сравнение возможностей, ROI-калькулятор, тарифы, FAQ, контакты. Иконки + текст, **без видео-демо**.
- **Слабые места:** нет publicly-visible interactive demo, дорогая нижняя планка (6 334 ₽/мес против 3 ₽/стр у 1С:РПД), нет mobile-first сценария, лимиты по квартал/год могут «душить» сезонные бизнесы.

### 3. Скан-Загрузка документов (Гэндальф)

- **URL:** [gendalf.ru/svc/scan-doc](https://gendalf.ru/svc/scan-doc/)
- **Hero:** «„Скан-Загрузка документов“ — быстрый ввод первички в „1С“». Подзаголовок — программа для накладных, счёт-фактур, УПД.
- **ЦА:** компании от 200 документов/мес, пользователи 1С:Предприятие 8 ред.3.
- **Pricing (per-seat/year, безлимит по документам):**
  - 1 рабочее место: **12 000 ₽/год** (~1 000 ₽/мес)
  - 3 РМ: 22 500 ₽/год
  - 5 РМ: 33 500 ₽/год
  - 10 РМ: 49 000 ₽/год
  - 25 РМ: 95 000 ₽/год
- **Фичи:** трёхстраничный документ — за 1 минуту, ТОРГ-12/счёт-фактуры/УПД, внешняя обработка для 1С (обновления не ломают), техподдержка от разработчика.
- **Лендинг:** простой 3-step «сканируешь → распознаёт → создаёт документ в 1С». Видео-демонстрация по клику. CTA «Оставить заявку».
- **Слабые места:** ограниченные типы документов (только 3), требует установки локально (не SaaS), отсутствует мобильный сценарий, нет облака.

### 4. Smart Engines

- **URL:** [smartengines.ru/raspoznavanie-pervichki](https://smartengines.ru/raspoznavanie-pervichki/)
- **Hero:** «Распознавание сканов и фотографий бухгалтерских документов». Подзаголовок: «До 50 раз быстрее и в 1,5 раза точнее бухгалтера».
- **ЦА:** enterprise (T-Bank, МТС, ВТБ, Альфа-Банк — клиентские логотипы), банки, корпорации, госсектор.
- **Pricing:** **скрыто за «Заказать продукт»**. Кастомные контракты, on-premise лицензия.
- **Фичи:** ВСЕ типы первички (УПД, ТТН, ТОРГ-12/13, КС-2/КС-3, банковские, 2-НДФЛ, 50+ типов), mobile SDK (единственное в РФ), serverless 600K стр/день, кластер до 16M, on-premise (данные не уходят), без шаблонов, support Astra/RED OS/Эльбрус.
- **Лендинг:** скрины + иконки + mobile mockup + клиентские логотипы. Демо-приложение в App Store/Google Play/RuStore. **Это сильный пример того, как enterprise-OCR продаёт серьёзность без видео.**
- **Слабые места:** не для SMB, нет публичной цены (отпугивает мелкого клиента), нет turnkey интеграции с 1С (надо звать интегратора), сложный onboarding.

### 5. DocsInBox

- **URL:** [docsinbox.ru](https://docsinbox.ru/) · [docsinbox.ru/price](https://docsinbox.ru/price)
- **Hero:** «Документооборот и отчётность в госсистемы для ресторанов в одном окне». Подзаголовок: «Подписание эУПД с любого устройства и ввод накладных в учётную систему **за 13 секунд** с автосопоставлением номенклатур».
- **ЦА:** **только HoReCa** — рестораны, кафе, бары, кальянные, стрит-фуд, отели, кофейни, франчайзи-сети.
- **Pricing (помесячно, есть -10% на 6 мес и -20% на год):**
  - Маркировка: 7 900 ₽/мес
  - ЕГАИС: 6 600 ₽/мес
  - ЭДО: 15 000 ₽/мес
  - **Полный DocsInBox** (всё + накладные): 21 700 ₽/мес
  - Безалкогольный: 15 700 ₽/мес
- **Фичи:** ЭДО + ЕГАИС + Меркурий + Честный знак + накладные в одном окне, AI-сопоставление номенклатур, интеграции с iiko/R-Keeper/Restik/Jupiter/Dooglys, мобильный приёмщик, AI-тендер на закупки.
- **Лендинг:** **табовая структура «выбери тип бизнеса → увидишь свои потребности».** Один из лучших паттернов «что мы делаем» на рынке — подсвечивает релевантность под клиента.
- **Слабые места:** прибит к HoReCa, дороже (от 7 900 ₽ без накладных вообще), не для 1С:УНФ напрямую, нет публичной цены за одни накладные.

### 6. Rossum

- **URL:** [rossum.ai](https://rossum.ai/) · [rossum.ai/pricing](https://rossum.ai/pricing/)
- **Hero:** «Offload paperwork to AI agents and focus on what matters». Подзаголовок про AI-агентов, читающих документы, валидирующих, отправляющих email-ы, пишущих в ERP.
- **ЦА:** enterprise AP-команды, supply chain, finance, shared service centers; manufacturing/logistics/retail/wholesale/construction.
- **Pricing:**
  - Starter: **от $18 000/год** (~135 000 ₽/мес!) — unlimited seats + Aurora AI + 12 мес архив
  - Business / Enterprise / Ultimate: по запросу
  - Минимум **1 год контракта**, всё в USD
- **Фичи:** proprietary LLM на 276 языков + рукопись, валидация против ERP, automated approval-workflows, real-time analytics, «zero hallucinations», PEPPOL-ingestion.
- **Лендинг:** скрины интерфейса + диаграммы + клиентские логотипы + аналитики (IDC, Gartner, Forrester). Без видео в hero. CTA «Free Demo» + «14-Day Trial».
- **Слабые места:** **дорого и enterprise-only**, 1-year-lock, нет per-doc-биллинга, перегружен функционалом для SMB.

### 7. Klippa DocHorizon

- **URL:** [klippa.com/en/ocr/financial-documents/invoices](https://www.klippa.com/en/ocr/financial-documents/invoices/)
- **Hero:** «AI-Powered Invoice OCR Software — Automated Data Extraction». Подзаголовок про 100+ стран и structured output (JSON/CSV).
- **ЦА:** разработчики, AP-команды, ERP-интеграторы, white-label-партнёры (банки/финтехи).
- **Pricing:** **per-scan или monthly licence**, конкретных цифр публично нет — «Get a personalized pricing breakdown». GDPR/ISO 27001/ISAE 3000.
- **Фичи:** 99% точность, 30+ полей, 100+ стран, multi-language (latin), JSON/CSV/XML/UBL/XLS вывод, OCR API + Mobile SDK.
- **Лендинг:** clean design + live demo секция (загрузи свой инвойс и попробуй!), customer reviews (4.8★), trust badges (ISO/GDPR), case study, FAQ. **Live demo — сильный паттерн.**
- **Слабые места:** нет публичной цены, нет нативной интеграции с 1С (это API/SDK для самостоятельной сборки), нет русского языка как первоклассного.

### 8. Veryfi

- **URL:** [veryfi.com](https://www.veryfi.com/) · [veryfi.com/pricing](https://www.veryfi.com/pricing/)
- **Hero:** «Documents into Data — securely, in seconds». Подзаголовок: «APIs & SDKs powered by Veryfi AI, enabling multimodal document extraction, fraud detection, and endless business use cases».
- **ЦА:** разработчики, accounting/banking/construction/CPG/fintech/healthcare/real estate.
- **Pricing:** **самая прозрачная per-doc модель на западе:**
  - Free: 100 docs/мес, $0
  - Starter: **от $500/мес** минимум (~5 000 docs base), $0.16/invoice, $0.08/receipt, $0.25/check
  - Growth: volume-based + unlimited storage + SLA
  - 12-month-commit: -1¢ скидка за документ
- **Фичи:** 39+ типов документов, SOC 2 Type II + GDPR + HIPAA + CCPA + ITAR, fraud-detection (7% fraud rate на чеках), mobile + browser SDK, no-code embedded experiences.
- **Лендинг:** customer logos + product screenshots + code snippets + mobile interfaces + interactive demo. **Demo Test-Drive** — попробовать сразу.
- **Слабые места:** $500/мес минимум — отсекает SMB, нет 1С-интеграции, для разработчиков (нет turnkey-UI), русского нет.

### 9. Mindee

- **URL:** [mindee.com](https://www.mindee.com/) · [mindee.com/pricing](https://www.mindee.com/pricing)
- **Hero:** «Automate document processing with AI-powered API». Подзаголовок: «From simple photos to complex PDFs or handwritten files, our API turn your document data into structured JSON».
- **ЦА:** разработчики, продукт-команды (Spendesk, Payfit, Lucca, Circula — логотипы), enterprise.
- **Pricing (annual, EUR):**
  - Starter: **€44/мес** (~4 400 ₽/мес), 500 credits/мес, €0.05 за extra
  - Pro: **€179/мес** (~17 900 ₽/мес), 2 500 credits/мес, €0.04 за extra
  - Business: **€584/мес** (~58 400 ₽/мес), 10 000 credits/мес, €0.035 за extra
  - Enterprise: 250K+ credits, custom
  - 14-day free trial, no permanent free
- **Фичи:** Extract / Split / Classify / Crop, continuous-learning RAG, confidence scores + bounding boxes, page-based billing без надбавок за сложность.
- **Лендинг:** clean + minimal + diagrams + customer logos + interactive demo. **Очень прозрачное и понятное pricing — рынок ценит.**
- **Слабые места:** API-only, не для конечного бухгалтера, нет 1С-коннектора, нет русского, RAG-лимит на Pro (20 документов).

### 10. Dext (ex-Receipt Bank)

- **URL:** [dext.com](https://dext.com/)
- **Hero:** про bookkeeping-automation с 99.9% точностью.
- **ЦА:** бухгалтеры и accounting firms, фокус на UK/US, MSPs.
- **Pricing:** **скрыто, нужен «plan builder» или sales-call.** Tier-ы Essentials и Advanced. 14-day free trial без CC. Скидки для бухгалтеров (приглашают клиентов бесплатно в их подписку).
- **Фичи:** captures 99.9%, sync c QuickBooks/Xero/Sage, fetch счетов от 1 400+ поставщиков (это **киллер**), line-item categorisation, mobile/email/bank-feeds capture.
- **Лендинг:** typical SaaS — стандартный (hero, features, integrations, testimonials, pricing-call).
- **Слабые места:** нет публичной цены, не для 1С (только QuickBooks/Xero/Sage), нет русского, не для SMB-владельца — для бухгалтера-аутсорсера.

---

## 3. Pricing-сравнение (нормализация в ₽/мес)

| Сервис | Минимальная точка входа | Включено | Логика | Контракт |
|---|---|---|---|---|
| 1С:РПД | **~750 ₽/мес** (250 стр × 3 ₽) | 250 стр в подписке ИТС | per-page | месячная, бесплатный пробный пакет |
| Entera Лайт | 6 334 ₽/мес | 1 200 стр/квартал | annual + page-cap | год |
| Гэндальф (1 РМ) | ~1 000 ₽/мес (12 000 ₽/год) | unlimited docs | per-seat | год |
| Smart Engines | по запросу | — | enterprise | от 1 года |
| DocsInBox (full) | 21 700 ₽/мес | unlimited (для HoReCa) | tier-bundle | месячная |
| Rossum Starter | **~135 000 ₽/мес** ($18K/год) | — | enterprise | минимум 1 год |
| Klippa | по запросу | — | per-scan/licence | по договору |
| Veryfi Starter | **~45 000 ₽/мес** ($500/мес) | ~5 000 docs | per-doc | 12-month-commit -10% |
| Mindee Starter | ~4 400 ₽/мес (€44) | 500 страниц | credit-based | месячная |
| Dext | скрыто | — | subscription | trial 14 дней |

**Что видно сразу:**
1. На РФ-рынке нижняя планка — 750–1 000 ₽/мес (1С:РПД и Гэндальф 1 РМ). Entera уже в 6× дороже — это явное окно для ScanFlow.
2. International OCR-API (Mindee, Veryfi) на 1–2 порядка дороже для российского SMB (4 400–45 000 ₽/мес).
3. **Никто из конкурентов не предлагает freemium + честный per-scan + turnkey-UX для 1С:УНФ одновременно.** 1С:РПД дешёвый, но только внутри 1С; Entera SaaS, но дорогой; Гэндальф — установка, не SaaS.

---

## 4. Анализ лендинг-паттернов

Что работает у конкурентов для объяснения «что мы делаем»:

**Паттерн А — выбор по бизнесу (DocsInBox):** табовый интерфейс «ты ресторан? → вот твои фичи». **Лучшее решение проблемы „пользователь не понимает что можно сканировать“.** ScanFlow может сделать «фото бумажной накладной? → 1С УНФ. Чек поставщика? → СберБизнес. ТОРГ-12 → всё вместе».

**Паттерн B — 3-step pipeline (Гэндальф, 1С:РПД):** «1. Сканируешь → 2. Распознаёт → 3. Документ в 1С». Простая иконография, понятно за 5 секунд. **Это база, без неё нельзя.**

**Паттерн C — live demo (Klippa, Veryfi, Mindee):** «загрузи свой инвойс прямо здесь и посмотри что распознает». Интерактив на лендинге. **Сильно повышает trust, но дорого реализовать.**

**Паттерн D — социальные доказательства (Smart Engines, Rossum):** логотипы клиентов (Альфа-Банк, МТС, ВТБ) в hero. Работает для enterprise; для SMB — менее критично, но какие-то отзывы нужны.

**Hero-формула победителей:**
- **Короткий глагольный заголовок** (Veryfi: «Documents into Data — securely, in seconds»; 1С: «Пусть компьютер вводит первичку за вас»).
- **Конкретный numeric-claim в подзаголовке** (DocsInBox: «за 13 секунд», Entera: «в 10 раз быстрее», Smart Engines: «50 раз быстрее и в 1,5 раза точнее бухгалтера»).
- **Один primary CTA**, повторённый 2–4 раза вниз по странице.

**Что НЕ работает (избегать):**
- Длинный многосекционный лендинг с ROI-калькуляторами в начале (Entera) — конверсия падает.
- Hero без цифры или конкретики («AI-Powered…» — Klippa, Rossum) — нужно срочно понимать что именно делает сервис.
- Pricing скрытый под «contact sales» — для SMB это смертельно. Rossum/Dext/Klippa теряют SMB-сегмент.

**Видео или нет?** Большинство конкурентов **не используют видео в hero** (только Гэндальф — клик-по-демо). Видео — nice-to-have, но 3-step иконография работает не хуже. **ScanFlow может обойтись без видео в первой версии лендинга.**

**Длина страницы:** оптимум — 6–8 секций (как у Klippa и 1С:РПД). Длинные single-page (Entera) хуже конвертят SMB.

---

## 5. Рекомендации для ScanFlow

### 5.1. Как упростить лендинг чтобы «было сразу понятно что можно сканировать»

**Hero-формула (рекомендую):**
- **Заголовок:** «Фото накладной → документ в 1С:УНФ за 30 секунд» (или «…за минуту»).
- **Подзаголовок:** «ScanFlow распознаёт бумажные ТОРГ-12 и УПД через AI, создаёт „Приходную накладную“ в 1С:УНФ и черновик платёжки в СберБизнес. Бесплатно в бете».
- **3 иконки прямо под hero** (паттерн B + DocsInBox-влияние):
  1. 📷 Фото бумажной накладной с телефона
  2. 🧠 AI распознаёт позиции и поставщика
  3. 📦 Приходная накладная в 1С:УНФ + черновик платежа в СберБизнес

**Тип лендинга — короткий (6 секций):**
1. Hero + 3-step
2. «Что можно сканировать?» — табы ТОРГ-12 / УПД / счёт-фактура / счёт на оплату с реальным скрином OCR-результата
3. Киллер-фичи (см. 5.3)
4. Pricing (даже если в бете — показать «бесплатно сейчас, [N] ₽/мес после релиза»)
5. FAQ (безопасность, как настроить 1С:УНФ за 5 минут, что если OCR ошибся)
6. CTA «Начать бесплатно» + Telegram-канал

**Что украсть у DocsInBox:** табовая структура «выбери свой тип документа → увидишь живой пример». Это лучший паттерн для объяснения «что можно сканировать».

**Что украсть у 1С:РПД:** простая визуальная схема workflow в 3–6 шагов; перечисление поддерживаемых форматов в виде иконок (JPG / PNG / PDF / HEIC).

**Что украсть у Klippa:** live demo block — «попробуй прямо тут, без регистрации» (можно сделать загрузку 1 фото без логина → показать JSON).

**Чего НЕ делать:**
- Не копировать длинный single-page Entera с ROI-калькулятором — для SMB перебор.
- Не скрывать pricing за «Свяжитесь с нами» — это самый частый промах российских конкурентов и западных enterprise (Rossum, Dext, Klippa, DocsInBox-частично).
- Не делать hero без цифры — «AI-powered OCR for invoices» одинаково проиграет конкретному «фото → 1С за 30 сек».

### 5.2. Какую pricing-модель выбрать после беты

**Рекомендация: hybrid freemium + per-scan, с месячной подпиской-надстройкой.**

Логика:
- **Free tier:** 50 страниц/мес — крючок, копируется у 1С:РПД (250 стр) и Mindee. Этого хватит микробизнесу с 2–3 поставщиками.
- **Pro:** 1 ₽/страница сверху или 990 ₽/мес за 1 000 страниц (cheaper-per-page) — позиционируется **ниже 1С:РПД** (3 ₽/стр) и **на порядок ниже Entera** (6 334 ₽/мес). Это «киллер-нижняя-планка» — есть запас даже если LLM-стоимость поднимется.
- **Business:** 4 990 ₽/мес за 10 000 страниц + СберБизнес безлимит + поддержка — для тех, у кого 200+ накладных/мес (=куда Гэндальф уже неудобен из-за установки).
- **Enterprise:** по запросу, on-premise SLA — для тех кто упрётся в потолок.

**Почему именно так:**
- **Per-scan базе** против Entera (annual subscription) — это reusable angle: «плати только за то, что обработал».
- **Freemium** — против 1С:РПД (250 стр требует подписки ИТС за деньги).
- **Месячный subscription** против Гэндальфа (per-seat-year-licence без облака).
- **Минимальная точка входа дешевле всех российских SaaS-конкурентов** — узкая ниша, в которую никто пока не зашёл (1С:РПД дешевле только при подписке ИТС, что не SaaS).

### 5.3. Какие фичи выпячивать в hero

Из 4 киллер-фич ScanFlow в hero идут 2–3 максимум. Приоритет:

1. **🥇 Нативная интеграция с 1С:УНФ.** Никто из 10 конкурентов не делает 1С:УНФ как первоклассный target — у 1С:РПД это часть зоопарка, у Entera через расширение, у Smart Engines через интеграторов. Это **главный USP**.
2. **🥈 Черновик платёжки в СберБизнес.** Уникальная фича — никто из 10 этого не делает. В hero как «бонус-line»: «…и сразу черновик платежа в СберБизнес».
3. **🥉 Фото с телефона.** Mobile-first — только Smart Engines и Dext это делают первоклассно. Mobile camera page ScanFlow — недооценённый USP, надо выпячивать.

**Что НЕ нужно в hero (но в фичах ниже — да):**
- LLM-маппинг номенклатур — слишком техническая фишка для hero, но в FAQ/feature-grid обязательна.
- ШТ→КГ pack-transform — это «доказательство глубины», но не сразу понятно зачем. Положить в «продвинутые возможности».
- Claude Sonnet 4.6 — упоминать ТОЛЬКО как trust-сигнал в подвале или в «Технологии». Сами по себе AI-эпитеты слабы (Rossum/Klippa так делают и проигрывают).

### 5.4. Что копировать, что не копировать

**Копировать:**
- **DocsInBox-табы** «выбери свой документ» — лучший паттерн «что можно сканировать».
- **Mindee transparent pricing table** — публичные цены, минимум звонков.
- **Klippa live demo** — interactive «загрузи и попробуй» на лендинге.
- **1С:РПД-простота** — короткие иконографические workflow-схемы.
- **Veryfi numeric trust** — «100 docs free, no credit card» прямо в hero.

**НЕ копировать:**
- **Rossum / Dext / Smart Engines hidden pricing** — для SMB смертельно.
- **Entera-длинноту** — 10-секционный single-page с ROI-калькулятором перегружает.
- **Klippa-generic-AI-headline** — «AI-Powered Invoice OCR» работает только если ты уже бренд. ScanFlow ещё не бренд, нужна конкретика.
- **DocsInBox-tier-only-bundle** — не делать «всё-или-ничего» пакетов, начинать с per-scan/freemium.
- **Hypatos 36-month-min-contract** — антипаттерн для SMB.

### 5.5. Стратегическая позиционная карта

```
              ДЕШЁВЫЙ                      ДОРОГОЙ
SIMPLE-UX     [1С:РПД]      ┌─────────┐    [DocsInBox]
              [Гэндальф]     │ScanFlow │    [Dext]
                             │  ⇐ здесь│
COMPLEX-UX    [Mindee API]   └─────────┘    [Rossum, Smart Engines, Hypatos]
              [Klippa API]                  [Veryfi]
```

**ScanFlow позиционная ниша:** simple-UX + дешёво + российская специфика (1С:УНФ + СберБизнес + Telegram). Никто из 10 одновременно этих трёх углов не закрывает:
- 1С:РПД simple + дёшево, но без СберБизнеса и слабый UX вне 1С.
- DocsInBox simple, но HoReCa-only и дороже.
- Mindee/Veryfi/Klippa — API-only, не для конечного владельца SMB.

**Главная мысль:** ScanFlow воюет не с одним конкурентом, а собирает 3 категорий boatload: «как 1С:РПД, но SaaS», «как Entera, но в 6 раз дешевле», «как DocsInBox, но для всех 1С:УНФ-бизнесов, не только HoReCa».

---

## Источники

**Российские:**
- [ocr.1c.ai](https://ocr.1c.ai/)
- [entera.pro](https://entera.pro/) + [entera.pro/cost](https://entera.pro/cost)
- [gendalf.ru/svc/scan-doc](https://gendalf.ru/svc/scan-doc/)
- [smartengines.ru/raspoznavanie-pervichki](https://smartengines.ru/raspoznavanie-pervichki/)
- [docsinbox.ru](https://docsinbox.ru/) + [docsinbox.ru/price](https://docsinbox.ru/price)

**Международные:**
- [rossum.ai](https://rossum.ai/) + [rossum.ai/pricing](https://rossum.ai/pricing/)
- [klippa.com](https://www.klippa.com/en/ocr/financial-documents/invoices/)
- [veryfi.com](https://www.veryfi.com/) + [veryfi.com/pricing](https://www.veryfi.com/pricing/)
- [mindee.com](https://www.mindee.com/) + [mindee.com/pricing](https://www.mindee.com/pricing)
- [dext.com](https://dext.com/)
