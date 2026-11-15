#!/usr/bin/env node
// Замер Core Web Vitals главных страниц всех сайтов (телефон 390×844): LCP, CLS, FCP,
// вес страницы и самые тяжёлые файлы. Каждый сайт открывается --runs раз, печатается
// медиана: сеть облака шумная, первый заход часто в разы медленнее.
//
//   node .claude/skills/improvement-routine/cwv.mjs                 # все сайты
//   node .claude/skills/improvement-routine/cwv.mjs https://scanflow.ru/ --runs 5
//   node .claude/skills/improvement-routine/cwv.mjs https://scanflow.ru/ --css /css/landing.css=public/css/landing.css
//
// --css путь=файл подменяет файл сайта локальным: так правку CSS можно замерить на
// настоящей сети прода до выкладки (15.11.2026 так поймали LCP 3,65 с → 1,05 с).
// Ориентиры Google: LCP ≤ 2,5 с, CLS ≤ 0,1.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const args = process.argv.slice(2);
let runs = 3; const subs = []; const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs') runs = +args[++i];
  else if (args[i] === '--css') { const [path, file] = args[++i].split('='); subs.push({ path, body: readFileSync(file) }); }
  else urls.push(args[i]);
}
if (!urls.length) urls.push('https://scanflow.ru/', 'https://ordersflow.ru/', 'https://tasksflow.ru/', 'https://projectsflow.ru/', 'https://yesbeat.ru/');

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const browser = await chromium.launch();
for (const url of urls) {
  const samples = []; let heavy = [];
  for (let r = 0; r < runs; r++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    for (const s of subs) await ctx.route(`**${s.path}`, (rt) => rt.fulfill({ status: 200, contentType: 'text/css', body: s.body }));
    const page = await ctx.newPage(); const files = [];
    page.on('response', async (res) => {
      const body = await res.body().catch(() => null);
      if (body) files.push({ url: res.url(), type: res.request().resourceType(), kb: body.length / 1024 });
    });
    await page.addInitScript(() => {
      window.__cwv = { lcp: 0, el: '', cls: 0 };
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__cwv.lcp = e.startTime; window.__cwv.el = e.element ? `${e.element.tagName}.${e.element.getAttribute("class") || ""}` : e.url; } }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cwv.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    try { await page.goto(url, { waitUntil: 'load', timeout: 60000 }); } catch { /* замер того, что успело */ }
    await page.waitForTimeout(2500);
    const m = await page.evaluate(() => ({ ...window.__cwv, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0 })).catch(() => null);
    if (m && m.fcp) samples.push({ ...m, kb: files.reduce((a, f) => a + f.kb, 0) });
    heavy = files.sort((a, b) => b.kb - a.kb).slice(0, 4);
    await ctx.close();
  }
  if (!samples.length) { console.log(`\n${url}\n  не открылся`); continue; }
  const lcp = med(samples.map((s) => s.lcp)); const cls = med(samples.map((s) => s.cls));
  const flag = (ok) => (ok ? 'ok' : 'ПЛОХО');
  console.log(`\n${url}`);
  console.log(`  LCP ${(lcp / 1000).toFixed(2)} с [${flag(lcp <= 2500)}]  FCP ${(med(samples.map((s) => s.fcp)) / 1000).toFixed(2)} с  CLS ${cls.toFixed(3)} [${flag(cls <= 0.1)}]  вес ${Math.round(med(samples.map((s) => s.kb)))} КБ`);
  console.log(`  LCP-элемент: ${samples.at(-1).el}`);
  for (const f of heavy) console.log(`  ${String(Math.round(f.kb)).padStart(5)} КБ ${f.type} ${f.url.slice(0, 100)}`);
}
await browser.close();
