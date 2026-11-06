// Service worker мобильного приложения (спек docs/superpowers/specs/2026-11-06-mobile-app-design.md).
// Регистрируется из /m/ с областью '/m/': лендинг и кабинет он не трогает.
// Хранит только оболочку, чтобы приложение открывалось без сети. /api/* не
// перехватывается: данные компании в кеше устройства не оседают, а фото без
// сети ждут в IndexedDB (public/js/upload.js).
// Меняете список файлов — меняйте номер версии кеша.
const CACHE = 'sf-m-v1';
const NETWORK_TIMEOUT_MS = 4000;
const SHELL = [
  '/m/',
  '/css/fonts.css',
  '/css/mobile.css',
  '/js/mobile-core.js',
  '/js/mobile.js',
  '/js/upload.js',
  '/js/recognition-queue.js',
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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  const key = request.mode === 'navigate'
    ? (url.pathname === '/m/' ? '/m/' : null)
    : (SHELL.includes(url.pathname) ? url.pathname : null);
  if (!key) return;
  event.respondWith(networkFirst(event, request, key));
});

// Сначала сеть: после выкладки оболочка всегда свежая (сервер шлёт no-cache +
// ETag). Нет сети или она «висит» дольше NETWORK_TIMEOUT_MS — из кеша, а
// ответ сети, когда придёт, обновит кеш.
async function networkFirst(event, request, key) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) return cache.put(key, response.clone()).then(() => response, () => response);
    return response;
  });
  event.waitUntil(network.catch(() => null));
  const cached = await cache.match(key);
  if (!cached) return network;
  const slow = new Promise(resolve => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), slow]);
}
