#!/usr/bin/env node
// Скриншоты и автопроверки страниц (Playwright из облачного контейнера).
//
//   node shots.mjs [--preset public|app|all] [--base URL] [путь|URL ...]
//                  [--viewports desktop,mobile] [--themes light,dark] [--full]
//                  [--login] [--relogin] [--wait 600] [--wait-for "css"] [--video]
//                  [--sheet] [--compare DIR] [--out DIR] [--max-height 6000]
//
// На каждую страницу × ширину × тему: PNG + проверки (код ответа, ошибки консоли
// и JS, упавшие запросы, горизонтальная прокрутка с виновниками, битые картинки).
// Итог: report.md и report.json в каталоге вывода, при --sheet ещё contact-sheet.png —
// один кадр со всеми снимками (удобно отправить человеку). --compare DIR кладёт
// рядом прежний снимок: сравнение «до | после».
//
// Пресеты и настройки страницы — routes.json рядом; вход и подготовка браузера —
// hooks.mjs. Внешние адреса идут через прокси сессии (HTTPS_PROXY), localhost — напрямую.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const require = createRequire(import.meta.url);

// Сначала предустановленный в облаке Playwright: его версия совпадает с браузером в
// /opt/pw-browsers. Проектный (например, TasksFlow держит свой) ждёт другую сборку Chromium.
function loadPlaywright() {
  for (const id of ['/usr/local/lib/node_modules_global/playwright', 'playwright', path.join(ROOT, 'node_modules/playwright')]) {
    try {
      return require(id);
    } catch {}
  }
  console.error('shots: Playwright не найден (в облаке он предустановлен глобально)');
  process.exit(2);
}

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1280, height: 800 },
  tablet: { width: 834, height: 1112, isMobile: true, hasTouch: true },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
  small: { width: 360, height: 740, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
};

const NETWORK_FLAKE = /http 50[234]|request failed|ERR_CONNECTION|ERR_EMPTY_RESPONSE|ERR_TUNNEL|Refused to execute script|net::ERR/;

function parseArgs(argv) {
  const o = { _: [] };
  const bool = new Set(['full', 'login', 'relogin', 'video', 'sheet', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (bool.has(k)) o[k] = true;
      else o[k] = argv[++i];
    } else o._.push(a);
  }
  return o;
}

const slug = (s) =>
  s
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#=&/]+/g, '_')
    .replace(/[^\p{L}\p{N}_.-]+/gu, '')
    .replace(/^_+|_+$/g, '') || 'root';

async function loadHooks() {
  const f = path.join(HERE, 'hooks.mjs');
  if (!fs.existsSync(f)) return {};
  return import(pathToFileURL(f).href);
}

function routesConfig() {
  const f = path.join(HERE, 'routes.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { base: 'http://127.0.0.1:3000', presets: {} };
}

// Страница: { path, name?, login?, waitFor?, waitUntil?, full?, wait?, expectStatus?, actions? } или строка.
function resolveTargets(opts, cfg) {
  const items = [];
  for (const p of (opts.preset || '').split(',').filter(Boolean)) {
    const list = p === 'all' ? Object.values(cfg.presets).flat() : cfg.presets[p];
    if (!list) throw new Error(`нет пресета ${p} (есть: ${Object.keys(cfg.presets).join(', ')})`);
    items.push(...list);
  }
  items.push(...opts._);
  return items.map((it) => (typeof it === 'string' ? { path: it } : it));
}

const isLocal = (u) => /^https?:\/\/(localhost|127\.|\[::1\])/.test(u);

// Вход один раз на прогон (и кэш на диске): у входа везде лимит попыток.
async function authState(browser, role, base, opts, cfg, hooks) {
  if (!hooks.login) throw new Error('в hooks.mjs нет login()');
  const dir = path.join(ROOT, 'output', 'shots', '.auth');
  const file = path.join(dir, `${slug(new URL(base).host)}-${role || 'default'}.json`);
  const ttl = Number(cfg.authTtlMin || 600) * 60000;
  if (!opts.relogin && fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < ttl) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: base });
  try {
    await hooks.login(ctx, { base, role });
    const state = await ctx.storageState();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return state;
  } finally {
    await ctx.close();
  }
}

async function checkPage(page, vpWidth) {
  return page.evaluate((vw) => {
    const doc = document.documentElement;
    const overflow = doc.scrollWidth - window.innerWidth;
    const culprits = [];
    if (overflow > 1) {
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.right > vw + 1 || r.left < -1) {
          const style = getComputedStyle(el);
          if (style.visibility === 'hidden' || style.display === 'none') continue;
          const id = el.id ? `#${el.id}` : '';
          const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
          culprits.push(`${el.tagName.toLowerCase()}${id}${cls} [${Math.round(r.left)}…${Math.round(r.right)}]`);
          if (culprits.length >= 8) break;
        }
      }
    }
    const brokenImages = [...document.images]
      .filter((img) => img.complete && img.naturalWidth === 0 && img.currentSrc)
      .map((img) => img.currentSrc)
      .slice(0, 10);
    const h1 = [...document.querySelectorAll('h1')].map((h) => h.textContent.trim().slice(0, 80));
    return { overflow: Math.max(0, overflow), culprits, brokenImages, h1, title: document.title, height: doc.scrollHeight };
  }, vpWidth);
}

// Докрутить до низа и обратно: ленивые секции и появление при прокрутке успевают отрисоваться.
async function autoScroll(page, scrollerSel) {
  await page.evaluate(async (sel) => {
    const el = (sel && document.querySelector(sel)) || document.scrollingElement || document.documentElement;
    const step = Math.max(200, Math.round((el === document.scrollingElement ? window.innerHeight : el.clientHeight) * 0.8));
    for (let i = 0; i < 60; i++) {
      const before = el.scrollTop;
      el.scrollTop = before + step;
      await new Promise((r) => setTimeout(r, 120));
      if (el.scrollTop === before) break;
    }
    el.scrollTop = 0;
  }, scrollerSel || null);
  await page.waitForTimeout(400);
}

async function shoot(browser, target, vpName, theme, opts, cfg, hooks, outDir, states) {
  const vp = VIEWPORTS[vpName];
  if (!vp) throw new Error(`нет ширины ${vpName} (есть: ${Object.keys(VIEWPORTS).join(', ')})`);
  const base = opts.base || cfg.base;
  const url = /^https?:\/\//.test(target.path) ? target.path : new URL(target.path, base).href;
  const name = target.name || slug(target.path);
  const file = `${name}__${vpName}__${theme}.png`;
  const login = target.login ?? (opts.login ? true : undefined);
  const role = typeof login === 'string' ? login : undefined;
  let storageState;
  if (login) {
    const key = `${base}|${role || ''}`;
    if (!states.has(key)) states.set(key, await authState(browser, role, base, opts, cfg, hooks));
    storageState = states.get(key);
  }
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.deviceScaleFactor || 1,
    isMobile: !!vp.isMobile,
    hasTouch: !!vp.hasTouch,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
    reducedMotion: cfg.reducedMotion || 'reduce',
    locale: 'ru-RU',
    timezoneId: cfg.timezone || 'Europe/Moscow',
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    storageState,
    recordVideo: opts.video ? { dir: path.join(outDir, 'video'), size: { width: vp.width, height: vp.height } } : undefined,
  });
  const issues = [];
  try {
    if (hooks.prepareContext) await hooks.prepareContext(context, { base, theme, viewport: vpName, login: !!login });
    const page = await context.newPage();
    for (const pattern of cfg.blockUrls || []) await page.route(pattern, (r) => r.abort());
    const origin = new URL(url).origin;
    const ignore = (cfg.ignoreIssues || []).map((s) => new RegExp(s));
    const add = (msg) => {
      if (!ignore.some((re) => re.test(msg))) issues.push(msg);
    };
    page.on('console', (m) => {
      if (m.type() === 'error') add(`console: ${m.text().slice(0, 300)}`);
    });
    page.on('pageerror', (e) => add(`js: ${String(e.message || e).slice(0, 300)}`));
    page.on('requestfailed', (r) => {
      const f = r.failure();
      if (f && /ERR_ABORTED/.test(f.errorText)) return;
      add(`request failed: ${r.method()} ${r.url().slice(0, 160)} ${f ? f.errorText : ''}`);
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && r.url().startsWith(origin) && r.request().resourceType() !== 'document') add(`http ${r.status()}: ${r.request().method()} ${r.url().slice(0, 160)}`);
    });
    const started = Date.now();
    let status = null;
    try {
      const resp = await page.goto(url, { waitUntil: target.waitUntil || cfg.waitUntil || 'networkidle', timeout: Number(opts.timeout || cfg.timeout || 45000) });
      status = resp ? resp.status() : null;
    } catch (e) {
      add(`goto: ${String(e.message).split('\n')[0]}`);
    }
    const waitFor = target.waitFor || opts['wait-for'] || (login && cfg.waitForApp);
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 20000 }).catch(() => add(`нет элемента ${waitFor}`));
    if (cfg.waitGone) {
      await page
        .waitForFunction((sel) => document.querySelectorAll(sel).length === 0, cfg.waitGone, { timeout: 20000 })
        .catch(() => add(`не дождался исчезновения ${cfg.waitGone}`));
    }
    if (target.actions && hooks.actions && hooks.actions[target.actions]) await hooks.actions[target.actions](page, { base });
    if (login && cfg.loginPath && new URL(page.url()).pathname === cfg.loginPath && new URL(url).pathname !== cfg.loginPath) {
      add(`перекинуло на вход (${cfg.loginPath}): сессия не принята, повторите с --relogin`);
    }
    const full = target.full ?? opts.full;
    const maxH = Number(opts['max-height'] || 6000);
    const scroller = target.scroller || cfg.scroller;
    if (full) await autoScroll(page, scroller);
    await page.waitForTimeout(Number(target.wait ?? opts.wait ?? cfg.wait ?? 600));
    const facts = await checkPage(page, vp.width).catch(() => ({}));
    if (status && status >= 400 && status !== target.expectStatus) issues.unshift(`status ${status}`);
    if (target.expectStatus && status === target.expectStatus) {
      for (let k = issues.length - 1; k >= 0; k--) if (issues[k].includes(`status of ${status}`)) issues.splice(k, 1);
    }
    if (facts.overflow > 1) add(`горизонтальная прокрутка +${facts.overflow}px: ${facts.culprits.join(', ')}`);
    if (facts.brokenImages && facts.brokenImages.length) add(`битые картинки: ${facts.brokenImages.join(', ')}`);
    let shotOpts = { path: path.join(outDir, file), animations: 'disabled' };
    // Страница с внутренней прокруткой (кабинет: шапка + свой скроллер) целиком не снимается
    // fullPage-ом — растягиваем окно на высоту содержимого скроллера.
    const inner = full && scroller ? await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el && el.scrollHeight > el.clientHeight + 4 ? el.scrollHeight - el.clientHeight : 0;
    }, scroller) : 0;
    if (inner) {
      await page.setViewportSize({ width: vp.width, height: Math.min(maxH, vp.height + inner) });
      await page.waitForTimeout(500);
    } else if (full) {
      shotOpts = { ...shotOpts, fullPage: true, clip: facts.height > maxH ? { x: 0, y: 0, width: vp.width, height: maxH } : undefined };
    }
    await page.screenshot(shotOpts);
    const finalUrl = page.url();
    await page.close();
    return { name, url, finalUrl, viewport: vpName, theme, file, status, ms: Date.now() - started, title: facts.title, h1: facts.h1, issues };
  } finally {
    await context.close();
  }
}

// Общий лист: карточка на страницу, в ней все ширины и темы в ряд; по 8 страниц на лист,
// чтобы кадр читался и на телефоне. С --compare в каждом варианте «до | после».
async function contactSheet(browser, results, outDir, compareDir) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const groups = [];
  for (const r of results) {
    let g = groups.find((x) => x.name === r.name);
    if (!g) groups.push((g = { name: r.name, items: [] }));
    g.items.push(r);
  }
  const card = (g) => {
    const variants = g.items
      .map((r) => {
        const before = compareDir && fs.existsSync(path.join(compareDir, r.file)) ? `<img src="${pathToFileURL(path.join(compareDir, r.file)).href}">` : '';
        return `<figure><figcaption>${r.viewport} · ${r.theme} · ${r.status ?? '—'}</figcaption><div class=pair>${before}<img src="${encodeURI(r.file)}"></div></figure>`;
      })
      .join('');
    const notes = g.items.flatMap((r) => [...r.issues, ...(r.retried ? [r.retried] : [])].map((i) => `${r.viewport}/${r.theme}: ${i}`));
    const bad = notes.length ? `<ul>${notes.slice(0, 6).map((i) => `<li>${esc(i)}</li>`).join('')}${notes.length > 6 ? `<li>… ещё ${notes.length - 6}</li>` : ''}</ul>` : '<p class=ok>без замечаний</p>';
    return `<section><h4>${esc(g.name)}</h4><div class=row>${variants}</div>${bad}</section>`;
  };
  const per = 8;
  // Больше двух вариантов на страницу (ширины × темы) — карточка на всю ширину листа.
  const cols = compareDir || Math.max(...groups.map((g) => g.items.length)) > 2 ? 1 : 2;
  const sheets = [];
  for (let i = 0; i < groups.length; i += per) {
    const part = groups.slice(i, i + per);
    const n = groups.length > per ? `-${i / per + 1}` : '';
    const html = `<!doctype html><meta charset=utf-8><style>
      body{margin:0;padding:16px;background:#f3f4f6;font:13px/1.4 system-ui,sans-serif;color:#111}
      main{display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:14px}
      section{background:#fff;border:1px solid #ddd;border-radius:10px;padding:10px}
      h4{margin:0 0 8px;font-size:15px}
      .row{display:flex;gap:10px;align-items:flex-start}
      figure{margin:0;min-width:0}figcaption{color:#555;margin-bottom:4px}
      .pair{display:flex;gap:6px}.pair img{max-height:420px;max-width:100%;border:1px solid #e5e5e5;display:block}
      ul{margin:8px 0 0;padding-left:18px;color:#b42318}.ok{margin:8px 0 0;color:#067647}</style>
      <h3 style="margin:0 0 12px">${results.length} снимков${groups.length > per ? ` · лист ${i / per + 1} из ${Math.ceil(groups.length / per)}` : ''} · ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК${compareDir ? ' · в каждой паре слева до, справа после' : ''}</h3>
      <main>${part.map(card).join('')}</main>`;
    const sheetHtml = path.join(outDir, `contact-sheet${n}.html`);
    fs.writeFileSync(sheetHtml, html);
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(pathToFileURL(sheetHtml).href);
    await page.waitForTimeout(300);
    const sheet = path.join(outDir, `contact-sheet${n}.png`);
    await page.screenshot({ path: sheet, fullPage: true });
    await ctx.close();
    sheets.push(sheet);
  }
  return sheets;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = routesConfig();
  if (opts.help || (!opts.preset && !opts._.length)) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 17).join('\n'));
    console.log(`\nПресеты: ${Object.keys(cfg.presets).join(', ')}; база: ${cfg.base}`);
    return;
  }
  const targets = resolveTargets(opts, cfg);
  const viewports = (opts.viewports || 'desktop,mobile').split(',');
  const themes = (opts.themes || 'light').split(',');
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const outDir = path.resolve(opts.out || path.join(ROOT, 'output', 'shots', stamp));
  fs.mkdirSync(outDir, { recursive: true });
  const hooks = await loadHooks();
  const { chromium } = loadPlaywright();
  const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1,::1' } : undefined;
  const browser = await chromium.launch({ proxy }).catch((e) => {
    if (!/Executable doesn't exist/.test(String(e.message)) || !fs.existsSync('/opt/pw-browsers/chromium')) throw e;
    return chromium.launch({ proxy, executablePath: '/opt/pw-browsers/chromium' });
  });
  const results = [];
  const states = new Map();
  try {
    for (const t of targets)
      for (const vp of viewports)
        for (const th of themes) {
          const once = () =>
            shoot(browser, t, vp, th, opts, cfg, hooks, outDir, states).catch((e) => ({
              name: t.name || slug(t.path),
              url: t.path,
              viewport: vp,
              theme: th,
              file: null,
              status: null,
              issues: [`ошибка снимка: ${String(e.message).split('\n')[0]}`],
            }));
          let r = await once();
          // Внешние адреса идут через прокси сессии, а он изредка рвёт туннель (502 на
          // случайном чанке, ERR_CONNECTION_RESET). Такой снимок переснимаем один раз.
          if (!isLocal(new URL(t.path, opts.base || cfg.base).href) && r.issues.some((i) => NETWORK_FLAKE.test(i))) {
            const first = r.issues.filter((i) => NETWORK_FLAKE.test(i)).length;
            r = await once();
            r.retried = `повтор: в первой попытке ${first} сетевых сбоев (прокси сессии?)`;
          }
          results.push(r);
          console.log(`${r.issues.length ? '✗' : '✓'} ${r.name} ${vp}/${th} ${r.status ?? ''}${r.issues.length ? ` — ${r.issues.length} замеч.` : ''}${r.retried ? ' (повтор)' : ''}`);
        }
    const ok = results.filter((r) => r.file);
    if (opts.sheet && ok.length) for (const f of await contactSheet(browser, ok, outDir, opts.compare && path.resolve(opts.compare))) console.log(`sheet: ${path.relative(process.cwd(), f)}`);
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
  const md = [`# Снимки ${stamp}`, '', '| страница | ширина | тема | код | замечания | файл |', '|---|---|---|---|---|---|'];
  for (const r of results) {
    const notes = [...r.issues, ...(r.retried ? [r.retried] : [])];
    md.push(`| ${r.name} | ${r.viewport} | ${r.theme} | ${r.status ?? '—'} | ${notes.length ? notes.map((i) => i.replace(/\|/g, '\\|')).join('<br>') : '—'} | ${r.file || '—'} |`);
  }
  fs.writeFileSync(path.join(outDir, 'report.md'), md.join('\n') + '\n');
  const bad = results.filter((r) => r.issues.length).length;
  console.log(`\n${results.length} снимков, с замечаниями ${bad} → ${path.relative(process.cwd(), outDir)}/report.md`);
}

main().catch((e) => {
  console.error(`shots: ${e.message}`);
  process.exit(2);
});
