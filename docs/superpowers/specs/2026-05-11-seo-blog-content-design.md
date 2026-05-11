# SEO foundations + blog system + content launch

**Status:** spec draft for review
**Date:** 2026-05-11
**Owner:** djdes
**Scope of first round:** 6 published articles + the surrounding infrastructure.
**Estimated work:** one implementation plan, several phases.

---

## Goal

Make `scanflow.ru` a search-friendly site by:

1. Adding proper SEO infrastructure (meta tags, JSON-LD, sitemap, robots.txt) to every page.
2. Publishing a semantic-core document that drives content and meta decisions.
3. Standing up a static blog (`/blog/` + per-article pages) integrated with the existing landing.
4. Writing six initial articles covering the product's core keyword clusters.
5. Surfacing the three newest articles on the landing between FAQ and signup.

Non-goals for this round:

- No headless CMS, no Markdown→HTML build pipeline, no SSG. Keep the project's "vanilla HTML/CSS/JS, no client build step" rule.
- No per-article Open Graph images. All articles use a shared default OG. Custom OG generation is a follow-up.
- No email digest / RSS / comments / on-page search. Add to roadmap later.
- No translations. Russian only.

---

## Storage & routing

Files (no build step):

```
public/
  blog/
    index.html              # listing page (cards for 6 articles)
    articles.json           # metadata array (slug, title, description, tags, date, readingMinutes, ogImage)
    ocr-nakladnyh-kak-rabotaet.html
    perevod-paper-zacenok-v-1c-unf.html
    avto-platezhka-v-sberbiznes.html
    torg-12-kak-pravilno-raspoznat.html
    dadata-i-kontragenty-po-inn.html
    multi-page-nakladnye-sliyanie.html
  css/
    article.css             # extends landing.css (prose, ToC, blog grid, callouts)
  og/
    default.jpg             # 1200×630 shared OG image
robots.txt                  # static, at /
sitemap.xml                 # generated dynamically at server startup
```

Express routes in `src/api/server.ts`:

```ts
app.get('/sitemap.xml', sendDynamicSitemap);   // text/xml, built from articles.json
app.get('/robots.txt',  serveStatic('robots.txt'));
app.get('/blog',  (_req, res) => res.sendFile(path.join(publicDir, 'blog/index.html')));
app.get('/blog/', (_req, res) => res.redirect(301, '/blog'));         // canonical: no trailing slash
app.get('/blog/:slug', sendArticleHtml);  // serves blog/<slug>.html, 404 if not found
// SPA fallback stays LAST and does NOT intercept /blog/*, /sitemap.xml, /robots.txt
```

URL canonical form: `/`, `/blog`, `/blog/<slug>` — no trailing slash on inner pages.

`articles.json` is the single source of truth for article metadata. Listing page, blog-preview section on landing, and sitemap all read it. Adding an article = create `<slug>.html` + add an entry to `articles.json`. No other place to update.

---

## SEO infrastructure (applies to every page)

Every HTML page (`index.html`, `blog/index.html`, every article) has in `<head>`:

- `<title>` (50–60 chars, page-specific, key phrase early)
- `<meta name="description">` (140–160 chars, page-specific, contains primary keyword naturally)
- `<link rel="canonical" href="https://scanflow.ru{path}">`
- `<meta name="robots" content="index, follow">`
- Full Open Graph block (`og:type`, `og:title`, `og:description`, `og:url`, `og:image`, `og:site_name=ScanFlow`, `og:locale=ru_RU`)
- Twitter card block (`twitter:card=summary_large_image`, `twitter:title`, `twitter:description`, `twitter:image`)
- Favicon set: `/favicon.ico`, `/icon.svg`, `/apple-touch-icon.png`, `/site.webmanifest`

JSON-LD structured data:

- Landing (`/`): `Organization`, `WebSite`, `SoftwareApplication`, `FAQPage` (auto-generated from the existing FAQ accordion HTML at build of the response).
- Listing (`/blog`): `BreadcrumbList` (Home → Blog), `CollectionPage`.
- Each article: `Article` (with `headline`, `description`, `image`, `datePublished`, `dateModified`, `author=Organization`, `mainEntityOfPage`, `publisher`), `BreadcrumbList` (Home → Blog → Article), `FAQPage` if the article has a FAQ section.

`sitemap.xml` is built at Express startup from `articles.json` (plus the two static entries `/` and `/blog`). Regenerated on every server restart, served from memory. No file write.

`robots.txt`:

```
User-agent: *
Allow: /
Disallow: /app.html
Disallow: /camera
Disallow: /api/

Sitemap: https://scanflow.ru/sitemap.xml
```

Heading hierarchy: exactly one `<h1>` per page. Landing's `<h1>` is the hero headline; listing's is "Блог ScanFlow"; article's is the article title.

---

## Semantic core

A planning artifact: `docs/marketing/seo-semantic-core.md`. Contents:

**Target audience:** owners and accountants of small/mid Russian B2B (food retail, wholesale, foodservice) running 1C:УНФ, who currently re-key supplier invoices into 1C by hand.

**Six clusters (one cluster = one article):**

| # | Cluster | Primary query (est. monthly Russian volume) | Supporting queries | Target page | Search intent |
|---|---|---|---|---|---|
| 1 | OCR накладных | `распознавание накладных программа` (~1200) | `OCR накладных`, `сканирование накладных в 1С`, `автоматическое распознавание ТТН` | `/blog/ocr-nakladnyh-kak-rabotaet` | informational, top-of-funnel |
| 2 | 1С:УНФ интеграция | `как загрузить накладную в 1С УНФ` (~800) | `1С УНФ обмен накладными`, `внешняя обработка для УНФ`, `приходная накладная 1С автоматически` | `/blog/perevod-paper-zacenok-v-1c-unf` | how-to, mid-funnel |
| 3 | СберБизнес платёжки | `как создать платёжку в Сбербизнес автоматически` (~600) | `СберБизнес API`, `интеграция с СберБизнес`, `платёжное поручение из накладной` | `/blog/avto-platezhka-v-sberbiznes` | how-to, mid-funnel |
| 4 | ТОРГ-12 | `как заполнять ТОРГ-12` (~3000) | `ТОРГ-12 распознать`, `ТОРГ-12 расшифровка`, `накладная ТОРГ-12 образец` | `/blog/torg-12-kak-pravilno-raspoznat` | informational, top-of-funnel |
| 5 | Контрагенты по ИНН | `проверка контрагента по ИНН` (~5000) | `DaData API`, `получить реквизиты по ИНН`, `автозаполнение контрагента` | `/blog/dadata-i-kontragenty-po-inn` | how-to + brand awareness |
| 6 | Многостраничные накладные | `накладная на нескольких листах как загрузить` (~200, low comp) | `склейка фото в один документ`, `multi-page scan накладные` | `/blog/multi-page-nakladnye-sliyanie` | feature spotlight |

**Branded cluster** (target = landing `/`): `ScanFlow`, `сканфлоу`, `сканфлоу OCR`, `scanflow.ru`.

**Excluded queries (not our product):** `1С бухгалтерия`, `ЕГАИС`, `маркировка`, `ЭДО`. Pursuing these dilutes relevance.

**LSI / semantic neighbours** (drive natural keyword density across the corpus): накладная, поставщик, ИНН, номенклатура, артикул, единица измерения, НДС, остатки, приход, ОКВЭД, ИП, ООО, бухгалтерия, учёт.

**Internal linking matrix** (each article links to 2–3 siblings, all link to `/`, `/#features`, `/#pricing`):

| From | Links to |
|---|---|
| 1 OCR | 2 1C, 4 ТОРГ-12 |
| 2 1C | 1 OCR, 3 Sber |
| 3 Sber | 2 1C, 5 контрагенты |
| 4 ТОРГ-12 | 1 OCR, 6 multi-page |
| 5 контрагенты | 3 Sber, 2 1C |
| 6 multi-page | 4 ТОРГ-12, 1 OCR |

---

## Blog pages design

All blog pages reuse `site-header` and `site-footer` from `index.html` (same nav, theme switcher, mobile menu) so the site reads as one product. Navigation gets a new `Блог` item between «Тарифы» and «Войти». Current-page is marked with `aria-current="page"`.

### Listing `/blog`

Container max-width 1200px. Sections from top:

- Eyebrow `[ БЛОГ · 6 СТАТЕЙ ]` (mono, uppercase, accent color)
- `<h1>` Unbounded: "Как мы делаем OCR накладных <span class="gradient-text">и зачем это вам</span>"
- Subline (text-dim, 18px): one-line statement of what the blog is.
- Tag-filter row: `# все · # ocr · # 1c-unf · # sber · # torg-12 · # suppliers · # multi-page` — all distinct tags found in `articles.json`, rendered server-side from the JSON union. Client-side filter via `data-tag` on cards; default = все. Each article has 1–2 tags (see mapping below).
- Bento-style grid of cards:
  - Row 1: one **featured** wide card (most recent article) + one regular card.
  - Row 2: three regular cards.
  - Row 3: one **full-width** card.
- Bottom CTA: `[ Все статьи · обновляется ежемесячно ]` (text-only, no email collection in this round).

Each card:

- Tags (`# ocr  # 1c-unf`) — mono, small, accent-tinted.
- Title — `<h3>` Unbounded.
- 2-line description.
- Meta row: `5 мин чтения · 22 окт 2026`.
- Hover: slight `translateY(-3px)` + `--shadow-glow`, same as bento on landing.
- No images. Editorial / typography-first.

### Article `/blog/<slug>`

Three-column max layout on ≥1100px: thin left gutter, 740px reading column, ToC on the right (sticky). Below 1100px the ToC collapses to an inline `<details>` at the top of the article.

Article hero (above body):

- Breadcrumb `Главная / Блог / <tag>` with `BreadcrumbList` microdata.
- Tags row.
- `<h1>` Unbounded, up to 80px on desktop, with gradient on the key phrase part.
- Meta row: `автор Команда ScanFlow · 7 мин чтения · 22 окт 2026`.

Article body — `.article-prose` class on the wrapper applies:

- Body font: Outfit 17px, line-height 1.75, color `var(--text)`.
- `<h2>`: Unbounded 30px, top margin 56px.
- `<h3>`: Unbounded 22px, top margin 32px.
- `<p>`: bottom margin 1.2em.
- `<ul>`/`<ol>`: comfortable indent + bullet color `var(--accent-blue)`.
- `<blockquote>`: 4px left border in `var(--accent-blue)`, italic, max-width inherits.
- `<code>` inline: JetBrains Mono, `var(--surface-tint)` background, 1px `var(--border)`.
- `<pre><code>`: dark `#1e293b` background (matches evidence-artifact color used elsewhere), JetBrains Mono, syntax tinted via existing tokens.
- Callouts: `.callout.callout--tip|warn|info` — left accent bar + icon + body.
- Pull-quote: `.pull-quote` — Unbounded 32px, generous side margin, accent quote glyph.
- Images: lazy-loaded, with `<figcaption>`.

Article footer:

- Big CTA: «Понравилось? Попробовать ScanFlow бесплатно →» (btn-primary).
- Related articles: 3 cards generated from `articles.json` by tag overlap, rendered server-side so crawlers see them.

Page extras:

- Reading-progress bar at top of viewport (thin gradient strip, fills on scroll). Skipped under `prefers-reduced-motion`.
- Two `.paper` elements floating in the article hero, scaled-down vs landing (decorative only).
- Theme switcher persists across pages via existing `localStorage.sf-theme`.
- `data-animate="fade-up"` continues to be wired by `landing.js` (we'll move that block into a shared `common.js` accessible from blog pages too).

### New CSS file `public/css/article.css`

Extends `landing.css` (no duplication). Adds:

- `.article-prose` and child selectors above
- `.article-toc` (sticky right column)
- `.callout`, `.callout--tip`, `.callout--warn`, `.callout--info`
- `.pull-quote`
- `.article-meta`, `.article-tags`, `.article-breadcrumb`
- `.read-progress`
- `.blog-grid`, `.blog-card`, `.blog-card--featured`, `.blog-card--full`
- `.blog-tag-filter`

---

## Landing `Блог` preview section

New section in `index.html` between FAQ (`#faq`) and signup (`#auth`). Anchor id `#blog-preview`.

Markup outline:

```html
<section class="blog-preview-section" id="blog-preview">
  <div class="container">
    <div class="section-label">Блог</div>
    <h2 class="section-title">
      Гайды и <span class="gradient-text">разборы</span>
    </h2>
    <p class="section-sub">…one-line description…</p>

    <div class="blog-preview-grid">
      <!-- BLOG-PREVIEW-PLACEHOLDER -->
    </div>

    <div class="blog-preview-cta">
      <a href="/blog" class="btn-outline">Все статьи →</a>
    </div>
  </div>
</section>
```

On server startup, `loadArticlesIntoIndexHtml()` reads `public/blog/articles.json`, takes the three most recent entries, renders them as `.blog-card` markup, and substitutes the placeholder in an in-memory copy of `index.html`. The substituted HTML is what Express serves for `GET /`. This gives:

- Search crawlers see real article cards in the landing HTML (boosts internal linking).
- Visitors without JS see the cards.
- The client `landing.js` can still rebind hover/animation handlers.

Failure mode: if `articles.json` is missing or malformed, the placeholder stays as a comment and the section renders empty. Site doesn't break.

Header nav gets `<a href="/blog">Блог</a>` inserted between «Тарифы» and the header-actions wrapper.

---

## Article content

Six articles, 1500–2500 words each, structure-uniform:

```
[Eyebrow with tags]
[H1 — primary keyword embedded naturally]
[Lead — 2–3 sentences, says why to read]
[ToC — generated automatically from H2/H3]

H2: Проблема — what's painful for the reader
H2: Как обычно решают — the manual / non-AI status quo
H2: Как это работает в ScanFlow — technical substance, no marketing
  H3: 2–3 detail subsections
H2: Что важно учесть — gotchas, edge cases, limits
H2: FAQ — 3–5 Q&A items, also serialized to JSON-LD FAQPage
H2: Что дальше — links to 2–3 sibling articles + product CTA
```

Tone: engineer-expert, same voice as the project's CLAUDE.md. First-person plural ("у нас", "мы видим"). No press-release fluff. Every article includes 1–2 real code/JSON fragments and 1 `callout--warn` with a real-world gotcha.

About 70% of content is real material that already exists in the project (under `CLAUDE.md`, `docs/_archive/`, and source comments). The articles are publishing the engineering substance, not inventing it.

### Tag taxonomy

The full tag set used across the six articles. Each article has 1–2 tags.

| Tag slug | Russian label (for chips) |
|---|---|
| `ocr` | OCR |
| `1c-unf` | 1С:УНФ |
| `sber` | Сбер |
| `torg-12` | ТОРГ-12 |
| `suppliers` | Контрагенты |
| `multi-page` | Многостраничные |

Per-article assignment:

| Slug | Tags |
|---|---|
| `ocr-nakladnyh-kak-rabotaet` | `ocr` |
| `perevod-paper-zacenok-v-1c-unf` | `1c-unf`, `ocr` |
| `avto-platezhka-v-sberbiznes` | `sber` |
| `torg-12-kak-pravilno-raspoznat` | `torg-12`, `ocr` |
| `dadata-i-kontragenty-po-inn` | `suppliers` |
| `multi-page-nakladnye-sliyanie` | `multi-page`, `ocr` |

### Article-by-article abstracts

1. **`ocr-nakladnyh-kak-rabotaet`** — "Как работает OCR накладных в 2026: от Google Vision к Claude Sonnet 4.6"
   Compares the legacy OCR chain (Vision + regex parser) with single-shot vision-LLM. Real numbers from ScanFlow production: 99.2% accuracy, ~1.2s per page, ~$0.003 per invoice. Failure modes per engine. Why we kept the fallback chain anyway.

2. **`perevod-paper-zacenok-v-1c-unf`** — "От фото накладной до приходной в 1С:УНФ за 3 секунды"
   Full pipeline diagram: photo → JSON → external `.epf` processing → «Приходная накладная» document. What 1C pulls via `/api/invoices/pending`, how nomenclature maps to «Справочник.Номенклатура» (fuzzy + Claude LLM matcher), how VAT (`СтавкиНДС.СтавкаНДС(ВидСтавки, Period)`) is resolved by date for the 18%/20% history.

3. **`avto-platezhka-v-sberbiznes`** — "Автоматическое создание платёжки в СберБизнес из накладной"
   Real guide to `/fintech/api/v1/payments`: mTLS setup, OAuth flow, exact `purpose` rules (≤210 chars, ASCII-safe), the `Authorization` quirk (no `Bearer` prefix). Why we only create drafts (legal + security), with a `callout--warn` about double-payment protection via `sber_payments.invoice_id UNIQUE`.

4. **`torg-12-kak-pravilno-raspoznat`** — "ТОРГ-12: какие графы важны и где OCR ошибается чаще всего"
   Form structure overview, what fields matter (supplier, ИНН, number, date, line items, qty/price/total/НДС). Real OCR failure modes: SKU mistaken for quantity, VAT↔total swap, page-boundary continuations. Walk-through of `qty × price ≈ total` cross-validation catching ~30% of errors.

5. **`dadata-i-kontragenty-po-inn`** — "Автозаполнение контрагентов по ИНН через DaData: как это устроено"
   What DaData returns for an ИНН, pricing, limits, how we cache results in `suppliers` (PK=ИНН). Comparison with СПАРК API / Контур.Фокус / direct ФНС lookups. What "checking a counterparty" actually proves, and what it doesn't.

6. **`multi-page-nakladnye-sliyanie`** — "Накладная на 3 страницах: как ScanFlow собирает её обратно в один документ"
   The merge algorithm: shared invoice number + supplier → single `invoices` row, items appended to `invoice_items` by `row_no`. Cases where merge silently fails (different number formats, lost signature page) and how `findRecentByNumber` decides what to do.

---

## Implementation phases (for the plan)

1. **SEO foundations** — update `index.html` head, add `robots.txt`, add `sitemap.xml` Express route, drop in the JSON-LD scripts. Test before/after with Lighthouse SEO score.
2. **Blog infrastructure** — `articles.json` schema, `public/blog/index.html` listing, `public/css/article.css`, Express routes for `/blog` and `/blog/:slug`, update SPA fallback to not steal those, server-side blog-preview injection into `index.html`.
3. **Semantic core doc** — write `docs/marketing/seo-semantic-core.md`.
4. **Article template + first article (1: OCR)** — flesh out the article HTML template, then write content for the OCR article end-to-end. This validates the template before bulk-writing.
5. **Articles 2–6** — write the remaining five using the validated template.
6. **Landing blog-preview section + nav update** — add the section to `index.html`, update navbar.
7. **Final QA** — both themes, mobile, dead links, schema-validator, Lighthouse SEO=100.

Each phase is an independent merge unit (small enough to review).

---

## Open follow-ups (not in this round)

- Per-article Open Graph image generation (Sharp + canvas).
- Email digest subscription.
- RSS / Atom feed.
- Comments (probably never — moderation cost).
- On-page search (probably MiniSearch over `articles.json`).
- English translations (`/en/blog/…`).
- Algolia Crawler / Yandex Webmaster verification metas (will need real domain ownership setup).

---

## Risks / gotchas to keep an eye on during implementation

- **SPA fallback regression.** `index.html` is currently served for any unmatched GET. The new `/blog/:slug` and `/sitemap.xml` and `/robots.txt` routes must register before the fallback. A missing test or a route reordering bug will silently make every blog URL render the landing.
- **In-memory `index.html` injection.** If `loadArticlesIntoIndexHtml()` runs before `articles.json` is readable (e.g., during `npm test`), it must fall back gracefully — never throw at startup.
- **Canonical URL drift.** Both the landing and articles must use `scanflow.ru` (no `www`), no trailing slash on inner pages. A small helper `canonical(path)` enforces this.
- **Sitemap freshness.** Generated at startup, not on every request. New articles only appear after a `pm2 restart scanflow`. Document this.
- **Article file growth.** Six articles is fine inline. If this grows to 50+, we'll need a build step. Out of scope for now; flag in the spec.
- **Heading hierarchy.** Landing already has one `<h1>` (hero). Blog preview section on landing uses `<h2>`. Article pages have their own `<h1>` (article title) — that's fine because they are different pages.
- **Reading-time estimator.** Compute at content authoring time (manually in `articles.json`), not at runtime. Avoids JS dependency and gives author control.
- **Stale links.** Each article references 2–3 siblings by hardcoded URL. If a slug ever renames, those links break. Mitigation: introduce a small static `slugs.ts` constant and have articles use server-injected slug refs… BUT that adds a build step. For first round we accept hardcoded links and add a redirect rule when we rename.
