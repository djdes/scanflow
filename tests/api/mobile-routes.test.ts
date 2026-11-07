import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => 1 }) }) }));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { assetLinks, registerMobileRoutes, ANDROID_PACKAGE } from '../../src/api/mobileRoutes';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

const FP_A = Array.from({ length: 32 }, (_, i) => (i + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const FP_B = Array.from({ length: 32 }, () => 'AB').join(':');

let app: express.Express;
beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

describe('Мобильное приложение /m/', () => {
  it('отдаёт оболочку по адресу со слешем', async () => {
    const res = await request(app).get('/m/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('<title>ScanFlow</title>');
    expect(res.text).toContain('rel="manifest"');
  });

  it('без слеша — постоянный редирект на /m/', async () => {
    const res = await request(app).get('/m').redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/m/');
  });

  it.each(['/camera', '/camera.html'])('старая камера %s ведёт в приложение', async (url) => {
    const res = await request(app).get(url).redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/m/');
  });

  it('service worker отдаётся как JS с корня', async () => {
    const res = await request(app).get('/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('манифест открывает приложение и даёт иконку под маску', async () => {
    const res = await request(app).get('/site.webmanifest');
    const manifest = JSON.parse(res.text);
    expect(manifest.start_url).toBe('/m/');
    expect(manifest.id).toBe('/m/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.some((i: any) => i.purpose === 'maskable' && i.sizes === '512x512')).toBe(true);
    for (const icon of manifest.icons) {
      expect((await request(app).get(icon.src)).status).toBe(200);
    }
  });

  it('«Поделиться» на Android: манифест принимает фото, PDF и XML в /m/share', async () => {
    const manifest = JSON.parse((await request(app).get('/site.webmanifest')).text);
    expect(manifest.share_target).toMatchObject({ action: '/m/share', method: 'POST', enctype: 'multipart/form-data' });
    const accept = manifest.share_target.params.files[0].accept;
    expect(manifest.share_target.params.files[0].name).toBe('files');
    for (const type of ['image/*', 'application/pdf', 'text/xml']) expect(accept).toContain(type);
  });

  it('«Поделиться» без service worker — назад в приложение с понятным сообщением', async () => {
    const res = await request(app).post('/m/share').attach('files', Buffer.from('x'), 'a.jpg').redirects(0);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/m/#/share?n=0');
  });

  it('assetlinks без ключа — пустой список, не 404', async () => {
    const res = await request(app).get('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('APK, которого ещё не собрали, — 404', async () => {
    expect((await request(app).get('/downloads/scanflow.apk')).status).toBe(404);
  });
});

describe('assetLinks', () => {
  it('ничего нет — пустой список', () => {
    expect(assetLinks(null, undefined)).toEqual([]);
    expect(assetLinks('', '')).toEqual([]);
  });

  it('берёт отпечатки из файла и env, отбрасывает мусор и повторы', () => {
    const links = assetLinks(`${FP_A.toLowerCase()}\nмусор\n`, `${FP_B}, ${FP_A}, AA:BB`);
    expect(links).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: [FP_A, FP_B] },
    }]);
  });
});

describe('выдача APK и отпечатка из каталога сборки', () => {
  let dir: string;
  let local: express.Express;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-downloads-'));
    fs.writeFileSync(path.join(dir, 'scanflow.apk'), Buffer.from('PK\u0003\u0004apk'));
    fs.writeFileSync(path.join(dir, 'android-cert-sha256.txt'), `${FP_A}\n`);
    local = express();
    registerMobileRoutes(local, path.resolve('public'), { downloadsDir: dir, androidCertSha256: '' });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('APK скачивается с типом пакета Android', async () => {
    const res = await request(local).get('/downloads/scanflow.apk');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toContain('scanflow.apk');
  });

  it('assetlinks подтверждает ключ из файла сборки', async () => {
    const res = await request(local).get('/.well-known/assetlinks.json');
    expect(res.body[0].target.sha256_cert_fingerprints).toEqual([FP_A]);
    expect(res.body[0].target.package_name).toBe('ru.scanflow.app');
  });
});
