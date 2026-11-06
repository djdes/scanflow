import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

// Мобильное приложение (спек docs/superpowers/specs/2026-11-06-mobile-app-design.md):
// оболочка /m/, старые адреса камеры, подтверждение ключа APK и сам APK.

export const ANDROID_PACKAGE = 'ru.scanflow.app';
const APK_FILE = 'scanflow.apk';
const FINGERPRINT_FILE = 'android-cert-sha256.txt';
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/**
 * Содержимое /.well-known/assetlinks.json. Отпечатки — из файла, который кладёт
 * сборка APK, и из env ANDROID_CERT_SHA256 (через запятую или с новой строки).
 * Мусор отбрасывается: Android проверяет файл целиком, и одна кривая строка
 * вернула бы приложению адресную строку браузера.
 */
export function assetLinks(fileText: string | null, envValue: string | undefined): object[] {
  const fingerprints = [...new Set(
    `${fileText ?? ''}\n${envValue ?? ''}`
      .split(/[\s,;]+/)
      .map(s => s.trim().toUpperCase())
      .filter(s => FINGERPRINT_RE.test(s)),
  )];
  if (!fingerprints.length) return [];
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: fingerprints },
  }];
}

function readIfExists(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

export function registerMobileRoutes(
  app: express.Express,
  publicDir: string,
  opts: { downloadsDir: string; androidCertSha256: string },
): void {
  // Оболочка живёт по адресу со слешем: область service worker — '/m/', и
  // без слеша страница оказалась бы вне её.
  app.get('/m', (req, res, next) => {
    if (req.path !== '/m') return next();
    res.redirect(301, '/m/');
  });
  app.get('/m/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(publicDir, 'mobile.html'));
  });

  // Старая страница «Фото накладной» — теперь это главная кнопка приложения.
  // Ярлыки на экранах телефонов продолжают работать.
  app.get(['/camera', '/camera.html'], (_req, res) => {
    res.redirect(301, '/m/');
  });

  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const fileText = readIfExists(path.join(opts.downloadsDir, FINGERPRINT_FILE));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(assetLinks(fileText, opts.androidCertSha256));
  });

  app.get(`/downloads/${APK_FILE}`, (_req, res, next) => {
    const file = path.join(opts.downloadsDir, APK_FILE);
    if (!fs.existsSync(file)) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.type('application/vnd.android.package-archive');
    res.download(file, APK_FILE);
  });
}
