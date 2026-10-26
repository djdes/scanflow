import { describe, it, expect, beforeAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => 1 }) }) }));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

let app: express.Express;

beforeAll(() => {
  app = createServer(new FileWatcher() as never, new NomenclatureMapper() as never);
});

describe('Legal pages', () => {
  it.each([
    ['/privacy', 'Политика обработки персональных данных'],
    ['/consent', 'Согласие на обработку персональных данных'],
    ['/terms', 'Пользовательское соглашение'],
  ])('GET %s renders the document with substituted marks', async (url, title) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain(`<h1>${title}</h1>`);
    expect(res.text).not.toContain('<!--LEGAL:');
  });

  it('redirects the raw template to the clean URL', async () => {
    const res = await request(app).get('/legal/privacy.html').redirects(0);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/privacy');
  });

  it('does not serve anything else from /legal/', async () => {
    expect((await request(app).get('/legal/unknown.html')).status).toBe(404);
    expect((await request(app).get('/legal/')).status).toBe(404);
  });
});

describe('Consent on the landing', () => {
  it('every registration form has its own unchecked consent box linking to /consent', async () => {
    const res = await request(app).get('/');
    const boxes = res.text.match(/<input type="checkbox"[^>]*name="pd_consent"[^>]*>/g) || [];
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).not.toMatch(/\bchecked\b/);
    expect(res.text.match(/href="\/consent"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('footer links to all legal documents', async () => {
    const res = await request(app).get('/');
    for (const url of ['/privacy', '/consent', '/terms']) expect(res.text).toContain(`href="${url}"`);
  });
});
