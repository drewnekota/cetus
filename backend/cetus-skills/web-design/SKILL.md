---
name: web-design
description: Use when building any web page, HTML artifact, landing page, dashboard, slide deck, report, email, or UI component the user will look at. A taste-first design system that makes generated pages look intentional and crafted instead of generic "AI-made". Provides an aesthetic-direction process, design tokens, a starter CSS baseline, component patterns, and an anti-AI-slop checklist.
---

# Web design

Your default web output regresses to the mean of the training set — and the mean
is ugly: system fonts, a centered hero over a purple gradient, three identical
cards, emoji headers. That look reads instantly as "AI-made". This skill exists to
pull every page off that mean and onto something that looks **deliberately
designed**. Follow the process; don't free-style from scratch.

## Process (do these in order)

1. **Commit to one aesthetic direction.** Before any markup, pick a single point
   of view that fits the content and name it in a comment. Examples:
   - *Editorial* — serif display, wide measure, strong hierarchy, ink-on-paper.
   - *Technical / precise* — mono or grotesk, tight grid, hairlines, data-dense.
   - *Warm / organic* — humanist sans, soft neutrals, generous radius, gentle.
   - *Brutalist* — flat, high-contrast, oversized type, raw structure.
   - *Refined product* — neutral grotesk, restrained accent, soft depth.
   Pick ONE and carry it through everything. Mixing directions = slop.

2. **Set tokens first.** Define type, color, space, radius as CSS custom
   properties at the top (see baseline below). Build from tokens, never hardcode
   one-off values. Consistency is most of what "designed" means.

3. **Layout with a real grid + asymmetry.** Use CSS grid. Constrain text measure
   to ~60–72ch. Do NOT center everything — anchor content, use deliberate
   asymmetry, let whitespace do work. Generous, *uneven* spacing reads as
   intentional; uniform padding reads as a template.

4. **Compose components** from the patterns below, restyled to your direction.

5. **Self-review against the checklist**, then — when it matters — open the page
   in the browser, look at it, and fix whatever reads as cheap before sending.

## Typography (80% of the result)

- **Load a real typeface from a CDN.** Never ship the system default. Good,
  free, characterful pairings:
  - Editorial: `Fraunces` or `Libre Caslon Text` display + `Inter` / `Newsreader` body.
  - Technical: `Space Grotesk` + `IBM Plex Mono`, or `Geist` + `Geist Mono`.
  - Warm: `Bricolage Grotesque` + `Instrument Sans`.
  - Refined: `General Sans` / `Satoshi` (Fontshare) for both.
  Use at most two families.
- **Type scale with real contrast.** Display should be dramatically larger than
  body (use `clamp()` for fluid display). A flat scale where h1≈h2≈body is the
  #1 tell of an undesigned page.
- **Body:** line-height 1.5–1.7, measure ≤72ch, weight 400, generous paragraph
  spacing. **Headings:** tighter line-height (1.05–1.2), often a heavier or
  contrasting weight, slightly negative letter-spacing on large display sizes.

## Color

- Build on a **consistent lightness scale**, not random hexes. Prefer
  `oklch()` / `hsl()` so steps are perceptually even.
- One near-neutral background (an *off*-white like `#fafaf7` or a true dark like
  `#0e0e10` — **never** pure `#fff` / `#000` for large areas) + a small set of
  ink shades + **one or two** accents max.
- **Avoid the AI-slop palette:** purple→indigo→blue gradients, oversaturated
  neon, rainbow gradients, glassmorphism everywhere. A flat or barely-there
  gradient in one considered place beats gradients on every surface.
- Hit **WCAG AA** contrast for text (4.5:1 body, 3:1 large).

## Space, depth, detail

- One spacing scale, 4px base: `4 8 12 16 24 32 48 64 96 128`. Use it everywhere.
- Whitespace is a feature — be generous, especially around headings and between
  sections. Cramped = cheap.
- **Subtle depth:** hairline (1px) borders in a low-contrast ink, restrained
  shadows (layered, low-opacity — not the default `0 4px 6px rgba(0,0,0,.1)`),
  ONE consistent corner radius reused everywhere (or 0 for brutalist/editorial).
- Motion: subtle and purposeful (150–250ms ease), and **always** wrap in
  `@media (prefers-reduced-motion: reduce)`.

## Starter CSS baseline

Paste this in, then override the tokens to match your chosen direction. It's a
floor, not a finish — push the type scale and accent further per direction.

```html
<style>
  :root {
    /* type */
    --font-display: "Fraunces", Georgia, serif;
    --font-body: "Inter", system-ui, sans-serif;
    --step--1: clamp(0.83rem, 0.8rem + 0.15vw, 0.9rem);
    --step-0:  clamp(1rem, 0.95rem + 0.25vw, 1.125rem);
    --step-1:  clamp(1.33rem, 1.2rem + 0.6vw, 1.6rem);
    --step-2:  clamp(1.77rem, 1.5rem + 1.3vw, 2.4rem);
    --step-3:  clamp(2.37rem, 1.9rem + 2.3vw, 3.6rem);
    --step-4:  clamp(3.16rem, 2.3rem + 4vw, 5.6rem);
    /* color — refined neutral default; retune per direction */
    --bg: oklch(0.99 0.004 95);
    --surface: oklch(0.975 0.005 95);
    --ink: oklch(0.22 0.01 260);
    --ink-soft: oklch(0.46 0.012 260);
    --line: oklch(0.9 0.006 260);
    --accent: oklch(0.55 0.16 25);
    /* space + shape */
    --s1: 0.5rem; --s2: 1rem; --s3: 1.5rem; --s4: 2rem;
    --s5: 3rem;  --s6: 4rem;  --s7: 6rem;   --s8: 8rem;
    --radius: 10px;
    --measure: 66ch;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: var(--font-body); font-size: var(--step-0);
    line-height: 1.6; -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  h1, h2, h3 {
    font-family: var(--font-display); line-height: 1.1;
    letter-spacing: -0.02em; font-weight: 600; margin: 0 0 var(--s2);
  }
  h1 { font-size: var(--step-4); }
  h2 { font-size: var(--step-2); }
  h3 { font-size: var(--step-1); }
  p  { max-width: var(--measure); color: var(--ink-soft); }
  a  { color: var(--accent); text-underline-offset: 2px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .wrap { width: min(100% - 2rem, 72rem); margin-inline: auto; }
  .section { padding-block: var(--s7); }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
```

## Component patterns (restyle to direction)

- **Hero:** asymmetric, not dead-center. A large display line (use the full type
  scale), a short ink-soft subhead capped at the measure, one primary action.
  Anchor left or split into a 2-col grid; avoid the centered-text-on-blob cliché.
- **Cards:** vary them — different sizes/spans in a grid (bento), not three
  identical boxes. Hairline border OR soft surface fill, not both + shadow.
- **Sections:** lead with a real heading and let whitespace separate them; don't
  prefix headings with emoji. Alternate rhythm (full-bleed vs. constrained).
- **Buttons:** solid accent for primary, quiet bordered/ghost for secondary.
  Comfortable padding, the shared radius, a real hover/active/focus state.
- **Data / tables:** align numbers right, use tabular figures
  (`font-variant-numeric: tabular-nums`), hairline row separators, generous cell
  padding. No zebra-stripe-plus-borders-plus-shadow pileup.

## Anti-slop checklist (reject the page if any are true)

- [ ] Still using a system/default font → load a real one.
- [ ] Type scale is flat (heading barely bigger than body) → increase contrast.
- [ ] Everything centered → introduce a grid and asymmetry.
- [ ] Purple/indigo→blue or neon gradient present → replace with restrained palette.
- [ ] Three identical feature cards → vary sizes/content or use a bento layout.
- [ ] Emoji as section-heading bullets → remove.
- [ ] Pure #fff background + pure #000 text → use off-white / near-black.
- [ ] Gradients/shadows/glass on every surface → keep depth subtle and sparse.
- [ ] Cramped, uniform padding → add generous, uneven whitespace.
- [ ] No focus states, sub-AA contrast, or not responsive → fix the basics.

## Deliverable

Prefer a single self-contained `.html` file (fonts via CDN, CSS inline or in one
`<style>`), then `send_artifact` it. Keep it accessible (semantic landmarks, alt
text, labels) and responsive to mobile.
