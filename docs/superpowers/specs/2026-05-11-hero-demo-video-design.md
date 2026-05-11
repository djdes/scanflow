# Hero demo video — HyperFrames composition

**Status:** spec for approval
**Date:** 2026-05-11
**Owner:** djdes

## Goal

A short MP4 explainer (~30 seconds, looped, silent) that visually narrates the
ScanFlow pipeline — фото накладной → JSON через Claude Sonnet 4.6 → 1С УНФ +
СберБизнес + Telegram. Placed in a new `Demo` section directly under the
landing hero so it's "above the fold" without replacing the existing
typographic hero composition.

## Why use HyperFrames

HeyGen's [hyperframes](https://github.com/heygen-com/hyperframes) renders HTML
compositions to MP4 using Puppeteer + FFmpeg. Open-source, no API keys, no
paid services. Lets us reuse the actual landing CSS tokens and fonts
(Outfit / Unbounded / JetBrains Mono / `--gradient`) so the video visually
matches the site one-to-one. The video is built like a page, not animated in
After Effects — keeps the project's "vanilla HTML/CSS, no build" spirit even
for marketing assets.

## Storyboard (~30 seconds, 6 beats)

| t (s) | Beat | Visual |
|---|---|---|
| 0–3   | **Cold open** | Dark canvas with grain overlay. Mono eyebrow text «[ OCR ENGINE: CLAUDE-SONNET-4.6 · ONLINE ]» fades in with green dot pulse. |
| 3–7   | **Photo intake** | A "polaroid" photo of an invoice slides in from bottom-right with rotation, rests at angle. Caption: «Снимаешь фото накладной». |
| 7–12  | **Scan + analyse** | Horizontal scan-line sweeps over the photo top→bottom. Top-left badge spins in: «Claude Sonnet 4.6 · vision». Bottom counter ticks 0.0s → 1.2s. |
| 12–17 | **JSON emerges** | The photo dims; on the right side, a JetBrains-Mono JSON typewriter prints key fields (`invoice_number: 2841`, `supplier: ИП Чихинов`, `items: [...14...]`, `total: 22 893 ₽`). |
| 17–24 | **3-way fanout** | JSON pulses, then 3 cards "deal" out from it: a 1С:УНФ «Приходная Накладная» row, a Сбер «Платёжное поручение draft» card, a Telegram chat bubble. Each animates in with a 0.4s offset. |
| 24–28 | **Result** | All 3 outputs settle. A big Unbounded display label appears at top: «3 секунды». Underneath: «1 документ → 3 системы». |
| 28–30 | **Loop seam** | Fade to the eyebrow line from beat 0. Seamless loop. |

Total length: 30 seconds. Loops on `<video loop>`.

## Visual identity (must match landing)

- **Fonts:** Outfit (body), Unbounded (display headlines), JetBrains Mono
  (code/eyebrow). Pre-loaded as web fonts in the composition HTML.
- **Palette:** `--bg=#06080d`, `--bg-surface=#0c1018`, `--accent-blue=#3b82f6`,
  `--accent-green=#06d6a0`, `--gradient: linear-gradient(135deg, #3b82f6, #06d6a0)`,
  `--text=#e8ecf4`, `--text-dim=#8892a4`, `--text-muted=#4a5568`. Same hex
  values used in `public/css/landing.css`.
- **Texture:** grain overlay (re-use the SVG noise from landing.css),
  scan-line beam (same animation as `.hero-scanline`).
- **Paper cards:** small white-ish rectangles with subtle shadow + 1px border,
  rotated 2–8°, in the same vocabulary as `.paper` / `.bento-tile`.
- **Animations:** standard easing `cubic-bezier(0.34, 1.56, 0.64, 1)` for
  arrivals (matches magnetic CTA + theme pill).

## Technical specifics

- **Resolution:** 1920×1080 (16:9, hero-safe).
- **Frame rate:** 30 fps.
- **Duration:** 30 seconds.
- **Codec:** H.264 (libx264), `yuv420p`, preset `slow`, CRF 22 → ~6–9 MB.
- **Audio:** none. `<video>` is autoplay-muted-loop-playsinline.
- **File location:** `public/video/scanflow-hero.mp4`. Also a poster image
  `public/video/scanflow-hero-poster.jpg` (frame 0 PNG → JPG via FFmpeg)
  for the `<video poster>` attribute — shown before MP4 starts loading.
- **HyperFrames project lives at:** `tools/hero-video/` (separate from `public/`
  so the source composition isn't shipped). `tools/hero-video/.gitignore`
  excludes `node_modules`, `*.mp4` intermediate files, and Puppeteer cache.

## DOM placement on the landing

A new `<section class="demo-video-section" id="demo">` inserted in
`public/index.html` immediately AFTER the closing `</section>` of the hero
and BEFORE the live activity ticker (`<section class="ticker-section">`).

Markup outline:

```html
<section class="demo-video-section" id="demo">
  <div class="container">
    <div class="section-label">Demo</div>
    <h2 class="section-title">
      <span class="gradient-text">3 секунды</span> от фото до записи в 1С
    </h2>
    <div class="demo-video-wrap">
      <video class="demo-video"
             src="/video/scanflow-hero.mp4"
             poster="/video/scanflow-hero-poster.jpg"
             autoplay muted loop playsinline preload="metadata"
             aria-label="Демо пайплайна ScanFlow: фото накладной → JSON → 1С + Сбер + Telegram">
      </video>
    </div>
  </div>
</section>
```

CSS additions to `landing.css`:

- `.demo-video-section { padding: 56px 0 80px; }`
- `.demo-video-wrap` — max-width 1100px, centered, `border-radius: var(--radius-xl)`,
  overflow hidden, `box-shadow: var(--shadow-glow)`, 1px border with `var(--border-lit)`.
- `.demo-video` — `width: 100%; height: auto; display: block;`.
- Subtle entrance: `data-animate="fade-up"` on the wrap to reuse the existing
  IntersectionObserver in `landing.js`.

Note: the existing landing already has an `id="demo"` on a different section
(the dropzone "Загрузите тестовую накладную"). We rename THAT section's id to
`id="try"` and have the nav «Демо» link to the NEW video section instead. The
"try" section keeps its dropzone but no longer fights for the `#demo` anchor.

## Files touched

**New:**
- `tools/hero-video/` (full HyperFrames project — composition.html, package.json,
  .gitignore, README).
- `public/video/scanflow-hero.mp4` (rendered output).
- `public/video/scanflow-hero-poster.jpg` (poster frame).
- `public/video/.gitkeep` if not already present.

**Modified:**
- `public/index.html` — add `<section class="demo-video-section">` + rename
  existing `id="demo"` (dropzone) → `id="try"` + update the nav anchor target.
- `public/css/landing.css` — add `.demo-video-section` and `.demo-video-wrap`
  styles.
- `.gitignore` — ignore `tools/hero-video/node_modules`, `tools/hero-video/.cache`,
  `tools/hero-video/output/`.

## Build prerequisites

- **FFmpeg** — not installed on this machine. Plan: download static
  Windows binary from <https://www.gyan.dev/ffmpeg/builds/> (Essentials
  release), unzip to `C:\ffmpeg\bin\`, prepend to `PATH` (session-scoped via
  PowerShell or via an `.env` for hyperframes if it supports it). Confirm
  with `ffmpeg -version` before render.
- **Node** — already 25.8.2 ≥ 22 required.
- **HyperFrames** — `npx hyperframes@latest init tools/hero-video`.
- **Puppeteer** — installs Chromium automatically on first `render`. ~300 MB
  download, expect 1–2 min on a fast connection.

## Render workflow

1. `cd tools/hero-video`
2. Edit `composition.html` + assets (icons, the "fake invoice" PNG).
3. `npx hyperframes preview` → browser opens at localhost, can scrub timeline.
4. Iterate on timing/animation in HTML until storyboard reads right.
5. `npx hyperframes render --output ../../public/video/scanflow-hero.mp4
   --resolution 1920x1080 --fps 30` (exact flags depend on `--help`; will
   verify in implementation).
6. Extract poster frame: `ffmpeg -i public/video/scanflow-hero.mp4 -ss 0
   -frames:v 1 public/video/scanflow-hero-poster.jpg`.
7. Commit.

## Non-goals

- **No audio / no voiceover.** Hero videos auto-play muted (browser policy).
  Skip Kokoro TTS entirely — Russian quality is mediocre.
- **No per-user customization.** Static MP4, same for every visitor.
- **No A/B testing yet.** Ship one version, observe.
- **No upload-to-CDN step.** Lives in `public/`, served by Express static
  (the file is 6–9 MB, fine for direct serve; pm2 + nginx-like compression
  happens upstream on prod).
- **No `<source>` fallback to WebM.** Modern Chromium / Firefox / Safari all
  ship H.264 MP4 support. If we ever need iOS 9 fallback, add WebM then.

## Risks / gotchas

- **FFmpeg install on Windows.** The session can't elevate to a system PATH
  edit, so the binary needs to live in a session-scoped folder and PATH
  needs to be set per-shell. Document the exact commands. Risk: hyperframes
  might shell out to `ffmpeg` literally — the path setup must precede the
  `npx hyperframes render` call.
- **Puppeteer Chromium download.** ~300 MB through Anthropic-proxy can be
  slow on this VM's network (currently 192.168.33.x via Hyper-V vSwitch with
  outbound through host's WAN). First render may take 5–10 min.
- **Render time per iteration.** 30s @ 30 fps = 900 frames. Even at fast
  Puppeteer screenshot rate (5–10 fps), one full render = 1.5–3 minutes.
  Plan budget for 3–5 iterations.
- **File-size budget.** Aim ≤ 10 MB. If CRF 22 lands over, escalate to CRF
  24 or scale to 1600×900.
- **Existing `id="demo"` collision.** The current landing has an anchor
  `#demo` pointing to the upload dropzone. Renaming to `#try` is part of
  this work — must also update all internal links inside `index.html`
  (search for `href="#demo"`).
- **Live preview tunnel.** The dev tunnel currently points to port 8900. The
  video file will be served as a static asset; no server changes required.
- **Site memory rule:** the design-language memory mandates using only
  existing `landing.css` tokens. The video CSS must follow suit (load the
  fonts via Google Fonts CDN inside the composition HTML; use the exact
  hex values listed under "Visual identity" rather than redefining the
  palette).

## Test plan

- Render: open generated MP4 in browser via VLC and via `<video>` tag.
- Layout: load landing locally, scroll, verify the new section sits between
  hero and ticker without breaking spacing. Light + dark theme; mobile
  width 360px (video should remain responsive `width: 100%`).
- Network: throttle to "Slow 3G" in DevTools, confirm poster image shows
  while MP4 buffers; video starts within 1–2 s on resume to "Fast 4G".
- Accessibility: `aria-label` present. When `prefers-reduced-motion: reduce`
  is set, modern browsers (Safari, recent Chromium) suppress `<video autoplay>`
  per the Web Animations spec — the `poster` image stays visible. No extra CSS
  needed for reduced-motion; rely on browser behaviour. The `<video>` is also
  click-to-play-able so users who explicitly want it can start playback.
- Existing tests: `npm test` should remain at 224 / 17 (no test files touch
  this asset).
