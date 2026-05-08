# Объединение страниц «Камера» и «Загрузить» в одну

**Дата:** 2026-05-08
**Автор:** Claude (брэйнсторм с Oleg)
**Статус:** Approved — переход к implementation

---

## Проблема

В текущем UI два отдельных пункта навигации делают, по сути, одно и то же — отправляют JPG в `POST /api/upload`:

- `/#/camera` (`public/js/camera.js`) — IndexedDB-persisted очередь, асинхронные параллельные fetch'и, ретрай по item, авто-recovery после refresh страницы. Логика «дорабатывалась долго», даёт надёжность на мобиле.
- `/#/upload` (`public/js/upload.js`) — карусель «один слайд за раз» с прогресс-баром через XHR, последовательная отправка, обработка HTTP 429 c уважением `RateLimit-Reset`.

UX-разлом: юзер должен решить «фото или файл» **до** того как зайдёт на нужную вкладку, и каждая страница ведёт себя по-своему. На мобиле часто хочется одной рукой и сфотать, и подгрузить уже отсканированный PDF/JPG — а это разные экраны.

Цель: **одна страница `/#/upload`, на которой и кнопка «Сфотографировать», и блок загрузки файлов, и общий список с одинаковой логикой надёжности**.

## Не-цели (явно вне scope)

- **Обработка `public/camera.html`** (standalone-страница для мобилок через LAN, доступна по `/camera` без хэша и без auth). У неё другая аудитория и архитектура — она остаётся как есть.
- **Service Worker / background sync.** Не вводим. IndexedDB + Wake Lock + явное предупреждение покрывают сценарий «не дать загрузке сорваться».
- **Сжатие изображений на клиенте перед отправкой.** YAGNI, ограничение 20 MB и так есть.
- **Авто-удаление успешных items через N сек.** Юзер сам жмёт «Убрать» если хочет.
- **Удаление функциональности `Upload.openAllResults()` / `Upload.clearAll()`** — текущая реализация Upload их экспортирует, но они вызываются только из view-upload разметки. Эта разметка переписывается → методы исчезают вместе с разметкой, никто их больше не зовёт.

---

## Архитектура

### Один пайплайн на все источники

Все способы получить файл (камера / drag-drop / browse / retry / restore-after-refresh) проходят через **одну функцию** `Upload.addFile(file)`. Это критично — гарантирует, что поведение одинаково независимо от того, как юзер дал файл.

```
[btn Сфотографировать] ──┐
[drag-drop in zone]      ├──► Upload.addFile(file)
[browse files button]    │       │
                          │       ├──► save to IndexedDB (survives refresh/lock)
[restoreFromIndexedDB] ──┘       ├──► history.push({ status:'uploading', progress:0 })
                                  ├──► acquireWakeLock() if first pending
                                  └──► doUpload(file, idx, dbId)
                                          │
                                          ├──► XHR with upload.onprogress → history[idx].progress
                                          ├──► on 2xx → status='ok' + IndexedDB delete
                                          ├──► on 429 → status='error' + retryAfterMs
                                          ├──► on other non-2xx → status='error'
                                          └──► on success/done → releaseWakeLock() if no pending
```

### Wake Lock API

`navigator.wakeLock.request('screen')` удерживает экран включённым в пределах вкладки. Поддержка: Chrome 84+, Edge 84+, Safari 16.4+ (iOS 16.4+), Firefox 126+ (май 2024).

Поведение:
- При первом `pending` item — захватываем lock, показываем плашку «🔒 Экран не будет гаснуть пока идёт загрузка. Не закрывай вкладку.»
- При обнулении pending — releasing lock, плашку прячем.
- Браузер автоматически освобождает lock при `visibilitychange → hidden`. На `visible` — re-acquire если ещё есть pending.
- Если API не поддерживается — плашка превращается в жёлтое предупреждение: «⚠️ Не блокируй экран и не закрывай вкладку — загрузка прервётся. Если что — фото восстановится при следующем открытии и догрузится автоматически.»

### Прогресс-бар per item

Используем `XMLHttpRequest` (как в текущем `Upload.uploadOneFile`):

```js
xhr.upload.addEventListener('progress', (e) => {
  if (e.lengthComputable) {
    history[idx].progress = Math.round((e.loaded / e.total) * 100);
    renderHistory();
  }
});
```

В DOM каждый item в `status='uploading'` рендерит:

```html
<div class="upload-progress-bar"><div class="upload-progress-fill" style="width:42%"></div></div>
```

При переходе в `ok` / `error` — прогресс-бар заменяется на статус-pill (как сейчас в Camera.js).

### Throttling и 429 handling

- Внутренний предел: **3 параллельных XHR одновременно**. Если pending > 3, новые ждут в очереди (FIFO). Защищает от того, что юзер бросит сразу 20 файлов и сервер получит burst.
- HTTP 429 → item помечается `error` с `_retryAfterMs = max(1, RateLimit-Reset || Retry-After || 60) * 1000`. Кнопка «↻ Повторить» при клике уважит этот delay.
- Кнопка «↻ Повторить всё» внизу списка ошибок — отдельная, ставит все error-items в pending и применяет максимальный из `_retryAfterMs`.

### IndexedDB persistence

Один-в-один как сейчас в Camera.js:
- DB name: `scanflow_upload` (был `scanflow_camera` — переименуем при миграции, или оставим старое имя для backwards-compat).
- Object store: `pending_photos`, keyPath `id` autoincrement.
- При `addFile()` — сначала `dbPut(blob, name)`, потом upload.
- При успехе — `dbDelete(id)`.
- При неудаче — оставляем в DB.
- При `init()` — `retryPending()` пробегает по DB, для каждой записи восстанавливает blob и кладёт в очередь.

**Миграция имени БД.** Чтобы не потерять текущие pending записи у пользователей с открытой страницей `/#/camera` в момент деплоя:

1. Открываем новую DB `scanflow_upload`.
2. Также пытаемся открыть старую `scanflow_camera` (если есть).
3. Если в старой есть записи — перенесём их в новую и удалим старую.
4. Дальше работаем только с `scanflow_upload`.

### DOM — новая структура `view-upload`

```html
<section id="view-upload">
  <h2>Загрузить накладные</h2>

  <div class="upload-camera-block">
    <button class="btn btn-primary btn-large" id="btn-capture">
      <svg>...camera icon...</svg>
      Сфотографировать
    </button>
    <input type="file" id="capture-input" accept="image/*" capture="environment" hidden>
  </div>

  <div id="drop-zone" class="upload-dropzone">
    <p>Перетащите файлы сюда или <button class="btn btn-outline" id="btn-browse">выберите</button></p>
    <p class="muted">jpg, png, bmp, tiff, webp · до 20 МБ · можно сразу несколько</p>
    <input type="file" id="file-input"
           accept=".jpg,.jpeg,.png,.bmp,.tiff,.tif,.webp"
           multiple hidden>
  </div>

  <div id="upload-wakelock-notice" hidden></div>
  <div id="upload-counter"></div>
  <div id="upload-history"></div>
</section>
```

Удаляется секция `view-camera` целиком.

---

## Файловая структура (после)

| Файл | Действие |
|------|----------|
| `public/js/upload.js` | Полностью переписывается. Объединённая логика. |
| `public/js/camera.js` | Удаляется |
| `public/app.html` | `view-camera` удаляется; `view-upload` переписывается под новую разметку; `<script src="/js/camera.js">` убирается |
| `public/js/app.js` | В роутере: `case '#/camera'` редирект через `App.navigate('#/upload')`. Остальное не трогается. |
| `public/css/style.css` | Стили для `.upload-dropzone`, `.upload-progress-bar`, `.upload-progress-fill`, `.upload-history-item`, `.upload-status-*`, `.upload-wakelock-notice` |
| `public/camera.html` | Не трогается |

---

## Тестирование

UI-only фича в SPA без unit-test инфраструктуры на frontend. Поэтому manual smoke checklist (выполняется в Task 6 implementation plan):

1. **Десктоп Chrome:**
   - `/#/upload` отображается.
   - «Сфотографировать» открывает file picker (на десктопе capture игнорируется).
   - Drag-drop одного файла → появляется в списке, прогресс-бар, потом «Накладная #N».
   - Drag-drop пяти файлов сразу → видим всех пять с прогрессом, не больше 3 одновременно идут.
   - Wake Lock плашка появилась → исчезла после готовности.
   - Refresh во время загрузки → после reload видим тот же файл с пометкой «дозагрузка».

2. **Мобила (тест с https://scanflow.ru на телефоне):**
   - «Сфотографировать» открывает камеру.
   - Снятое фото идёт в список и грузится.
   - Wake Lock держит экран — проверить через DevTools mobile emulation или вручную.

3. **Случай ошибки:**
   - Отключить интернет → upload падает → status=error, кнопка «↻ Повторить».
   - Включить интернет → жмём «↻ Повторить» → грузится.
   - Залить 200 файлов сразу → 429 у части → кнопка «Повторить всё» работает с задержкой.

4. **Legacy-bookmarks:**
   - Открыть `/#/camera` напрямую → редирект на `/#/upload`.

---

## Открытые вопросы

Нет. Все решения зафиксированы пользователем при брэйнсторме:
- Объединить функционально, не только кнопки навигации.
- Камера сверху, файлы ниже.
- Логика как у Camera.js + прогресс-бар + предупреждение про экран.
- `/#/camera` → редирект.
- `/camera` standalone мобилка не трогается.
