import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { siteConfig, injectSiteConfig, applyHeroVariants } from '../../src/seo/siteConfig';

vi.mock('../../src/database/db', () => ({ getDb: () => ({ prepare: () => ({ get: () => 1 }) }) }));
vi.mock('../../src/watcher/fileWatcher', () => ({ FileWatcher: class {} }));
vi.mock('../../src/mapping/nomenclatureMapper', () => ({ NomenclatureMapper: class {} }));

import { createServer } from '../../src/api/server';
import { FileWatcher } from '../../src/watcher/fileWatcher';
import { NomenclatureMapper } from '../../src/mapping/nomenclatureMapper';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('siteConfig', () => {
  it('takes a numeric Metrika counter and ignores anything else', () => {
    expect(siteConfig(env({ YANDEX_METRIKA_ID: ' 12345678 ' }))).toEqual({ metrika: 12345678 });
    for (const bad of ['', '0', 'abc', '123;alert(1)', '-5', '1e5']) {
      expect(siteConfig(env({ YANDEX_METRIKA_ID: bad }))).toEqual({});
    }
  });

  it('turns the headline A/B on only together with the counter', () => {
    expect(siteConfig(env({ SITE_HERO_AB: '1' }))).toEqual({});
    expect(siteConfig(env({ YANDEX_METRIKA_ID: '42', SITE_HERO_AB: 'true' }))).toEqual({ metrika: 42, heroAb: true });
    expect(siteConfig(env({ YANDEX_METRIKA_ID: '42', SITE_HERO_AB: '0' }))).toEqual({ metrika: 42 });
  });

  it('replaces the mark with a script or with nothing', () => {
    const html = '<head><!--SITE-CONFIG--></head>';
    expect(injectSiteConfig(html, {})).toBe('<head></head>');
    expect(injectSiteConfig(html, { metrika: 42, heroAb: true }))
      .toBe('<head><script>window.SF_SITE={"metrika":42,"heroAb":true};</script></head>');
  });
});

describe('hero headline variants', () => {
  const h1 = '<h1>\n  <span class="gradient-text" data-hero-v="a">A</span>\n  <span class="gradient-text" data-hero-v="b">B</span>\n</h1>';

  it('drops variant b unless the A/B is on', () => {
    expect(applyHeroVariants(h1, {})).toBe('<h1>\n  <span class="gradient-text" data-hero-v="a">A</span>\n</h1>');
    expect(applyHeroVariants(h1, { metrika: 1, heroAb: true })).toBe(h1);
  });
});

describe('site config on public pages', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  const app = () => createServer(new FileWatcher() as never, new NomenclatureMapper() as never) as express.Express;
  const pages = ['/', '/blog', '/blog/torg-12-kak-pravilno-raspoznat', '/privacy', '/consent', '/terms'];

  it('without a counter pages carry neither the mark nor the config', async () => {
    delete process.env.YANDEX_METRIKA_ID;
    const server = app();
    for (const url of pages) {
      const res = await request(server).get(url);
      expect(res.status, url).toBe(200);
      expect(res.text, url).not.toContain('SITE-CONFIG');
      expect(res.text, url).not.toContain('window.SF_SITE=');
    }
  });

  it('the landing keeps only headline variant a without the A/B flag', async () => {
    process.env.YANDEX_METRIKA_ID = '98765432';
    delete process.env.SITE_HERO_AB;
    const res = await request(app()).get('/');
    expect(res.text).toContain('data-hero-v="a"');
    expect(res.text).not.toContain('data-hero-v="b"');
    process.env.SITE_HERO_AB = '1';
    const ab = await request(app()).get('/');
    expect(ab.text).toContain('data-hero-v="b"');
  });

  it('with a counter every public page gets window.SF_SITE', async () => {
    process.env.YANDEX_METRIKA_ID = '98765432';
    const server = app();
    for (const url of pages) {
      const res = await request(server).get(url);
      expect(res.text, url).toContain('window.SF_SITE={"metrika":98765432};');
    }
  });
});
