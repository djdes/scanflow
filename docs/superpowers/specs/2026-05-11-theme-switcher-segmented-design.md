# Theme switcher — segmented pill redesign

**Status:** spec for approval
**Date:** 2026-05-11
**Owner:** djdes

## Goal

Replace the current single-button + dropdown theme switcher with a 3-segment
inline pill (Light · Auto · Dark) using custom line-art SVG icons. One click
selects the mode instead of two; the active segment is always visible.

## Why

The existing control has two issues:

1. **Emoji glyphs (☀️/🌙) clash with the editorial aesthetic.** Outfit /
   Unbounded / JetBrains Mono are crisp; the emoji render differently per OS
   (Windows native ≠ macOS ≠ Linux), can't be tinted with `currentColor`, and
   look out of place against the brand's blue→green gradient.
2. **Two-click flow** (open dropdown → pick option) is slower than necessary
   for a 3-option control that's always visible in the navbar.

## Design

### Markup

```html
<div class="theme-switcher" id="theme-switcher"
     role="radiogroup" aria-label="Тема" data-mode="auto">
  <button class="theme-opt" type="button"
          data-mode="light" role="radio" aria-checked="false"
          title="Светлая тема">
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <!-- sun: circle + 8 rays -->
    </svg>
    <span class="sr-only">Светлая</span>
  </button>
  <button class="theme-opt" type="button"
          data-mode="auto" role="radio" aria-checked="true"
          title="По времени дня (07–19)">
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <!-- half-filled circle -->
    </svg>
    <span class="sr-only">По времени дня</span>
  </button>
  <button class="theme-opt" type="button"
          data-mode="dark" role="radio" aria-checked="false"
          title="Тёмная тема">
    <svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">
      <!-- crescent moon -->
    </svg>
    <span class="sr-only">Тёмная</span>
  </button>
  <span class="theme-indicator" aria-hidden="true"></span>
</div>
```

Order is fixed: **Light · Auto · Dark** (reads left-to-right from "always
light" → "depends" → "always dark"; auto in the middle is the default).

### Styles (extends `landing.css`)

```css
.theme-switcher {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  background: var(--surface-tint);
  border: 1px solid var(--border);
  border-radius: 100px;
}

.theme-opt {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  border: 0;
  border-radius: 100px;
  cursor: pointer;
  color: var(--text-dim);
  transition: color 0.2s ease;
}

.theme-opt:hover { color: var(--text); }
.theme-opt[aria-checked="true"] { color: var(--on-accent); }
.theme-opt:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 2px;
}

.theme-icon { width: 16px; height: 16px; pointer-events: none; }

.theme-indicator {
  position: absolute;
  top: 3px;
  bottom: 3px;
  left: 3px;
  width: 32px;
  background: var(--gradient);
  border-radius: 100px;
  box-shadow: 0 2px 12px var(--accent-blue-glow);
  transition: transform 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
  z-index: 0;
}

.theme-switcher[data-mode="light"] .theme-indicator { transform: translateX(0); }
.theme-switcher[data-mode="auto"]  .theme-indicator { transform: translateX(34px); }
.theme-switcher[data-mode="dark"]  .theme-indicator { transform: translateX(68px); }

@media (prefers-reduced-motion: reduce) {
  .theme-indicator { transition: none; }
}

@media (max-width: 540px) {
  .theme-opt { width: 28px; height: 28px; }
  .theme-icon { width: 14px; height: 14px; }
  .theme-switcher[data-mode="auto"] .theme-indicator { transform: translateX(30px); }
  .theme-switcher[data-mode="dark"] .theme-indicator { transform: translateX(60px); }
  .theme-indicator { width: 28px; }
}

.sr-only {
  position: absolute; width: 1px; height: 1px;
  overflow: hidden; clip: rect(0 0 0 0);
  white-space: nowrap;
}
```

### Icons (line-art)

Three SVGs, all on `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
`stroke-width="2"`, `stroke-linecap="round"`, `stroke-linejoin="round"`:

- **Sun**: `<circle cx="12" cy="12" r="4"/>` + 8 line segments at 45° intervals
  for rays (Feather/Lucide-style).
- **Half-circle (auto)**: full circle outline + a filled half on the right.
  Looks like ◐. Visually communicates "one or the other depending".
- **Moon**: classic crescent path
  `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>` (Feather moon).

### JavaScript

Replaces the existing `setupThemeSwitcher` IIFE in `public/js/landing.js`.
Same storage contract (`sf-theme` = `'light' | 'dark' | 'auto'`); same
`resolveAuto()` and 60-second auto-tick.

Key changes:

- Drop dropdown open/close logic (`switcher.classList.add('open')`, click-
  outside, Escape handlers).
- Click on a `.theme-opt[data-mode]` → `setMode(button.dataset.mode)` directly.
- `applyMode(mode)` now sets `data-mode` on the `.theme-switcher` root (drives
  CSS indicator translation) AND on `<html>` (`data-theme-mode`), AND toggles
  `aria-checked` on each `.theme-opt`.
- Keyboard: `keydown` on the radiogroup — `ArrowLeft`/`ArrowRight` cycles
  between segments, focuses the new one, applies its mode. (Roving-tabindex
  pattern.)

### Anti-FOUC script

No change. Still sets `data-theme` on `<html>` from storage + time-of-day.

The new switcher just additionally needs `data-mode` on the `.theme-switcher`
element at mount — the JS sets it on first paint via `applyMode(readMode())`.
No visual flash because the indicator is `position: absolute` with `z-index: 0`
behind the opt buttons.

## Files touched

- `public/css/landing.css` — replace the `.theme-toggle` / `.theme-menu*`
  block with `.theme-switcher` + `.theme-opt` + `.theme-indicator` + `.theme-icon`.
- `public/index.html` — replace `<div class="theme-switcher" id="theme-switcher">…</div>` in `.header-actions`.
- `public/blog/index.html` — same.
- `public/blog/<6 articles>.html` — same (Tasks 4.1+5.x added theme-switcher
  to all of them in commit 51c5bb6).
- `public/js/landing.js` — rewrite `setupThemeSwitcher` IIFE.
- `.sr-only` class already exists in `landing.css`? If not, add to landing.css
  (it's an accessibility utility, fine to introduce).

## Non-goals

- No icon library dependency (e.g. Lucide via npm). Inline SVG only.
- No animated icon morphing (sun↔moon transformations). YAGNI.
- No persistence change. Storage format `'light' | 'dark' | 'auto'` stays.
- No prefers-color-scheme logic change.
- Auto-tick (60s re-evaluation when mode=auto) stays unchanged.

## Risks / gotchas

- **Width on small viewports**: 110px pill in navbar might crowd. Mitigated
  by `@media (max-width: 540px)` shrinking opts to 28×28.
- **Indicator math is hardcoded** (`translateX(34px)` for auto, `68px` for
  dark). If we change `.theme-opt` width, these must update in sync.
  Acceptable risk for this size of UI.
- **Removing the dropdown DOM**: existing JS handlers for `.theme-menu-item`,
  click-outside on `.theme-switcher`, Escape close — all need to be removed
  to avoid orphan listeners. Tests don't cover the switcher so manual smoke
  needed after the swap.
- **All 8 HTML files have the old markup** — bulk replace must be exact;
  one stale block leaves a half-broken nav.

## Test plan

- Manual: open `/`, `/blog`, one article in browser. Click each segment, watch
  pill slide, verify theme actually changes. Refresh, verify storage and
  initial-segment match. Try keyboard arrows.
- No unit tests added (rendering-only client code, lives in HTML/CSS/JS only).
- Run `npm test` after — should stay at 224 pass / 17 skipped.
