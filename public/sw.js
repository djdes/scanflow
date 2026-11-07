// Service worker мобильного приложения (спек docs/superpowers/specs/2026-11-06-mobile-app-design.md).
// Регистрируется из /m/ с областью '/m/': лендинг и кабинет он не трогает.
// Хранит только оболочку, чтобы приложение открывалось без сети. /api/* не
// перехватывается: данные компании в кеше устройства не оседают, а фото без
// сети ждут в IndexedDB (public/js/upload.js).
// Меняете список файлов — меняйте номер версии кеша.
importScripts('/js/share-inbox.js');

const CACHE = 'sf-m-v3';
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  '/m/',
  '/css/fonts.css',
  '/css/mobile.css',
  '/js/mobile-core.js',
  '/js/mobile.js',
  '/js/upload.js',
  '/js/recognition-queue.js',
  '/js/share-inbox.js',
  '/fonts/geist-v5-cyrillic.woff2',
  '/fonts/geist-v5-latin.woff2',
  '/fonts/geist-v5-latin-ext.woff2',
  '/icon.svg',
  '/icon-192.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
  '/site.webmanifest',
];

self.addEventListener('install', (event) => {
  // По одному: без одного файла (например, иконки) оболочка всё равно нужна.
  event.waitUntil(caches.open(CACHE)
    .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => null))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('sf-m-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Страницы, открытые из кеша (нет сети или она «висит»): их файлы тоже берём
// из кеша, иначе новая разметка встретилась бы со старым скриптом или наоборот.
const cachedClients = new Set();

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // «Поделиться → ScanFlow» на Android (share_target в манифесте).
  if (request.method === 'POST' && url.origin === self.location.origin && url.pathname === '/m/share') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    if (url.pathname === '/m/') event.respondWith(openShell(event, request));
    return;
  }
  if (SHELL.includes(url.pathname)) event.respondWith(shellFile(event, request, url.pathname));
});

// Ответ сети годится, если сервер не упал: 5xx (например, во время перезапуска
// после выкладки) — повод отдать сохранённую копию.
function usable(response) {
  return response && response.status < 500;
}

async function fromNetwork(event, request, key) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    const saving = cache.put(key, response.clone()).catch(() => null);
    try { event.waitUntil(saving); } catch { /* событие уже завершено — кеш обновится и так */ }
  }
  return response;
}

// Оболочка: сначала сеть, после выкладки она всегда свежая (сервер шлёт
// no-cache + ETag). Нет сети, 5xx или ответ дольше NETWORK_TIMEOUT_MS — из
// кеша; ответ сети, когда придёт, обновит кеш на следующий раз.
async function openShell(event, request) {
  const cached = await caches.match('/m/', { cacheName: CACHE });
  const network = fromNetwork(event, request, '/m/');
  event.waitUntil(network.catch(() => null));
  if (!cached) return network;
  const useCache = () => {
    if (event.resultingClientId) cachedClients.add(event.resultingClientId);
    return cached;
  };
  const slow = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  const response = await Promise.race([network.catch(() => null), slow]);
  return usable(response) ? response : useCache();
}

// Файлы оболочки: для страницы из кеша — из кеша; иначе из сети (без
// таймаута, чтобы версии не смешались), а без сети или при 5xx — из кеша.
async function shellFile(event, request, key) {
  const cached = await caches.match(key, { cacheName: CACHE });
  if (cached && cachedClients.has(event.clientId)) return cached;
  try {
    const response = await fromNetwork(event, request, key);
    if (usable(response) || !cached) return response;
  } catch (error) {
    if (!cached) throw error;
  }
  return cached;
}

// Файлы из «Поделиться»: на устройство, затем в приложение. Ключа API у этого
// запроса нет — отправит их приложение после входа (ShareInbox → upload.js).
async function receiveShare(request) {
  let count = 0;
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter(f => f && typeof f !== 'string' && f.size > 0);
    if (files.length) count = await ShareInbox.put(files);
  } catch {
    count = 0;
  }
  return Response.redirect(`/m/#/share?n=${count}`, 303);
}

// ── Уведомления на телефон (Web Push) ──────────────────────────────────
// Текст и ссылку присылает сервер (src/notifications/push.ts); badge — число
// «Проверить» для значка приложения.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const work = [self.registration.showNotification(data.title || 'ScanFlow', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-badge-96.png',
    tag: data.tag || undefined,
    renotify: Boolean(data.tag),
    lang: 'ru',
    data: { url: data.url || '/m/' },
  })];
  if (typeof data.badge === 'number' && self.navigator.setAppBadge) {
    work.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  }
  event.waitUntil(Promise.all(work).catch(() => null));
});

// Нажали на уведомление — открыть накладную в уже открытом приложении или в новом окне.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/m/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = windows.find(w => new URL(w.url).pathname.startsWith('/m/'));
    if (app) {
      app.postMessage({ type: 'open', hash: target.hash || '#/' });
      return app.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
